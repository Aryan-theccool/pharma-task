# =============================================================================
# Security — application secrets, the security-group mesh, and the WAF.
#
# KMS keys live in modules/kms because the network module needs one for its
# flow-log group, and this module needs the network's VPC id for its security
# groups. Keeping keys here would make that a dependency cycle.
# =============================================================================

# --------------------------------------------------------------- secrets

# Terraform never sets these values. It creates the container with a
# placeholder and a lifecycle-ignore, so the real secret is written
# out-of-band (console, CLI, or a rotation Lambda) and never lands in state.
#
# Terraform state contains secret values in plaintext; keeping them out of
# state is the only way `terraform state pull` is not a credential dump.
resource "aws_secretsmanager_secret" "app" {
  for_each = toset([
    "jwt-access-secret",
    "jwt-refresh-secret",
    "encryption-master-key",
    "email-hmac-key",
    "prescription-signing-key",
    "webhook-signing-secret",
  ])

  name                    = "${var.name_prefix}/${each.value}"
  description             = "${each.value} for ${var.name_prefix}"
  kms_key_id              = var.app_kms_key_arn
  recovery_window_in_days = var.secret_recovery_window

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.value}" })
}

resource "aws_secretsmanager_secret_version" "app_placeholder" {
  for_each = aws_secretsmanager_secret.app

  secret_id     = each.value.id
  secret_string = "PLACEHOLDER-ROTATE-ME"

  lifecycle {
    # The real value is set outside Terraform. Without this, every apply would
    # revert live credentials to the placeholder.
    ignore_changes = [secret_string]
  }
}

# ------------------------------------------------------- security groups

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  description = "Public load balancer"
  vpc_id      = var.vpc_id

  lifecycle { create_before_destroy = true }
  tags = merge(var.tags, { Name = "${var.name_prefix}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Port 80 exists only to 301 to 443; the listener never serves content.
resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS at the listener"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to ECS tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "tasks" {
  name_prefix = "${var.name_prefix}-tasks-"
  description = "ECS Fargate tasks"
  vpc_id      = var.vpc_id

  lifecycle { create_before_destroy = true }
  tags = merge(var.tags, { Name = "${var.name_prefix}-tasks" })
}

# Only the ALB may reach the app port — no CIDR-based rule, so a compromised
# host elsewhere in the VPC still cannot talk to the tasks directly.
resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "App traffic from the ALB only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  description       = "HTTPS egress for AWS APIs and payment providers"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_db" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "PostgreSQL"
  referenced_security_group_id = aws_security_group.database.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_cache" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "Redis"
  referenced_security_group_id = aws_security_group.cache.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "database" {
  name_prefix = "${var.name_prefix}-db-"
  description = "RDS PostgreSQL"
  vpc_id      = var.vpc_id

  lifecycle { create_before_destroy = true }
  tags = merge(var.tags, { Name = "${var.name_prefix}-db" })
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from ECS tasks only"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# No egress rule on the database SG at all: a compromised database instance
# has nowhere to send data.

resource "aws_security_group" "cache" {
  name_prefix = "${var.name_prefix}-cache-"
  description = "ElastiCache Redis"
  vpc_id      = var.vpc_id

  lifecycle { create_before_destroy = true }
  tags = merge(var.tags, { Name = "${var.name_prefix}-cache" })
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_tasks" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Redis from ECS tasks only"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# ------------------------------------------------------------------- WAF

resource "aws_wafv2_web_acl" "this" {
  count = var.enable_waf ? 1 : 0

  name  = "${var.name_prefix}-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  # Coarse backstop. The application's own Redis limiter is per-identity and
  # fails open by design; this one fails closed at the edge, so the two
  # together cover both a Redis outage and a volumetric flood.
  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-common"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-sqli"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-sqli"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-known-bad-inputs"
    priority = 4

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-waf"
    sampled_requests_enabled   = true
  }

  tags = var.tags
}

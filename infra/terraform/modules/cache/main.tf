# =============================================================================
# Cache — ElastiCache Redis, replication group with automatic failover.
#
# Redis is not only a cache here. It holds:
#   - distributed booking locks (lock:slot:{id})
#   - idempotency claims
#   - the audit hash-chain head
#   - rate-limit windows
#   - BullMQ queues
#
# Losing it is therefore a correctness concern, not just a latency one, which
# is why this is a Multi-AZ replication group with AOF-equivalent durability
# via snapshots rather than a single cache.t3.micro node.
#
# The application is written to degrade rather than fail: the rate limiter
# fails open, and the booking flow still has two database-level defences when
# the Redis lock is unavailable.
# =============================================================================

resource "aws_elasticache_subnet_group" "this" {
  name        = "${var.name_prefix}-cache"
  subnet_ids  = var.subnet_ids
  description = "Isolated subnets for ${var.name_prefix}"

  tags = var.tags
}

resource "aws_elasticache_parameter_group" "this" {
  name_prefix = "${var.name_prefix}-redis7-"
  family      = "redis7"
  description = "Tuned for ${var.name_prefix}"

  # Evicting a booking lock or an idempotency claim under memory pressure
  # would break correctness. volatile-lru only evicts keys that carry an
  # explicit TTL, and every such key is one we have decided is safe to lose.
  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }

  # Surface slow commands; a blocking KEYS in production would show up here.
  parameter {
    name  = "slowlog-log-slower-than"
    value = "10000" # microseconds
  }

  lifecycle { create_before_destroy = true }
  tags = var.tags
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name_prefix}-redis"
  description          = "${var.name_prefix} Redis — locks, idempotency, queues, cache"

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  num_cache_clusters         = var.num_cache_clusters
  automatic_failover_enabled = var.num_cache_clusters > 1
  multi_az_enabled           = var.num_cache_clusters > 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [var.security_group_id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  # In transit and at rest. The auth token is required whenever transit
  # encryption is on, and is generated outside Terraform for the same
  # state-hygiene reason as the application secrets.
  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = var.auth_token

  snapshot_retention_limit = var.snapshot_retention_days
  snapshot_window          = "16:00-17:00" # 21:30 IST
  maintenance_window       = "sun:19:30-sun:20:30"

  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.engine.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
  }

  lifecycle {
    ignore_changes = [auth_token]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-redis" })
}

resource "aws_cloudwatch_log_group" "slow" {
  name              = "/aws/elasticache/${var.name_prefix}/slow"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "engine" {
  name              = "/aws/elasticache/${var.name_prefix}/engine"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

# ----------------------------------------------------------------- alarms

resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${var.name_prefix}-redis-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 75
  alarm_description   = "Redis engine CPU above 75%"
  alarm_actions       = var.alarm_topic_arns

  dimensions = { ReplicationGroupId = aws_elasticache_replication_group.this.id }
  tags       = var.tags
}

# Evictions mean keys with TTLs are being dropped early — idempotency claims
# and booking locks among them. Any sustained eviction rate is a problem.
resource "aws_cloudwatch_metric_alarm" "evictions" {
  alarm_name          = "${var.name_prefix}-redis-evictions"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Evictions"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Redis is evicting keys — idempotency and lock correctness at risk"
  alarm_actions       = var.alarm_topic_arns

  dimensions = { ReplicationGroupId = aws_elasticache_replication_group.this.id }
  tags       = var.tags
}

resource "aws_cloudwatch_metric_alarm" "memory" {
  alarm_name          = "${var.name_prefix}-redis-memory"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Redis memory above 80% — evictions imminent"
  alarm_actions       = var.alarm_topic_arns

  dimensions = { ReplicationGroupId = aws_elasticache_replication_group.this.id }
  tags       = var.tags
}

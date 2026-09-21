# =============================================================================
# Production stack — ap-south-1 (Mumbai).
#
# State lives in S3 with a DynamoDB lock table. Both must exist before the
# first `terraform init`; see infra/terraform/README.md for the bootstrap.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  backend "s3" {
    bucket         = "amrutam-tfstate-prod"
    key            = "telemedicine/prod/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "amrutam-tflock-prod"
    encrypt        = true
  }
}

module "stack" {
  source = "../../"

  project     = "amrutam"
  environment = "prod"
  region      = "ap-south-1"

  availability_zones = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
  vpc_cidr           = "10.20.0.0/16"
  single_nat_gateway = false # one NAT per AZ; egress survives an AZ loss

  # --- data tier ------------------------------------------------------------
  db_instance_class        = "db.r6g.xlarge"
  db_allocated_storage     = 500
  db_max_allocated_storage = 4000
  db_multi_az              = true
  db_replica_count         = 1
  db_backup_retention_days = 35 # RDS maximum

  redis_node_type               = "cache.r7g.large"
  redis_num_nodes               = 3
  redis_snapshot_retention_days = 14

  # --- compute --------------------------------------------------------------
  # Floor of 3 API tasks so losing an AZ leaves 2 serving; headroom to 30.
  api_min_capacity    = 3
  api_max_capacity    = 30
  api_cpu             = 1024
  api_memory          = 2048
  worker_min_capacity = 2
  worker_max_capacity = 20

  image = var.image

  # --- security -------------------------------------------------------------
  certificate_arn  = var.certificate_arn
  redis_auth_token = var.redis_auth_token
  enable_waf       = true
  waf_rate_limit   = 2000
  cors_origins     = ["https://app.amrutam.example", "https://doctor.amrutam.example"]
  swagger_enabled  = false # no public API docs in production
  enable_exec      = false # break-glass only; flip deliberately, never by default

  # --- operational ----------------------------------------------------------
  log_level           = "info"
  log_retention_days  = 365 # clinical audit trail
  deletion_protection = true
  apply_immediately   = false
  alarm_topic_arns    = [aws_sns_topic.alerts.arn]

  tags = {
    CostCentre = "clinical-platform"
    OnCall     = "platform-team"
  }
}

resource "aws_sns_topic" "alerts" {
  name              = "amrutam-prod-alerts"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "pagerduty" {
  count = var.pagerduty_endpoint != null ? 1 : 0

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "https"
  endpoint  = var.pagerduty_endpoint
}

provider "aws" {
  region = "ap-south-1"
}

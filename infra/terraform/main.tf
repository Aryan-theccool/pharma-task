# =============================================================================
# Amrutam Telemedicine — root module.
#
# Composes network -> security -> data stores -> compute. Called by the
# per-environment stacks in envs/dev and envs/prod, which supply a backend
# configuration and environment-specific sizing.
# =============================================================================

locals {
  name_prefix = "${var.project}-${var.environment}"

  tags = merge(
    {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = var.repository
      # Tag-based cost allocation and, more importantly, a machine-readable
      # marker for the data-classification audit.
      Compliance = "hipaa-aligned"
    },
    var.tags,
  )
}

# ---------------------------------------------------------------------- KMS

# First: everything else encrypts with these keys.
module "kms" {
  source = "./modules/kms"

  name_prefix     = local.name_prefix
  region          = var.region
  deletion_window = var.kms_deletion_window

  tags = local.tags
}

# ------------------------------------------------------------------ network

module "network" {
  source = "./modules/network"

  name_prefix             = local.name_prefix
  region                  = var.region
  vpc_cidr                = var.vpc_cidr
  availability_zones      = var.availability_zones
  single_nat_gateway      = var.single_nat_gateway
  flow_log_retention_days = var.log_retention_days
  kms_key_arn             = module.kms.data_key_arn

  tags = local.tags
}

# ----------------------------------------------------------------- security

module "security" {
  source = "./modules/security"

  name_prefix            = local.name_prefix
  vpc_id                 = module.network.vpc_id
  app_kms_key_arn        = module.kms.app_key_arn
  app_port               = var.app_port
  enable_waf             = var.enable_waf
  waf_rate_limit         = var.waf_rate_limit
  secret_recovery_window = var.secret_recovery_window

  tags = local.tags
}

# ---------------------------------------------------------------- data tier

module "database" {
  source = "./modules/database"

  name_prefix       = local.name_prefix
  subnet_ids        = module.network.isolated_subnet_ids
  security_group_id = module.security.database_security_group_id
  kms_key_arn       = module.kms.data_key_arn

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  multi_az              = var.db_multi_az
  replica_count         = var.db_replica_count
  backup_retention_days = var.db_backup_retention_days
  deletion_protection   = var.deletion_protection
  skip_final_snapshot   = !var.deletion_protection
  apply_immediately     = var.apply_immediately
  alarm_topic_arns      = var.alarm_topic_arns

  tags = local.tags
}

module "cache" {
  source = "./modules/cache"

  name_prefix       = local.name_prefix
  subnet_ids        = module.network.isolated_subnet_ids
  security_group_id = module.security.cache_security_group_id
  kms_key_arn       = module.kms.data_key_arn
  auth_token        = var.redis_auth_token

  node_type               = var.redis_node_type
  num_cache_clusters      = var.redis_num_nodes
  snapshot_retention_days = var.redis_snapshot_retention_days
  log_retention_days      = var.log_retention_days
  apply_immediately       = var.apply_immediately
  alarm_topic_arns        = var.alarm_topic_arns

  tags = local.tags
}

# -------------------------------------------------------------------- ECR

resource "aws_ecr_repository" "app" {
  name                 = local.name_prefix
  image_tag_mutability = "IMMUTABLE" # a tag can never be repointed at new bytes

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.kms.data_key_arn
  }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last 30 release images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "sha-"]
          countType     = "imageCountMoreThan"
          countNumber   = 30
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
    ]
  })
}

# --------------------------------------------------------------------- S3

# Prescription PDFs — PHI at rest outside the database.
resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "${local.name_prefix}-artifacts-"
  force_destroy = !var.deletion_protection

  tags = merge(local.tags, { DataClass = "phi" })
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = module.kms.data_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "clinical-retention"
    status = "Enabled"

    filter {}

    # Clinical records are retained for 7 years; move them to cheaper storage
    # as they age rather than deleting them.
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 365
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = 2557 # ~7 years
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# Reject any request that is not TLS — belt and braces alongside the bucket
# policy's default of private.
resource "aws_s3_bucket_policy" "artifacts_tls_only" {
  bucket = aws_s3_bucket.artifacts.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.artifacts.arn,
        "${aws_s3_bucket.artifacts.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

# ALB access logs. A separate bucket: access logs are operational data, not
# PHI, and the ALB service principal needs write access that must not extend
# to the prescription bucket.
resource "aws_s3_bucket" "access_logs" {
  bucket_prefix = "${local.name_prefix}-alb-logs-"
  force_destroy = !var.deletion_protection

  tags = merge(local.tags, { DataClass = "operational" })
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ALB log delivery does not support KMS, only SSE-S3.
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_log_retention_days
    }
  }
}

data "aws_elb_service_account" "current" {}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = data.aws_elb_service_account.current.arn }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.access_logs.arn}/*"
    }]
  })
}

# ------------------------------------------------------------------ compute

module "ecs" {
  source = "./modules/ecs"

  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  public_subnet_ids       = module.network.public_subnet_ids
  private_subnet_ids      = module.network.private_subnet_ids
  alb_security_group_id   = module.security.alb_security_group_id
  tasks_security_group_id = module.security.tasks_security_group_id

  image            = var.image != null ? var.image : "${aws_ecr_repository.app.repository_url}:latest"
  app_port         = var.app_port
  cpu_architecture = var.cpu_architecture

  api_cpu             = var.api_cpu
  api_memory          = var.api_memory
  api_min_capacity    = var.api_min_capacity
  api_max_capacity    = var.api_max_capacity
  worker_cpu          = var.worker_cpu
  worker_memory       = var.worker_memory
  worker_min_capacity = var.worker_min_capacity
  worker_max_capacity = var.worker_max_capacity

  database_host              = module.database.address
  database_port              = module.database.port
  database_name              = module.database.database_name
  database_master_secret_arn = module.database.master_user_secret_arn

  redis_host = module.cache.primary_endpoint
  redis_port = module.cache.port

  secret_arns          = module.security.secret_arns
  kms_key_arn          = module.kms.data_key_arn
  app_kms_key_arn      = module.kms.app_key_arn
  artifacts_bucket_arn = aws_s3_bucket.artifacts.arn
  certificate_arn      = var.certificate_arn
  waf_web_acl_arn      = module.security.waf_web_acl_arn
  access_logs_bucket   = aws_s3_bucket.access_logs.id

  log_level           = var.log_level
  log_retention_days  = var.log_retention_days
  swagger_enabled     = var.swagger_enabled
  cors_origins        = var.cors_origins
  enable_exec         = var.enable_exec
  deletion_protection = var.deletion_protection
  alarm_topic_arns    = var.alarm_topic_arns

  tags = local.tags
}

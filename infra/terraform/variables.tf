variable "project" {
  description = "Project slug used in every resource name."
  type        = string
  default     = "amrutam"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.project))
    error_message = "project must be lowercase alphanumeric with hyphens, 2-15 characters."
  }
}

variable "environment" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "region" {
  description = "AWS region. ap-south-1 (Mumbai) keeps patient data in-country and latency low for an India-first service."
  type        = string
  default     = "ap-south-1"
}

variable "repository" {
  description = "Source repository, recorded as a tag for provenance."
  type        = string
  default     = "Aryan-theccool/pharma-task"
}

# ------------------------------------------------------------------ network

variable "vpc_cidr" {
  description = "VPC CIDR."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones" {
  description = "AZs to deploy across."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
}

variable "single_nat_gateway" {
  description = "Share one NAT gateway across AZs. Dev only."
  type        = bool
  default     = false
}

# ----------------------------------------------------------------- database

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.r6g.xlarge"
}

variable "db_allocated_storage" {
  description = "Initial RDS storage in GiB."
  type        = number
  default     = 200
}

variable "db_max_allocated_storage" {
  description = "RDS storage autoscaling ceiling in GiB."
  type        = number
  default     = 2000
}

variable "db_multi_az" {
  description = "Synchronous standby in a second AZ."
  type        = bool
  default     = true
}

variable "db_replica_count" {
  description = "Analytics read replicas."
  type        = number
  default     = 1
}

variable "db_backup_retention_days" {
  description = "Automated backup retention in days."
  type        = number
  default     = 30
}

# -------------------------------------------------------------------- cache

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.r7g.large"
}

variable "redis_num_nodes" {
  description = "Nodes in the Redis replication group."
  type        = number
  default     = 2
}

variable "redis_snapshot_retention_days" {
  description = "Redis snapshot retention."
  type        = number
  default     = 7
}

variable "redis_auth_token" {
  description = "Redis AUTH token. Supply via TF_VAR_redis_auth_token from a secret store, never in a tfvars file."
  type        = string
  sensitive   = true
}

# ------------------------------------------------------------------ compute

variable "image" {
  description = "Container image to deploy. Null uses the ECR repo's :latest, which is only appropriate for a first bootstrap; CI supplies a digest afterwards."
  type        = string
  default     = null
}

variable "app_port" {
  description = "Container port."
  type        = number
  default     = 3000
}

variable "cpu_architecture" {
  description = "ARM64 or X86_64."
  type        = string
  default     = "ARM64"
}

variable "api_cpu" {
  description = "API task CPU units."
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "API task memory in MiB."
  type        = number
  default     = 2048
}

variable "api_min_capacity" {
  description = "Minimum API tasks."
  type        = number
  default     = 3
}

variable "api_max_capacity" {
  description = "Maximum API tasks."
  type        = number
  default     = 30
}

variable "worker_cpu" {
  description = "Worker task CPU units."
  type        = number
  default     = 1024
}

variable "worker_memory" {
  description = "Worker task memory in MiB."
  type        = number
  default     = 2048
}

variable "worker_min_capacity" {
  description = "Minimum worker tasks."
  type        = number
  default     = 2
}

variable "worker_max_capacity" {
  description = "Maximum worker tasks."
  type        = number
  default     = 20
}

# ----------------------------------------------------------------- security

variable "certificate_arn" {
  description = "ACM certificate ARN for the HTTPS listener."
  type        = string
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL to the ALB."
  type        = bool
  default     = true
}

variable "waf_rate_limit" {
  description = "WAF per-IP request ceiling over 5 minutes."
  type        = number
  default     = 2000
}

variable "kms_deletion_window" {
  description = "Days before a scheduled KMS key deletion completes. Deleting a key destroys every ciphertext it protects, so dev keeps the full window too."
  type        = number
  default     = 30
}

variable "secret_recovery_window" {
  description = "Days a deleted secret remains recoverable."
  type        = number
  default     = 30
}

variable "cors_origins" {
  description = "Allowed CORS origins."
  type        = list(string)
  default     = []
}

variable "enable_exec" {
  description = "Allow ECS exec into running tasks."
  type        = bool
  default     = false
}

variable "swagger_enabled" {
  description = "Expose the Swagger UI."
  type        = bool
  default     = false
}

# ------------------------------------------------------------- operational

variable "log_level" {
  description = "Application log level."
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 90
}

variable "access_log_retention_days" {
  description = "ALB access log retention in S3."
  type        = number
  default     = 90
}

variable "deletion_protection" {
  description = "Protect stateful resources from accidental destruction."
  type        = bool
  default     = true
}

variable "apply_immediately" {
  description = "Apply data-store changes immediately rather than in the maintenance window."
  type        = bool
  default     = false
}

variable "alarm_topic_arns" {
  description = "SNS topics notified by CloudWatch alarms."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags merged into the defaults."
  type        = map(string)
  default     = {}
}

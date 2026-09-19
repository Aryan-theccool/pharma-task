variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "vpc_id" {
  description = "VPC id for the target group."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnets for the Fargate tasks."
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "Security group for the ALB."
  type        = string
}

variable "tasks_security_group_id" {
  description = "Security group for the tasks."
  type        = string
}

variable "image" {
  description = "Fully qualified container image, digest-pinned in production."
  type        = string
}

variable "app_port" {
  description = "Port the container listens on."
  type        = number
  default     = 3000
}

variable "cpu_architecture" {
  description = "ARM64 (Graviton) is ~20% cheaper per vCPU; the image is built multi-arch."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

# ------------------------------------------------------------------ sizing

variable "api_cpu" {
  description = "API task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "API task memory in MiB."
  type        = number
  default     = 2048
}

variable "worker_cpu" {
  description = "Worker task CPU units."
  type        = number
  default     = 1024
}

variable "worker_memory" {
  description = "Worker task memory in MiB. PDF rendering is memory-hungry."
  type        = number
  default     = 2048
}

variable "api_min_capacity" {
  description = "Minimum API tasks. At least 3 for multi-AZ tolerance of a single-AZ loss."
  type        = number
  default     = 3

  validation {
    condition     = var.api_min_capacity >= 1
    error_message = "api_min_capacity must be at least 1."
  }
}

variable "api_max_capacity" {
  description = "Maximum API tasks."
  type        = number
  default     = 30
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

variable "worker_spot_weight" {
  description = "Relative weight of FARGATE_SPOT in worker capacity beyond the on-demand base."
  type        = number
  default     = 3
}

# ------------------------------------------------------------- autoscaling

variable "api_target_requests_per_task" {
  description = "Target ALB requests per task per minute. Derived from the load test: a task sustained ~1900 rps of reads, so this is a deliberately conservative fraction."
  type        = number
  default     = 12000
}

variable "worker_target_queue_depth" {
  description = "Target waiting jobs per worker task."
  type        = number
  default     = 100
}

# ------------------------------------------------------------ dependencies

variable "database_host" {
  description = "RDS endpoint hostname."
  type        = string
}

variable "database_port" {
  description = "RDS port."
  type        = number
  default     = 5432
}

variable "database_name" {
  description = "Database name."
  type        = string
}

variable "database_master_secret_arn" {
  description = "Secrets Manager ARN of the RDS-managed master credentials."
  type        = string
}

variable "redis_host" {
  description = "ElastiCache primary endpoint."
  type        = string
}

variable "redis_port" {
  description = "ElastiCache port."
  type        = number
  default     = 6379
}

variable "secret_arns" {
  description = "Map of logical secret name to ARN, injected as upper-snake-case env vars."
  type        = map(string)
}

variable "kms_key_arn" {
  description = "Data KMS key, used for log groups and ECS exec."
  type        = string
}

variable "app_kms_key_arn" {
  description = "Application KMS key the task role may use for envelope encryption."
  type        = string
}

variable "artifacts_bucket_arn" {
  description = "S3 bucket ARN for prescription PDFs."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener."
  type        = string
}

variable "waf_web_acl_arn" {
  description = "WAFv2 web ACL to associate with the ALB. Null to skip."
  type        = string
  default     = null
}

variable "access_logs_bucket" {
  description = "S3 bucket for ALB access logs. Null disables them."
  type        = string
  default     = null
}

variable "otlp_endpoint" {
  description = "OTLP collector endpoint for traces."
  type        = string
  default     = "http://localhost:4318"
}

# ----------------------------------------------------------------- toggles

variable "log_level" {
  description = "Pino log level."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace"], var.log_level)
    error_message = "log_level must be one of fatal, error, warn, info, debug, trace."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 90
}

variable "swagger_enabled" {
  description = "Expose /docs. Disabled in production to reduce attack surface."
  type        = bool
  default     = false
}

variable "cors_origins" {
  description = "Allowed CORS origins. Never '*' in production."
  type        = list(string)
  default     = []
}

variable "enable_exec" {
  description = "Allow `aws ecs execute-command` into running tasks. Audited via CloudTrail; disable in production unless break-glass is needed."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect the ALB from deletion."
  type        = bool
  default     = true
}

variable "alarm_5xx_threshold" {
  description = "Target 5xx count per minute that triggers an alarm."
  type        = number
  default     = 10
}

variable "alarm_topic_arns" {
  description = "SNS topics notified by CloudWatch alarms."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

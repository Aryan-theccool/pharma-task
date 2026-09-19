variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "subnet_ids" {
  description = "Isolated subnet ids for the cache subnet group."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group allowing 6379 from the ECS tasks only."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for at-rest encryption and log groups."
  type        = string
}

variable "auth_token" {
  description = "Redis AUTH token. Required when transit encryption is enabled; generated out-of-band and ignored on subsequent applies."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.auth_token) >= 16
    error_message = "Redis AUTH token must be at least 16 characters."
  }
}

variable "engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

variable "node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.r7g.large"
}

variable "num_cache_clusters" {
  description = "Nodes in the replication group. More than one enables automatic failover and Multi-AZ."
  type        = number
  default     = 2

  validation {
    condition     = var.num_cache_clusters >= 1
    error_message = "At least one cache node is required."
  }
}

variable "snapshot_retention_days" {
  description = "Daily snapshot retention."
  type        = number
  default     = 7
}

variable "log_retention_days" {
  description = "CloudWatch retention for slow and engine logs."
  type        = number
  default     = 30
}

variable "apply_immediately" {
  description = "Apply changes immediately rather than in the maintenance window."
  type        = bool
  default     = false
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

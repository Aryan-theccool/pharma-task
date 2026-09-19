variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "subnet_ids" {
  description = "Isolated subnet ids for the DB subnet group."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group allowing 5432 from the ECS tasks only."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for storage, Performance Insights and the master-user secret."
  type        = string
}

variable "engine_version" {
  description = "PostgreSQL major.minor version."
  type        = string
  default     = "16.4"
}

variable "instance_class" {
  description = "RDS instance class for the primary."
  type        = string
  default     = "db.r6g.xlarge"
}

variable "replica_instance_class" {
  description = "Instance class for read replicas. Defaults to the primary's class."
  type        = string
  default     = null
}

variable "allocated_storage" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 200
}

variable "max_allocated_storage" {
  description = "Ceiling for storage autoscaling in GiB."
  type        = number
  default     = 2000
}

variable "database_name" {
  description = "Initial database name."
  type        = string
  default     = "amrutam"
}

variable "master_username" {
  description = "Master username. The password is generated and rotated by Secrets Manager."
  type        = string
  default     = "amrutam_admin"
}

variable "multi_az" {
  description = "Synchronous standby in a second AZ. Required for the 99.95% target."
  type        = bool
  default     = true
}

variable "replica_count" {
  description = "Number of analytics read replicas."
  type        = number
  default     = 1
}

variable "backup_retention_days" {
  description = "Automated backup retention. 35 is the RDS maximum."
  type        = number
  default     = 30

  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "Clinical data requires at least 7 days of point-in-time recovery."
  }
}

variable "deletion_protection" {
  description = "Block `terraform destroy` from removing the instance."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Never true in production."
  type        = bool
  default     = false
}

variable "performance_insights_retention" {
  description = "Performance Insights retention in days (7 is free tier, 731 is long-term)."
  type        = number
  default     = 31
}

variable "connection_alarm_threshold" {
  description = "DatabaseConnections value that triggers an alarm."
  type        = number
  default     = 400
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

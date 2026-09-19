variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "vpc_id" {
  description = "VPC the security groups belong to."
  type        = string
}

variable "app_port" {
  description = "Port the application container listens on."
  type        = number
  default     = 3000
}

variable "app_kms_key_arn" {
  description = "KMS key (from modules/kms) used to encrypt the application secrets."
  type        = string
}

variable "secret_recovery_window" {
  description = "Days a deleted secret stays recoverable. 0 deletes immediately (dev only)."
  type        = number
  default     = 30
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL to the ALB."
  type        = bool
  default     = true
}

variable "waf_rate_limit" {
  description = "WAF per-IP request ceiling over a 5-minute window."
  type        = number
  default     = 2000
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

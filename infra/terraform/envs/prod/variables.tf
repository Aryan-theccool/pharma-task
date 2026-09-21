variable "image" {
  description = "Digest-pinned container image supplied by CI, e.g. <acct>.dkr.ecr.ap-south-1.amazonaws.com/amrutam-prod@sha256:..."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the public hostname."
  type        = string
}

variable "redis_auth_token" {
  description = "Redis AUTH token. Supply as TF_VAR_redis_auth_token from the CI secret store."
  type        = string
  sensitive   = true
}

variable "pagerduty_endpoint" {
  description = "PagerDuty HTTPS integration URL subscribed to the alert topic."
  type        = string
  default     = null
  sensitive   = true
}

variable "image" {
  description = "Container image to deploy. Null falls back to the ECR repo's :latest."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the dev hostname."
  type        = string
}

variable "redis_auth_token" {
  description = "Redis AUTH token. Supply as TF_VAR_redis_auth_token."
  type        = string
  sensitive   = true
}

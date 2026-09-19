variable "name_prefix" {
  description = "Prefix applied to key aliases and names."
  type        = string
}

variable "region" {
  description = "AWS region, used in the CloudWatch Logs key grant."
  type        = string
}

variable "deletion_window" {
  description = "Days before a scheduled key deletion completes. Longer is safer: deleting a key destroys every ciphertext it protects."
  type        = number
  default     = 30

  validation {
    condition     = var.deletion_window >= 7 && var.deletion_window <= 30
    error_message = "KMS deletion window must be between 7 and 30 days."
  }
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

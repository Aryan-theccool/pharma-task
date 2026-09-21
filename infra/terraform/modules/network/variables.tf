variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "region" {
  description = "AWS region, used to build VPC endpoint service names."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for the VPC. Must be a /16 to leave room for three /20 tiers per AZ."
  type        = string

  validation {
    condition     = tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "vpc_cidr must be /16 or larger to fit the three-tier subnet layout."
  }
}

variable "availability_zones" {
  description = "AZs to spread subnets across. Three or more for the 99.95% availability target."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "At least two availability zones are required for a multi-AZ deployment."
  }
}

variable "single_nat_gateway" {
  description = "Use one shared NAT instead of one per AZ. Cheaper, but a single point of egress failure. Dev only."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "CloudWatch retention for VPC flow logs."
  type        = number
  default     = 90
}

variable "kms_key_arn" {
  description = "KMS key used to encrypt the flow log group."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

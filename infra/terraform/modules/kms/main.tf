# =============================================================================
# KMS — customer-managed keys.
#
# Split out of the security module because keys have no dependency on the VPC
# while the security groups do, and the network module needs a key for its
# flow-log group. Keeping keys in `security` would make network -> security ->
# network a cycle. Keys are also the longest-lived resource here: they outlive
# VPCs and clusters, so they deserve their own module and their own lifecycle.
#
# Two keys, because their blast radius differs:
#   data : RDS, ElastiCache, S3, CloudWatch log groups
#   app  : wraps the application's field-encryption master key
#
# The app key matters because the service encrypts PHI *inside* the database
# (src/common/crypto/field-encryption.service.ts). RDS storage encryption does
# not protect a row from anyone holding a valid database credential; field
# encryption does. Revoking the app key crypto-shreds every encrypted column
# without touching a single row, which is what makes GDPR erasure tractable
# against a 7-year clinical retention requirement.
# =============================================================================

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "data" {
  description             = "${var.name_prefix} data-at-rest (RDS, ElastiCache, S3, CloudWatch)"
  deletion_window_in_days = var.deletion_window
  enable_key_rotation     = true # annual, AWS-managed

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableIAMUserPermissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        # CloudWatch Logs encrypts log groups with this key and must be able
        # to describe it; scoped to this account's log service only.
        Sid       = "AllowCloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:*"
          }
        }
      },
    ]
  })

  tags = merge(var.tags, { Name = "${var.name_prefix}-data" })
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name_prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "app" {
  description             = "${var.name_prefix} application field-encryption master key"
  deletion_window_in_days = var.deletion_window
  enable_key_rotation     = true

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-app"
    DataClass = "phi"
    # AWS rotates the backing key annually. The application layers its own
    # key_version on top (see scripts/rotate-keys.ts) so historical
    # ciphertext stays decryptable across rotations.
    RotationPolicy = "annual-automatic-plus-manual-key-version-bump"
  })
}

resource "aws_kms_alias" "app" {
  name          = "alias/${var.name_prefix}-app"
  target_key_id = aws_kms_key.app.key_id
}

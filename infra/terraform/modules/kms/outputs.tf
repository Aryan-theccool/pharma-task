output "data_key_arn" {
  description = "KMS key for data at rest (RDS, ElastiCache, S3, log groups)."
  value       = aws_kms_key.data.arn
}

output "data_key_id" {
  description = "Key id of the data key."
  value       = aws_kms_key.data.key_id
}

output "app_key_arn" {
  description = "KMS key wrapping the application field-encryption master key."
  value       = aws_kms_key.app.arn
}

output "app_key_id" {
  description = "Key id of the application key."
  value       = aws_kms_key.app.key_id
}

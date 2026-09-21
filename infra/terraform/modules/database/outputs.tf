output "endpoint" {
  description = "Primary endpoint, host:port."
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "Primary hostname."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Primary port."
  value       = aws_db_instance.this.port
}

output "database_name" {
  description = "Initial database name."
  value       = aws_db_instance.this.db_name
}

output "master_user_secret_arn" {
  description = "Secrets Manager ARN holding the RDS-managed master credentials."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "replica_endpoints" {
  description = "Analytics read-replica endpoints."
  value       = aws_db_instance.replica[*].endpoint
}

output "identifier" {
  description = "Primary instance identifier."
  value       = aws_db_instance.this.identifier
}

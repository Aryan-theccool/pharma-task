output "alb_security_group_id" {
  description = "Security group for the public load balancer."
  value       = aws_security_group.alb.id
}

output "tasks_security_group_id" {
  description = "Security group for ECS tasks."
  value       = aws_security_group.tasks.id
}

output "database_security_group_id" {
  description = "Security group for RDS."
  value       = aws_security_group.database.id
}

output "cache_security_group_id" {
  description = "Security group for ElastiCache."
  value       = aws_security_group.cache.id
}

output "secret_arns" {
  description = "Map of logical secret name to Secrets Manager ARN."
  value       = { for k, v in aws_secretsmanager_secret.app : k => v.arn }
}

output "waf_web_acl_arn" {
  description = "WAFv2 web ACL ARN, or null when the WAF is disabled."
  value       = var.enable_waf ? aws_wafv2_web_acl.this[0].arn : null
}

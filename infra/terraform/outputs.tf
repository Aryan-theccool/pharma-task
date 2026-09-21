output "alb_dns_name" {
  description = "Public DNS name of the load balancer. Point a Route 53 alias at this."
  value       = module.ecs.alb_dns_name
}

output "alb_zone_id" {
  description = "Hosted zone id for the ALB alias record."
  value       = module.ecs.alb_zone_id
}

output "ecr_repository_url" {
  description = "ECR repository the CI pipeline pushes to."
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name, used by the deploy job."
  value       = module.ecs.cluster_name
}

output "api_service_name" {
  description = "API service name, used by `aws ecs update-service`."
  value       = module.ecs.api_service_name
}

output "worker_service_name" {
  description = "Worker service name."
  value       = module.ecs.worker_service_name
}

output "database_endpoint" {
  description = "RDS primary endpoint."
  value       = module.database.endpoint
}

output "database_replica_endpoints" {
  description = "Analytics read-replica endpoints."
  value       = module.database.replica_endpoints
}

output "redis_primary_endpoint" {
  description = "ElastiCache primary endpoint."
  value       = module.cache.primary_endpoint
}

output "artifacts_bucket" {
  description = "S3 bucket holding prescription PDFs."
  value       = aws_s3_bucket.artifacts.id
}

output "secret_arns" {
  description = "Application secret ARNs. Populate these out-of-band before the first deploy."
  value       = module.security.secret_arns
}

output "app_kms_key_arn" {
  description = "KMS key wrapping the field-encryption master key."
  value       = module.kms.app_key_arn
}

output "vpc_id" {
  description = "VPC id."
  value       = module.network.vpc_id
}

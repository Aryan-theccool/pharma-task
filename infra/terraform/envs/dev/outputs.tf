output "alb_dns_name" {
  description = "Public load balancer DNS name."
  value       = module.stack.alb_dns_name
}

output "ecr_repository_url" {
  description = "ECR repository CI pushes images to."
  value       = module.stack.ecr_repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.stack.ecs_cluster_name
}

output "api_service_name" {
  description = "API service name."
  value       = module.stack.api_service_name
}

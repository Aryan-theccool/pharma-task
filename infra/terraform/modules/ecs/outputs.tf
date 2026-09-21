output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "api_service_name" {
  description = "API ECS service name, used by the deploy job."
  value       = aws_ecs_service.api.name
}

output "worker_service_name" {
  description = "Worker ECS service name."
  value       = aws_ecs_service.worker.name
}

output "alb_dns_name" {
  description = "Public DNS name of the load balancer."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone id of the ALB, for a Route 53 alias record."
  value       = aws_lb.this.zone_id
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix, for CloudWatch dimensions."
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn_suffix" {
  description = "Target group ARN suffix, for CloudWatch dimensions."
  value       = aws_lb_target_group.api.arn_suffix
}

output "task_role_arn" {
  description = "IAM role assumed by the application at runtime."
  value       = aws_iam_role.task.arn
}

output "execution_role_arn" {
  description = "IAM role ECS uses to pull images and read secrets."
  value       = aws_iam_role.execution.arn
}

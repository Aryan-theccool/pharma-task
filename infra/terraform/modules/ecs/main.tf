# =============================================================================
# ECS — Fargate cluster, ALB, api + worker services, autoscaling, IAM.
#
# Two services from one image, exactly as docker-compose.yml does locally:
#   api    — behind the ALB, autoscaled on request count and CPU
#   worker — no ingress, autoscaled on queue depth via a custom metric
#
# Splitting them matters: a burst of prescription-PDF rendering must not
# consume the CPU that serves p95-sensitive reads, and the worker must be able
# to scale to zero-ish overnight while the API keeps a warm floor.
# =============================================================================

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  api_name    = "${var.name_prefix}-api"
  worker_name = "${var.name_prefix}-worker"

  # Secrets injected by the agent at task start; never baked into the image
  # and never visible in `docker inspect`.
  app_secrets = [
    for key, arn in var.secret_arns : {
      name      = upper(replace(key, "-", "_"))
      valueFrom = arn
    }
  ]

  db_secrets = [
    {
      name      = "DATABASE_USER"
      valueFrom = "${var.database_master_secret_arn}:username::"
    },
    {
      name      = "DATABASE_PASSWORD"
      valueFrom = "${var.database_master_secret_arn}:password::"
    },
  ]

  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(var.app_port) },
    { name = "DATABASE_HOST", value = var.database_host },
    { name = "DATABASE_PORT", value = tostring(var.database_port) },
    { name = "DATABASE_NAME", value = var.database_name },
    { name = "DATABASE_SSL", value = "true" },
    { name = "REDIS_HOST", value = var.redis_host },
    { name = "REDIS_PORT", value = tostring(var.redis_port) },
    { name = "REDIS_TLS", value = "true" },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "OTEL_ENABLED", value = "true" },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otlp_endpoint },
    { name = "OTEL_SERVICE_NAME", value = var.name_prefix },
    { name = "SWAGGER_ENABLED", value = tostring(var.swagger_enabled) },
    { name = "CORS_ORIGINS", value = join(",", var.cors_origins) },
    # Must stay 1 outside load tests — see load/README.md.
    { name = "RATE_LIMIT_ROUTE_MULTIPLIER", value = "1" },
  ]
}

# ---------------------------------------------------------------- cluster

resource "aws_ecs_cluster" "this" {
  name = var.name_prefix

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }

  configuration {
    execute_command_configuration {
      kms_key_id = var.kms_key_arn
      logging    = "OVERRIDE"

      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.exec.name
      }
    }
  }

  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  # The API never runs on Spot: a reclaim mid-request costs availability
  # budget. Workers tolerate interruption because every job is idempotent and
  # BullMQ retries, so they take Spot for the cost saving.
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = var.api_min_capacity
  }
}

# ------------------------------------------------------------------- logs

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.api_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.worker_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "exec" {
  name              = "/ecs/${var.name_prefix}/exec"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

# -------------------------------------------------------------------- IAM

# Execution role: what ECS itself needs to *start* the task.
resource "aws_iam_role" "execution" {
  name_prefix = "${var.name_prefix}-exec-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Scoped to exactly the secrets this service uses — not secretsmanager:*.
resource "aws_iam_role_policy" "execution_secrets" {
  name_prefix = "${var.name_prefix}-secrets-"
  role        = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = concat(values(var.secret_arns), [var.database_master_secret_arn])
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.kms_key_arn, var.app_kms_key_arn]
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      },
    ]
  })
}

# Task role: what the *application* may call at runtime. Deliberately small.
resource "aws_iam_role" "task" {
  name_prefix = "${var.name_prefix}-task-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "task" {
  name_prefix = "${var.name_prefix}-task-"
  role        = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid    = "PrescriptionPdfStorage"
          Effect = "Allow"
          Action = [
            "s3:PutObject",
            "s3:GetObject",
            "s3:DeleteObject",
          ]
          Resource = "${var.artifacts_bucket_arn}/*"
        },
        {
          Sid      = "ListArtifactsBucket"
          Effect   = "Allow"
          Action   = ["s3:ListBucket"]
          Resource = var.artifacts_bucket_arn
        },
        {
          # Envelope encryption: the app asks KMS to unwrap its master key.
          Sid      = "FieldEncryptionKey"
          Effect   = "Allow"
          Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
          Resource = var.app_kms_key_arn
        },
        {
          Sid      = "EmitCustomMetrics"
          Effect   = "Allow"
          Action   = ["cloudwatch:PutMetricData"]
          Resource = "*"
          Condition = {
            StringEquals = { "cloudwatch:namespace" = var.name_prefix }
          }
        },
      ],
      var.enable_exec ? [{
        Sid    = "ECSExec"
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      }] : [],
    )
  })
}

# -------------------------------------------------------------------- ALB

resource "aws_lb" "this" {
  name_prefix        = substr(var.name_prefix, 0, 6)
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  enable_deletion_protection = var.deletion_protection
  enable_http2               = true
  drop_invalid_header_fields = true

  # Must exceed the application's own keep-alive timeout, otherwise the ALB
  # can forward onto a connection the task is already closing -> sporadic 502s.
  idle_timeout = 65

  access_logs {
    bucket  = var.access_logs_bucket
    prefix  = var.name_prefix
    enabled = var.access_logs_bucket != null
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-alb" })
}

resource "aws_lb_target_group" "api" {
  name_prefix = substr(var.name_prefix, 0, 6)
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  # Give in-flight requests time to finish before the target is removed.
  # Must be >= the container's SIGTERM grace period.
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/readyz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # /readyz checks Postgres and Redis, so a task that has lost its
  # dependencies is pulled from rotation rather than serving 500s.

  stickiness {
    type    = "lb_cookie"
    enabled = false # stateless API; sticky sessions would defeat even balancing
  }

  lifecycle { create_before_destroy = true }
  tags = merge(var.tags, { Name = "${var.name_prefix}-api" })
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 minimum; the -Res- suffix restricts to forward-secret suites.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  tags = var.tags
}

resource "aws_wafv2_web_acl_association" "this" {
  count = var.waf_web_acl_arn != null ? 1 : 0

  resource_arn = aws_lb.this.arn
  web_acl_arn  = var.waf_web_acl_arn
}

# ------------------------------------------------------- task definitions

resource "aws_ecs_task_definition" "api" {
  family                   = local.api_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.image
      essential = true

      portMappings = [{
        containerPort = var.app_port
        protocol      = "tcp"
        name          = "http"
      }]

      environment = concat(local.common_environment, [
        { name = "SERVICE_ROLE", value = "api" },
      ])

      secrets = concat(local.app_secrets, local.db_secrets)

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "api"
          # Structured Pino output; the JSON parser makes fields queryable
          # in CloudWatch Logs Insights without a regex.
          "mode"                  = "non-blocking"
          "max-buffer-size"       = "4m"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${var.app_port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }

      # Defence in depth: even with a container escape, the filesystem is
      # read-only except for the tmpfs mounts declared below.
      readonlyRootFilesystem = true

      mountPoints = [
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
        { sourceVolume = "storage", containerPath = "/app/storage", readOnly = false },
      ]

      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }

      ulimits = [{
        name      = "nofile"
        softLimit = 65536
        hardLimit = 65536
      }]

      stopTimeout = 30
    }
  ])

  volume {
    name = "tmp"
  }

  volume {
    name = "storage"
  }

  tags = merge(var.tags, { Name = local.api_name })
}

resource "aws_ecs_task_definition" "worker" {
  family                   = local.worker_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.image
      essential = true
      command   = ["node", "dist/src/worker.js"]

      environment = concat(local.common_environment, [
        { name = "SERVICE_ROLE", value = "worker" },
      ])

      secrets = concat(local.app_secrets, local.db_secrets)

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "worker"
          "mode"                  = "non-blocking"
          "max-buffer-size"       = "4m"
        }
      }

      readonlyRootFilesystem = true

      mountPoints = [
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
        { sourceVolume = "storage", containerPath = "/app/storage", readOnly = false },
      ]

      linuxParameters = {
        initProcessEnabled = true
        capabilities = { drop = ["ALL"] }
      }

      # Long stop timeout so an in-flight PDF render or outbox drain can
      # finish rather than being killed and retried.
      stopTimeout = 60
    }
  ])

  volume {
    name = "tmp"
  }

  volume {
    name = "storage"
  }

  tags = merge(var.tags, { Name = local.worker_name })
}

# ---------------------------------------------------------------- services

resource "aws_ecs_service" "api" {
  name            = local.api_name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_min_capacity
  propagate_tags  = "SERVICE"

  launch_type            = "FARGATE"
  platform_version       = "1.4.0"
  enable_execute_command = var.enable_exec

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tasks_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.app_port
  }

  # Rolling deploy with a circuit breaker: a bad image rolls itself back
  # instead of draining the healthy fleet.
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_controller {
    type = "ECS"
  }

  # Do not count a task healthy until the ALB agrees.
  health_check_grace_period_seconds = 60

  # Spread across AZs first, then pack by memory, so losing an AZ costs at
  # most 1/N of capacity.
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  lifecycle {
    # Autoscaling owns desired_count after the first apply.
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]

  tags = merge(var.tags, { Name = local.api_name })
}

resource "aws_ecs_service" "worker" {
  name            = local.worker_name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_min_capacity
  propagate_tags  = "SERVICE"

  enable_execute_command = var.enable_exec
  platform_version       = "1.4.0"

  # Spot for the bulk of worker capacity: jobs are idempotent and retried,
  # so an interruption costs latency rather than correctness.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = var.worker_spot_weight
    base              = 0
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tasks_security_group_id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = merge(var.tags, { Name = local.worker_name })
}

# ------------------------------------------------------------- autoscaling

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_capacity
  max_capacity       = var.api_max_capacity

  tags = var.tags
}

# Request-count scaling reacts to the thing that actually causes latency.
# CPU-based scaling lags on an I/O-bound Node service, because the process is
# waiting on Postgres rather than burning CPU.
resource "aws_appautoscaling_policy" "api_requests" {
  name               = "${local.api_name}-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.api_target_requests_per_task

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
    }

    scale_in_cooldown  = 300 # slow to shrink — avoid flapping on a traffic dip
    scale_out_cooldown = 60  # fast to grow — latency budget is unforgiving
  }
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.api_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = 65

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_min_capacity
  max_capacity       = var.worker_max_capacity

  tags = var.tags
}

# Workers scale on queue backlog, published by the app as a custom metric.
# CPU would be the wrong signal: a worker blocked on a slow PDF render is
# idle on CPU while the backlog grows.
resource "aws_appautoscaling_policy" "worker_queue_depth" {
  name               = "${local.worker_name}-queue-depth"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.worker_target_queue_depth

    customized_metric_specification {
      metric_name = "QueueDepthPerTask"
      namespace   = var.name_prefix
      statistic   = "Average"

      dimensions {
        name  = "Service"
        value = local.worker_name
      }
    }

    scale_in_cooldown  = 600
    scale_out_cooldown = 60
  }
}

# ----------------------------------------------------------------- alarms

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name_prefix}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = var.alarm_5xx_threshold
  alarm_description   = "Target 5xx responses — burning the availability error budget"
  alarm_actions       = var.alarm_topic_arns
  treat_missing_data  = "notBreaching"

  dimensions = { LoadBalancer = aws_lb.this.arn_suffix }
  tags       = var.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${var.name_prefix}-alb-p95-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  extended_statistic  = "p95"
  threshold           = 0.5
  alarm_description   = "p95 latency above the 500ms write SLO at the load balancer"
  alarm_actions       = var.alarm_topic_arns
  treat_missing_data  = "notBreaching"

  dimensions = { LoadBalancer = aws_lb.this.arn_suffix }
  tags       = var.tags
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.name_prefix}-unhealthy-targets"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Average"
  threshold           = 0
  alarm_description   = "At least one API task is failing its readiness check"
  alarm_actions       = var.alarm_topic_arns

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  tags = var.tags
}

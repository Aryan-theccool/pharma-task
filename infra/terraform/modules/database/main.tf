# =============================================================================
# Database — RDS PostgreSQL 16, Multi-AZ, in the isolated subnet tier.
#
# Availability maths for the 99.95% target (21.9 min/month of budget):
# a Multi-AZ failover is 60-120s, so a single unplanned failover consumes
# ~10% of the monthly budget. That is affordable; a single-AZ instance
# restoring from a snapshot (tens of minutes) is not.
# =============================================================================

resource "aws_db_subnet_group" "this" {
  name_prefix = "${var.name_prefix}-"
  subnet_ids  = var.subnet_ids
  description = "Isolated subnets for ${var.name_prefix}"

  lifecycle { create_before_destroy = true }
  tags = merge(var.tags, { Name = "${var.name_prefix}-db" })
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name_prefix}-pg16-"
  family      = "postgres16"
  description = "Tuned for ${var.name_prefix}"

  # --- Correctness / durability -------------------------------------------

  # The booking flow relies on SELECT ... FOR UPDATE NOWAIT and a GiST
  # exclusion constraint. NOWAIT returns 55P03 immediately, so a long
  # lock_timeout would not help, but a runaway statement still must not pin
  # a connection forever.
  parameter {
    name  = "statement_timeout"
    value = "30000" # 30s
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000" # 60s — a forgotten open transaction blocks vacuum
  }

  parameter {
    name  = "lock_timeout"
    value = "10000"
  }

  # --- Observability -------------------------------------------------------

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log anything over 1s
  }

  # Connection lifecycle logging feeds the audit trail.
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # Never log statement text: parameters routinely contain PHI.
  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "pg_stat_statements.track"
    value = "all"
  }

  # --- Security ------------------------------------------------------------

  # Reject any client that will not speak TLS.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle { create_before_destroy = true }
  tags = var.tags
}

# Master credentials are generated and rotated by Secrets Manager, so no
# password is ever passed through Terraform or stored in state.
resource "aws_db_instance" "this" {
  identifier_prefix = "${var.name_prefix}-"

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = var.database_name
  username = var.master_username

  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name
  port                   = 5432
  publicly_accessible    = false

  multi_az = var.multi_az

  backup_retention_period = var.backup_retention_days
  backup_window           = "17:00-18:00" # 22:30 IST — off-peak for an India-first service
  maintenance_window      = "sun:18:30-sun:19:30"
  copy_tags_to_snapshot   = true
  delete_automated_backups = false

  # Point-in-time recovery to any second within the retention window is what
  # makes the hash-chained audit log restorable to a known-good state.
  deletion_protection      = var.deletion_protection
  skip_final_snapshot      = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name_prefix}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = var.performance_insights_retention

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  monitoring_interval = 30
  monitoring_role_arn = aws_iam_role.monitoring.arn

  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately

  lifecycle {
    ignore_changes = [
      # A timestamp() in the snapshot name would otherwise force replacement
      # on every plan.
      final_snapshot_identifier,
    ]
  }

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-postgres"
    DataClass = "phi"
  })
}

# Read replica for analytics. Admin dashboards aggregate over the whole
# consultations table; running that on the primary would contend with the
# booking path's row locks.
resource "aws_db_instance" "replica" {
  count = var.replica_count

  identifier_prefix   = "${var.name_prefix}-ro-${count.index}-"
  replicate_source_db = aws_db_instance.this.identifier
  instance_class      = var.replica_instance_class != null ? var.replica_instance_class : var.instance_class

  storage_encrypted   = true
  kms_key_id          = var.kms_key_arn
  publicly_accessible = false

  vpc_security_group_ids = [var.security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name

  performance_insights_enabled    = true
  performance_insights_kms_key_id = var.kms_key_arn
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.monitoring.arn

  skip_final_snapshot = true
  apply_immediately   = var.apply_immediately

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-postgres-ro-${count.index}"
    Role      = "analytics-replica"
    DataClass = "phi"
  })
}

resource "aws_iam_role" "monitoring" {
  name_prefix = "${var.name_prefix}-rds-mon-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ----------------------------------------------------------------- alarms

resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${var.name_prefix}-rds-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS CPU above 80% for 15 minutes"
  alarm_actions       = var.alarm_topic_arns
  ok_actions          = var.alarm_topic_arns

  dimensions = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  tags       = var.tags
}

resource "aws_cloudwatch_metric_alarm" "storage" {
  alarm_name          = "${var.name_prefix}-rds-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 10737418240 # 10 GiB
  alarm_description   = "RDS free storage below 10 GiB"
  alarm_actions       = var.alarm_topic_arns

  dimensions = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  tags       = var.tags
}

# Connection exhaustion shows up in the app as db_pool_waiting > 0; catching
# it at the RDS layer too means we see it even if the app cannot report.
resource "aws_cloudwatch_metric_alarm" "connections" {
  alarm_name          = "${var.name_prefix}-rds-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.connection_alarm_threshold
  alarm_description   = "RDS connection count approaching max_connections"
  alarm_actions       = var.alarm_topic_arns

  dimensions = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  tags       = var.tags
}

resource "aws_cloudwatch_metric_alarm" "replica_lag" {
  count = var.replica_count > 0 ? 1 : 0

  alarm_name          = "${var.name_prefix}-rds-replica-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ReplicaLag"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 30
  alarm_description   = "Analytics replica lagging more than 30s"
  alarm_actions       = var.alarm_topic_arns

  dimensions = { DBInstanceIdentifier = aws_db_instance.replica[0].identifier }
  tags       = var.tags
}

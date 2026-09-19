# =============================================================================
# Dev stack — same topology as production, deliberately smaller and cheaper.
#
# The point of keeping the module identical is that a change is exercised
# against the real shape of production before it gets there. What differs is
# only sizing, retention and the guard rails that would make iteration painful.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  backend "s3" {
    bucket         = "amrutam-tfstate-dev"
    key            = "telemedicine/dev/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "amrutam-tflock-dev"
    encrypt        = true
  }
}

module "stack" {
  source = "../../"

  project     = "amrutam"
  environment = "dev"
  region      = "ap-south-1"

  # Two AZs is enough to prove the multi-AZ code paths without a third NAT.
  availability_zones = ["ap-south-1a", "ap-south-1b"]
  vpc_cidr           = "10.30.0.0/16"
  single_nat_gateway = true # ~$32/month saved; acceptable SPOF in dev

  # --- data tier ------------------------------------------------------------
  db_instance_class        = "db.t4g.medium"
  db_allocated_storage     = 20
  db_max_allocated_storage = 100
  db_multi_az              = false
  db_replica_count         = 0
  db_backup_retention_days = 7

  redis_node_type               = "cache.t4g.micro"
  redis_num_nodes               = 1 # no automatic failover
  redis_snapshot_retention_days = 1

  # --- compute --------------------------------------------------------------
  api_min_capacity    = 1
  api_max_capacity    = 4
  api_cpu             = 512
  api_memory          = 1024
  worker_min_capacity = 1
  worker_max_capacity = 2
  worker_cpu          = 512
  worker_memory       = 1024

  image = var.image

  # --- security -------------------------------------------------------------
  certificate_arn        = var.certificate_arn
  redis_auth_token       = var.redis_auth_token
  enable_waf             = false # skip the ~$10/month fixed cost in dev
  cors_origins           = ["http://localhost:5173", "https://dev.amrutam.example"]
  swagger_enabled        = true  # /docs is useful here
  enable_exec            = true  # shell into tasks while iterating
  secret_recovery_window = 0     # delete secrets immediately, no 30-day wait

  # --- operational ----------------------------------------------------------
  log_level           = "debug"
  log_retention_days  = 14
  deletion_protection = false # `terraform destroy` must actually work
  apply_immediately   = true

  tags = {
    CostCentre = "engineering"
    AutoStop   = "nightly"
  }
}

provider "aws" {
  region = "ap-south-1"
}

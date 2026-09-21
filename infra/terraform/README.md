# Infrastructure

Terraform for the Amrutam telemedicine backend on AWS: ECS Fargate, RDS
PostgreSQL, ElastiCache Redis, ALB, WAF and the supporting IAM/KMS.

```
infra/terraform/
├── main.tf              root module — composes everything, owns ECR and S3
├── variables.tf         root inputs
├── outputs.tf           root outputs
├── versions.tf          provider pins
├── modules/
│   ├── kms/             customer-managed keys (data + application)
│   ├── network/         VPC, three subnet tiers, NAT, VPC endpoints, flow logs
│   ├── security/        secrets, security groups, WAFv2
│   ├── database/        RDS PostgreSQL 16, Multi-AZ, replica, alarms
│   ├── cache/           ElastiCache Redis replication group, alarms
│   └── ecs/             cluster, ALB, api + worker services, autoscaling, IAM
└── envs/
    ├── dev/             small, cheap, destroyable
    └── prod/            Multi-AZ, WAF on, deletion protection on
```

Module dependency order is a strict DAG:

```
kms → network → security → {database, cache} → ecs
```

`kms` is separate rather than part of `security` specifically to keep that a
DAG: the network module needs a key to encrypt its flow-log group, and the
security module needs the network's VPC id for its security groups. Keys in
`security` would make `network → security → network`.

## Design decisions worth knowing

**Three subnet tiers, not two.** Public holds only the ALB and NAT gateways.
Private holds the Fargate tasks. Isolated holds RDS and ElastiCache and has
**no route to a NAT at all** — so a fully compromised application container
still has no network path to exfiltrate a database dump to an external host.

**Two KMS keys.** `data` encrypts storage (RDS, ElastiCache, S3, logs). `app`
wraps the field-encryption master key the application uses to encrypt PHI
*inside* the database. RDS storage encryption is transparent to anyone holding
a valid database credential; field encryption is not. Separating them also
means revoking the app key crypto-shreds encrypted columns without touching
the backups that clinical retention requires.

**Terraform never holds a secret value.** `aws_secretsmanager_secret_version`
is created with a placeholder and `ignore_changes = [secret_string]`; real
values are written out-of-band. RDS master credentials use
`manage_master_user_password`, so the password is generated and rotated by
Secrets Manager and never enters state. This matters because Terraform state
stores values in plaintext — without it, `terraform state pull` is a
credential dump.

**Security groups reference each other, never CIDRs.** The database accepts
5432 only from the tasks' security group, and has *no egress rule at all*.
The tasks accept the app port only from the ALB's security group.

**Fargate Spot for workers, never for the API.** Jobs are idempotent and
retried by BullMQ, so a Spot reclaim costs latency. An API task reclaimed
mid-request costs availability budget.

**API autoscales on request count, not CPU.** The service is I/O-bound —
under load it is waiting on Postgres, not burning CPU — so CPU-based scaling
lags the latency it is supposed to prevent. `ALBRequestCountPerTarget` leads
it. CPU remains as a secondary policy for the compute-heavy paths (scrypt
password hashing, AES-GCM field decryption). Workers scale on **queue depth**
for the same reason: a worker blocked on a slow PDF render is idle on CPU
while the backlog grows.

**Scale-out is fast (60s cooldown), scale-in is slow (300s).** Latency budget
is unforgiving; a traffic dip is not worth flapping over.

**Deployment circuit breaker with rollback.** A bad image rolls itself back
rather than draining the healthy fleet. `deployment_minimum_healthy_percent =
100` with `maximum_percent = 200` means new tasks come up before old ones go
down — no capacity dip mid-deploy.

**ECR is `IMMUTABLE`.** A tag can never be repointed at different bytes, so
the image that passed CI is provably the image that runs.

**Read-only root filesystem, all capabilities dropped**, `/tmp` and
`/app/storage` as the only writable mounts.

## SLO mapping

| Requirement           | How it is met                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------- |
| 99.95% availability   | 3 AZs, Multi-AZ RDS, Redis with automatic failover, min 3 API tasks, circuit-breaker deploys  |
| p95 < 200ms reads     | Redis cache-aside, analytics on a read replica, request-count autoscaling                     |
| p95 < 500ms writes    | Connection pooling, isolated write path, no cross-AZ hop between task and primary             |
| 100k consultations/day| Measured headroom in [`load/README.md`](../../load/README.md); autoscale to 30 tasks          |
| Encryption            | KMS at rest, TLS 1.3 in transit, `rds.force_ssl`, application field encryption for PHI        |
| Audit                 | VPC flow logs, ALB access logs, CloudTrail, `log_connections`, app-level hash-chained log     |

## Bootstrap

State lives in S3 with a DynamoDB lock table. Both must exist before the first
`init` — a chicken-and-egg Terraform cannot solve for its own backend:

```bash
aws s3api create-bucket \
  --bucket amrutam-tfstate-prod \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

aws s3api put-bucket-versioning \
  --bucket amrutam-tfstate-prod \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket amrutam-tfstate-prod \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block \
  --bucket amrutam-tfstate-prod \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'

aws dynamodb create-table \
  --table-name amrutam-tflock-prod \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-south-1
```

## Deploying

```bash
cd envs/dev

export TF_VAR_redis_auth_token="$(openssl rand -base64 32)"
export TF_VAR_certificate_arn="arn:aws:acm:ap-south-1:123456789012:certificate/..."

terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

### Populate the secrets before the first deploy

Terraform creates the secret *containers* with placeholder values. Tasks will
start and immediately fail their readiness check until real values are set:

```bash
for name in jwt-access-secret jwt-refresh-secret encryption-master-key \
            email-hmac-key prescription-signing-key webhook-signing-secret; do
  aws secretsmanager put-secret-value \
    --secret-id "amrutam-prod/$name" \
    --secret-string "$(openssl rand -hex 32)"
done
```

### Database migrations

Migrations are **not** run by Terraform. They run as a one-off ECS task in the
CD pipeline, before the service update, so a schema change lands before the
code that depends on it:

```bash
aws ecs run-task \
  --cluster amrutam-prod \
  --task-definition amrutam-prod-api \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-...],securityGroups=[sg-...]}" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/scripts/migrate.js"]}]}'
```

All migrations are additive and backwards-compatible by convention, so the
previous image keeps working during a rolling deploy.

## Validating changes

Terraform is not installed in this workspace (the HashiCorp release CDN is
unreachable from the build sandbox), so the configuration here has been
validated by parsing every file with `python-hcl2` and checking, mechanically:

- all 28 files parse (102 resources, 49 types)
- every `module.X.output` reference resolves to a declared output
- every required module input is supplied at its call site, with no unknown inputs
- the module graph is acyclic
- no declared variable is unused

Run the real thing in CI or locally before applying:

```bash
terraform fmt -recursive -check
terraform init -backend=false
terraform validate
tflint --recursive
tfsec .            # or: trivy config .
```

## Cost sketch (ap-south-1, prod, monthly)

| Item                                    | Approx USD |
| --------------------------------------- | ---------: |
| RDS db.r6g.xlarge Multi-AZ + 500GB gp3  |       ~610 |
| RDS read replica (single-AZ)            |       ~230 |
| ElastiCache 3 × cache.r7g.large         |       ~330 |
| Fargate 3 × (1 vCPU, 2GB) API baseline  |       ~105 |
| Fargate workers (mostly Spot)           |        ~35 |
| ALB + 3 NAT gateways                    |       ~135 |
| WAF + CloudWatch + S3 + KMS             |        ~90 |
| **Total baseline**                      | **~1,535** |

Scaling to the 30-task ceiling adds roughly $950/month of Fargate at full
stretch. The single largest saving available is Graviton — already the default
via `cpu_architecture = "ARM64"`.

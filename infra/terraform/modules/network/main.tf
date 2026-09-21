# =============================================================================
# Network — three-tier VPC across N availability zones.
#
#   public   : ALB and NAT gateways only
#   private  : ECS tasks; egress via NAT, no inbound from the internet
#   isolated : RDS and ElastiCache; no route to a NAT at all
#
# The isolated tier is the important one. Even if an application container is
# fully compromised, the database subnets have no path off the VPC, so an
# attacker cannot exfiltrate a dump to an external host over the network.
# =============================================================================

locals {
  az_count = length(var.availability_zones)

  # /16 VPC carved into /20s: 16 subnets per tier, room to grow.
  public_cidrs   = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_cidrs  = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 4)]
  isolated_cidrs = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = "${var.name_prefix}-vpc" })
}

# ------------------------------------------------------------------ public

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  # Tasks get their address from the private tier; nothing here should be
  # public by default just because it landed in a public subnet.
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-public-${var.availability_zones[count.index]}"
    Tier = "public"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ----------------------------------------------------------------- private

# One NAT per AZ in production so a single AZ failure cannot cut egress for
# the whole fleet. Dev collapses to one NAT to save ~$32/month per gateway.
resource "aws_eip" "nat" {
  count      = var.single_nat_gateway ? 1 : local.az_count
  domain     = "vpc"
  tags       = merge(var.tags, { Name = "${var.name_prefix}-nat-${count.index}" })
  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = var.single_nat_gateway ? 1 : local.az_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags       = merge(var.tags, { Name = "${var.name_prefix}-nat-${count.index}" })
  depends_on = [aws_internet_gateway.this]
}

resource "aws_subnet" "private" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-private-${var.availability_zones[count.index]}"
    Tier = "private"
  })
}

resource "aws_route_table" "private" {
  count  = local.az_count
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-private-${var.availability_zones[count.index]}"
  })
}

resource "aws_route" "private_nat" {
  count = local.az_count

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = var.single_nat_gateway ? aws_nat_gateway.this[0].id : aws_nat_gateway.this[count.index].id
}

resource "aws_route_table_association" "private" {
  count          = local.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ---------------------------------------------------------------- isolated

resource "aws_subnet" "isolated" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.isolated_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-isolated-${var.availability_zones[count.index]}"
    Tier = "isolated"
  })
}

# Deliberately no 0.0.0.0/0 route. Data subnets reach AWS services through
# VPC endpoints below, and nothing else.
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-isolated" })
}

resource "aws_route_table_association" "isolated" {
  count          = local.az_count
  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

# ------------------------------------------------------------- VPC endpoints

# Gateway endpoint for S3: free, and keeps prescription-PDF traffic off the NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    aws_route_table.private[*].id,
    [aws_route_table.isolated.id],
  )

  tags = merge(var.tags, { Name = "${var.name_prefix}-s3" })
}

resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name_prefix}-vpce-"
  description = "Interface VPC endpoints"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from inside the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-vpce" })
}

# Interface endpoints so tasks can pull images, read secrets and ship logs
# without egressing to the public internet through the NAT.
resource "aws_vpc_endpoint" "interface" {
  for_each = toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
    "kms",
    "ssm",
  ])

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.value}" })
}

# ----------------------------------------------------------------- flow logs

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/vpc/${var.name_prefix}"
  retention_in_days = var.flow_log_retention_days
  kms_key_id        = var.kms_key_arn

  tags = var.tags
}

resource "aws_iam_role" "flow_logs" {
  name_prefix = "${var.name_prefix}-flow-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  name_prefix = "${var.name_prefix}-flow-"
  role        = aws_iam_role.flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}

# Required for HIPAA-aligned audit: who talked to whom, at the network layer.
resource "aws_flow_log" "this" {
  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  iam_role_arn         = aws_iam_role.flow_logs.arn
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  log_destination_type = "cloud-watch-logs"
  max_aggregation_interval = 60

  tags = merge(var.tags, { Name = "${var.name_prefix}-flow-logs" })
}

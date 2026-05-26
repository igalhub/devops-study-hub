---
title: HCL Fundamentals
module: terraform
duration_min: 20
difficulty: beginner
tags: [terraform, hcl, providers, resources, variables, outputs, plan, apply]
exercises: 4
---

## Overview
Terraform is the dominant Infrastructure as Code tool. You write HCL (HashiCorp Configuration Language) describing what infrastructure you want; Terraform figures out how to create it. Every major cloud provider, DNS registrar, database service, and monitoring platform has a Terraform provider. This lesson covers HCL syntax, the core workflow, and the building blocks of any Terraform configuration.

## Concepts

### Core Workflow
```bash
terraform init     # download providers and modules
terraform plan     # show what will be created/changed/destroyed
terraform apply    # apply the plan (prompts for confirmation)
terraform destroy  # destroy all managed resources (prompts)
```

Always review `plan` output before `apply`. Terraform shows additions (+), changes (~), and destructions (-).

### Providers
Providers are plugins that know how to talk to a specific API (AWS, GCP, Azure, Kubernetes, GitHub, etc.):

```hcl
terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"   # any 5.x version
    }
  }
}

provider "aws" {
  region = "us-east-1"
  # Credentials: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars, or ~/.aws/credentials
}
```

### Resources
Resources are the infrastructure objects Terraform manages:

```hcl
# resource "<provider>_<type>" "<local_name>" { ... }

resource "aws_s3_bucket" "app_assets" {
  bucket = "mycompany-app-assets-prod"

  tags = {
    Environment = "production"
    Team        = "platform"
  }
}

resource "aws_s3_bucket_versioning" "app_assets_versioning" {
  bucket = aws_s3_bucket.app_assets.id   # reference to another resource

  versioning_configuration {
    status = "Enabled"
  }
}
```

Reference syntax: `<resource_type>.<local_name>.<attribute>`

### Variables
```hcl
# variables.tf
variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "instance_count" {
  type    = number
  default = 2
}

variable "db_password" {
  type      = string
  sensitive = true    # masked in plan output and logs
}

variable "tags" {
  type = map(string)
  default = {
    Project = "myapp"
  }
}

variable "allowed_cidrs" {
  type    = list(string)
  default = ["10.0.0.0/8"]
}
```

Provide variable values:
```bash
terraform apply -var="region=eu-west-1"
terraform apply -var-file="prod.tfvars"
```

```hcl
# prod.tfvars
region         = "eu-west-1"
instance_count = 3
db_password    = "supersecret"
```

Or via environment: `TF_VAR_region=eu-west-1 terraform apply`

### Outputs
```hcl
# outputs.tf
output "bucket_name" {
  description = "S3 bucket name"
  value       = aws_s3_bucket.app_assets.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.app_assets.arn
}

output "db_endpoint" {
  value     = aws_db_instance.main.endpoint
  sensitive = true
}
```

```bash
terraform output bucket_name
terraform output -json   # all outputs as JSON
```

### Locals
```hcl
locals {
  common_tags = merge(var.tags, {
    ManagedBy   = "terraform"
    Environment = var.environment
  })
  
  name_prefix = "${var.project}-${var.environment}"
}

resource "aws_instance" "web" {
  ami  = "ami-0c55b159cbfafe1f0"
  tags = local.common_tags
}
```

### Data Sources
Data sources read existing infrastructure (not managed by this config):

```hcl
# Look up the latest Amazon Linux AMI
data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }
}

resource "aws_instance" "web" {
  ami           = data.aws_ami.amazon_linux.id
  instance_type = "t3.micro"
}

# Look up an existing VPC by tag
data "aws_vpc" "main" {
  tags = {
    Name = "production-vpc"
  }
}
```

### Expressions and Functions
```hcl
# String interpolation
name = "myapp-${var.environment}"

# Conditional
instance_type = var.environment == "prod" ? "t3.medium" : "t3.micro"

# For expressions
security_group_ids = [for sg in var.security_groups : sg.id]

# Functions
cidr_block   = cidrsubnet("10.0.0.0/16", 8, 1)   # 10.0.1.0/24
name         = lower(replace(var.name, " ", "-"))
merged_tags  = merge(var.tags, local.extra_tags)
```

## Examples

### EC2 Instance with Security Group
```hcl
# main.tf

provider "aws" {
  region = var.region
}

resource "aws_security_group" "web" {
  name_prefix = "${var.name_prefix}-web-"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_instance" "web" {
  count         = var.instance_count
  ami           = data.aws_ami.amazon_linux.id
  instance_type = var.instance_type

  vpc_security_group_ids = [aws_security_group.web.id]
  subnet_id              = var.subnet_ids[count.index % length(var.subnet_ids)]

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-web-${count.index + 1}"
  })
}

output "instance_ips" {
  value = aws_instance.web[*].private_ip
}
```

## Exercises

1. Write a Terraform configuration that creates an S3 bucket with versioning enabled. Run `terraform init`, `terraform plan`, and `terraform apply`. Then inspect the state with `terraform show`.
2. Add an `environment` variable (type: string, no default) and use it in the bucket name and tags. Apply with `-var="environment=dev"` and then with `staging` — observe the plan differences.
3. Add an output that prints the bucket's ARN and website endpoint. Run `terraform output` after applying to view them.
4. Use a data source to look up an existing resource (e.g. `data "aws_caller_identity"` to get your AWS account ID). Use it in a local variable to construct a globally unique bucket name.

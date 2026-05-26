---
title: State Management
module: terraform
duration_min: 20
difficulty: intermediate
tags: [terraform, state, remote-state, s3, locking, import, drift]
exercises: 4
---

## Overview
Terraform state is the source of truth about what infrastructure Terraform manages. Local state (`terraform.tfstate`) works for experimentation but breaks in teams — no sharing, no locking, real risk of conflicting writes. Remote state, stored in S3 (or GCS, Azure Blob) with DynamoDB locking, is mandatory for any shared or production configuration.

## Concepts

### What State Contains
The state file maps your HCL resource blocks to the actual infrastructure objects — IDs, ARNs, IP addresses, all attributes. Terraform uses it to:
- Determine what exists vs what the config describes
- Calculate the diff (`terraform plan`)
- Know what to delete on `terraform destroy`

```bash
# View current state
terraform show
terraform show -json | jq '.values.root_module.resources[] | {type, name}'

# List resources in state
terraform state list

# Show a specific resource
terraform state show aws_s3_bucket.app_assets
```

### Remote State (S3 Backend)
```hcl
# backend.tf
terraform {
  backend "s3" {
    bucket         = "mycompany-terraform-state"
    key            = "prod/myapp/terraform.tfstate"   # path within bucket
    region         = "us-east-1"
    encrypt        = true                              # server-side encryption
    dynamodb_table = "terraform-state-lock"           # locking table
  }
}
```

Create the S3 bucket and DynamoDB table first (usually in a bootstrap config):
```hcl
resource "aws_s3_bucket" "tf_state" {
  bucket = "mycompany-terraform-state"
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"   # versioning: recover from accidental deletes/overwrites
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_dynamodb_table" "tf_lock" {
  name         = "terraform-state-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"   # required attribute name

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

After creating these, run `terraform init` to migrate local state to S3.

### State Locking
When Terraform runs, it writes a lock to DynamoDB. Any concurrent `apply` by another user or CI job gets an error:

```
Error: Error acquiring the state lock
  Lock Info:
    ID: abc-123
    Who: igal@workstation
    Operation: apply
    Created: 2024-01-15 10:00:00
```

Force-unlock only when you're certain the previous run is dead (CI job killed mid-apply):
```bash
terraform force-unlock <lock-id>
```

### State Organization Patterns

#### Per-Environment State Files
```
s3://mycompany-terraform-state/
  dev/
    vpc/terraform.tfstate
    eks/terraform.tfstate
    apps/myapp/terraform.tfstate
  prod/
    vpc/terraform.tfstate
    eks/terraform.tfstate
    apps/myapp/terraform.tfstate
```

Each environment is a separate configuration with its own state — changes in dev don't affect prod state.

#### Remote State Data Source (Cross-Config References)
```hcl
# Read outputs from another Terraform config's state
data "terraform_remote_state" "vpc" {
  backend = "s3"
  config = {
    bucket = "mycompany-terraform-state"
    key    = "prod/vpc/terraform.tfstate"
    region = "us-east-1"
  }
}

# Use the VPC's outputs in this config
resource "aws_security_group" "app" {
  vpc_id = data.terraform_remote_state.vpc.outputs.vpc_id
}
```

### Importing Existing Resources
Import resources created outside Terraform into state management:

```bash
# terraform import <resource_address> <resource_id>
terraform import aws_s3_bucket.legacy_bucket my-existing-bucket-name
terraform import aws_instance.web i-1234567890abcdef0

# After import: write the HCL to match, or use terraform state show to see attributes
terraform state show aws_s3_bucket.legacy_bucket
```

**Terraform 1.5+ import blocks** (declarative, can be planned):
```hcl
import {
  to = aws_s3_bucket.legacy_bucket
  id = "my-existing-bucket-name"
}
```

### Dealing with Drift
Drift happens when someone makes manual changes to infrastructure outside Terraform:

```bash
# Detect drift (refresh state from real world, then plan)
terraform plan -refresh-only   # show what changed externally
terraform apply -refresh-only  # update state to match real world (no infra changes)

# Or just plan — Terraform always refreshes before planning
terraform plan
```

Options when drift is detected:
1. **Let Terraform fix it** — `terraform apply` reverts the manual change
2. **Update the code** — if the manual change was intentional, update HCL to match
3. **Update state** — `terraform apply -refresh-only` if the change is correct and you want to keep it

### State Manipulation (Use Sparingly)
```bash
# Remove a resource from state (Terraform forgets it — real resource untouched)
terraform state rm aws_s3_bucket.app_assets

# Move/rename a resource in state (after renaming in HCL)
terraform state mv aws_s3_bucket.old_name aws_s3_bucket.new_name

# Move between configs (e.g. extracting a module)
terraform state mv -state-out=../other/terraform.tfstate \
    module.app aws_instance.web
```

## Examples

### Multi-Environment Backends
```hcl
# Using partial backend config (supply different key per environment)
terraform {
  backend "s3" {
    bucket = "mycompany-terraform-state"
    region = "us-east-1"
    # key and dynamodb_table provided via -backend-config flag
  }
}
```

```bash
# Init for prod
terraform init \
    -backend-config="key=prod/myapp/terraform.tfstate" \
    -backend-config="dynamodb_table=terraform-state-lock-prod"

# Init for dev
terraform init \
    -backend-config="key=dev/myapp/terraform.tfstate" \
    -backend-config="dynamodb_table=terraform-state-lock-dev"
```

## Exercises

1. Configure an S3 backend for a Terraform config. Run `terraform init` — observe how local state migrates to S3. Verify the state file exists in S3 with `aws s3 ls`.
2. Import an existing AWS resource (e.g. a manually created S3 bucket) with `terraform import`. Write the corresponding HCL and run `terraform plan` — verify it shows no changes.
3. Simulate drift: apply a config, then manually modify a resource (change a tag via the AWS console). Run `terraform plan` — identify the drift. Then run `terraform apply` to revert, and `terraform plan -refresh-only` to observe the difference.
4. Use `terraform_remote_state` data source to read outputs from one Terraform config's state into another. Verify the cross-config reference resolves correctly by running `terraform plan` in the consumer config.

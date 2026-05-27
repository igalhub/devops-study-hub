---
title: State Management
module: terraform
duration_min: 20
difficulty: intermediate
tags: [terraform, state, remote-state, s3, locking, import, drift]
exercises: 4
---

## Overview

Terraform state is the mechanism by which Terraform maps your configuration to the real world. Every resource block in your HCL corresponds to a record in `terraform.tfstate` — a JSON file containing the resource's type, name, provider-assigned ID, and every attribute Terraform knows about. Without state, Terraform has no way to know whether an `aws_instance.web` block refers to an already-running EC2 instance or needs to create a new one. State is not a cache; it is the authoritative record of what Terraform owns and how it relates to your configuration.

Local state (`terraform.tfstate` on disk) is acceptable for solo experimentation but is a liability in any team setting. It cannot be shared between engineers, it provides no concurrency protection, and it is trivially lost or corrupted. Remote backends — S3, GCS, Azure Blob, Terraform Cloud — solve all three problems: the file lives in a durable, versioned object store, and a locking mechanism prevents two `terraform apply` runs from racing. For S3, the traditional locking mechanism uses a DynamoDB table; Terraform 1.10+ introduced native S3 file locking that eliminates the DynamoDB dependency entirely.

State management also covers operational tasks you will encounter regularly: importing resources that exist outside Terraform, detecting and resolving drift when infrastructure is modified manually, reorganizing state when refactoring configurations, and sharing outputs across configurations with the `terraform_remote_state` data source. Understanding state deeply is what separates a practitioner who can safely operate Terraform in production from one who can only run it in a tutorial.

## Concepts

### What State Contains and How Terraform Uses It

The state file is a JSON document. At the top level it records the Terraform version, a serial number (incremented on every write), and a `resources` array. Each entry in that array maps a configuration address (`aws_s3_bucket.app_assets`) to a provider resource type and a set of instances, each of which holds the full set of attributes as returned by the provider after the last apply.

```bash
# See a human-readable summary of the entire state
terraform show

# Extract resource addresses and types with jq
terraform show -json | jq '.values.root_module.resources[] | {address, type}'

# List every resource address currently tracked
terraform state list

# Dump all attributes for one resource
terraform state show aws_s3_bucket.app_assets
```

Terraform consults state in three phases:

| Phase | What state provides |
|---|---|
| `terraform plan` | Existing attribute values to diff against configuration and real world |
| `terraform apply` | Resource IDs needed to make API calls (update/delete) |
| `terraform destroy` | Complete list of resources to remove, with their provider IDs |

**The serial number is a consistency guard.** If two operators read the same state and both try to write, the one whose serial is now stale gets rejected. This is why the locking mechanism exists — to prevent even reaching a serial conflict.

**State contains secrets in plaintext.** Database passwords, private keys, and other sensitive attributes written by providers end up in the state file. Enable encryption at rest on your backend and treat state access as you would production secret access.

### Remote State Backends (S3)

The backend block tells Terraform where to store and lock state. For S3, two locking options exist:

```hcl
# backend.tf — Option A: DynamoDB locking (all Terraform versions)
terraform {
  backend "s3" {
    bucket         = "mycompany-terraform-state"
    key            = "prod/myapp/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}

# backend.tf — Option B: Native S3 file locking (Terraform 1.10+ only)
terraform {
  backend "s3" {
    bucket       = "mycompany-terraform-state"
    key          = "prod/myapp/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true   # S3 conditional writes serve as the lock mechanism
  }
}
```

The bootstrap infrastructure for Option A must be created before running `terraform init` on the config that uses it — you cannot manage the state bucket in the same config that uses it as a backend. The conventional approach is a separate `bootstrap` or `terraform-state` configuration:

```hcl
# bootstrap/main.tf — run once, commit state manually or use local backend initially
resource "aws_s3_bucket" "tf_state" {
  bucket = "mycompany-terraform-state"
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"   # allows recovery from accidental overwrites
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

# Block all public access — state must never be public
resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Option A only: DynamoDB table for locking
resource "aws_dynamodb_table" "tf_lock" {
  name         = "terraform-state-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"   # must be exactly "LockID" — Terraform requires this

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

After applying the bootstrap config, run `terraform init` in your application config. Terraform detects that the configured backend differs from the current (local) state location and offers to migrate:

```bash
terraform init
# Terraform will prompt:
# > Do you want to copy existing state to the new backend? (yes/no)
# Type "yes" to migrate
```

**Prefer Option B (native S3 locking) for new projects on Terraform 1.10+.** It eliminates the DynamoDB table, reduces IAM permissions needed, and has no additional cost. Use Option A when your organization runs older Terraform versions or has existing DynamoDB infrastructure.

### State Locking

Whenever Terraform starts an operation that modifies state (`apply`, `destroy`, some `plan` invocations), it acquires a lock. With DynamoDB, this is a conditional write to the lock table. With native S3 locking, it uses an S3 object conditional write (`If-None-Match`). Both approaches are atomic at the storage level.

If a lock is already held, Terraform errors immediately rather than waiting:

```
Error: Error acquiring the state lock

  Lock Info:
    ID:        f4a9b2c1-1234-5678-abcd-ef0123456789
    Path:      mycompany-terraform-state/prod/myapp/terraform.tfstate
    Operation: apply
    Who:       deploy@ci-runner-42
    Version:   1.6.0
    Created:   2024-03-10 14:22:01.123456789 +0000 UTC
```

This tells you who holds the lock, what operation they are running, and when they started. In most cases the right response is to wait for that run to finish.

```bash
# Force-unlock: releases the lock without running anything
terraform force-unlock f4a9b2c1-1234-5678-abcd-ef0123456789
```

**Only force-unlock when you are certain the previous process is dead.** Unlocking while an apply is still running removes the only protection against concurrent state writes. Check your CI system — if the job was killed at the infrastructure layer, the lock record may persist as a ghost. Common scenarios requiring force-unlock: CI runner was terminated mid-apply, engineer's laptop lost network mid-apply.

### State Organization Patterns

How you partition state across files has a direct impact on blast radius, plan speed, and team autonomy.

| Pattern | When to use | Trade-off |
|---|---|---|
| One state per environment | Always | Separates dev and prod blast radius |
| One state per logical layer (network, compute, apps) | Medium-to-large infra | Faster plans; requires cross-state references |
| One state per microservice/team | Many teams, large org | Maximum isolation; more backends to manage |
| Monolithic state | Solo projects, tiny infra | Simple; slow plans; high blast radius |

A well-structured S3 key hierarchy for a multi-environment, multi-layer setup:

```
s3://mycompany-terraform-state/
  dev/
    vpc/terraform.tfstate
    eks/terraform.tfstate
    rds/terraform.tfstate
    apps/
      api/terraform.tfstate
      worker/terraform.tfstate
  staging/
    vpc/terraform.tfstate
    ...
  prod/
    vpc/terraform.tfstate
    eks/terraform.tfstate
    rds/terraform.tfstate
    apps/
      api/terraform.tfstate
      worker/terraform.tfstate
```

**Splitting state is a permanent decision that is painful to reverse.** Start with the split you expect to need at scale. Merging two state files later requires `terraform state mv` for every resource.

#### Cross-Configuration References with `terraform_remote_state`

When configurations are split, downstream configs need outputs from upstream configs. The `terraform_remote_state` data source reads the outputs block of another config's state file:

```hcl
# apps/api/main.tf — consuming outputs from the VPC config
data "terraform_remote_state" "vpc" {
  backend = "s3"
  config = {
    bucket = "mycompany-terraform-state"
    key    = "prod/vpc/terraform.tfstate"
    region = "us-east-1"
  }
}

data "terraform_remote_state" "eks" {
  backend = "s3"
  config = {
    bucket = "mycompany-terraform-state"
    key    = "prod/eks/terraform.tfstate"
    region = "us-east-1"
  }
}

resource "aws_security_group" "api" {
  name   = "api-sg"
  vpc_id = data.terraform_remote_state.vpc.outputs.vpc_id   # from vpc config output
}

resource "helm_release" "api" {
  name       = "api"
  chart      = "./charts/api"
  namespace  = "default"

  set {
    name  = "clusterEndpoint"
    value = data.terraform_remote_state.eks.outputs.cluster_endpoint
  }
}
```

The upstream config must explicitly declare outputs for anything downstream consumers need:

```hcl
# vpc/outputs.tf
output "vpc_id" {
  value       = aws_vpc.main.id
  description = "VPC ID for use by downstream configurations"
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
}
```

**`terraform_remote_state` creates a hard coupling between configurations.** If the upstream config renames or removes an output, every downstream config breaks. An alternative is to pass values through AWS SSM Parameter Store or similar, which decouples the configs at the cost of more infrastructure.

### Importing Existing Resources

Infrastructure created outside Terraform (manually in the console, by another tool, by a previous team) can be brought under Terraform management by importing it into state.

**CLI import (all versions):**

```bash
# Syntax: terraform import <resource_address> <provider_resource_id>
terraform import aws_s3_bucket.legacy my-existing-bucket-name
terraform import aws_instance.web i-0abc123def456789a
terraform import aws_security_group.app sg-0123456789abcdef0

# After import, inspect what attributes were recorded
terraform state show aws_s3_bucket.legacy
```

The import only writes to state — it does not generate HCL. You must write the resource block manually and then run `terraform plan` to confirm there are no unintended changes. **If your HCL is incomplete or wrong after an import, `terraform plan` will show a diff that may destroy or modify the resource to match.** Always verify the plan shows no changes before committing.

**Import blocks (Terraform 1.5+, declarative and plannable):**

```hcl
# import.tf — declare what to import
import {
  to = aws_s3_bucket.legacy
  id = "my-existing-bucket-name"
}

import {
  to = aws_instance.web
  id = "i-0abc123def456789a"
}
```

```bash
# Plan shows the import as a planned action — review before applying
terraform plan

# Apply performs the import and writes state
terraform apply
```

The advantage of import blocks: they appear in `terraform plan` output so the import is reviewable, auditable in version control, and executable in CI without interactive flags. After the import is complete, remove the import block — it is a one-time declaration.

**Terraform 1.5+ can also generate HCL from an import:**

```bash
terraform plan -generate-config-out=generated.tf
```

This produces a starting-point resource block from the imported attributes. Review and clean it up — generated HCL often includes read-only attributes that cannot be set in configuration.

### Detecting and Resolving Drift

Drift occurs when the real-world state of infrastructure diverges from what Terraform last recorded. Common causes: manual changes in the console, automated remediations by other tools, cloud provider changes to managed resource attributes.

```bash
# Refresh-only plan: show what changed externally without planning any config changes
terraform plan -refresh-only

# Refresh-only apply: update the state file to match reality (no infrastructure changes)
terraform apply -refresh-only

# A normal plan also refreshes before computing the diff
terraform plan
```

When drift is detected, you have three options:

| Option | Command | When to use |
|---|---|---|
| Revert drift (Terraform wins) | `terraform apply` | Manual change was unauthorized or incorrect |
| Accept drift into state | `terraform apply -refresh-only` | Manual change was correct; config will be updated to match |
| Update config to match | Edit HCL, then `terraform apply` | Manual change was intentional and should be permanent |

**`-refresh-only` does not fix drift — it makes Terraform accept it.** After a `terraform apply -refresh-only`, the state matches reality, but your HCL still describes the old configuration. The next `terraform plan` will show a diff wanting to revert back to what the HCL says. Update your HCL after accepting drift, or use it as a diagnostic step only.

To skip the refresh phase entirely (useful in large configs where the refresh is slow and you know the state is accurate):

```bash
terraform plan -refresh=false
```

### State Manipulation Commands

Direct state manipulation bypasses the normal plan/apply cycle. Use these only when necessary — they are the sharp edges of Terraform operations.

```bash
# Remove a resource from state (Terraform forgets it; real resource is untouched)
# Use case: you want to delete the resource manually, or hand it to another config
terraform state rm aws_s3_bucket.app_assets

# Rename a resource in state (required after renaming the block in HCL)
# Without this, Terraform would destroy the old resource and create a new one
terraform state mv aws_s3_bucket.old_name aws_s3_bucket.new_name

# Move a resource into a module (after wrapping resources in a module block)
terraform state mv aws_instance.web module.app.aws_instance.web

# Move a resource to a different state file (extracting to a new config)
terraform state mv \
    -state-out=../new-config/terraform.tfstate \
    aws_instance.web \
    aws_instance.web

# Pull the current state to stdout (useful for inspection or backup)
terraform state pull > backup.tfstate

# Push a local state file to the backend (use with extreme caution)
terraform state push backup.tfstate
```

| Command | Effect on real infrastructure | When to use |
|---|---|---|
| `state rm` | None | Abandoning a resource or moving to another config |
| `state mv` | None | Renaming resources or refactoring into modules |
| `state push` | None directly, but wrong state = destructive next apply | Disaster recovery only |
| `state pull` | None | Inspection
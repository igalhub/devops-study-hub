---
title: State Management
module: terraform
duration_min: 20
difficulty: intermediate
tags: [terraform, state, remote-state, s3, locking, import, drift]
exercises: 4
---

## Overview

Terraform state is the mechanism by which Terraform maps your configuration to the real world. Every resource block in your HCL corresponds to a record in `terraform.tfstate` — a JSON file containing the resource's type, name, provider-assigned ID, and every attribute Terraform knows about. Without state, Terraform has no way to know whether an `aws_instance.web` block refers to an already-running EC2 instance or needs to create a new one. State is not a cache; it is the authoritative record of what Terraform owns and how it relates to your configuration. Losing or corrupting state is one of the most disruptive things that can happen to a Terraform-managed environment — recovery requires manually re-importing every resource.

Local state (`terraform.tfstate` on disk) is acceptable for solo experimentation but is a liability in any team setting. It cannot be shared between engineers, it provides no concurrency protection, and it is trivially lost or corrupted. Remote backends — S3, GCS, Azure Blob, Terraform Cloud — solve all three problems: the file lives in a durable, versioned object store, and a locking mechanism prevents two `terraform apply` runs from racing. For S3, the traditional locking mechanism uses a DynamoDB table; Terraform 1.10+ introduced native S3 file locking that eliminates the DynamoDB dependency entirely.

State management also covers operational tasks you will encounter regularly: importing resources that exist outside Terraform, detecting and resolving drift when infrastructure is modified manually, reorganizing state when refactoring configurations, and sharing outputs across configurations with the `terraform_remote_state` data source. Understanding state deeply is what separates a practitioner who can safely operate Terraform in production from one who can only run it in a tutorial.

## Concepts

### What State Contains and How Terraform Uses It

The state file is a JSON document. At the top level it records the Terraform version, a serial number (incremented on every successful write), a lineage UUID (a unique ID assigned when the state is first created), and a `resources` array. Each entry in that array maps a configuration address (`aws_s3_bucket.app_assets`) to a provider resource type and a set of instances, each of which holds the full set of attributes as returned by the provider after the last apply.

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
| `terraform plan` | Existing attribute values to diff against configuration and the real world |
| `terraform apply` | Resource IDs needed to make API calls (update/delete) |
| `terraform destroy` | Complete list of resources to remove, with their provider-assigned IDs |

**The serial number is a consistency guard.** If two operators read the same state and both try to write, the one whose serial is now stale gets rejected at the storage layer. This is the second line of defense — locking is the first.

**The lineage UUID prevents state file mix-ups.** If you accidentally point a backend at the wrong state file, Terraform detects that the lineage doesn't match the local cache and refuses to proceed. This prevents silent corruption from path misconfigurations.

**State contains secrets in plaintext.** Database passwords, private keys, and other sensitive attributes written by providers end up in the state file. Marking an output `sensitive = true` in HCL does not prevent the value from appearing in state — it only suppresses it from CLI output. Enable encryption at rest on your backend and treat state access as you would production secret access. Audit who has `s3:GetObject` on your state bucket.

### Remote State Backends (S3)

The `backend` block tells Terraform where to store and lock state. For S3, two locking options exist:

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
```

```hcl
# backend.tf — Option B: Native S3 file locking (Terraform 1.10+ only)
terraform {
  backend "s3" {
    bucket       = "mycompany-terraform-state"
    key          = "prod/myapp/terraform.tfstate"
    region        = "us-east-1"
    encrypt      = true
    use_lockfile = true   # S3 conditional writes (If-None-Match) serve as the lock
  }
}
```

The bootstrap infrastructure for Option A must be created before running `terraform init` on any config that uses it — you cannot manage the state bucket in the same config that uses it as a backend (a chicken-and-egg problem). The conventional approach is a separate `bootstrap` or `terraform-state` configuration applied once:

```hcl
# bootstrap/main.tf — run once, use local backend initially, commit state manually
resource "aws_s3_bucket" "tf_state" {
  bucket = "mycompany-terraform-state"
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"   # enables recovery from accidental overwrites
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

# State must never be publicly accessible
resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Option A only: DynamoDB table for distributed locking
resource "aws_dynamodb_table" "tf_lock" {
  name         = "terraform-state-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"   # must be exactly "LockID" — Terraform requires this key name

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

After applying the bootstrap config, run `terraform init` in your application config. Terraform detects that the configured backend differs from the current (local) backend and offers to migrate existing state:

```bash
cd myapp/
terraform init
# Terraform will prompt:
# > Do you want to copy existing state to the new backend? (yes/no)
# Type "yes" to migrate — Terraform uploads the local state file and deletes the local copy
```

**Prefer Option B (native S3 locking) for new projects on Terraform 1.10+.** It eliminates the DynamoDB table, reduces the IAM permissions required, and has no additional cost beyond S3 request pricing. Use Option A when your organization standardizes on older Terraform versions or already has DynamoDB lock tables in place.

| Feature | DynamoDB locking | Native S3 locking |
|---|---|---|
| Minimum Terraform version | All versions | 1.10+ |
| Additional AWS resources | DynamoDB table | None |
| IAM permissions needed | S3 + DynamoDB | S3 only |
| Cost | DynamoDB reads/writes | S3 PUT requests only |
| Lock visibility | DynamoDB item | `.tflock` file in bucket |

### State Locking

Whenever Terraform starts an operation that modifies state (`apply`, `destroy`, some `plan` invocations with `-refresh-only`), it acquires a lock before reading state. With DynamoDB, this is an atomic conditional write to the lock table. With native S3 locking, it creates a `.tflock` file using an S3 conditional write (`If-None-Match: *`), which only succeeds if the object does not yet exist. Both approaches are atomic at the storage level.

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

This message tells you who holds the lock, what operation they are running, and when they started. In most cases the correct response is to wait for that run to finish and retry.

```bash
# Force-unlock: releases the lock without running any Terraform operations
# Use the lock ID printed in the error message above
terraform force-unlock f4a9b2c1-1234-5678-abcd-ef0123456789
```

**Only force-unlock when you are certain the previous process is dead.** Unlocking while an apply is still in progress removes the only protection against concurrent state writes and can corrupt state. Verify in your CI system that the job is no longer running before using `force-unlock`. Common legitimate scenarios: CI runner was killed by a spot interruption mid-apply, engineer's laptop lost network connectivity mid-apply and the process is confirmed dead.

### State Organization Patterns

How you partition state across files directly impacts blast radius, plan performance, and team autonomy. A single `terraform apply` can only destroy resources that exist in its state file — so state boundaries are also blast radius boundaries.

| Pattern | When to use | Trade-off |
|---|---|---|
| One state per environment | Always — non-negotiable minimum | Separates dev and prod blast radius |
| One state per logical layer (network, compute, apps) | Medium-to-large infrastructure | Faster plans; requires cross-state references |
| One state per microservice or team | Many teams, large org | Maximum isolation; more backends to manage |
| Monolithic state | Solo projects, tiny infrastructure | Simple to start; slow plans; high blast radius at scale |

A well-structured S3 key hierarchy for a multi-environment, multi-layer setup:

```
s3://mycompany-terraform-state/
  global/
    iam/terraform.tfstate          # IAM roles, policies (no region)
  dev/
    vpc/terraform.tfstate
    eks/terraform.tfstate
    rds/terraform.tfstate
    apps/
      api/terraform.tfstate
      worker/terraform.tfstate
  prod/
    vpc/terraform.tfstate
    eks/terraform.tfstate
    rds/terraform.tfstate
    apps/
      api/terraform.tfstate
      worker/terraform.tfstate
```

**Splitting state is effectively a permanent architectural decision.** Merging two state files later requires `terraform state mv` for every resource and careful coordination across teams. Start with the split you expect to need at scale. The cost of splitting too late is higher than the cost of managing an extra state file from the beginning.

#### Cross-Configuration References with `terraform_remote_state`

When configurations are split across multiple state files, downstream configs need outputs from upstream configs. The `terraform_remote_state` data source reads the `outputs` block of another configuration's state file directly from the backend:

```hcl
# apps/api/main.tf — consuming outputs from the vpc and eks configurations
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
  vpc_id = data.terraform_remote_state.vpc.outputs.vpc_id
}

resource "helm_release" "api" {
  name      = "api"
  chart     = "./charts/api"
  namespace = "default"

  set {
    name  = "clusterEndpoint"
    value = data.terraform_remote_state.eks.outputs.cluster_endpoint
  }
}
```

The upstream config must explicitly declare outputs for anything downstream consumers reference:

```hcl
# vpc/outputs.tf
output "vpc_id" {
  value       = aws_vpc.main.id
  description = "VPC ID for use by downstream configurations"
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
  description = "List of private subnet IDs"
}
```

**`terraform_remote_state` creates a hard coupling between configurations.** If the upstream config renames or removes an output, every downstream config that references it breaks at plan time. An alternative is to pass values through a neutral intermediary like AWS SSM Parameter Store — the VPC config writes the VPC ID as a parameter, and the app config reads it with the `aws_ssm_parameter` data source. This decouples the configs at the cost of slightly more infrastructure and an extra IAM permission.

### Importing Existing Resources

Infrastructure created outside Terraform — manually in the console, by a different tool, or before Terraform was adopted — can be brought under Terraform management by importing it into state. Importing does not modify the real resource; it only creates a state record that allows Terraform to track and manage it going forward.

**CLI import (all Terraform versions):**

```bash
# Syntax: terraform import <resource_address> <provider_resource_id>
terraform import aws_s3_bucket.legacy my-existing-bucket-name
terraform import aws_instance.web i-0abc123def456789a
terraform import aws_security_group.app sg-0123456789abcdef0

# For resources with composite IDs (e.g., IAM role policy attachment)
terraform import aws_iam_role_policy_attachment.example "my-role/arn:aws:iam::aws:policy/ReadOnlyAccess"

# After import, inspect the attributes that were recorded
terraform state show aws_s3_bucket.legacy
```

CLI import only writes to state — it does not generate HCL. You must write the resource block manually and then run `terraform plan` to verify there are no unintended differences. **If your HCL is incomplete or wrong after an import, `terraform plan` will show a diff that may destroy or modify the resource to match your configuration.** Always verify the plan shows zero changes before treating an import as complete.

**Import blocks (Terraform 1.5+, declarative and plannable):**

```hcl
# import.tf — declare what to import alongside your regular configuration
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
# The import appears as a planned action — review it before applying
terraform plan

# Apply performs the import and updates state
terraform apply

# Remove the import blocks after the apply — they are one-time declarations
# Leaving them in place causes no harm but is misleading
```

The key advantage of import blocks over CLI import: they appear in `terraform plan` output, so the import action is reviewable, auditable in version control, and executable in CI without interactive prompts or manual steps.

**Terraform 1.5+ can generate HCL from an import:**

```bash
# Combine with an import block — generates a starting-point resource block
terraform plan -generate-config-out=generated.tf
```

This produces a resource block pre-populated from the imported attributes. Always review and clean up the generated HCL — it frequently includes computed or read-only attributes (like `arn`, `id`) that are invalid in configuration and will cause errors if left in place.

### Detecting and Resolving Drift

Drift occurs when the real-world state of infrastructure diverges from what Terraform last recorded in state. Common causes: a developer made a change directly in the AWS console, a cloud provider updated a managed attribute, a security team rotated credentials, or an auto-scaling event changed instance counts.

```bash
# Refresh-only plan: detect what changed externally without planning config changes
# Shows additions, modifications, and deletions relative to recorded state
terraform plan -refresh-only

# Refresh-only apply: update the state file to match reality
# Does not change any real infrastructure
terraform apply -refresh-only

# A normal terraform plan also refreshes before computing the diff
# The refresh is visible in the output as "Refreshing state..."
terraform plan
```

When drift is detected, you have three options:

| Option | Command | When to use |
|---|---|---|
| Revert drift (Terraform wins) | `terraform apply` | The manual change was unauthorized or incorrect |
| Accept drift into state | `terraform apply -refresh-only` then update HCL | The manual change was correct and should be preserved |
| Update config to match drift | Edit HCL, then `terraform apply` | The manual change was intentional and permanent |

**`-refresh-only` does not resolve drift — it makes Terraform accept it.** After `terraform apply -refresh-only`, state matches reality, but your HCL still describes the previous configuration. The next `terraform plan` will show a diff wanting to revert infrastructure back to what the HCL describes. Always update your HCL to reflect the accepted drift, or treat `refresh-only` as a diagnostic tool only.

```bash
# Skip the refresh phase entirely — useful for large configs where refresh is slow
# and you are confident state is accurate (e.g., in a CI pipeline with no manual changes)
terraform plan -refresh=false
terraform apply -refresh=false
```

**Skipping refresh can mask drift.** Use `-refresh=false` only in controlled environments where you have high confidence no out-of-band changes have occurred, or when you are intentionally targeting a specific resource and don't need a full refresh.

### State Manipulation Commands

Direct state manipulation bypasses the normal plan/apply cycle. These commands are necessary for refactoring and recovery but carry real risk — incorrect use can cause Terraform to destroy resources it believes no longer exist in state.

```bash
# Remove a resource from state — Terraform forgets it; the real resource is untouched
# Use case: handing a resource to another config, or allowing it to be deleted manually
terraform state rm aws_s3_bucket.app_assets

# Rename a resource in state after renaming the block in HCL
# Without this, plan would destroy the old resource and create a new one
terraform state mv aws_s3_bucket.old_name aws_s3_bucket.new_name

# Move a resource into a module after wrapping it in a module block
terraform state mv aws_instance.web module.app.aws_instance.web

# Move a resource to a completely different state file (extracting to a new config)
terraform state mv \
  -state-out=../new-config/terraform.tfstate \
  aws_instance.web \
  aws_instance.web

# Pull current remote state to stdout — useful for inspection or creating a backup
terraform state pull > backup-$(date +%Y%m%d-%H%M%S).tfstate

# Push a local state file to the remote backend
# WARNING: this overwrites the remote state entirely
terraform state push backup.tfstate
```

| Command | Effect on real infrastructure | Primary use case |
|---|---|---|
| `state rm` | None | Abandoning a resource or transferring to another config |
| `state mv` | None | Renaming resources or refactoring into/out of modules |
| `state pull` | None | Inspection, backup, offline analysis |
| `state push` | None directly — but incorrect state causes destructive next apply | Disaster recovery only |

**`terraform state push` is the most dangerous command in this list.** It unconditionally overwrites the remote state file. If you push an outdated backup, the next `terraform plan` will see the difference between the outdated state and reality and may plan to destroy resources to match. Only use it to restore from a verified backup when the current state is confirmed corrupted. Prefer restoring from S3 versioning (via the AWS console or CLI) when possible, as that bypasses Terraform entirely and has a lower risk of human error.

**Before any bulk `state mv` or `state rm` operation, take a manual backup:**

```bash
terraform state pull > pre-refactor-backup.tfstate
# Verify it's non-empty and valid JSON before proceeding
jq '.serial' pre-refactor-backup.tfstate
```

## Examples

### Example 1: Bootstrap S3 Remote Backend with Native Locking

This example sets up the S3 backend infrastructure and migrates a local state file to remote storage. Run this before any application Terraform configs are initialized.

```bash
# 1. Create the bootstrap directory
mkdir -p infra/bootstrap && cd infra/bootstrap

# 2. Write the bootstrap config
cat > main.tf << 'EOF'
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Intentionally using local backend for bootstrap — chicken-and-egg
  # After apply, this state file is committed to version control or stored manually
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "tf_state" {
  bucket = "mycompany-terraform-state-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true  # safeguard against accidental bucket deletion
  }
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"
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

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket_name" {
  value = aws_s3_bucket.tf_state.bucket
}
EOF

# 3. Apply the bootstrap config (uses local state)
terraform init
terraform apply

# 4. Note the bucket name from the output
# state_bucket_name = "mycompany-terraform-state-123456789012"
```

Now configure the application config to use the new bucket:

```bash
cd ../myapp

cat > backend.tf << 'EOF'
terraform {
  backend "s3" {
    bucket       = "mycompany-terraform-state-123456789012"
    key          = "dev/myapp/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true   # Terraform 1.10+ native locking
  }
}
EOF

# 5. Initialize — Terraform detects new backend and offers to migrate local state
terraform init
# > Do you want to copy existing state to the new backend? yes

# 6. Verify state is now in S3
aws s3 ls s3://mycompany-terraform-state-123456789012/dev/myapp/
# 2024-03-10 14:00:00       1423 terraform.tfstate
```

### Example 2: Import an Existing EC2 Instance

A developer manually created an EC2 instance that needs to come under Terraform management. This example uses import blocks (Terraform 1.5+) for auditability.

```bash
# 1. Find the instance ID
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=legacy-web-server" \
  --query "Reservations[].Instances[].InstanceId" \
  --output text
# i-0abc123def456789a

# 2. First, look at the actual instance attributes to write accurate HCL
aws ec2 describe-instances --instance-ids i-0abc123def456789a \
  --query "Reservations[].Instances[0]" | jq '{
    instance_type: .InstanceType,
    ami: .ImageId,
    subnet_id: .SubnetId,
    vpc_security_group_ids: [.SecurityGroups[].GroupId],
    tags: .Tags
  }'
```

```hcl
# main.tf — write the resource block to match the real instance
resource "aws_instance" "legacy_web" {
  ami           = "ami-0c55b159cbfafe1f0"   # match the actual AMI
  instance_type = "t3.medium"

  subnet_id              = "subnet-0abc123def"
  vpc_security_group_ids = ["sg-0123456789abcdef0"]

  tags = {
    Name        = "legacy-web-server"
    Environment = "prod"
  }
}

# import.tf — declare the import alongside the resource
import {
  to = aws_instance.legacy_web
  id = "i-0abc123def456789a"
}
```

```bash
# 3. Plan — shows the import as a planned action, not a create
terraform plan
# aws_instance.legacy_web: Preparing import... [id=i-0abc123def456789a]
# Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.

# 4. Apply the import
terraform apply

# 5. Verify — plan should show no changes after a successful import
terraform plan
# No changes. Your infrastructure matches the configuration.

# 6. Remove the import block from import.tf (it's a one-time declaration)
# The resource block in main.tf stays — that's the ongoing configuration
```

### Example 3: Refactor Resources into a Module

You have an EC2 instance and security group defined at the root level and want to wrap them in a reusable module without destroying and recreating the resources.

**Before (root level):**
```hcl
# main.tf
resource "aws_security_group" "web" {
  name   = "web-sg"
  vpc_id = var.vpc_id
}

resource "aws_instance" "web" {
  ami                    = var.ami_id
  instance_type          = "t3.small"
  vpc_security_group_ids = [aws_security_group.web.id]
}
```

**After (moved into a module):**
```hcl
# modules/web/main.tf
resource "aws_security_group" "web" {
  name   = "web-sg"
  vpc_id = var.vpc_id
}

resource "aws_instance" "web" {
  ami                    = var.ami_id
  instance_type          = "t3.small"
  vpc_security_group_ids = [aws_security_group.web.id]
}

# main.tf (root)
module "web" {
  source   = "./modules/web"
  vpc_id   = var.vpc_id
  ami_id   = var.ami_id
}
```

```bash
# 1. Take a backup before touching state
terraform state pull > pre-module-refactor.tfstate

# 2. Move resources to their new module addresses
terraform state mv aws_security_group.web module.web.aws_security_group.web
terraform state mv aws_instance.web module.web.aws_instance.web

# 3. Verify the addresses updated correctly
terraform state list
# module.web.aws_security_group.web
# module.web.aws_instance.web

# 4. Plan — should show zero changes if HCL and state addresses match
terraform plan
# No changes. Your infrastructure matches the configuration.
```

**If the plan shows a destroy/create cycle, the state address doesn't match the HCL address.** Use `terraform state list` to see what addresses are in state and compare to the address Terraform is trying to plan. Re-run `state mv` to correct the discrepancy.

### Example 4: Detect and Respond to Drift

A security engineer manually updated a security group ingress rule in the AWS console. You need to detect the change and decide how to handle it.

```bash
# 1. Run a refresh-only plan to detect drift without planning config changes
terraform plan -refresh-only

# Output shows the drift:
# ~ resource "aws_security_group_rule" "web_ingress_https" {
#     ~ cidr_blocks = [
#       - "10.0.0.0/8",
#       + "0.0.0.0/0",   # someone opened this to the internet
#     ]
# }
# Plan: 0 to add, 0 to change, 0 to destroy.
# Note: Objects have changed outside of Terraform

# 2a. If the change was unauthorized — revert it with a normal apply
terraform apply
# Terraform reverts the security group rule back to 10.0.0.0/8

# 2b. If the change was intentional — first accept it into state
terraform apply -refresh-only
# State now reflects 0.0.0.0/0

# Then update HCL to match (so the next plan shows no diff)
# Edit the resource block to set cidr_blocks = ["0.0.0.0/0"]
vim security_groups.tf

# Apply the HCL change — since state already reflects it, no infrastructure change occurs
terraform apply
# No changes. Your infrastructure matches the configuration.
```

## Exercises

### Exercise 1: Configure and Validate a Remote S3 Backend

Set up an S3 bucket (you can use LocalStack or a real AWS account) and migrate a simple Terraform config from local to remote state.

1. Write a minimal Terraform config that creates one resource (e.g., `aws_s3_bucket` or `null_resource`).
2. Run `terraform apply` with the default local backend. Verify `terraform.tfstate` exists on disk.
3. Create a separate S3 bucket (manually via `aws s3 mb` or via a bootstrap config) to hold your state.
4. Add a `backend "s3"` block to your config. Run `terraform init` and confirm the migration prompt.
5. Verify the state file now exists in S3: `aws s3 ls s3://your-bucket/path/to/terraform.tfstate`
6. Run `terraform plan` and confirm it shows no changes — proving the migrated state is consistent.

**Stretch goal:** Enable versioning on the state bucket, run `terraform apply` twice with small config changes, and use `aws s3api list-object-versions` to inspect the state file version history.

### Exercise 2: Import a Pre-Existing Resource

This exercise builds the muscle memory for one of the most common real-world Terraform tasks.

1. Manually create an S3 bucket via the AWS CLI (outside Terraform): `aws s3 mb s3://tf-import-exercise-$(date +%s)`
2. Write a `resource "aws_s3_bucket"` block in your Terraform config that matches the bucket name.
3. Run `terraform plan` — notice that Terraform wants to create a new bucket (it doesn't know the existing one belongs to it yet).
4. Use `terraform import` or an `import {}` block to import the existing bucket.
5. Run `terraform plan` again — confirm it shows no changes.
6. **Challenge:** Modify the HCL to add a tag that isn't on the real bucket. Run `terraform plan` — confirm it now shows exactly one change (adding the tag) and no destroy/create. Apply it. The resource should be updated in place, not replaced.

### Exercise 3: Simulate and Recover from a Stuck Lock

This exercise requires access to a DynamoDB-backed remote state (Option A backend).

1. Configure the S3 + DynamoDB backend as described in the Concepts section.
2. Manually insert a fake lock record into the DynamoDB table to simulate a ghost lock:
   ```bash
   aws dynamodb put-item \
     --table-name terraform-state-lock \
     --item '{
       "LockID": {"S": "mycompany-terraform-state/dev/myapp/terraform.tfstate"},
       "Info": {"S": "{\"ID\":\"deadbeef-dead-dead-dead-deaddeaddeaf\",\"Operation\":\"apply\",\"Who\":\"ghost@dead-runner\"}"}
     }'
   ```
3. Run `terraform plan` — observe the lock error and read the lock info from the error message.
4. Confirm the lock is a ghost (no active process holds it).
5. Use `terraform force-unlock` with the lock ID to clear it.
6. Verify `terraform plan` now runs successfully.
7. **Reflection question:** What would have happened if you ran `force-unlock` while a real `terraform apply` was in progress?

### Exercise 4: Refactor State with `state mv` and Verify No Drift

Practice the most common state manipulation operation: renaming a resource without destroying it.

1. Write a config with a resource using an intentionally bad name, e.g., `resource "aws_s3_bucket" "temp123"`. Apply it.
2. Rename the resource block in HCL to `resource "aws_s3_bucket" "app_assets"` (do not change any attributes).
3. Run `terraform plan` — observe that Terraform plans to destroy the old bucket and create a new one. **Do not apply this plan.**
4. Run `terraform state mv aws_s3_bucket.temp123 aws_s3_bucket.app_assets` to update the state address.
5. Run `terraform plan` again — confirm it shows no changes.
6. **Challenge:** Take it further. Wrap the resource in a module (`module "storage"`) and use `terraform state mv` to move it to `module.storage.aws_s3_bucket.app_assets`. Verify `terraform plan` still shows no changes after the move.

---

### Quick Checks

7. Count resources in a Terraform state list. Run: `printf 'aws_instance.web\naws_s3_bucket.logs\naws_iam_role.app\naws_security_group.web\n' | wc -l`

```expected_output
4
```

hint: Think about how you can count the number of lines produced by a command's output.
hint: Pipe the output of printf (or terraform state list) into wc -l, which counts the total number of lines received on stdin.

8. Parse the backend type from a Terraform config stub. Run: `printf 'terraform {\n  backend "s3" {\n    bucket = "my-tfstate"\n  }\n}\n' | awk '/backend/{gsub(/"/, ""); print $2; exit}'`

```expected_output
s3
```

hint: Consider how you can stream a multi-line Terraform config into a text-processing tool that can search for a specific keyword and extract a particular field from that line.
hint: Use printf to generate the config, pipe it into awk with a pattern matching 'backend', then use gsub to strip quote characters and print the second whitespace-separated field before calling exit.

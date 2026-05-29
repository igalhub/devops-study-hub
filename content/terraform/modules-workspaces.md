---
title: Modules & Workspaces
module: terraform
duration_min: 20
difficulty: intermediate
tags: [terraform, modules, workspaces, reusability, for-each, count]
exercises: 4
---

## Overview
Modules package reusable Terraform configurations — instead of copy-pasting the same VPC or EKS cluster definition across teams, you write it once as a module and call it with different inputs. Workspaces let a single configuration manage multiple state files for different environments. Together they're the foundation of scalable Terraform architecture.

## Concepts

### Modules
A module is any directory containing `.tf` files. You've been using the root module; child modules are referenced from it:

```hcl
# Call a local module
module "vpc" {
  source = "./modules/vpc"      # local path

  cidr_block         = "10.0.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b"]
  environment        = var.environment
}

# Call a Terraform Registry module
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "my-cluster"
  cluster_version = "1.29"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets
}

# Call a module from a git repo
module "db" {
  source = "git::https://github.com/myorg/terraform-modules.git//rds?ref=v1.2.0"

  instance_class = "db.t3.medium"
  db_name        = "myapp"
}
```

After adding or changing a module source, run `terraform init` again.

### Module Structure
```
modules/
  vpc/
    main.tf        # resources
    variables.tf   # input variables (the module's interface)
    outputs.tf     # outputs (what callers can reference)
    versions.tf    # required_providers, required_version
```

```hcl
# modules/vpc/variables.tf
variable "cidr_block" {
  type        = string
  description = "VPC CIDR block"
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)"
}

variable "tags" {
  type    = map(string)
  default = {}
}
```

```hcl
# modules/vpc/outputs.tf
output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnets" {
  value = aws_subnet.private[*].id
}

output "public_subnets" {
  value = aws_subnet.public[*].id
}
```

Reference module outputs: `module.vpc.vpc_id`, `module.vpc.private_subnets`

### for_each and count — Multiple Resource Instances
```hcl
# count — simple numeric repetition
resource "aws_instance" "web" {
  count         = var.instance_count
  ami           = data.aws_ami.linux.id
  instance_type = "t3.micro"

  tags = {
    Name = "web-${count.index}"
  }
}

# Reference: aws_instance.web[0].id, aws_instance.web[*].id

# for_each — iterate a map or set (preferred over count for named resources)
resource "aws_s3_bucket" "assets" {
  for_each = toset(["images", "videos", "documents"])

  bucket = "mycompany-${each.key}"
  tags = {
    AssetType = each.key
  }
}

# Reference: aws_s3_bucket.assets["images"].id

# for_each with a map
variable "subnets" {
  default = {
    "us-east-1a" = "10.0.1.0/24"
    "us-east-1b" = "10.0.2.0/24"
  }
}

resource "aws_subnet" "private" {
  for_each = var.subnets

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = each.value
}
```

Prefer `for_each` over `count` for anything named — removing an element from a `count` list shifts indices and causes Terraform to destroy and recreate everything after the gap.

### Workspaces
Workspaces let you use the same configuration with separate state files — one per workspace:

```bash
# List workspaces
terraform workspace list
# * default
#   staging
#   production

# Create and switch
terraform workspace new staging
terraform workspace select production
terraform workspace show    # current workspace name
```

Use `terraform.workspace` in your config:
```hcl
locals {
  env_config = {
    default    = { instance_type = "t3.micro",  count = 1 }
    staging    = { instance_type = "t3.small",  count = 2 }
    production = { instance_type = "t3.medium", count = 4 }
  }
  config = local.env_config[terraform.workspace]
}

resource "aws_instance" "app" {
  count         = local.config.count
  instance_type = local.config.instance_type
}
```

**Workspace limitations:**
- State files share the same backend — can't use different AWS accounts per workspace
- Easy to forget which workspace is active — accidental prod changes
- For true environment isolation (different accounts, different permissions), use separate root configurations with separate backends instead

### Terraform Registry and Module Versioning
```hcl
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"   # ~> 20.0 = >= 20.0, < 21.0
}

# Version constraints:
# = 20.5.0   — exact
# ~> 20.5    — >= 20.5, < 20.6 (patch only)
# ~> 20.0    — >= 20.0, < 21.0 (minor+patch)
# >= 20.0, < 21.0   — explicit range
```

Always pin module versions in production — `source = "...//module"` without a `version` is a footgun.

## Examples

### Multi-Environment with Modules
```hcl
# environments/prod/main.tf
module "network" {
  source      = "../../modules/network"
  environment = "prod"
  cidr_block  = "10.0.0.0/16"
  az_count    = 3
}

module "app" {
  source         = "../../modules/app"
  environment    = "prod"
  vpc_id         = module.network.vpc_id
  subnet_ids     = module.network.private_subnets
  instance_count = 4
  instance_type  = "t3.medium"
}
```

```
infrastructure/
  modules/
    network/    # reusable VPC, subnets, IGW, NAT
    app/        # reusable ECS/EC2 app deployment
    rds/        # reusable RDS cluster
  environments/
    dev/main.tf
    staging/main.tf
    prod/main.tf
```

### Call a Public Module
```hcl
# Use the community EKS module instead of writing 500 lines yourself
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "mycompany-prod"
  cluster_version = "1.29"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  eks_managed_node_groups = {
    general = {
      instance_types = ["t3.medium"]
      min_size       = 2
      max_size       = 10
      desired_size   = 3
    }
  }
}
```

## Exercises

1. Extract a repeated resource block (e.g. multiple S3 buckets or EC2 instances) into a module. Call it from the root module with different inputs for each instance. Verify `terraform plan` shows the same result as before.
2. Use `for_each` to create three S3 buckets from a `toset` of names. Then remove one name from the set — observe how `terraform plan` handles removal vs what would happen with `count`.
3. Create two workspaces (`dev` and `prod`). Use `terraform.workspace` to set different instance types in each. Apply in both workspaces and verify different instances were created via `terraform state list`.
4. Use the `terraform-aws-modules/s3-bucket/aws` module from the Terraform Registry to create an S3 bucket with versioning and encryption. Compare the amount of HCL needed vs writing the resources directly.


---

### Quick Checks

5. Count `module` blocks in an HCL config stub. Run: `printf 'module "vpc" {\n  source = "./modules/vpc"\n}\nmodule "eks" {\n  source = "./modules/eks"\n}\n' | grep -c '^module'`

```expected_output
2
```

hint: Think about how you can filter lines that start with a specific keyword and count the matches in a single command.
hint: Use grep with the -c flag and the anchored pattern '^module' to count only lines where 'module' appears at the very beginning.

6. Extract the resource type from a Terraform resource address. Run: `echo "aws_instance.web_server" | cut -d. -f1`

```expected_output
aws_instance
```

hint: Think about how you can split a string by a delimiter and select only the first segment.
hint: Use the cut command with the -d flag to specify '.' as the delimiter and -f1 to extract the first field.

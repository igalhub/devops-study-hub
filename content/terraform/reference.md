# Terraform — Quick Reference

## Core Workflow

| Command | Description |
|---------|-------------|
| `terraform init` | Initialize providers and modules |
| `terraform fmt` | Format HCL files |
| `terraform validate` | Validate configuration |
| `terraform plan` | Preview changes |
| `terraform plan -out=plan.tfplan` | Save plan to file |
| `terraform apply` | Apply changes (prompts) |
| `terraform apply -auto-approve` | Apply without prompt |
| `terraform apply plan.tfplan` | Apply saved plan |
| `terraform destroy` | Destroy all managed resources |
| `terraform destroy -auto-approve` | Destroy without prompt |

## State Management

| Command | Description |
|---------|-------------|
| `terraform show` | Print current state |
| `terraform state list` | List all resources in state |
| `terraform state show res.name` | Show specific resource |
| `terraform state mv src dst` | Rename resource in state |
| `terraform state rm res.name` | Remove from state (keeps infra) |
| `terraform state pull` | Print raw state JSON |
| `terraform import res.name id` | Import existing resource |
| `terraform refresh` | Sync state with real infra |

## Workspaces

| Command | Description |
|---------|-------------|
| `terraform workspace list` | List workspaces |
| `terraform workspace new name` | Create workspace |
| `terraform workspace select name` | Switch workspace |
| `terraform workspace show` | Current workspace |
| `terraform workspace delete name` | Delete workspace |

## Targeting & Inspection

| Command | Description |
|---------|-------------|
| `terraform plan -target=res.name` | Plan specific resource |
| `terraform apply -target=res.name` | Apply specific resource |
| `terraform output` | Show output values |
| `terraform output name` | Show specific output |
| `terraform graph \| dot -Tpng > graph.png` | Visualize dependency graph |
| `terraform providers` | Show required providers |
| `terraform version` | Show Terraform version |

## HCL Patterns

| Pattern | Description |
|---------|-------------|
| `variable "name" { default = "val" }` | Input variable |
| `var.name` | Reference variable |
| `output "name" { value = res.attr }` | Output value |
| `locals { key = value }` | Local value |
| `local.key` | Reference local |
| `data "aws_ami" "latest" { ... }` | Data source |
| `module "name" { source = "./modules/x" }` | Call module |
| `count = var.enabled ? 1 : 0` | Conditional resource |
| `for_each = toset(var.list)` | Create one per list item |
| `depends_on = [res.other]` | Explicit dependency |
| `lifecycle { prevent_destroy = true }` | Protect from destroy |

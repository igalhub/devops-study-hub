---
title: Ansible vs Terraform
module: ansible
duration_min: 15
difficulty: intermediate
tags: [ansible, terraform, iac, configuration-management, comparison, when-to-use]
exercises: 4
---

## Overview
Ansible and Terraform are both Infrastructure as Code tools, but they solve different problems. Using the wrong one for a job — or trying to replace one with the other — leads to pain. Understanding where each excels and how they complement each other is one of the most common DevOps interview topics and a genuine architectural decision you'll face repeatedly.

## Concepts

### Core Distinction
| | Terraform | Ansible |
|---|---|---|
| Primary purpose | Provisioning infrastructure | Configuring software |
| Model | Declarative (desired state) | Declarative in intent, procedural in execution |
| State | Tracks infrastructure state in `.tfstate` | Stateless — checks live system each run |
| Targets | Cloud resources, DNS, databases, k8s objects | Running servers, applications, files, packages |
| Agent | None (uses cloud APIs) | None (uses SSH) |
| Language | HCL | YAML + Jinja2 |
| Idempotency | Built-in (resource graph) | Per-module (mostly built-in, but not always) |

### Terraform's Strengths
```hcl
# Terraform is best at: creating and managing cloud infrastructure
resource "aws_eks_cluster" "main" { ... }
resource "aws_rds_instance" "db" { ... }
resource "aws_vpc" "main" { ... }
resource "aws_lb" "web" { ... }
resource "cloudflare_record" "api" { ... }
resource "github_repository" "myapp" { ... }
```

- Creating VPCs, subnets, security groups
- Provisioning cloud databases (RDS, CloudSQL)
- Managing DNS records (Route53, Cloudflare)
- Kubernetes cluster creation (EKS, GKE, AKS)
- IAM roles and policies
- Load balancers and CDN configuration
- **Anything where you need to know what exists before you can create it**

Terraform's state file knows your infrastructure topology. It can create resources in the right order, handle dependencies, and cleanly destroy everything it created.

### Ansible's Strengths
```yaml
# Ansible is best at: configuring servers after they exist
- name: Install and configure application stack
  hosts: webservers
  roles:
    - nginx
    - myapp
    - certbot

- name: Deploy application release
  hosts: webservers
  tasks:
    - name: Pull latest code
      ansible.builtin.git:
        repo: "{{ app_repo }}"
        version: "{{ app_version }}"
        dest: /opt/myapp

    - name: Run database migrations
      ansible.builtin.command: /opt/myapp/bin/migrate
```

- Installing and configuring OS packages
- Deploying application code
- Managing configuration files across many servers
- Running one-time tasks (migrations, data backups)
- Ad-hoc operations (`ansible all -m shell -a "uptime"`)
- Orchestrating multi-step deployments

### The Overlap Zone
Both tools can do things the other does — poorly:

| Task | Terraform | Ansible |
|---|---|---|
| Create an EC2 instance | ✓ (right tool) | ✓ (via `amazon.aws` collection, but no state) |
| Install nginx on EC2 | Possible (user_data) | ✓ (right tool) |
| Create S3 bucket | ✓ (right tool) | Possible (via module) |
| Deploy app code | Possible (null_resource + provisioner) | ✓ (right tool) |
| Manage DNS records | ✓ (right tool) | Possible |

**Terraform provisioners** (`remote-exec`, `local-exec`) can run scripts after creating a resource — but they don't track state, can't be re-run safely, and are considered a last resort.

### The Standard Pattern: Both Together
```
[Terraform]                          [Ansible]
  - Creates VPC, subnets               - Installs nginx, app deps
  - Provisions EC2 instances    →      - Deploys application code
  - Sets up RDS database               - Configures systemd services
  - Creates EKS cluster                - Runs database migrations
  - Outputs: instance IPs, DB URL      - Uses Terraform outputs as vars
```

```bash
# 1. Terraform provisions infrastructure
terraform apply

# 2. Get outputs for Ansible
DB_HOST=$(terraform output -raw db_endpoint)
WEB_IPS=$(terraform output -json web_ips)

# 3. Build dynamic Ansible inventory from Terraform state
# (or use terraform-inventory or a dynamic inventory script)

# 4. Ansible configures the servers
ansible-playbook -i inventory.py deploy.yml
```

### Ansible vs Other Config Management Tools
| Tool | Model | Agent | Language | Best for |
|---|---|---|---|---|
| Ansible | Push, agentless | No | YAML | General purpose, low barrier |
| Chef | Pull, agent | Yes | Ruby DSL | Large teams, complex policies |
| Puppet | Pull, agent | Yes | Puppet DSL | Enterprise, compliance |
| SaltStack | Push/pull | Yes | YAML + Python | Large scale, event-driven |

**Ansible's advantage:** no agents to install and maintain. Works on any server reachable over SSH. Quick to get started. **Disadvantage:** slower for very large fleets (SSH overhead) and less real-time than agent-based tools.

### When Kubernetes Changes the Equation
In a Kubernetes-centric environment:
- **Terraform** provisions the EKS/GKE cluster, node groups, networking, IAM
- **Helm** handles application deployment and configuration (replaces some Ansible use cases)
- **Ansible** still useful for: configuring EC2 bastion hosts, setting up the CI server, bootstrapping before k8s, non-containerized workloads

Ansible's server configuration use case shrinks in fully containerized environments — configuration management moves into Dockerfiles and Helm charts.

## Examples

### Terraform + Ansible Together
```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Provision
terraform -chdir=./infra apply -auto-approve

# 2. Wait for SSH to be available
DB_HOST=$(terraform -chdir=./infra output -raw db_host)
WEB_IPS=$(terraform -chdir=./infra output -json web_private_ips | jq -r '.[]')

# 3. Generate Ansible inventory from Terraform output
cat > /tmp/inventory.ini << EOF
[webservers]
$(echo "$WEB_IPS" | tr '\n' '\n')

[all:vars]
db_host=${DB_HOST}
ansible_user=ubuntu
ansible_ssh_private_key_file=~/.ssh/deploy
EOF

# 4. Configure
ansible-playbook -i /tmp/inventory.ini ./ansible/deploy.yml
```

## Exercises

1. List three infrastructure tasks you'd use Terraform for and three configuration tasks you'd use Ansible for. For each, explain why the other tool would be the wrong choice.
2. Design the IaC architecture for a 3-tier web application (load balancer, 3 app servers, RDS database): which parts does Terraform own, which parts does Ansible own, and how do they hand off to each other?
3. Research one real-world limitation of using Terraform for configuration management (hint: look at `null_resource` + `remote-exec` provisioner behavior on re-runs). Write a short explanation of why it's problematic.
4. Research one real-world limitation of using Ansible for infrastructure provisioning at scale (hint: look at its lack of state tracking for cloud resources). How does Terraform's state file solve this problem?

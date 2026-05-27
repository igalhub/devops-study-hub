---
title: Ansible vs Terraform
module: ansible
duration_min: 15
difficulty: intermediate
tags: [ansible, terraform, iac, configuration-management, comparison, when-to-use]
exercises: 4
---

## Overview

Ansible and Terraform are both Infrastructure as Code tools, but they solve fundamentally different problems. Terraform is a provisioner: it creates and manages the existence of infrastructure resources — VPCs, EC2 instances, RDS databases, DNS records — by talking directly to cloud APIs and tracking what it created in a state file. Ansible is a configurator: it connects to servers that already exist, installs software, writes config files, restarts services, and runs deployment steps. The mental model is simple: Terraform builds the stage; Ansible sets the props and directs the actors.

The core design difference is how each tool thinks about state. Terraform maintains a `.tfstate` file that represents the last known condition of your infrastructure. When you run `terraform apply`, it diffs your configuration against that state file and against the real world, then issues only the API calls needed to converge. Ansible has no such file. Every time an Ansible playbook runs, it reaches out to the live system, checks the current condition of each task, and acts if the condition isn't already satisfied. This makes Ansible resilient and self-healing for configuration drift, but it means Ansible has no memory of what cloud resources it created last Tuesday.

In the broader DevOps toolchain, these tools occupy adjacent but distinct layers. Terraform sits at the infrastructure layer — it's often run in CI pipelines during environment provisioning or by platform engineers managing shared infrastructure. Ansible sits at the configuration and deployment layer — it's invoked during application releases, OS hardening runs, and operational tasks. In Kubernetes-centric shops, Helm partially displaces Ansible for application delivery, but Ansible remains essential for everything that isn't a container: CI runners, bastion hosts, bare-metal nodes, legacy workloads. Knowing when to reach for each tool — and when they're being misused — is one of the most practical and frequently tested skills in a DevOps interview.

## Concepts

### Core Distinction

| Attribute | Terraform | Ansible |
|---|---|---|
| **Primary purpose** | Provision and manage infrastructure resources | Configure software and systems on existing servers |
| **Execution model** | Declarative: describe desired end state | Declarative in intent, procedural in execution order |
| **State tracking** | `.tfstate` file tracks every managed resource | Stateless — checks live system on every run |
| **Idempotency** | Built into the resource graph | Per-module; mostly built-in, but not guaranteed for `command`/`shell` |
| **Primary targets** | Cloud APIs, DNS providers, databases, Kubernetes objects | Running hosts reachable via SSH or WinRM |
| **Agent required** | No — uses cloud provider APIs | No — uses SSH (or WinRM for Windows) |
| **Language** | HCL (HashiCorp Configuration Language) | YAML + Jinja2 templating |
| **Secrets handling** | Terraform Vault provider, environment variables | Ansible Vault, `no_log: true` |
| **Parallelism** | Native resource graph enables parallel API calls | `forks` setting controls parallel SSH connections |

The most important row is **state tracking**. Terraform's state file is what allows it to know that `aws_instance.web` already exists and doesn't need to be recreated on the next run. Without state, every apply would try to create duplicate resources. Ansible checks the live system instead — which is perfect for configuration (idempotent modules check current file contents, package versions, service status), but inadequate for cloud provisioning where "does this VPC already exist?" requires a separate API call with no standardized mechanism.

### Terraform's Strengths

Terraform excels at any task where you need to create a resource, record that it exists, understand the dependency order between resources, and potentially destroy it cleanly later.

```hcl
# terraform/main.tf
# Terraform understands that the subnet depends on the VPC,
# and that the EC2 instance depends on both — it builds this
# dependency graph automatically and provisions in the right order.

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags        = { Name = "main" }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id   # implicit dependency via reference
  cidr_block        = "10.0.1.0/24"
  availability_zone = "us-east-1a"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.public.id  # waits for subnet to exist
}

resource "aws_route53_record" "web" {
  zone_id = var.zone_id
  name    = "api.example.com"
  type    = "A"
  ttl     = 300
  records = [aws_instance.web.public_ip]  # waits for EC2, gets its public IP
}
```

Terraform's strongest use cases:
- Creating VPCs, subnets, route tables, security groups
- Provisioning cloud databases (RDS, CloudSQL, Aurora)
- Managing DNS records (Route53, Cloudflare)
- Kubernetes cluster creation (EKS, GKE, AKS) and node group management
- IAM roles, policies, and cross-account trust relationships
- Load balancers, target groups, listener rules
- S3 buckets with policies and lifecycle rules
- **Any resource where creation order or circular dependencies matter**

**Key insight:** `terraform destroy` cleanly removes everything it created, in reverse dependency order. Ansible has no equivalent — it can't reliably reverse a playbook run against cloud resources because it has no record of what it created or in what order.

### Ansible's Strengths

Ansible excels at anything that happens *on* a server after it exists: installing software, writing files, starting services, running commands in sequence, deploying code.

```yaml
# ansible/deploy.yml
---
- name: Configure web servers
  hosts: webservers
  become: true  # escalate to root via sudo
  vars:
    app_version: "{{ lookup('env', 'APP_VERSION') | default('main') }}"
    app_repo: "https://github.com/myorg/myapp.git"

  tasks:
    - name: Install system dependencies
      ansible.builtin.apt:
        name:
          - python3
          - python3-pip
          - nginx
        state: present
        update_cache: true

    - name: Deploy application code
      ansible.builtin.git:
        repo: "{{ app_repo }}"
        version: "{{ app_version }}"
        dest: /opt/myapp
        force: true  # overwrite local changes; intentional for deploy
      notify: restart app  # triggers handler only if this task changed something

    - name: Write nginx config from template
      ansible.builtin.template:
        src: templates/nginx.conf.j2
        dest: /etc/nginx/sites-available/myapp
        owner: root
        group: root
        mode: "0644"
      notify: reload nginx

    - name: Run database migrations
      ansible.builtin.command:
        cmd: /opt/myapp/bin/migrate --env production
        chdir: /opt/myapp
      run_once: true          # only run on one host even if targeting many
      environment:
        DATABASE_URL: "{{ db_url }}"
      changed_when: true      # migrations always count as a change

  handlers:
    - name: restart app
      ansible.builtin.systemd:
        name: myapp
        state: restarted

    - name: reload nginx
      ansible.builtin.systemd:
        name: nginx
        state: reloaded
```

Ansible's strongest use cases:
- Installing and pinning OS packages across a fleet
- Writing templated config files (nginx, systemd units, app config)
- Managing services: start, stop, enable, disable, reload
- Deploying application releases in a controlled, ordered sequence
- Running one-time operational tasks: database migrations, cache flushes, log rotation
- Ad-hoc fleet operations: `ansible all -m shell -a "systemctl status nginx"`
- Rolling deployments with `serial: 1` to update one server at a time
- Bootstrapping new hosts before a full config management system is in place

**Handlers are a key Ansible pattern.** They only fire if the task that notified them reported a change — so `reload nginx` won't run on every playbook execution, only when the config template actually changed. Handlers also deduplicate: if five tasks all notify the same handler, it fires once at the end of the play. This makes playbooks efficient and safe to re-run repeatedly.

### The Overlap Zone

Both tools can technically do what the other does. Neither does it well when used outside its core role.

| Task | Terraform | Ansible |
|---|---|---|
| Create EC2 instance | ✅ Right tool | ⚠️ Possible via `amazon.aws` — no state, can't cleanly destroy |
| Install nginx on EC2 | ⚠️ Possible via `user_data` — runs once at boot, not re-runnable | ✅ Right tool |
| Create S3 bucket | ✅ Right tool | ⚠️ Possible — no drift detection without state |
| Write `/etc/nginx/nginx.conf` | ❌ Awkward (`null_resource` + file provisioner) | ✅ Right tool |
| Deploy application code | ❌ Wrong tool (`null_resource` + `remote-exec`) | ✅ Right tool |
| Manage DNS record | ✅ Right tool | ⚠️ Possible — no cleanup on record removal |
| Create IAM policy | ✅ Right tool | ⚠️ Possible — no drift detection |
| Rolling restart of services | ❌ Not designed for this | ✅ Right tool (`serial`) |

**Terraform provisioners (`remote-exec`, `local-exec`) are a trap.** They run scripts after a resource is created, but Terraform does not re-run them on subsequent `terraform apply` calls — only on resource creation. If the script fails midway, Terraform marks the resource as *tainted* and tries to recreate it on the next apply, which may cause data loss or downtime. The Terraform documentation explicitly labels provisioners a "last resort." Any non-trivial configuration work should be handed off to Ansible.

**Ansible lacks cloud resource state**, which creates real operational problems at scale. If an Ansible task creates an EC2 instance and you run the playbook again, it may try to create a second instance depending on the module's idempotency implementation. If you delete the resource manually, Ansible doesn't know. You cannot run `ansible-playbook destroy.yml` and expect it to reliably clean up cloud resources the way `terraform destroy` does.

### The Standard Integration Pattern

The canonical pattern in production environments: Terraform provisions, outputs relevant information, and Ansible consumes those outputs to configure what Terraform created.

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│         TERRAFORM           │     │           ANSIBLE           │
│                             │     │                             │
│  • VPC, subnets, SGs        │     │  • Install app dependencies │
│  • EC2 instances            │────▶│  • Write config files       │
│  • RDS database             │     │  • Deploy application code  │
│  • EKS cluster              │     │  • Run DB migrations        │
│  • S3 buckets               │     │  • Configure systemd units  │
│  • Route53 records          │     │  • Set up cron jobs         │
│  • IAM roles                │     │                             │
│         ↓                   │     │         ↑                   │
│  outputs: IPs, URLs,        │────▶│  vars: db_host, redis_url,  │
│           ARNs, endpoints   │     │         instance IPs         │
└─────────────────────────────┘     └─────────────────────────────┘
```

The handoff point is Terraform outputs. After `terraform apply`, you extract outputs and pass them to Ansible as inventory variables or extra vars:

```bash
# pipeline.sh — the glue between Terraform and Ansible
#!/usr/bin/env bash
set -euo pipefail

cd infra/
terraform apply -auto-approve

# Extract Terraform outputs as plain strings
DB_HOST=$(terraform output -raw db_host)
REDIS_URL=$(terraform output -raw redis_url)
# -json gives a JSON array; jq converts it to newline-separated IPs
WEB_IPS=$(terraform output -json web_private_ips | jq -r '.[]')

# Build an Ansible inventory dynamically from Terraform outputs.
# A production pipeline would use a dynamic inventory plugin instead,
# but this approach is transparent and easy to debug.
INVENTORY_FILE=$(mktemp /tmp/inventory.XXXXXX.ini)
cat > "$INVENTORY_FILE" << EOF
[webservers]
$(echo "$WEB_IPS")

[webservers:vars]
db_host=${DB_HOST}
redis_url=${REDIS_URL}
ansible_user=ubuntu
ansible_ssh_private_key_file=~/.ssh/deploy_key
ansible_ssh_common_args='-o StrictHostKeyChecking=no'
EOF

cd ../ansible/
ansible-playbook \
  -i "$INVENTORY_FILE" \
  --extra-vars "app_version=${APP_VERSION:-main}" \
  deploy.yml

rm "$INVENTORY_FILE"
```

For more sophisticated setups, the `cloud.terraform` Ansible collection provides a dynamic inventory plugin that reads directly from Terraform state without manual extraction:

```yaml
# ansible/inventory/terraform.yml
plugin: cloud.terraform.terraform_provider
project_path: ../infra/
# Reads infra/terraform.tfstate and exposes resources as inventory hosts.
# Instances tagged with ansible_group=webservers appear in the [webservers] group.
# Requires: ansible-galaxy collection install cloud.terraform
```

**Why not just use Terraform for everything?** Some teams reach for Terraform's `remote-exec` or `local-exec` provisioners to avoid the two-tool complexity. This almost always causes pain: you lose Ansible's idempotency, retry logic, templating, and the ability to re-run configuration independently of infrastructure lifecycle. The operational cost of two tools is lower than the debugging cost of misconfigured provisioners at 2 AM.

### Idempotency: Where Each Tool Stands

Idempotency means running the same operation multiple times produces the same result. Both tools aim for this, but through different mechanisms.

**Terraform idempotency** is handled at the engine level. The state file plus a live API read (the "refresh" step) tells Terraform exactly what exists. If the resource matches the config, no API call is made. This is reliable by default — you don't have to write defensive HCL.

**Ansible idempotency** is module-by-module. Well-written modules check before they act:
- `ansible.builtin.apt` checks if the package is already at the right version
- `ansible.builtin.template` checksums the rendered file against what's on disk
- `ansible.builtin.service` reads current service state before issuing start/stop

**The idempotency traps in Ansible:**

```yaml
# ❌ NOT idempotent — appends every time the playbook runs
- name: Add line to config
  ansible.builtin.command:
    cmd: echo "option=value" >> /etc/myapp/config.ini

# ✅ Idempotent — checks if line exists before adding
- name: Ensure option is set in config
  ansible.builtin.lineinfile:
    path: /etc/myapp/config.ini
    line: "option=value"
    state: present

# ❌ NOT idempotent without changed_when — always reports "changed"
# and always triggers any downstream handlers
- name: Run migration
  ansible.builtin.command:
    cmd: /opt/myapp/bin/migrate

# ✅ Use changed_when to control when Ansible considers this a change
- name: Run migration (only if needed)
  ansible.builtin.command:
    cmd: /opt/myapp/bin/migrate --check-first
  register: migrate_result
  changed_when: "'Applied' in migrate_result.stdout"

# ✅ Use creates: to skip a command if its output file already exists
- name: Compile assets (skip if already done)
  ansible.builtin.command:
    cmd: /opt/myapp/bin/compile-assets
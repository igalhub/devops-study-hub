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
| **Destroy / rollback** | `terraform destroy` cleanly removes in reverse order | No destroy equivalent for cloud resources |

The most important row is **state tracking**. Terraform's state file is what allows it to know that `aws_instance.web` already exists and doesn't need to be recreated on the next run. Without state, every apply would try to create duplicate resources. Ansible checks the live system instead — which is perfect for configuration (idempotent modules check current file contents, package versions, service status), but inadequate for cloud provisioning where "does this VPC already exist?" requires a separate API call with no standardized mechanism across providers.

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

# Outputs used downstream by Ansible
output "web_public_ip" {
  value = aws_instance.web.public_ip
}

output "web_private_ip" {
  value = aws_instance.web.private_ip
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

**Key insight:** `terraform destroy` cleanly removes everything it created, in reverse dependency order. Ansible has no equivalent — it can't reliably reverse a playbook run against cloud resources because it has no record of what it created or in what order. This asymmetry alone justifies separating infrastructure provisioning into Terraform.

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

    - name: Enable nginx site
      ansible.builtin.file:
        src: /etc/nginx/sites-available/myapp
        dest: /etc/nginx/sites-enabled/myapp
        state: link

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
        enabled: true

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
| Manage Kubernetes manifests | ✅ Via `kubernetes` provider | ✅ Via `kubernetes.core` collection |

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
│  • IAM roles                │     │  • Harden OS config         │
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
terraform init -input=false
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
trap "rm -f $INVENTORY_FILE" EXIT  # always clean up temp file

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

**Why not just use Terraform for everything?** Some teams reach for Terraform's `remote-exec` or `local-exec` provisioners to avoid the two-tool complexity. This almost always causes pain: you lose Ansible's idempotency, retry logic, templating, and the ability to re-run configuration independently of infrastructure lifecycle. The operational cost of maintaining two tools is lower than the debugging cost of misconfigured provisioners at 2 AM.

### Idempotency: Where Each Tool Stands

Idempotency means running the same operation multiple times produces the same result. Both tools aim for this, but through different mechanisms — and each has specific failure modes worth knowing.

**Terraform idempotency** is handled at the engine level. The state file plus a live API read (the "refresh" step) tells Terraform exactly what exists. If the resource matches the config, no API call is made. This is reliable by default — you don't have to write defensive HCL.

**Ansible idempotency** is module-by-module. Well-written modules check before they act:
- `ansible.builtin.apt` checks if the package is already at the right version
- `ansible.builtin.template` checksums the rendered file against what's on disk
- `ansible.builtin.service` reads current service state before issuing start/stop

The idempotency traps in Ansible all involve `command` and `shell`:

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
# and always triggers any downstream handlers unnecessarily
- name: Run migration
  ansible.builtin.command:
    cmd: /opt/myapp/bin/migrate

# ✅ Use changed_when to control when Ansible considers this a change
- name: Run migration (only if needed)
  ansible.builtin.command:
    cmd: /opt/myapp/bin/migrate --check-first
  register: migrate_result
  changed_when: "'Applied' in migrate_result.stdout"

# ✅ Use creates: to skip a command if its output artifact already exists
- name: Compile assets (skip if already done)
  ansible.builtin.command:
    cmd: /opt/myapp/bin/compile-assets
    creates: /opt/myapp/public/assets/manifest.json
```

**The `changed_when: false` pattern** is useful for read-only commands like health checks or status queries that you never want to show as changes:

```yaml
- name: Check cluster node count
  ansible.builtin.command:
    cmd: kubectl get nodes --no-headers | wc -l
  register: node_count
  changed_when: false   # this is a read — never a change
```

**Summary of idempotency approach by tool:**

| Scenario | Terraform behavior | Ansible behavior |
|---|---|---|
| Resource already matches config | No-op, no API call | Depends on module — most skip, `command` acts |
| Resource drifted from config | Detects and corrects | Detects and corrects (for supported modules) |
| Resource deleted externally | Detects on refresh, recreates | Doesn't know — module may create duplicate |
| Script/command tasks | Not applicable | Not idempotent without `creates:` or `changed_when:` |

### When to Reach for Each Tool: Decision Heuristic

A practical mental flowchart for choosing the right tool:

```
Is the task creating or destroying a cloud resource (instance, DB, network, DNS)?
  └─ YES → Terraform

Is the task configuring, installing, or deploying onto an existing server?
  └─ YES → Ansible

Is the task a rolling update across a fleet of running servers?
  └─ YES → Ansible (serial, max_fail_percentage)

Does the task need to be repeated or re-run independently of infrastructure lifecycle?
  └─ YES → Ansible

Does the task need to be cleanly reversible with an automated destroy?
  └─ YES → Terraform

Are you managing Kubernetes manifests on an existing cluster?
  └─ Either works — prefer Helm or kubectl for apps, Terraform for cluster config
```

**The "paved road" antipatterns to watch for in interviews and job descriptions:**
- "We use Terraform to install Docker on our servers" → should be Ansible
- "We use Ansible to manage our AWS VPCs" → should be Terraform
- "We use Terraform `remote-exec` to deploy our app" → should be split: Terraform provisions, Ansible deploys
- "We use Ansible to spin up and tear down test environments" → acceptable for simple cases, but Terraform handles the resource lifecycle better at any meaningful scale

## Examples

### Example 1: Provision an EC2 Instance with Terraform, Then Configure It with Ansible

This is the end-to-end workflow that most production pipelines follow.

**Step 1: Terraform provisions the server**

```hcl
# infra/main.tf
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_security_group" "web" {
  name        = "web-sg"
  description = "Allow HTTP and SSH"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]  # restrict to your IP in production
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "web" {
  ami                    = "ami-0c55b159cbfafe1f0"  # Amazon Linux 2 us-east-1
  instance_type          = "t3.micro"
  key_name               = var.key_pair_name
  vpc_security_group_ids = [aws_security_group.web.id]

  tags = {
    Name          = "web-server"
    ansible_group = "webservers"  # consumed by cloud.terraform dynamic inventory
  }
}

output "web_public_ip" {
  value = aws_instance.web.public_ip
}

output "web_public_dns" {
  value = aws_instance.web.public_dns
}
```

```bash
# Provision the infrastructure
cd infra/
terraform init
terraform plan   # review what will be created
terraform apply  # creates SG + EC2 instance

# Capture the IP for use in the next step
export WEB_IP=$(terraform output -raw web_public_ip)
echo "Server ready at: $WEB_IP"
```

**Step 2: Ansible configures nginx on the new server**

```yaml
# ansible/nginx.yml
---
- name: Configure nginx web server
  hosts: all
  become: true

  tasks:
    - name: Wait for SSH to be available
      ansible.builtin.wait_for_connection:
        timeout: 120  # new instances need time to boot and start sshd

    - name: Install nginx
      ansible.builtin.yum:
        name: nginx
        state: present

    - name: Write index page
      ansible.builtin.copy:
        content: "<h1>Deployed by Ansible on {{ inventory_hostname }}</h1>\n"
        dest: /usr/share/nginx/html/index.html
        mode: "0644"

    - name: Start and enable nginx
      ansible.builtin.systemd:
        name: nginx
        state: started
        enabled: true
```

```bash
# Run Ansible against the IP Terraform gave us
ansible-playbook \
  -i "${WEB_IP}," \           # trailing comma makes this an inline inventory
  -u ec2-user \
  --private-key ~/.ssh/my-key.pem \
  ansible/nginx.yml

# Verify it worked
curl "http://${WEB_IP}"
# Expected: <h1>Deployed by Ansible on <IP></h1>
```

---

### Example 2: Rolling Application Deployment with Ansible

This shows how Ansible handles a fleet update that Terraform cannot — updating servers one at a time to avoid downtime.

```yaml
# ansible/rolling-deploy.yml
---
- name: Rolling deploy of myapp
  hosts: webservers
  serial: 1              # update exactly 1 server at a time
  max_fail_percentage: 0 # abort the entire play if any host fails
  become: true

  vars:
    deploy_version: "{{ app_version | mandatory }}"  # fail loudly if not passed

  pre_tasks:
    - name: Remove host from load balancer
      ansible.builtin.uri:
        url: "https://lb.internal/api/members/{{ inventory_hostname }}"
        method: DELETE
        headers:
          Authorization: "Bearer {{ lb_token }}"
      delegate_to: localhost  # run this against the LB API from the control node

    - name: Wait for in-flight requests to drain
      ansible.builtin.pause:
        seconds: 10

  tasks:
    - name: Deploy new application version
      ansible.builtin.git:
        repo: https://github.com/myorg/myapp.git
        version: "{{ deploy_version }}"
        dest: /opt/myapp
        force: true
      notify: restart myapp

    - name: Install updated Python dependencies
      ansible.builtin.pip:
        requirements: /opt/myapp/requirements.txt
        virtualenv: /opt/myapp/.venv

  handlers:
    - name: restart myapp
      ansible.builtin.systemd:
        name: myapp
        state: restarted

  post_tasks:
    - name: Wait for application health check to pass
      ansible.builtin.uri:
        url: "http://{{ inventory_hostname }}:8080/health"
        status_code: 200
      retries: 10
      delay: 5
      until: result.status == 200
      register: result

    - name: Re-add host to load balancer
      ansible.builtin.uri:
        url: "https://lb.internal/api/members"
        method: POST
        body_format: json
        body:
          host: "{{ inventory_hostname }}"
          weight: 100
        headers:
          Authorization: "Bearer {{ lb_token }}"
      delegate_to: localhost
```

```bash
# Trigger a rolling deploy to all webservers
ansible-playbook \
  -i inventory/production.ini \
  --extra-vars "app_version=v2.4.1" \
  ansible/rolling-deploy.yml

# Watch it progress: each host is drained, updated, health-checked, re-added
# If any host's health check fails, the play stops before touching remaining hosts
```

---

### Example 3: Terraform Manages Database; Ansible Configures Application to Use It

This demonstrates the practical handoff of credentials and endpoints.

```hcl
# infra/rds.tf
resource "aws_db_instance" "app" {
  identifier        = "myapp-production"
  engine            = "postgres"
  engine_version    = "15.3"
  instance_class    = "db.t3.medium"
  allocated_storage = 20
  db_name           = "myapp"
  username          = "myapp"
  password          = var.db_password  # passed in via TF_VAR_db_password env var

  # skip_final_snapshot = false in production; set to true only for throwaway envs
  skip_final_snapshot = true
}

output "db_host" {
  value = aws_db_instance.app.address
}

output "db_port" {
  value = aws_db_instance.app.port
}
```

```bash
# Apply and capture outputs
terraform apply -auto-approve
export DB_HOST=$(terraform output -raw db_host)
export DB_PORT=$(terraform output -raw db_port)
```

```yaml
# ansible/templates/database.yml.j2
# This template is rendered by Ansible using vars passed from Terraform outputs
production:
  adapter: postgresql
  host: {{ db_host }}
  port: {{ db_port }}
  database: myapp
  username: myapp
  password: {{ db_password }}
  pool: 5
```

```yaml
# ansible/configure-app.yml
---
- name: Configure application database connection
  hosts: webservers
  become: true

  tasks:
    - name: Write database config from Terraform outputs
      ansible.builtin.template:
        src: templates/database.yml.j2
        dest: /opt/myapp/config/database.yml
        owner: myapp
        group: myapp
        mode: "0600"   # credentials file — restrict permissions
      no_log: true      # prevent db_password from appearing in Ansible output
      notify: restart myapp

  handlers:
    - name: restart myapp
      ansible.builtin.systemd:
        name: myapp
        state: restarted
```

```bash
ansible-playbook \
  -i inventory/production.ini \
  --extra-vars "db_host=${DB_HOST} db_port=${DB_PORT} db_password=${DB_PASSWORD}" \
  ansible/configure-app.yml

# Verify the app can reach the database
ansible webservers -i inventory/production.ini \
  -m command -a "/opt/myapp/bin/check-db-connection"
```

---

### Example 4: Using Terraform `user_data` vs Ansible for Bootstrap — Seeing the Difference

This example illustrates why `user_data` is inadequate for configuration management and when Ansible is the right follow-up.

```hcl
# infra/userdata.tf
# user_data runs ONCE at first boot — not re-runnable, not idempotent
resource "aws_instance" "app" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"

  # Only appropriate for minimal bootstrapping — install SSM agent,
  # set hostname, configure cloud-init. NOT for app deployment.
  user_data = <<-EOF
    #!/bin/bash
    yum update -y
    yum install -y python3
    # Stop here — hand off to Ansible for anything more complex
  EOF
}
```

```bash
# After Terraform creates the instance, Ansible handles everything else.
# If the nginx config changes next week, you re-run Ansible — not terraform apply.

WEB_IP=$(terraform output -raw web_public_ip)

# First run: installs everything
ansible-playbook -i "${WEB_IP}," -u ec2-user \
  --private-key ~/.ssh/key.pem playbook.yml

# Second run: no-op if nothing changed, or corrects drift
ansible-playbook -i "${WEB_IP}," -u ec2-user \
  --private-key ~/.ssh/key.pem playbook.yml
# Output: "changed=0" — this is the goal for a stable system

# If someone manually edits nginx.conf on the server (config drift):
ansible-playbook -i "${WEB_IP}," -u ec2-user \
  --private-key ~/.ssh/key.pem playbook.yml
# Output: "changed=1" — Ansible corrects it automatically
```

## Exercises

### Exercise 1: Identify Misused Tools in a Pipeline Script

Read the following CI pipeline fragment and identify every instance where the wrong tool is being used. For each one, explain what the problem is and how you would fix it.

```bash
#!/bin/bash
# deploy.sh — DO NOT USE AS-IS; contains intentional errors

# Step 1: Create VPC and subnets
ansible-playbook -i localhost, create-vpc.yml \
  -e "cidr=10.0.0.0/16 region=us-east-1"

# Step 2: Provision EC2 instance
ansible-playbook -i localhost, create-ec2.yml \
  -e "instance_type=t3.micro ami=ami-0c55b159cbfafe1f0"

# Step 3: Install nginx (runs once at launch)
cat > user_data.sh << 'EOF'
#!/bin/bash
apt-get install -y nginx
echo "server { listen 80; root /var/www/html; }" > /etc/nginx/sites-enabled/default
systemctl start nginx
EOF
# (user_data passed to EC2 above)

# Step 4: Deploy application
terraform apply -auto-approve \
  -var "app_version=${APP_VERSION}" \
  # Terraform null_resource runs remote-exec to git clone the app
```

Your answer should address: which steps belong in Terraform, which belong in Ansible, and why the `user_data` approach for nginx is a maintenance problem. No code submission needed — write your analysis as bullet points.

---

### Exercise 2: Write an Idempotent Ansible Task Block

The following task block contains three idempotency bugs. Fix all three without changing what the tasks are trying to accomplish.

```yaml
tasks:
  - name: Create app directory
    ansible.builtin.command:
      cmd: mkdir -p /opt/myapp

  - name: Add database URL to environment file
    ansible.builtin.command:
      cmd: echo "DATABASE_URL=postgres://localhost/myapp" >> /etc/environment

  - name: Generate self-signed TLS cert
    ansible.builtin.command:
      cmd: >
        openssl req -x509 -nodes -days 365 -newkey rsa:2048
        -keyout /etc/ssl/myapp.key
        -out /etc/ssl/myapp.crt
        -subj "/CN=myapp.internal"
```

Hint: use `ansible.builtin.file`, `ansible.builtin.lineinfile`, and the `creates:` parameter where appropriate. After your fix, running the playbook twice should show `changed=0` on the second run.

---

### Exercise 3: Build the Terraform-to-Ansible Handoff

Set up a minimal working integration between Terraform and Ansible using LocalStack (a local AWS emulator) or a real AWS account.

1. Write a `main.tf` that creates one EC2 instance (or LocalStack equivalent) and outputs its IP address and a fake `db_host` value using a `local_file` resource if you don't have AWS credentials.
2. Write a `pipeline.sh` that:
   - Runs `terraform apply`
   - Extracts the IP and db_host outputs
   - Builds a temporary Ansible inventory file with those values as `[webservers:vars]`
   - Runs `ansible-playbook -i` against that inventory
   - Cleans up the temp file on exit (use `trap`)
3. Write an `install.yml` playbook that installs nginx and writes a file to `/tmp/db_host.txt` containing the value of `{{ db_host }}`.
4. Verify: after running `pipeline.sh`, SSH to the server and confirm `/tmp/db_host.txt` contains the expected value.

**What to observe:** run `pipeline.sh` twice. On the second run, Terraform should show no changes. Ansible should show `changed=0` or `changed=1` only for tasks where the state actually differed.

---

### Exercise 4: Terraform Destroy vs Ansible Cleanup — Observe the Difference

This exercise builds intuition for the state gap between the two tools.

1. Use Terraform to provision two EC2 instances tagged `env=test`.
2. Write an Ansible playbook that installs a package and creates a file on both instances.
3. Manually terminate one instance through the AWS console (simulating unexpected deletion).
4. Run `terraform plan` — observe how Terraform detects the missing resource and proposes to recreate it.
5. Run the same Ansible playbook — observe what happens when Ansible tries to reach the terminated instance (it fails; Ansible has no awareness that the instance is gone).
6. Run `terraform destroy` — observe that it cleanly removes both instances (recreating the missing one first if you didn't run apply, or just destroying the remaining one).

Write a one-paragraph explanation of what you observed about how each tool handles external state changes, and what that means for which tool should own the lifecycle of cloud resources.
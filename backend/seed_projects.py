import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import get_conn

PROJECTS = [
    {
        "slug": "containerize-python-app",
        "title": "Containerize a Python App",
        "description": "Build and containerize a Python web service, then write a CI/CD pipeline to test and publish it.",
        "modules": ["Python", "Docker", "CI/CD Pipelines"],
        "difficulty": "intermediate",
        "steps": [
            {
                "order_index": 1,
                "title": "Generate a requirements file",
                "type": "sandbox",
                "prompt": (
                    "Write a bash command that creates `/tmp/requirements.txt` containing exactly two lines:\n\n"
                    "```\nflask==3.0.0\ngunicorn==21.2.0\n```\n\n"
                    "Then print the number of lines in the file."
                ),
                "language": "bash",
                "expected_output": "2",
            },
            {
                "order_index": 2,
                "title": "Parse app configuration",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that parses this YAML string and prints the value of `port`:\n\n"
                    '`name: my-app\\nport: 8080\\ndebug: false`\n\n'
                    "Import `yaml` from the standard PyYAML library."
                ),
                "language": "python",
                "expected_output": "8080",
            },
            {
                "order_index": 3,
                "title": "Write a production Dockerfile",
                "type": "ai",
                "prompt": (
                    "Write a multi-stage Dockerfile for a Python Flask application.\n\n"
                    "Stage 1 (builder): install dependencies from requirements.txt into a virtualenv.\n"
                    "Stage 2 (runtime): copy only the virtualenv and app code into a minimal base image.\n\n"
                    "Include best practices: non-root user, no dev packages in the final image, "
                    "a HEALTHCHECK instruction, and explicit EXPOSE."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Design the CI pipeline",
                "type": "ai",
                "prompt": (
                    "Write a GitHub Actions workflow (`.github/workflows/ci.yml`) that:\n"
                    "1. Triggers on push to `main` and on pull requests\n"
                    "2. Runs `pytest` with pip caching\n"
                    "3. Builds and pushes a Docker image to GitHub Container Registry (GHCR) only on merge to `main`\n"
                    "4. Caches Docker layers between runs\n\n"
                    "Explain briefly why you structured the jobs the way you did."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "zero-downtime-deploy",
        "title": "Zero-Downtime Kubernetes Deployment",
        "description": "Design a Kubernetes workload with rolling updates, readiness probes, and a self-healing strategy.",
        "modules": ["Kubernetes", "Docker", "CI/CD Pipelines"],
        "difficulty": "advanced",
        "steps": [
            {
                "order_index": 1,
                "title": "Extract image from kubectl output",
                "type": "sandbox",
                "prompt": (
                    "Use `awk` to extract the container image from this `kubectl get pods -o wide` output line "
                    "and print only the image name:\n\n"
                    "`myapp-6d4b8 1/1 Running 0 10m nginx:1.24`"
                ),
                "language": "bash",
                "expected_output": "nginx:1.24",
            },
            {
                "order_index": 2,
                "title": "Parse pod status JSON",
                "type": "sandbox",
                "prompt": (
                    "Write a bash one-liner (using Python) that parses this JSON and prints the pod phase:\n\n"
                    '`{"status":{"phase":"Running","hostIP":"10.0.0.1"}}`'
                ),
                "language": "bash",
                "expected_output": "Running",
            },
            {
                "order_index": 3,
                "title": "Write a Deployment manifest",
                "type": "ai",
                "prompt": (
                    "Write a complete Kubernetes Deployment manifest for an app called `api-server` with:\n"
                    "- 3 replicas\n"
                    "- Rolling update strategy: `maxSurge: 1`, `maxUnavailable: 0`\n"
                    "- CPU and memory resource requests and limits\n"
                    "- An HTTP readiness probe on `/health` port 8080 with appropriate `initialDelaySeconds`\n"
                    "- An HTTP liveness probe that gives the pod 30 seconds to start\n\n"
                    "Explain your choice of readiness vs liveness probe parameters."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Readiness vs liveness probes",
                "type": "ai",
                "prompt": (
                    "Explain the difference between Kubernetes readiness and liveness probes.\n\n"
                    "Specifically: describe a realistic scenario where a pod fails a readiness check but passes "
                    "a liveness check — and why that distinction matters for zero-downtime deployments.\n\n"
                    "Then write probe definitions for a service that has a 30-second startup warmup "
                    "but must be ready within 60 seconds of launch."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "linux-system-hardening",
        "title": "Linux System Hardening",
        "description": "Audit and lock down a Linux server: file permissions, SSH config, cron jobs, and user management.",
        "modules": ["Linux", "DevSecOps"],
        "difficulty": "intermediate",
        "steps": [
            {
                "order_index": 1,
                "title": "Find world-writable files",
                "type": "sandbox",
                "prompt": (
                    "Write a bash script that:\n"
                    "1. Creates a temp directory `/tmp/audit_test`\n"
                    "2. Creates `safe.conf` (permissions 644) and `danger.conf` (permissions 777) inside it\n"
                    "3. Finds and prints only the filename (not the full path) of any world-writable file in that directory"
                ),
                "language": "bash",
                "expected_output": "danger.conf",
            },
            {
                "order_index": 2,
                "title": "Extract privileged users",
                "type": "sandbox",
                "prompt": (
                    "Write a bash one-liner that extracts all users with UID 0 from this `/etc/passwd` snippet "
                    "and prints each username on its own line:\n\n"
                    "```\nroot:x:0:0:root:/root:/bin/bash\n"
                    "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n"
                    "admin:x:0:0::/home/admin:/bin/bash\n```"
                ),
                "language": "bash",
                "expected_output": "root\nadmin",
            },
            {
                "order_index": 3,
                "title": "Write SSH hardening config",
                "type": "ai",
                "prompt": (
                    "Write a production-ready `/etc/ssh/sshd_config` block with at least 8 hardening settings. "
                    "For each setting, add a one-line comment explaining why it matters.\n\n"
                    "Cover: root login, password authentication, key exchange algorithms, "
                    "session timeouts, allowed users, and port configuration."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Design a log rotation strategy",
                "type": "ai",
                "prompt": (
                    "Design a complete log rotation strategy for a web server generating logs in `/var/log/myapp/`.\n\n"
                    "Include:\n"
                    "1. A cron expression that runs at 2:30 AM daily\n"
                    "2. A bash script that compresses logs older than 7 days, deletes logs older than 30 days, "
                    "and sends a webhook alert if disk usage on the partition exceeds 80%\n\n"
                    "Explain each decision, including why you chose those retention thresholds."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "observability-stack",
        "title": "Observability Stack Setup",
        "description": "Deploy a full observability stack with Prometheus and Grafana, write PromQL queries, and configure alerting.",
        "modules": ["Prometheus", "Grafana", "Docker"],
        "difficulty": "intermediate",
        "steps": [
            {
                "order_index": 1,
                "title": "Extract a metric value",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that parses this Prometheus text-format string and prints "
                    "the integer value for `http_requests_total` where `method=\"GET\"`:\n\n"
                    '`http_requests_total{method="GET",status="200"} 1234\\n'
                    'http_requests_total{method="POST",status="200"} 56`'
                ),
                "language": "python",
                "expected_output": "1234",
            },
            {
                "order_index": 2,
                "title": "Parse an alerting rule",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that parses this Prometheus alerting rule YAML "
                    "and prints the alert name:\n\n"
                    "```\ngroups:\n- name: infra\n  rules:\n  - alert: InstanceDown\n"
                    "    expr: up == 0\n    for: 5m\n```"
                ),
                "language": "python",
                "expected_output": "InstanceDown",
            },
            {
                "order_index": 3,
                "title": "Write PromQL queries",
                "type": "ai",
                "prompt": (
                    "Write PromQL queries for these three scenarios:\n"
                    "1. HTTP request rate per second over the last 5 minutes, broken down by status code\n"
                    "2. 95th percentile request latency using a histogram metric `http_request_duration_seconds`\n"
                    "3. An alerting expression that fires when any instance has been down for more than 5 minutes\n\n"
                    "Explain the difference between `rate()` and `irate()` and why you chose one over the other for query 1."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Design the full stack",
                "type": "ai",
                "prompt": (
                    "Write a `docker-compose.yml` that runs:\n"
                    "- Prometheus (port 9090) scraping itself and a Node Exporter\n"
                    "- Node Exporter (port 9100)\n"
                    "- Grafana (port 3000) pre-configured with Prometheus as a data source\n\n"
                    "Include: named volumes for Prometheus data and Grafana dashboards, "
                    "a minimal `prometheus.yml` scrape config as an inline comment, "
                    "and Grafana datasource provisioning via environment variables."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "gitops-argocd",
        "title": "GitOps Pipeline with ArgoCD",
        "description": "Implement a GitOps deployment model using ArgoCD: write Application manifests, configure sync strategies, and design a multi-environment promotion workflow.",
        "modules": ["Git & VCS", "Kubernetes", "CI/CD Pipelines"],
        "difficulty": "advanced",
        "steps": [
            {
                "order_index": 1,
                "title": "Count merge commits",
                "type": "sandbox",
                "prompt": (
                    "Write a bash one-liner that counts the number of merge commits in this "
                    "`git log --oneline` output and prints just the count:\n\n"
                    "```\nabc1234 Merge pull request #12 from org/feature/login\n"
                    "def5678 feat: add user dashboard\n"
                    "ghi9012 Merge pull request #11 from org/feature/signup\n"
                    "jkl3456 fix: typo in README\n```"
                ),
                "language": "bash",
                "expected_output": "2",
            },
            {
                "order_index": 2,
                "title": "Parse ArgoCD application status",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that parses this ArgoCD Application status JSON "
                    "and prints the sync status:\n\n"
                    '`{"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}`'
                ),
                "language": "python",
                "expected_output": "Synced",
            },
            {
                "order_index": 3,
                "title": "Write an ArgoCD Application manifest",
                "type": "ai",
                "prompt": (
                    "Write a complete ArgoCD `Application` manifest that:\n"
                    "- Deploys from a Git repo `https://github.com/org/k8s-manifests` path `apps/api-server`\n"
                    "- Targets the `staging` namespace on the local cluster\n"
                    "- Uses `automated` sync policy with self-healing and pruning enabled\n"
                    "- Tracks the `main` branch\n\n"
                    "Explain the difference between ArgoCD's `Synced` and `Healthy` status fields, "
                    "and what it means when a resource is `OutOfSync` but `Healthy`."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Design environment promotion strategy",
                "type": "ai",
                "prompt": (
                    "Design a GitOps multi-environment promotion workflow for dev → staging → production "
                    "using a single Git repository.\n\n"
                    "Cover:\n"
                    "1. Directory structure for environment-specific manifests\n"
                    "2. How image version promotion is triggered (manual PR vs automated image updater)\n"
                    "3. How to prevent dev changes from accidentally reaching production\n"
                    "4. What a rollback looks like in a GitOps model vs `kubectl rollout undo`\n\n"
                    "Be specific: name files, branches, or tools where relevant."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "ansible-config",
        "title": "Ansible Server Configuration",
        "description": "Automate Linux server provisioning with Ansible: write playbooks, define roles, manage inventory, and enforce idempotent configuration across a fleet.",
        "modules": ["Ansible", "Linux"],
        "difficulty": "intermediate",
        "steps": [
            {
                "order_index": 1,
                "title": "Count tasks in a playbook",
                "type": "sandbox",
                "prompt": (
                    "Write a bash one-liner that counts the number of tasks in this Ansible playbook "
                    "snippet and prints just the count:\n\n"
                    "```\n- hosts: webservers\n  tasks:\n"
                    "    - name: Install nginx\n      apt:\n        name: nginx\n"
                    "    - name: Enable nginx\n      service:\n        name: nginx\n        state: started\n"
                    "    - name: Copy config\n      copy:\n        src: nginx.conf\n        dest: /etc/nginx/nginx.conf\n```"
                ),
                "language": "bash",
                "expected_output": "3",
            },
            {
                "order_index": 2,
                "title": "Count hosts in an inventory group",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that counts the number of hosts in the `[webservers]` group "
                    "of this Ansible inventory and prints just the count:\n\n"
                    "`[webservers]\\nweb1.example.com\\nweb2.example.com\\nweb3.example.com\\n"
                    "[dbservers]\\ndb1.example.com`"
                ),
                "language": "python",
                "expected_output": "3",
            },
            {
                "order_index": 3,
                "title": "Write an Nginx Ansible role",
                "type": "ai",
                "prompt": (
                    "Write an Ansible role called `nginx` that:\n"
                    "1. Installs Nginx via the OS package manager\n"
                    "2. Deploys a Jinja2 template for `nginx.conf` with variables for `worker_processes` and `server_name`\n"
                    "3. Ensures Nginx is enabled and started\n"
                    "4. Uses a `handler` to reload Nginx only when the config changes\n\n"
                    "Show the full role directory structure with content for: `tasks/main.yml`, "
                    "`handlers/main.yml`, `templates/nginx.conf.j2`, and `defaults/main.yml`.\n\n"
                    "Explain why using a handler for config reload is preferable to an unconditional service restart."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Design idempotent user management",
                "type": "ai",
                "prompt": (
                    "Write an Ansible playbook that manages a team of engineers across a fleet of servers. "
                    "The playbook should:\n"
                    "1. Create user accounts from a `users` list variable (each with name, groups, and SSH public key)\n"
                    "2. Remove users who appear in a `removed_users` list\n"
                    "3. Ensure sudo access for users in the `admins` group\n"
                    "4. Deploy each user's SSH authorized key\n\n"
                    "The playbook must be fully idempotent — running it twice must produce no changes on the second run. "
                    "Show the playbook YAML and a sample `group_vars/all.yml`. "
                    "Explain how Ansible's `user` module achieves idempotency for account management."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "elk-log-pipeline",
        "title": "ELK Stack Log Analysis",
        "description": "Build a full log ingestion pipeline with Logstash and Elasticsearch, write Query DSL searches, and design a Kibana dashboard with alerting.",
        "modules": ["Elasticsearch", "Logstash", "Kibana"],
        "difficulty": "advanced",
        "steps": [
            {
                "order_index": 1,
                "title": "Extract HTTP status from an access log",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that extracts the HTTP status code from this Apache access log line "
                    "and prints it:\n\n"
                    '`192.168.1.100 - admin [29/May/2026:14:22:31 +0000] "POST /api/users HTTP/1.1" 201 412`'
                ),
                "language": "python",
                "expected_output": "201",
            },
            {
                "order_index": 2,
                "title": "Parse an Elasticsearch query response",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that parses this Elasticsearch query response and "
                    "prints the total number of matching documents:\n\n"
                    '`{"hits":{"total":{"value":247,"relation":"eq"},"hits":[]}}`'
                ),
                "language": "python",
                "expected_output": "247",
            },
            {
                "order_index": 3,
                "title": "Write a Logstash pipeline for Apache logs",
                "type": "ai",
                "prompt": (
                    "Write a complete Logstash pipeline configuration (`logstash.conf`) that:\n"
                    "1. **Input**: reads from a file `/var/log/apache2/access.log` with `sincedb_path => /dev/null`\n"
                    "2. **Filter**: uses `grok` to parse the Apache Combined Log Format, extracts `clientip`, `verb`, `request`, `response`, `bytes`; "
                    "uses `date` to parse the timestamp into `@timestamp`; adds a `geoip` lookup on `clientip`; "
                    "drops health-check requests where `request == '/health'`\n"
                    "3. **Output**: sends to Elasticsearch index `apache-logs-%%{+YYYY.MM.dd}`\n\n"
                    "Explain what the `sincedb_path => /dev/null` setting does and when you would remove it in production."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Design index lifecycle and Kibana dashboard",
                "type": "ai",
                "prompt": (
                    "Design an Elasticsearch Index Lifecycle Management (ILM) policy for the Apache log index that:\n"
                    "- Rolls over at 50GB or 30 days (whichever comes first)\n"
                    "- Moves to warm phase after 7 days (force merge to 1 segment, set replicas to 0)\n"
                    "- Deletes after 90 days\n\n"
                    "Then describe a Kibana dashboard for a web ops team — name the panels, "
                    "the visualisation type for each (e.g. area chart, data table, metric), "
                    "and what question each panel answers.\n\n"
                    "Finally, write a Kibana alerting rule that fires when the 5xx error rate "
                    "exceeds 5% over a 5-minute window."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "helm-chart",
        "title": "Helm Chart Development",
        "description": "Build a production-grade Helm chart for a microservice with templating, values overrides, and a multi-environment deployment strategy using Helm upgrade and rollback.",
        "modules": ["Helm", "Kubernetes"],
        "difficulty": "intermediate",
        "steps": [
            {
                "order_index": 1,
                "title": "Scaffold a Helm chart directory",
                "type": "sandbox",
                "prompt": (
                    "Write a bash script that creates a minimal Helm chart directory at `/tmp/mychart` with "
                    "exactly 3 template files (`deployment.yaml`, `service.yaml`, `ingress.yaml`) inside `templates/`, "
                    "then prints the count of `.yaml` files in that directory."
                ),
                "language": "bash",
                "expected_output": "3",
            },
            {
                "order_index": 2,
                "title": "Parse Helm values YAML",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that parses this Helm `values.yaml` content and prints the replica count:\n\n"
                    "`replicaCount: 3\\nimage:\\n  repository: nginx\\n  tag: \\\"1.24\\\"\\nservice:\\n  port: 80`"
                ),
                "language": "python",
                "expected_output": "3",
            },
            {
                "order_index": 3,
                "title": "Write a Helm chart for a stateless service",
                "type": "ai",
                "prompt": (
                    "Write a Helm chart for a stateless web service called `api-server`. "
                    "Show the content of these files:\n\n"
                    "1. `Chart.yaml` — with `apiVersion: v2`, name, version, and appVersion\n"
                    "2. `values.yaml` — with defaults for replicaCount, image (repository + tag + pullPolicy), "
                    "service (type + port), resources (requests + limits), and ingress (enabled flag, host, tls)\n"
                    "3. `templates/deployment.yaml` — templated with `{{ .Values.* }}` references, "
                    "including resource limits and a liveness probe\n"
                    "4. `templates/service.yaml` — ClusterIP service using `{{ .Values.service.port }}`\n\n"
                    "Use `{{ include \"api-server.fullname\" . }}` for naming and show the `_helpers.tpl` snippet "
                    "that defines it."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Multi-environment values and release management",
                "type": "ai",
                "prompt": (
                    "Describe a strategy for deploying the same Helm chart to dev, staging, and production "
                    "environments with different values.\n\n"
                    "1. Show the file structure for per-environment values files\n"
                    "2. Write the `helm upgrade --install` commands for each environment, "
                    "explaining the flags used\n"
                    "3. Explain what `helm rollback` does vs manually reverting the values file in Git — "
                    "when would you use each?\n"
                    "4. What does `helm diff upgrade` (from the helm-diff plugin) tell you, "
                    "and why should it be part of every CI pipeline that deploys via Helm?"
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "api-security-testing",
        "title": "API Security & Testing",
        "description": "Design and execute a comprehensive API testing strategy: validate authentication flows, test for OWASP API vulnerabilities, and automate security checks in CI.",
        "modules": ["Postman / API Testing", "DevSecOps"],
        "difficulty": "intermediate",
        "steps": [
            {
                "order_index": 1,
                "title": "Validate JWT structure",
                "type": "sandbox",
                "prompt": (
                    "Write a bash one-liner that prints the number of parts in this JWT "
                    "(a valid JWT has exactly 3 parts separated by dots):\n\n"
                    "`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
                    ".eyJzdWIiOiJ1c2VyMTIzIn0"
                    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`"
                ),
                "language": "bash",
                "expected_output": "3",
            },
            {
                "order_index": 2,
                "title": "Decode a JWT payload",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that base64-decodes the middle segment of this JWT "
                    "and prints the value of the `sub` field:\n\n"
                    "`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
                    ".eyJzdWIiOiJ1c2VyMTIzIn0"
                    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`\n\n"
                    "Hint: split on `.`, take index 1, use `base64.urlsafe_b64decode` — "
                    "add `'=' * (-len(payload) % 4)` to fix padding."
                ),
                "language": "python",
                "expected_output": "user123",
            },
            {
                "order_index": 3,
                "title": "Write a Postman collection for an auth API",
                "type": "ai",
                "prompt": (
                    "Write a Postman collection (JSON) for an authentication API with these three requests:\n\n"
                    "1. **POST /auth/login** — body `{email, password}`, test that response status is 200 "
                    "and response body contains a `token` field; save the token to a collection variable\n"
                    "2. **GET /api/profile** — uses the saved token as a Bearer header; "
                    "test that status is 200 and response body contains `email`\n"
                    "3. **POST /auth/login (invalid)** — wrong password; test that status is 401 "
                    "and error message is present\n\n"
                    "Show the pre-request scripts and test scripts for each request. "
                    "Explain why you'd put the token in a collection variable rather than hardcoding it."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Design an API security testing strategy",
                "type": "ai",
                "prompt": (
                    "Design an API security testing strategy covering these OWASP API Security Top 10 risks:\n\n"
                    "- **API1** (Broken Object Level Authorization): describe a test scenario and how to automate it\n"
                    "- **API3** (Broken Object Property Level Authorization): give a concrete example using a PATCH endpoint\n"
                    "- **API5** (Broken Function Level Authorization): explain how to find and test admin-only endpoints\n"
                    "- **API8** (Security Misconfiguration): list 5 headers or settings to check in every response\n\n"
                    "Then describe how you would integrate these checks into a CI pipeline using Newman "
                    "(the Postman CLI runner), so that a failing security test blocks the PR."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
    {
        "slug": "iac-aws-vpc",
        "title": "Infrastructure as Code: AWS VPC",
        "description": "Write Terraform to provision a production-grade AWS VPC with subnets, security groups, and extract it into a reusable module.",
        "modules": ["Terraform", "AWS", "Networking Essentials"],
        "difficulty": "advanced",
        "steps": [
            {
                "order_index": 1,
                "title": "Count Terraform variable blocks",
                "type": "sandbox",
                "prompt": (
                    "Write a bash one-liner that counts the number of `variable` blocks in this HCL snippet "
                    "and prints just the count:\n\n"
                    "```\nvariable \"region\" { default = \"us-east-1\" }\n"
                    "variable \"env\" { default = \"prod\" }\n"
                    "variable \"cidr\" { default = \"10.0.0.0/16\" }\n```"
                ),
                "language": "bash",
                "expected_output": "3",
            },
            {
                "order_index": 2,
                "title": "Parse Terraform output JSON",
                "type": "sandbox",
                "prompt": (
                    "Write a Python one-liner that parses this Terraform output JSON and prints the VPC ID value:\n\n"
                    '`{"vpc_id":{"value":"vpc-0abc1234","type":"string"}}`'
                ),
                "language": "python",
                "expected_output": "vpc-0abc1234",
            },
            {
                "order_index": 3,
                "title": "Write a reusable VPC module",
                "type": "ai",
                "prompt": (
                    "Write a Terraform module for a production AWS VPC. "
                    "The module should accept variables for: CIDR block, environment name, and list of AZs.\n\n"
                    "It should create:\n"
                    "- The VPC with DNS hostnames enabled\n"
                    "- One public subnet per AZ\n"
                    "- One private subnet per AZ\n"
                    "- An internet gateway attached to public subnets\n"
                    "- A NAT gateway in the first public subnet (with an Elastic IP)\n"
                    "- Appropriate route tables for public and private subnets\n\n"
                    "Show `main.tf`, `variables.tf`, and `outputs.tf`. "
                    "Use consistent naming with the environment variable."
                ),
                "language": None,
                "expected_output": None,
            },
            {
                "order_index": 4,
                "title": "Security group design",
                "type": "ai",
                "prompt": (
                    "Write Terraform `aws_security_group` resources for a 3-tier application:\n"
                    "1. **Web tier** — allows HTTP (80) and HTTPS (443) from anywhere; SSH (22) from a bastion CIDR only\n"
                    "2. **App tier** — allows traffic only from the web tier security group on port 8080\n"
                    "3. **Database tier** — allows PostgreSQL (5432) only from the app tier security group\n\n"
                    "Use security group references (not CIDR) for inter-tier rules. "
                    "Explain why security group references are preferable to CIDR-based rules for internal traffic."
                ),
                "language": None,
                "expected_output": None,
            },
        ],
    },
]


def seed_projects():
    conn = get_conn()
    try:
        for p in PROJECTS:
            existing = conn.execute(
                "SELECT id FROM projects WHERE slug = ?", (p["slug"],)
            ).fetchone()
            if existing:
                continue
            conn.execute(
                "INSERT INTO projects (slug, title, description, modules, difficulty) VALUES (?, ?, ?, ?, ?)",
                (p["slug"], p["title"], p["description"], json.dumps(p["modules"]), p["difficulty"]),
            )
            project_id = conn.execute(
                "SELECT id FROM projects WHERE slug = ?", (p["slug"],)
            ).fetchone()["id"]
            for step in p["steps"]:
                conn.execute(
                    "INSERT INTO project_steps "
                    "(project_id, order_index, title, type, prompt, language, expected_output) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        project_id,
                        step["order_index"],
                        step["title"],
                        step["type"],
                        step["prompt"],
                        step.get("language"),
                        step.get("expected_output"),
                    ),
                )
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    seed_projects()
    print("Projects seeded.")

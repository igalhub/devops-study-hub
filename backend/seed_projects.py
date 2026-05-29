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

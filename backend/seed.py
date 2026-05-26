from db import get_conn, init_db

CURRICULUM = [
    {
        'group': 'Foundations',
        'modules': [
            {'slug': 'linux', 'title': 'Linux', 'lessons': [
                {'slug': 'filesystem-permissions', 'title': 'File System & Permissions', 'duration_min': 15, 'difficulty': 'intermediate'},
                {'slug': 'systemd', 'title': 'systemd & Service Management', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'ssh', 'title': 'SSH & Key Management', 'duration_min': 15, 'difficulty': 'beginner'},
                {'slug': 'cron', 'title': 'Cron Jobs', 'duration_min': 10, 'difficulty': 'beginner'},
                {'slug': 'package-managers', 'title': 'Package Managers (apt/yum)', 'duration_min': 10, 'difficulty': 'beginner'},
                {'slug': 'networking-commands', 'title': 'Networking Commands', 'duration_min': 15, 'difficulty': 'intermediate'},
            ]},
            {'slug': 'python', 'title': 'Python', 'lessons': [
                {'slug': 'scripting-fundamentals', 'title': 'Scripting Fundamentals', 'duration_min': 30, 'difficulty': 'beginner'},
                {'slug': 'subprocess-automation', 'title': 'Subprocess & Automation', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'boto3', 'title': 'boto3 — AWS SDK', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'cli-tools', 'title': 'Writing CLI Tools', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'yaml-json', 'title': 'YAML & JSON Parsing', 'duration_min': 15, 'difficulty': 'beginner'},
            ]},
            {'slug': 'bash', 'title': 'Bash / Shell', 'lessons': [
                {'slug': 'script-basics', 'title': 'Script Writing Basics', 'duration_min': 20, 'difficulty': 'beginner'},
                {'slug': 'error-handling', 'title': 'Error Handling', 'duration_min': 15, 'difficulty': 'intermediate'},
                {'slug': 'regex', 'title': 'Regex', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'awk-sed', 'title': 'awk & sed', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'pipes-redirects', 'title': 'Pipes & Redirects', 'duration_min': 10, 'difficulty': 'beginner'},
            ]},
            {'slug': 'git', 'title': 'Git & VCS', 'lessons': [
                {'slug': 'branching-strategies', 'title': 'Branching Strategies', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'rebase-vs-merge', 'title': 'Rebase vs Merge', 'duration_min': 15, 'difficulty': 'intermediate'},
                {'slug': 'git-hooks', 'title': 'Git Hooks', 'duration_min': 15, 'difficulty': 'intermediate'},
                {'slug': 'pr-workflows', 'title': 'PR Workflows', 'duration_min': 15, 'difficulty': 'beginner'},
            ]},
            {'slug': 'networking', 'title': 'Networking Essentials', 'lessons': [
                {'slug': 'tcp-ip', 'title': 'TCP/IP Fundamentals', 'duration_min': 20, 'difficulty': 'beginner'},
                {'slug': 'dns', 'title': 'DNS', 'duration_min': 15, 'difficulty': 'beginner'},
                {'slug': 'http-https', 'title': 'HTTP & HTTPS', 'duration_min': 15, 'difficulty': 'beginner'},
                {'slug': 'firewalls-lb', 'title': 'Firewalls & Load Balancers', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'subnets-cidr', 'title': 'Subnets & CIDR', 'duration_min': 15, 'difficulty': 'intermediate'},
            ]},
        ],
    },
    {
        'group': 'Containers & Infra',
        'modules': [
            {'slug': 'docker', 'title': 'Docker', 'lessons': [
                {'slug': 'images-containers', 'title': 'Images & Containers', 'duration_min': 20, 'difficulty': 'beginner'},
                {'slug': 'docker-compose', 'title': 'Docker Compose', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'multi-stage-builds', 'title': 'Multi-stage Builds', 'duration_min': 15, 'difficulty': 'intermediate'},
                {'slug': 'image-optimization', 'title': 'Image Optimization', 'duration_min': 15, 'difficulty': 'intermediate'},
                {'slug': 'registry', 'title': 'Registry Management', 'duration_min': 10, 'difficulty': 'beginner'},
            ]},
            {'slug': 'kubernetes', 'title': 'Kubernetes', 'lessons': [
                {'slug': 'pods-deployments', 'title': 'Pods & Deployments', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'services-ingress', 'title': 'Services & Ingress', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'rbac', 'title': 'RBAC', 'duration_min': 20, 'difficulty': 'advanced'},
                {'slug': 'persistent-volumes', 'title': 'Persistent Volumes', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'kubectl', 'title': 'kubectl Mastery', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'configmaps-secrets', 'title': 'ConfigMaps & Secrets', 'duration_min': 15, 'difficulty': 'intermediate'},
            ]},
            {'slug': 'helm', 'title': 'Helm', 'lessons': [
                {'slug': 'charts-basics', 'title': 'Charts, Templates & Values', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'managing-releases', 'title': 'Managing Releases', 'duration_min': 15, 'difficulty': 'intermediate'},
                {'slug': 'custom-charts', 'title': 'Writing Custom Charts', 'duration_min': 25, 'difficulty': 'advanced'},
            ]},
            {'slug': 'terraform', 'title': 'Terraform', 'lessons': [
                {'slug': 'hcl-basics', 'title': 'HCL Fundamentals', 'duration_min': 20, 'difficulty': 'beginner'},
                {'slug': 'state-management', 'title': 'State Management', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'modules-workspaces', 'title': 'Modules & Workspaces', 'duration_min': 20, 'difficulty': 'intermediate'},
            ]},
            {'slug': 'ansible', 'title': 'Ansible', 'lessons': [
                {'slug': 'playbooks', 'title': 'Playbooks & Inventory', 'duration_min': 20, 'difficulty': 'beginner'},
                {'slug': 'roles', 'title': 'Roles', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'ansible-vs-terraform', 'title': 'Ansible vs Terraform', 'duration_min': 15, 'difficulty': 'intermediate'},
            ]},
        ],
    },
    {
        'group': 'CI/CD & Cloud',
        'modules': [
            {'slug': 'cicd', 'title': 'CI/CD Pipelines', 'lessons': [
                {'slug': 'github-actions', 'title': 'GitHub Actions', 'duration_min': 30, 'difficulty': 'intermediate'},
                {'slug': 'jenkins', 'title': 'Jenkins', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'argocd-gitops', 'title': 'ArgoCD & GitOps', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'pipeline-best-practices', 'title': 'Pipeline Best Practices', 'duration_min': 20, 'difficulty': 'intermediate'},
            ]},
            {'slug': 'aws', 'title': 'AWS', 'lessons': [
                {'slug': 'ec2-s3-iam', 'title': 'EC2, S3 & IAM', 'duration_min': 35, 'difficulty': 'intermediate'},
                {'slug': 'vpc-route53', 'title': 'VPC & Route53', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'eks', 'title': 'EKS — Managed Kubernetes', 'duration_min': 30, 'difficulty': 'intermediate'},
                {'slug': 'lambda', 'title': 'Lambda', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'cost-management', 'title': 'Cost Management', 'duration_min': 20, 'difficulty': 'intermediate'},
            ]},
            {'slug': 'gcp', 'title': 'GCP', 'lessons': [
                {'slug': 'compute-storage', 'title': 'Compute Engine & GCS', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'gke', 'title': 'GKE — Managed Kubernetes', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'cloud-functions', 'title': 'Cloud Functions', 'duration_min': 20, 'difficulty': 'intermediate'},
            ]},
            {'slug': 'monitoring', 'title': 'Monitoring (Datadog)', 'lessons': [
                {'slug': 'observability-pillars', 'title': 'Metrics, Logs & Traces', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'alerting-dashboards', 'title': 'Alerting & Dashboards', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'apm', 'title': 'APM', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'opentelemetry', 'title': 'OpenTelemetry Basics', 'duration_min': 20, 'difficulty': 'intermediate'},
            ]},
        ],
    },
    {
        'group': 'Security & APIs',
        'modules': [
            {'slug': 'devsecops', 'title': 'DevSecOps', 'lessons': [
                {'slug': 'secrets-management', 'title': 'Secrets Management', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'container-security', 'title': 'Container Security', 'duration_min': 25, 'difficulty': 'intermediate'},
                {'slug': 'sast-dast', 'title': 'SAST & DAST Basics', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'iam-best-practices', 'title': 'IAM Best Practices', 'duration_min': 20, 'difficulty': 'intermediate'},
            ]},
            {'slug': 'postman', 'title': 'Postman / API Testing', 'lessons': [
                {'slug': 'rest-fundamentals', 'title': 'REST API Fundamentals', 'duration_min': 20, 'difficulty': 'beginner'},
                {'slug': 'collections-environments', 'title': 'Collections & Environments', 'duration_min': 20, 'difficulty': 'intermediate'},
                {'slug': 'automated-tests', 'title': 'Automated Tests', 'duration_min': 20, 'difficulty': 'intermediate'},
            ]},
        ],
    },
]


def seed():
    init_db()
    conn = get_conn()

    first_module = True
    for group_idx, group_data in enumerate(CURRICULUM):
        group_name = group_data['group']
        for mod_idx, mod in enumerate(group_data['modules']):
            is_locked = 0 if first_module else 1
            first_module = False
            conn.execute(
                "INSERT OR IGNORE INTO modules (slug, title, group_name, order_index, is_locked) VALUES (?, ?, ?, ?, ?)",
                (mod['slug'], mod['title'], group_name, group_idx * 100 + mod_idx, is_locked)
            )
            conn.commit()
            module_id = conn.execute("SELECT id FROM modules WHERE slug = ?", (mod['slug'],)).fetchone()['id']

            for lesson_idx, lesson in enumerate(mod.get('lessons', [])):
                md_path = f"content/{mod['slug']}/{lesson['slug']}.md"
                conn.execute(
                    """INSERT OR IGNORE INTO lessons
                       (module_id, title, slug, duration_min, difficulty, order_index, md_path)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (module_id, lesson['title'], lesson['slug'],
                     lesson.get('duration_min', 15), lesson.get('difficulty', 'beginner'),
                     lesson_idx, md_path)
                )

    conn.commit()
    conn.close()
    print("Database seeded.")


if __name__ == '__main__':
    seed()

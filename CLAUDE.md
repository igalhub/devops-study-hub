# DevOps Study Hub — Project Instructions

## Project Purpose
An interactive study hub to learn the DevOps skills required to land a job in the field.

## Curriculum Scope
23 modules across 5 groups:
- **Foundations:** Linux, Python, Bash/Shell, Git & VCS, Networking Essentials
- **Containers & Infra:** Docker, Kubernetes, Helm, Terraform, Ansible
- **CI/CD & Cloud:** CI/CD Pipelines, AWS, GCP, Monitoring (Datadog)
- **Security & APIs:** DevSecOps, Postman / API Testing
- **Observability:** Prometheus, Grafana, Zabbix, Elasticsearch, Logstash, Kibana, Opsgenie

91 lessons total, 455 quiz questions seeded (5 per lesson).

## Core Features
- **Study Content Tracking** — what's been covered, what's pending
- **Content Planning** — structured learning path
- **Daily Operations** — session management, streaks, goals
- **Code Builds** — in-app code execution for exercises

## Killer Features
- **AI Tutor** — answers questions in context of the current lesson
- **Code Sandbox** — write and run Bash/Python exercises inline
- **Spaced Repetition Quizzes** — SM-2 algorithm, 5 questions per lesson
- **Roadmap View** — visual skill tree showing what to learn next
- **Interview Prep Mode** — common DevOps interview questions with AI feedback

## Tone & Style
Rigorous, direct, no fluff. Cover things properly but don't pad. Breadth and rigor equally — cast a wide net, do it well.

## Architecture Authority
Always reference `devops-study-hub-prd.md` at the project root for authoritative architecture and component specs before making any structural changes.

## Content Expansion
Use `/expand-content` to expand thin lesson content. The skill enforces code-review after patches and a single-module smoke test before the full run — do not bypass it by running `seed_curriculum.py` directly for a full batch.

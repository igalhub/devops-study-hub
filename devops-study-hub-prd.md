# PRD — DevOps Study Hub

## Problem
A developer transitioning into DevOps needs structured, hands-on learning
that builds real job-ready skills — not passive reading. Existing platforms
(Udemy, Linux Foundation, etc.) lack personalization, active recall, and
integrated practice environments.

## Success Criteria
- Can confidently answer common DevOps interview questions
- Has hands-on experience with every tool in the curriculum
- Demonstrates measurable progress via quiz scores and roadmap completion
- Lands a DevOps job

## Scope

### In
- Curriculum: 23 modules across 5 groups — Foundations, Containers & Infra,
  CI/CD & Cloud, Security & APIs, Observability (see Module Content Outline)
- Features: AI Tutor, Code Sandbox, Spaced Repetition Quizzes,
  Roadmap View, Interview Prep Mode
- Study tracking, content planning, daily session management

### Out
- Mobile app (web-first)
- Multi-user / team features
- Paid content or marketplace
- Public deployment (local-only for now)

## Constraints
- Solo developer
- Linux desktop environment
- Local-only deployment for now

## UI Design
- Theme: dark/light toggleable
- Layout: 3-column — sidebar (220px) | lesson area | right panel (380px)
- Sidebar: grouped modules with badge states (Done / % In Progress)
- Right panel: Quiz tab + AI Tutor tab per lesson

## Curriculum

| Group | Modules |
|---|---|
| Foundations | Linux, Python, Bash/Shell, Git & VCS, Networking Essentials |
| Containers & Infra | Docker, Kubernetes, Helm, Terraform, Ansible |
| CI/CD & Cloud | CI/CD Pipelines, AWS, GCP, Monitoring (Datadog) |
| Security & APIs | DevSecOps, Postman / API Testing |
| Observability | Prometheus, Grafana, Zabbix, Elasticsearch, Logstash, Kibana, Opsgenie |

**91 lessons total. All modules unlocked (no progressive gating).**

## Module Content Outline

### Linux
- File system & permissions, systemd & service management
- SSH & key management, cron jobs
- Package managers (apt/yum), networking commands (netstat, ss, curl)

### Python
- Scripting fundamentals, subprocess & automation
- boto3 (AWS SDK), writing CLI tools, YAML/JSON parsing

### Bash/Shell
- Script writing best practices, error handling
- Regex, awk/sed, pipes & redirects

### Git & VCS
- Branching strategies (GitFlow vs trunk-based)
- Rebase vs merge, git hooks, PR workflows

### Networking Essentials
- TCP/IP, DNS, HTTP/HTTPS fundamentals
- Firewalls, load balancers, subnets & CIDR

### Docker
- Images, containers, volumes, networking
- Docker Compose, multi-stage builds
- Image optimization, registry management

### Kubernetes
- Pods, deployments, services, ingress
- RBAC, persistent volumes, kubectl mastery
- ConfigMaps & Secrets

### Helm
- Charts, templates, values
- Installing & managing releases
- Writing custom charts

### Terraform
- HCL fundamentals, providers & resources
- State management, modules, workspaces

### Ansible
- Playbooks, inventory, roles
- Configuration management vs Terraform

### CI/CD Pipelines
- GitHub Actions, Jenkins, ArgoCD & GitOps
- Pipeline best practices (caching, secrets, parallelism)

### AWS
- EC2, S3, VPC, IAM, Route53
- EKS, Lambda, cost management

### GCP
- Compute Engine, GCS, VPC, IAM
- GKE, Cloud Functions

### Monitoring (Datadog)
- Metrics vs logs vs traces (observability pillars)
- Alerting, dashboards, APM, OpenTelemetry

### DevSecOps
- Secrets management (HashiCorp Vault, AWS Secrets Manager)
- Container security, SAST/DAST, IAM best practices

### Postman / API Testing
- REST API fundamentals, request/response anatomy
- Collections, environments, automated tests

### Prometheus
- Metrics model (Counter, Gauge, Histogram, Summary), pull-based architecture
- PromQL (rate, irate, histogram_quantile, aggregations)
- Alertmanager (routing, inhibition, silences)
- Exporters & Kubernetes service discovery

### Grafana
- Data sources & panel types
- Dashboard design, variables, annotations
- Grafana alerting (unified alert model)

### Zabbix
- Architecture (server, proxy, agent)
- Templates, triggers, alert escalation

### Elasticsearch
- Distributed architecture (shards, replicas, nodes)
- Indexing, querying (Query DSL), mappings
- Cluster operations, security (TLS, RBAC)

### Logstash
- Pipeline architecture (inputs, filters, outputs)
- Grok parsing, enrichment, performance tuning

### Kibana
- Discover, visualizations, dashboards
- Kibana alerting, Lens

### Opsgenie
- On-call schedules, escalation policies
- Alert routing, incident workflows

## Tech Stack

### Frontend
- React + Vite
- Tailwind CSS
- React Router
- Monaco Editor (code sandbox)
- react-markdown + remark-gfm (lesson rendering)
- react-syntax-highlighter (code blocks)

### Backend
- FastAPI (Python) — API layer, Claude proxy, progress/quiz endpoints
- SQLite via `hub.db` — all persistent state
- Anthropic SDK — AI Tutor, quiz generation, interview prep

### AI
- Claude API via FastAPI backend (API key never exposed to frontend)
- Model: claude-sonnet-4-6 (configurable via CLAUDE_MODEL env var)

## Content Architecture
- Lesson content: pre-written Markdown files under `content/<module>/<lesson>.md`
- Each lesson has YAML frontmatter (title, module, duration_min, difficulty, tags, exercises)
- Quiz questions: seeded into SQLite via seeding scripts; never embedded in JS
- Content pipeline:
  - `seed.py` — seeds modules and lessons into DB from content/ directory
  - `seed_quiz.py` — handcrafted quiz questions (Prometheus lessons)
  - `seed_quiz_all.py` — batch AI-generated quiz questions for all lessons
  - `seed_curriculum.py` — full pipeline: detects thin content, expands via Claude API,
    then seeds quiz questions in one pass (idempotent, auto-commits)

## Code Sandbox
- Monaco Editor for inline code editing (Bash, Python)
- Actual subprocess execution via FastAPI backend — no simulated output
- Local-only; no container isolation for MVP

## Progress Tracking
- SQLite via FastAPI backend
- Tracks: completion per lesson, quiz attempts, XP, daily streaks, SRS schedule
- Progress is per-lesson; module % derived from lesson completion

## Project Structure
```
devops-study-hub/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── AiTutor.jsx
│   │   │   ├── CodePlayground.jsx
│   │   │   ├── Quiz.jsx
│   │   │   ├── Sidebar.jsx
│   │   │   └── ThemeToggle.jsx
│   │   ├── pages/
│   │   │   ├── InterviewPrep.jsx
│   │   │   ├── LessonViewer.jsx
│   │   │   ├── ModuleView.jsx
│   │   │   ├── Review.jsx        # Spaced repetition review queue
│   │   │   └── Roadmap.jsx
│   │   ├── store/
│   │   │   ├── curriculumStore.js
│   │   │   └── themeStore.js
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   └── package.json
├── backend/
│   ├── main.py              # FastAPI app entry point
│   ├── db.py                # SQLite schema + connection helpers
│   ├── seed.py              # Seeds modules & lessons from content/
│   ├── seed_quiz.py         # Handcrafted quiz questions (Prometheus)
│   ├── seed_quiz_all.py     # Batch AI quiz generation for all lessons
│   ├── seed_curriculum.py   # Full pipeline: expand content + seed quiz
│   ├── requirements.txt
│   ├── .env                 # ANTHROPIC_API_KEY (never committed)
│   └── routes/
│       ├── ai.py            # AI Tutor (streaming Claude responses)
│       ├── interview.py     # Interview Prep mode
│       ├── lessons.py       # Lesson content endpoints
│       ├── modules.py       # Module listing
│       ├── progress.py      # Lesson completion, XP, streaks
│       ├── quiz.py          # Quiz fetch, attempt recording, SRS queue
│       └── sandbox.py       # Code execution (subprocess)
├── content/                 # 91 .md lesson files
│   ├── linux/               # 6 lessons
│   ├── python/              # 5 lessons
│   ├── bash/                # 5 lessons
│   ├── git/                 # 4 lessons
│   ├── networking/          # 5 lessons
│   ├── docker/              # 5 lessons
│   ├── kubernetes/          # 6 lessons
│   ├── helm/                # 3 lessons
│   ├── terraform/           # 3 lessons
│   ├── ansible/             # 3 lessons
│   ├── cicd/                # 4 lessons
│   ├── aws/                 # 5 lessons
│   ├── gcp/                 # 3 lessons
│   ├── monitoring/          # 4 lessons
│   ├── devsecops/           # 4 lessons
│   ├── postman/             # 3 lessons
│   ├── prometheus/          # 4 lessons
│   ├── grafana/             # 3 lessons
│   ├── zabbix/              # 3 lessons
│   ├── elasticsearch/       # 4 lessons
│   ├── logstash/            # 3 lessons
│   ├── kibana/              # 3 lessons
│   └── opsgenie/            # 3 lessons
├── .claude/
│   ├── commands/              # Project slash commands (gitignored)
│   │   ├── dev-check.md
│   │   ├── expand-content.md  # Guided safe content expansion workflow
│   │   ├── seed-reset.md
│   │   └── test.md
│   ├── verify-data.sh         # Data integrity checks (run via /verify-data)
│   └── docs-manifest.sh       # Ground-truth outputs for /update-docs
├── devops-study-hub-prd.md
├── CLAUDE.md
├── start-backend.sh
└── start-frontend.sh
```

## Data Model

```
modules           id, slug, title, group_name, order_index, is_locked
lessons           id, module_id, slug, title, duration_min, difficulty, order_index, md_path
progress          id, lesson_id, status (not_started/in_progress/complete), completed_at
quiz_questions    id, lesson_id, question, options (JSON), correct_index, explanation
interview_questions  id, module_id, question
quiz_attempts     id, lesson_id, question_id, answer, is_correct, attempted_at
xp_log            id, source (lesson/quiz/streak), points, earned_at
streaks           id, date, completed (bool)
srs_schedule      question_id (PK), interval_days, ease, next_review, reviews
```

- Progress is per-lesson; module completion % is derived
- Quiz questions are seeded (5 per lesson, 455 total); questions served from DB
- SRS uses SM-2 algorithm: correct answers space out review intervals, wrong answers reset
- XP is append-only (never mutated): 10 XP per lesson, 5 XP per correct quiz answer

## Content File Format

Every lesson is a `.md` file with this structure:

```markdown
---
title: File System & Permissions
module: linux
duration_min: 15
difficulty: intermediate  # beginner / intermediate / advanced
tags: [permissions, chmod, chown, filesystem]
exercises: 3
---

## Overview
...

## Concepts
...

## Examples
...code blocks...

## Exercises
...hands-on tasks...
```

## XP Rules

| Action | XP |
|---|---|
| Complete a lesson | 10 XP |
| Quiz correct (first try) | 5 XP |
| Quiz correct (retry) | 2 XP |
| Complete a full module | 50 XP bonus |
| Daily streak bonus | +20% on all XP earned that day |

## Phases (all shipped)

### Phase 1 — Foundation ✅
- Project scaffold (React + Vite frontend, FastAPI backend, SQLite)
- Curriculum loaded from content/ directory (23 modules, 91 lessons)
- Roadmap View

### Phase 2 — Active Learning ✅
- Lesson viewer with Markdown rendering (tables, syntax-highlighted code)
- AI Tutor (streaming Claude responses, lesson-context aware)
- Code Sandbox (Monaco Editor + subprocess execution)

### Phase 3 — Retention ✅
- Spaced Repetition Quizzes (SM-2 algorithm)
- 455 quiz questions seeded (5 per lesson) via seeding pipeline
- Batch content expansion pipeline (seed_curriculum.py)

### Phase 4 — Job Readiness ✅
- Interview Prep Mode with AI-generated questions and feedback

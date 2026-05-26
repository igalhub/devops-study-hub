# PRD — DevOps Study Hub

## Problem
Igal is transitioning into DevOps and needs structured, hands-on learning
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
- Curriculum: 16 modules across 4 groups — Foundations, Containers & Infra,
  CI/CD & Cloud, Security & APIs (see Module Content Outline)
- Features: AI Tutor, Code Sandbox, Spaced Repetition Quizzes,
  Roadmap View, Interview Prep Mode
- Study tracking, content planning, daily session management

### Out
- Mobile app (web-first)
- Multi-user / team features
- Paid content or marketplace
- Public deployment (local-only for now)
- Fine-grained design decisions (deferred — iterate after MVP)

## Constraints
- Solo developer (Igal)
- Linux desktop environment
- Local-only deployment for now
- Budget: TBD

## UI Design
- Reference: `devops_study_hub_mockup.html` (on Desktop/AI/)
- Theme: dark/light toggleable
- Layout: 3-column — sidebar (220px) | lesson area | right panel (280px)
- Sidebar: grouped modules with badge states (Done / % In Progress / Locked)
- Right panel: Quiz + AI Tutor + Roadmap mini-view combined
- Design improvements deferred until after MVP

## Curriculum

| Group | Modules |
|---|---|
| Foundations | Linux, Python, Bash/Shell, Git & VCS, Networking Essentials |
| Containers & Infra | Docker, Kubernetes, Helm, Terraform, Ansible |
| CI/CD & Cloud | CI/CD Pipelines, AWS, GCP, Monitoring (Datadog) |
| Security & APIs | DevSecOps, Postman / API Testing |

## Module Content Outline

### Linux
- File system & permissions, systemd & service management
- SSH & key management, cron jobs
- Package managers (apt/yum), networking commands (netstat, ss, curl)

### Python
- Scripting fundamentals, subprocess & automation
- boto3 (AWS SDK), writing CLI tools, YAML/JSON parsing
- REST API consumption

### Bash/Shell
- Script writing best practices, error handling
- Regex, awk/sed, pipes & redirects

### Git & VCS
- Branching strategies (GitFlow vs trunk-based)
- Rebase vs merge, git hooks, PR workflows

### Networking Essentials
- TCP/IP, DNS, HTTP/HTTPS fundamentals
- Firewalls, load balancers, VPNs, subnets & CIDR

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
- Configuration management vs Terraform (when to use which)

### CI/CD Pipelines
- GitHub Actions (primary), Jenkins, GitLab CI
- ArgoCD & GitOps patterns
- Pipeline best practices (caching, secrets, parallelism)

### AWS
- EC2, S3, VPC, IAM, Route53
- EKS (managed Kubernetes), Lambda
- Cost management basics

### GCP
- Compute Engine, GCS, VPC, IAM
- GKE (managed Kubernetes), Cloud Functions

### Monitoring (Datadog)
- Metrics vs logs vs traces (observability pillars)
- Alerting, dashboards, APM
- OpenTelemetry basics

### DevSecOps
- Secrets management (HashiCorp Vault, AWS Secrets Manager)
- Container security, SAST/DAST basics, IAM best practices

### Postman / API Testing
- REST API fundamentals, request/response anatomy
- Collections, environments, automated tests

## Tech Stack

### Frontend
- React + Vite
- Tailwind CSS
- React Router
- Monaco Editor (code sandbox)
- react-markdown (lesson rendering)

### Backend
- FastAPI (Python) — proxies Claude API calls, serves progress data
- SQLite — progress tracking, quiz scores, study schedule

### AI
- Claude API via FastAPI backend (API key never exposed to frontend)

## Content Architecture
- Content is fully dynamic: topics can be added, removed, and reordered
  on the study schedule at any time
- System provides a default curriculum as a starting point; Igal adjusts it
- Lesson content is pre-written Markdown (.md files), imported or fetched
  at runtime — not embedded in JS files
- Content units are modular and decoupled from the schedule layer
- AI Tutor supplements lesson content with context-aware Q&A per lesson

## Code Sandbox
- Monaco Editor for inline code editing (Bash, Python)
- Actual subprocess execution via FastAPI backend — no simulated output
- Local-only; no container isolation needed for MVP

## Progress Tracking
- SQLite via FastAPI backend
- Tracks: completion per module, quiz scores, XP, daily streaks
- Replaces localStorage — persistent, portable, queryable

## Project Structure
```
devops-study-hub/
├── frontend/
│   ├── src/
│   │   ├── modules/         # One folder per topic
│   │   │   ├── linux/
│   │   │   │   ├── lessons/ # .md files
│   │   │   │   └── quizzes.js
│   │   │   ├── docker/
│   │   │   └── kubernetes/
│   │   ├── components/
│   │   │   ├── AiTutor.jsx
│   │   │   ├── CodePlayground.jsx
│   │   │   ├── Quiz.jsx
│   │   │   └── ProgressTracker.jsx
│   │   └── App.jsx
│   └── package.json
├── backend/
│   ├── main.py              # FastAPI app
│   ├── routes/
│   │   ├── ai.py            # Claude API proxy
│   │   ├── progress.py      # Progress endpoints
│   │   └── sandbox.py       # Code execution
│   └── db.py                # SQLite setup
├── content/                 # Shared .md lesson files
│   ├── linux/
│   ├── docker/
│   └── kubernetes/
└── .env                     # ANTHROPIC_API_KEY (backend only)
```

## Phases

### Phase 1 — Foundation
- Project scaffold (React + Vite frontend, FastAPI backend)
- Default curriculum loaded from content/ directory
- Roadmap View (skill tree)
- Study schedule with dynamic add/remove/reorder

### Phase 2 — Active Learning
- Lesson viewer (Markdown rendering)
- AI Tutor (Claude API via backend, lesson-context aware)
- Code Sandbox (Monaco + subprocess execution via backend)

### Phase 3 — Retention
- Spaced Repetition Quizzes

### Phase 4 — Job Readiness
- Interview Prep Mode with AI feedback

## Data Model

```
modules         id, slug, title, group, order_index, is_locked
lessons         id, module_id, title, slug, duration_min, difficulty, order_index, md_path
progress        id, lesson_id, status (not_started/in_progress/complete), completed_at
quiz_attempts   id, lesson_id, question_id, answer, is_correct, attempted_at
xp_log          id, source (lesson/quiz/streak), points, earned_at
streaks         id, date, completed (bool)
```

- Progress is per-lesson; module % is derived
- Quiz attempts logged individually to support spaced repetition
- XP is append-only, never mutated

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

## Module Unlock Rules

- A module unlocks when the previous module reaches **80% completion**
- Completion % = lessons with status `complete` / total lessons in module
- Manual override available (Igal can unlock any module manually)

## XP Rules

| Action | XP |
|---|---|
| Complete a lesson | 10 XP |
| Quiz correct (first try) | 5 XP |
| Quiz correct (retry) | 2 XP |
| Complete a full module | 50 XP bonus |
| Daily streak bonus | +20% on all XP earned that day |

## Open Questions
1. What does the default curriculum baseline look like —
   hand-curated topic list or AI-generated syllabus?
2. Do you have existing study materials to import?
3. Quiz format — multiple choice only, or free-text answers with AI grading?
4. Should the Code Sandbox support Docker commands in addition to Bash/Python?

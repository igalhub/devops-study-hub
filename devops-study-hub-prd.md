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
  Roadmap View, Interview Prep Mode, Projects
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
- AI calls isolated behind `ai_client.py` wrapper (swappable — see `backend/PROVIDERS.md`)

### AI
- Claude API via FastAPI backend (API key never exposed to frontend)
- Model: claude-sonnet-4-6 (configurable via CLAUDE_MODEL env var)

## Content Architecture
- Lesson content: pre-written Markdown files under `content/<module>/<lesson>.md`
- Each lesson has YAML frontmatter (title, module, duration_min, difficulty, tags, exercises)
- Quiz questions: seeded into SQLite via seeding scripts; never embedded in JS
- Content pipeline:
  - `seed.py` — seeds modules and lessons into DB from content/ directory
  - `seed_curriculum.py` — full pipeline: detects thin content, expands via Claude API,
    then seeds quiz questions in one pass (idempotent, auto-commits); `--quiz-only` or
    `--force-quiz` to regenerate quiz questions without expanding content
  - `seed_interview.py` — pre-seeds interview questions (8 per module) for all 23 modules; `--hints-only` backfills 2 progressive hints per question
  - `seed_exercise_hints.py` — adds 2 Claude-generated hints to Quick Check exercises that have `expected_output` but no hints; `--dry-run` and `--module` flags

## Code Sandbox
- Monaco Editor for inline code editing (Bash, Python, YAML)
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
│   │   │   ├── BookmarksDropdown.jsx
│   │   │   ├── CodePlayground.jsx
│   │   │   ├── Notes.jsx
│   │   │   ├── Quiz.jsx
│   │   │   ├── RecentDropdown.jsx
│   │   │   ├── SearchModal.jsx
│   │   │   ├── Sidebar.jsx
│   │   │   ├── ThemeToggle.jsx
│   │   │   └── __tests__/           # Vitest component tests (101 tests)
│   │   ├── pages/
│   │   │   ├── InterviewPrep.jsx
│   │   │   ├── LessonViewer.jsx
│   │   │   ├── ModuleQuiz.jsx
│   │   │   ├── ModuleView.jsx
│   │   │   ├── ProjectDetail.jsx # Multi-step project detail + sandbox/AI steps
│   │   │   ├── Projects.jsx      # Projects list page
│   │   │   ├── Review.jsx        # Spaced repetition review queue
│   │   │   ├── Roadmap.jsx
│   │   │   └── Stats.jsx
│   │   ├── store/
│   │   │   ├── curriculumStore.js
│   │   │   └── themeStore.js
│   │   ├── utils/
│   │   │   └── readiness.js      # Shared readiness color utility
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── test-setup.js            # Vitest global setup (@testing-library/jest-dom)
│   │   └── index.css
│   ├── e2e/
│   │   └── app.spec.js          # Playwright E2E suite (39 flows)
│   └── package.json
├── backend/
│   ├── main.py              # FastAPI app entry point
│   ├── ai_client.py         # AI provider wrapper (generate + stream_text; swap via PROVIDERS.md)
│   ├── PROVIDERS.md         # Drop-in implementations for OpenAI, Ollama, AWS Bedrock
│   ├── db.py                # SQLite schema + connection helpers
│   ├── srs.py               # Shared SM-2 spaced repetition logic
│   ├── seed.py              # Seeds modules & lessons from content/
│   ├── seed_curriculum.py   # Full pipeline: expand content + seed quiz
│   ├── seed_interview.py    # Pre-seeds interview questions (8 per module); --hints-only to backfill hints
│   ├── seed_exercise_hints.py  # Adds 2 Claude hints to Quick Check exercises in lesson markdown
│   ├── seed_projects.py     # Seeds 10 projects + steps (runs at startup)
│   ├── reset_progress.py    # Wipes all progress tables; preserves content (quiz/interview/projects)
│   ├── requirements.txt
│   ├── .env                 # ANTHROPIC_API_KEY (never committed)
│   ├── tests/
│   │   └── test_api.py      # 94 tests (infra + per-feature + parser + SRS unit + projects + quiz + notes + search + integrity + error handling + quick wins + gap coverage + full-curriculum + exercise SRS + project completion bonus)
│   └── routes/
│       ├── ai.py            # AI Tutor (streaming Claude responses)
│       ├── interview.py     # Interview Prep mode
│       ├── lessons.py       # Lesson content endpoints
│       ├── modules.py       # Module listing
│       ├── notes.py         # Per-lesson notes (fetch, save)
│       ├── progress.py      # Lesson completion, XP, streaks
│       ├── quiz.py          # Quiz fetch, attempt recording, SRS queue
│       ├── sandbox.py       # Code execution (subprocess)
│       ├── search.py        # Full-text content search
│       ├── stats.py         # Aggregate stats endpoint
│       ├── export.py        # Progress export (JSON backup)
│       └── projects.py      # Projects CRUD + sandbox/AI-grade step endpoints
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
│   │   ├── cleanup.md
│   │   ├── dev-check.md
│   │   ├── expand-content.md  # Guided safe content expansion workflow
│   │   ├── rollback.md
│   │   ├── seed-reset.md
│   │   ├── test.md
│   │   └── verifier-stats.md
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
interview_questions  id, module_id, question, hints (JSON), model_answer TEXT
interview_attempts   id, question_id, module_id, score, is_correct, attempted_at
interview_srs_schedule  question_id (PK), interval_days, ease, next_review, reviews
quiz_attempts     id, lesson_id, question_id, answer, is_correct, attempted_at
xp_log            id, source (lesson/quiz/interview/streak), points, earned_at
streaks           id, date, completed (bool)
srs_schedule      question_id (PK), interval_days, ease, next_review, reviews
projects          id, slug, title, description, modules (JSON), difficulty
project_steps     id, project_id, order_index, title, type (sandbox/ai), prompt, language, expected_output, hints (JSON)
project_progress  id, project_id, step_id, status, score, answer, completed_at
exercise_srs_schedule  exercise_key TEXT (PK, format slug:index), interval_days, ease, next_review, reviews
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
| Interview answer — Strong | 5 XP |
| Interview answer — Adequate | 2 XP |
| Interview answer — Weak | 0 XP |
| Exercise check (correct, first time) | 5 XP |
| Complete a full module | 50 XP bonus |
| Daily streak bonus | +20% on all XP earned that day |
| Project sandbox step — pass | 10 XP |
| Project AI step — Adequate | 8 XP |
| Project AI step — Strong | 15 XP |
| Complete a full project | 75 XP bonus |

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
- Interview Prep Mode with AI-generated questions and AI feedback (score: Weak/Adequate/Strong)
- Quick Review flashcard mode — pre-seeded model answers, self-grade Weak/Adequate/Strong, no live Claude call; `POST /interview/self-grade`; seeded via `seed_interview.py --model-answers` (184 answers across all 23 modules)
- Mock Interview mode — 8 randomly shuffled questions per selected module, 15-minute countdown timer (pauses during self-review), self-grading only, no backend writes; results card shows accuracy %, time used, per-question breakdown with model answers
- Interview SRS review queue (SM-2 algorithm; amber badge in sidebar when reviews due)
- XP awards for interview answers (Strong=5, Adequate=2)

### Phase 5 — Polish & Navigation ✅
- Lesson notes (per-lesson textarea, auto-saved to backend)
- Module Quiz (dedicated quiz page per module, reachable from ModuleView)
- Full-text content search (SearchModal, debounced backend, title + body results)
- Recently visited dropdown (last 5 lessons, persisted in localStorage)
- Keyboard lesson navigation (`[` / `]` and `j` / `k` keys); `space` toggles current lesson complete/incomplete (blocked inside inputs and textareas)
- Module completion banner (fires once on last-lesson completion, includes XP)
- Stats page (XP history, streak calendar, completion breakdown, quiz weak areas)
- Sidebar collapse, TOC (auto-generated from `##` headings), reading mode
- Bookmarks (star any lesson, persisted in localStorage, BookmarksDropdown in header)
- Job readiness score per module (completion 40% + quiz accuracy 40% + interview coverage 20%); shown as badge on Roadmap cards and breakdown row on ModuleView
- Progress export — download full JSON backup (progress, XP log, quiz attempts, notes, interview history, SRS state) from Stats page
- Lab exercise validation — `expected_output` fenced block in lesson markdown; amber Check button in CodePlayground; stdout match + exit 0 required; 5 XP awarded once per exercise (idempotent via xp_log source key); 182 exercises across all 23 modules

### Phase 6 — Projects ✅
- 10 multi-step interview-ready projects mixing 2–3 modules each: Containerize a Python App, Zero-Downtime Kubernetes Deployment, Linux System Hardening, Observability Stack Setup, IaC: AWS VPC, GitOps Pipeline with ArgoCD, Ansible Server Configuration, ELK Stack Log Analysis, Helm Chart Development, API Security & Testing
- Each project has 4 steps — Sandbox (Monaco editor + stdout check, 10 XP) or AI Review (Claude grading Weak/Adequate/Strong, 8/15 XP)
- 75 XP completion bonus per project; all XP idempotent via xp_log source keys
- Projects page (card grid with difficulty, module tags, step progress) + ProjectDetail page (expandable steps, server state restored on reload)
- Sidebar: Projects link above Interview Prep in Practice section
- Progressive Hints — amber HintBox in CodePlayground (exercises), InterviewPrep, and ProjectDetail; 2 hints revealed one at a time; resets on question/step change; hints stored as `hint:` lines in markdown (exercises) or JSON column (interview/project steps); seeded via `seed_exercise_hints.py` (184 exercise hints across all 23 modules) and `seed_interview.py --hints-only` (368 interview hints across all 23 modules)

### Phase 7 — Sandbox Polish ✅
- Show answer button (`POST /sandbox/answer`) on open-ended exercises (no `expected_output`); Haiku generates a complete solution using lesson title + content as context; renders as markdown in a blue Solution panel; validated exercises keep Check button only
- Per-exercise language assignment: YAML modules (kubernetes, ansible, helm) use bash for validated exercises (bash command exercises) and yaml for open-ended manifest-writing exercises; terraform, cicd, gcp, aws always use bash
- Language switcher hidden in exercise-bound sandboxes; static language label shown instead; free-form standalone sandbox retains full Bash / Python / YAML switcher
- Empty YAML stub warning: submitting the default `---` starter now exits 1 with a clear message ("⚠ Nothing to validate — your YAML is empty. Add your manifest below the --- line.")

### Phase 8 — Exercise SRS ✅
- SM-2 spaced-repetition schedule for exercises — every Check call (pass or fail) updates `exercise_srs_schedule` (TEXT PK `slug:index`, interval_days, ease, next_review, reviews)
- `GET /sandbox/exercises/due` endpoint returns `{due_count, due_keys}` (keys due today by next_review date)
- Sidebar: amber "N ex" badge on Spaced Review row when exercises are due
- LessonViewer: amber ↻ indicator next to exercises whose key is in due_keys; fetched on lesson load

### Phase 9 — Skeleton Loading Screens ✅
- App.jsx startup skeleton: replaces plain "Loading…" with animate-pulse layout matching the real 3-column structure — sidebar (logo, progress bar, 10 nav rows), header strip, and Roadmap-style card grid (5 groups × 3 cards each)
- LessonViewer skeleton: replaces plain "Loading…" with animate-pulse content approximating the lesson layout — back-link bar, title, two meta-badge pills, paragraph lines, section heading, more paragraph lines, code-block rectangle, trailing lines

### Phase 10 — Search Group Filter ✅
- Group-filter pill row in SearchModal: "All" + one pill per curriculum group that has results for the current query; only groups with matching results appear
- Clicking a group pill narrows results to that group's modules (client-side filter via slug→group map); clicking an active pill or switching query resets to All
- No backend changes; works across both title-match and content-search results

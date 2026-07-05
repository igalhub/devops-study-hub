# TICKETS — DevOps Study Hub

Full ticket history for this repo, backfilled from `docs/PRD.md`'s
"Phases (all shipped)" section (DSH-001 through DSH-012) plus real
open gaps found during this docs pass (DSH-013 through DSH-015).
Numbered in chronological shipping order.

---

## DSH-001 — Foundation

**Status:** DONE

**Description:**
Project scaffold (React + Vite frontend, FastAPI backend, SQLite).
Curriculum loaded from `content/` directory (23 modules, 91 lessons).
Roadmap View.

**Acceptance criteria:**
- [x] React + Vite frontend and FastAPI backend scaffolded, SQLite persistence
- [x] Curriculum content loads from `content/` — 23 modules, 91 lessons
- [x] Roadmap View renders the curriculum

---

## DSH-002 — Active Learning

**Status:** DONE

**Description:**
Lesson viewer with Markdown rendering (tables, syntax-highlighted
code). AI Tutor (streaming Claude responses, lesson-context aware).
Code Sandbox (Monaco Editor + subprocess execution).

**Acceptance criteria:**
- [x] Lesson viewer renders Markdown including tables and syntax-highlighted code
- [x] AI Tutor streams Claude responses scoped to the current lesson
- [x] Code Sandbox runs real subprocess execution via Monaco Editor

---

## DSH-003 — Retention

**Status:** DONE

**Description:**
Spaced Repetition Quizzes (SM-2 algorithm). 455 quiz questions seeded
(5 per lesson) via the seeding pipeline. Batch content expansion
pipeline (`seed_curriculum.py`).

**Acceptance criteria:**
- [x] SM-2 spaced-repetition quiz scheduling implemented
- [x] 455 quiz questions seeded (5 per lesson) across all modules
- [x] `seed_curriculum.py` batch content-expansion pipeline in place

---

## DSH-004 — Job Readiness

**Status:** DONE

**Description:**
Interview Prep Mode with AI-generated questions and AI feedback
(score: Weak/Adequate/Strong). Quick Review flashcard mode —
pre-seeded model answers, self-grade, no live Claude call
(`POST /interview/self-grade`, seeded via `seed_interview.py
--model-answers`, 184 answers across all 23 modules). Interview SRS
review queue (SM-2 algorithm); Practice Due banner on idle screen when
reviews are waiting. XP awards for interview answers (Strong=5,
Adequate=2).

**Acceptance criteria:**
- [x] AI-graded Interview Prep Mode implemented
- [x] Quick Review flashcard mode with 184 pre-seeded model answers, no Claude call required
- [x] Interview SRS review queue + Practice Due banner
- [x] XP awarded correctly per score tier

---

## DSH-005 — Polish & Navigation

**Status:** DONE

**Description:**
Lesson notes, Module Quiz, full-text content search, recently-visited
dropdown, keyboard lesson navigation, module completion banner, Stats
page, sidebar collapse/TOC/reading mode, bookmarks, Module Progress
score (completion 40% + quiz accuracy 40% + interview coverage 20%),
progress export, and lab exercise validation (182 exercises across all
23 modules, 5 XP per exercise, idempotent).

**Acceptance criteria:**
- [x] Lesson notes auto-save to backend per lesson
- [x] Full-text search (SearchModal) covers title + body across all lessons
- [x] Stats page shows XP history, streak calendar, completion breakdown, quiz weak areas
- [x] Module Progress score computed and shown on Roadmap cards and ModuleView
- [x] Progress export downloads a full JSON backup
- [x] Lab exercise validation (`expected_output` match) awards XP idempotently across 182 exercises

---

## DSH-006 — Projects

**Status:** DONE

**Description:**
10 multi-step interview-ready projects mixing 2–3 modules each
(Containerize a Python App, Zero-Downtime Kubernetes Deployment, Linux
System Hardening, Observability Stack Setup, IaC: AWS VPC, GitOps
Pipeline with ArgoCD, Ansible Server Configuration, ELK Stack Log
Analysis, Helm Chart Development, API Security & Testing). Each
project has 4 steps — Sandbox (10 XP) or AI Review (8/15 XP); 75 XP
completion bonus. Projects page + ProjectDetail page. Progressive
Hints (2 hints revealed one at a time, resets on step change).

**Acceptance criteria:**
- [x] 10 multi-module projects implemented, each with 4 steps
- [x] Sandbox and AI Review step types both award XP idempotently
- [x] Projects page and ProjectDetail page implemented, server state restored on reload
- [x] Progressive Hints implemented for both exercises and project steps

---

## DSH-007 — Sandbox Polish

**Status:** DONE

**Description:**
Show Answer button on open-ended exercises (Haiku generates a
complete solution using lesson context, rendered as markdown).
Per-exercise language assignment (YAML modules use bash for validated
exercises, yaml for open-ended manifest-writing; terraform/cicd/gcp/aws
always bash). Language switcher hidden in exercise-bound sandboxes.
Empty YAML stub now exits 1 with a clear message instead of silently
validating nothing.

**Acceptance criteria:**
- [x] Show Answer button generates and renders a full solution for open-ended exercises
- [x] Exercise language assignment matches the module-specific rules
- [x] Empty YAML stub submission produces a clear error, not a silent pass

---

## DSH-008 — Exercise SRS

**Status:** DONE

**Description:**
SM-2 spaced-repetition schedule for exercises — every Check call
(pass or fail) updates `exercise_srs_schedule` (TEXT PK `slug:index`,
interval_days, ease, next_review, reviews).

**Acceptance criteria:**
- [x] Every exercise Check call updates the SM-2 schedule regardless of pass/fail

---

## DSH-009 — Skeleton Loading Screens

**Status:** DONE

**Description:**
App.jsx startup skeleton replacing plain "Loading…" with an
animate-pulse layout matching the real 3-column structure. LessonViewer
skeleton replacing plain "Loading…" with animate-pulse content
approximating the real lesson layout.

**Acceptance criteria:**
- [x] App startup shows a structural skeleton, not a bare loading message
- [x] LessonViewer shows a structural skeleton while content loads

---

## DSH-010 — Search Group Filter

**Status:** DONE

**Description:**
Group-filter pill row in SearchModal — "All" plus one pill per
curriculum group with results for the current query; clicking narrows
results to that group. No backend changes; works across both
title-match and content-search results.

**Acceptance criteria:**
- [x] Group pills appear only for groups with matching results
- [x] Clicking a pill narrows results; switching query resets to All

---

## DSH-011 — Reference Cards

**Status:** DONE

**Description:**
23 per-module command cheat sheets in `reference/<slug>.md`. Backend
`GET /reference/{module_slug}` reads and returns the markdown file
(404 if none exists). Frontend `Reference.jsx` renders via
ReactMarkdown + remarkGfm. Files live in `reference/` rather than
`content/` to avoid the pre-commit 100-line minimum hook.

**Acceptance criteria:**
- [x] All 23 modules have a reference card
- [x] `GET /reference/{module_slug}` 404s gracefully for missing cards
- [x] Reference cards render with proper table/code formatting

---

## DSH-012 — Docker Containerization

**Status:** DONE

**Description:**
`backend/Dockerfile` (Python 3.12-slim, uvicorn on port 8000).
`frontend/Dockerfile` (multi-stage Node 18 build → nginx:alpine serve,
SPA routing via `try_files`). `docker-compose.yml` (backend + frontend
services, API key injected at runtime via `env_file`, SQLite DB
mounted as a volume). `.dockerignore` excludes secrets and build
artifacts.

**Acceptance criteria:**
- [x] `docker compose up --build` runs the full stack
- [x] API key never baked into the image, only injected at runtime
- [x] SQLite DB persists across container restarts via the mounted volume

---

## DSH-013 — No schema migration framework

**Status:** OPEN

**Description:**
`backend/db.py`'s `init_db()` is additive-only (`CREATE TABLE IF NOT
EXISTS`). Any change to an *existing* table's columns needs a manual
`ALTER TABLE` added by hand, or a one-off migration script — there's no
mechanism that detects a running `hub.db` is on an older schema than the
code expects. So far this hasn't bitten because every schema change to
date has been additive (new tables), but the first column-level change
to an existing table on someone's pre-seeded local DB will need this.

**Acceptance criteria:**
- [ ] Decide on an approach proportionate to a solo-dev SQLite project —
      e.g. a `schema_version` table + an ordered list of migration
      functions applied on startup, or (simpler) a documented manual
      procedure in the README for the rare case it's needed
- [ ] Document the chosen approach in `docs/SPEC.md`

---

## DSH-014 — Windows/WSL2 support unverified

**Status:** OPEN

**Description:**
README's Platform Support states Windows is "not currently supported"
and "WSL2 may work but is untested." This has been true since early in
the project and hasn't been revisited.

**Acceptance criteria:**
- [ ] Either do a real WSL2 smoke test (clone, backend venv, frontend
      npm install, `./start.sh`, one full lesson + quiz + sandbox
      exercise) and update the README with actual results, or
      explicitly decide Windows/WSL2 stays out of scope and say so
      plainly in the PRD's non-goals rather than leaving it as an open
      "untested" question

---

## DSH-015 — Bash sandbox version gap on macOS

**Status:** OPEN (workaround documented, not fixed)

**Description:**
README already documents the root cause and a workaround: macOS ships
bash 3.2 (Apple won't ship GPLv3), so sandbox exercises using bash 4+
syntax (`declare -A`, `mapfile`, `${var,,}`) fail unless the user either
runs the Docker path or `brew install bash`. This is a real, currently
user-facing rough edge, just with a documented workaround rather than a
fix — flagging it here so it doesn't get lost.

**Acceptance criteria:**
- [ ] Consider detecting the interpreter's bash version in
      `routes/sandbox.py` and surfacing a clear in-app message (rather
      than a raw syntax error) when a bash 4+ construct is submitted
      against bash 3.2
- [ ] Or: accept the README workaround as sufficient and close this with
      a note explaining why (e.g. low actual user count, Docker path
      already solves it cleanly)

---

## Ticket status

| Ticket | Title | Status |
|---|---|---|
| DSH-001 | Foundation | DONE |
| DSH-002 | Active Learning | DONE |
| DSH-003 | Retention | DONE |
| DSH-004 | Job Readiness | DONE |
| DSH-005 | Polish & Navigation | DONE |
| DSH-006 | Projects | DONE |
| DSH-007 | Sandbox Polish | DONE |
| DSH-008 | Exercise SRS | DONE |
| DSH-009 | Skeleton Loading Screens | DONE |
| DSH-010 | Search Group Filter | DONE |
| DSH-011 | Reference Cards | DONE |
| DSH-012 | Docker Containerization | DONE |
| DSH-013 | No schema migration framework | OPEN |
| DSH-014 | Windows/WSL2 support unverified | OPEN |
| DSH-015 | Bash sandbox version gap on macOS | OPEN |

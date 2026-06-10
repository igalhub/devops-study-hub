# DevOps Study Hub

An interactive, self-hosted study tool for learning DevOps. Covers 23 modules and 91 lessons across Linux, Python, Bash, Git, Docker, Kubernetes, Terraform, Ansible, CI/CD, AWS, GCP, and more.

## Features

### Learning & Practice
- **AI Tutor** — ask questions in context of the current lesson (streaming Claude responses)
- **Code Sandbox** — write and run Bash, Python, and YAML inline with real subprocess execution; validated exercises have a Check button that awards XP on correct output
- **Spaced Repetition Quizzes** — SM-2 algorithm, 5 questions per lesson; weak-area drill across all modules on the Stats page
- **Interview Prep** — 8 scenario-based questions per module with AI feedback (Weak/Adequate/Strong); Quick Review flashcard mode with pre-seeded model answers; Mock Interview mode with a 15-minute countdown and results card
- **Projects** — 10 multi-step interview-ready projects (containerization, Kubernetes, IaC, GitOps, ELK, Helm, and more); steps are either sandbox-validated or AI-graded; 75 XP completion bonus per project
- **Progressive Hints** — 2 hints revealed one at a time on exercises, interview questions, and project steps
- **Show Answer** — AI-generated solution panel for open-ended exercises
- **Reference Cards** — per-module command cheat sheets for all 23 modules; accessible from each module header

### Navigation & Tracking
- **Roadmap** — visual skill tree with per-module job readiness scores (completion 40% + quiz accuracy 40% + interview coverage 20%)
- **Stats page** — XP timeline, streak calendar, per-module completion breakdown, quiz weak areas drill
- **Progress export** — download a full JSON backup of progress, XP log, quiz attempts, notes, interview history, and SRS state
- **Content search** — full-text search across lesson titles and body content, filterable by curriculum group
- **Bookmarks** — star any lesson; accessible from the header dropdown
- **Recently visited** — last 5 lessons, one-click return from the header
- **Lesson notes** — per-lesson textarea, auto-saved to backend
- **Reading mode** — distraction-free view; auto-generated TOC for long lessons
- **Keyboard navigation** — `[` / `]` keys move between lessons; `space` toggles lesson complete

## Prerequisites

- Python 3.12+
- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

## Setup

```bash
# Clone
git clone https://github.com/igalhub/devops-study-hub.git
cd devops-study-hub

# Backend
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# Create backend/.env with your API key
cp backend/.env.example backend/.env
# Edit backend/.env and set ANTHROPIC_API_KEY=...

# Frontend
cd frontend && npm install && cd ..
```

## Seed the database

```bash
cd backend

# Modules and lessons
../.venv/bin/python seed.py

# AI-generated quiz questions (5 per lesson — calls Anthropic API)
set -a && source .env && set +a
../.venv/bin/python seed_curriculum.py --quiz-only

# Interview questions (8 per module — calls Anthropic API)
../.venv/bin/python seed_interview.py
```

## Run

Two terminals:

```bash
# Terminal 1 — backend (port 8000)
./start-backend.sh

# Terminal 2 — frontend (port 5173)
./start-frontend.sh
```

Then open http://localhost:5173.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key for AI Tutor, quizzes, interview feedback |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-6` | Claude model to use |
| `VITE_API_URL` | No | `http://localhost:8000` | Backend URL (set in `frontend/.env` for non-default ports) |

## Architecture

```
devops-study-hub/
├── frontend/          # React + Vite + Tailwind + Monaco Editor
├── backend/           # FastAPI + SQLite
│   ├── seed.py        # Seeds modules & lessons from content/
│   ├── seed_curriculum.py  # Expands content + generates quiz questions
│   └── seed_interview.py   # Generates interview questions + model answers
├── content/           # Markdown lesson files (91 lessons across 23 modules)
└── reference/         # Per-module command cheat sheets (23 modules)
```

The frontend fetches from the backend API (`localhost:8000` by default). The AI Tutor and interview evaluator stream responses from Claude. The code sandbox executes Bash/Python in subprocesses and validates YAML via PyYAML — local only, no container isolation.

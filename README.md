# DevOps Study Hub

An interactive, self-hosted study tool for learning DevOps. Covers 23 modules and 91 lessons across Linux, Python, Bash, Git, Docker, Kubernetes, Terraform, Ansible, CI/CD, AWS, GCP, and more.

## Features

- **AI Tutor** — ask questions in context of the current lesson (streaming Claude responses)
- **Code Sandbox** — write and run Bash, Python, and YAML inline (real subprocess execution)
- **Spaced Repetition Quizzes** — SM-2 algorithm, 5 AI-generated questions per lesson
- **Interview Prep** — 8 scenario-based questions per module with AI feedback
- **Roadmap** — visual skill tree showing completion across all modules
- **Progress tracking** — XP, daily streaks, per-lesson completion
- **Content search** — full-text search across lesson titles and body content
- **Lesson notes** — per-lesson textarea, auto-saved to backend
- **Bookmarks** — star any lesson; accessible from the header dropdown
- **Recently visited** — last 5 lessons, one-click return from the header
- **Stats page** — XP timeline, streak calendar, per-module completion breakdown
- **Module quiz** — dedicated quiz page per module
- **Reading mode** — distraction-free view; auto-generated TOC for long lessons
- **Keyboard navigation** — `[` / `]` keys move between lessons within a module

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
│   └── seed_interview.py   # Generates interview questions
└── content/           # Markdown lesson files (91 lessons across 23 modules)
```

The frontend fetches from the backend API (`localhost:8000` by default). The AI Tutor and interview evaluator stream responses from Claude. The code sandbox executes Bash/Python in subprocesses and validates YAML via PyYAML — local only, no container isolation.

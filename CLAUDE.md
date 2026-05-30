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

91 lessons total, 455 quiz questions seeded (5 per lesson), 184 interview questions seeded (8 per module).

## Core Features
- **Study Content Tracking** — what's been covered, what's pending
- **Content Planning** — structured learning path
- **Daily Operations** — session management, streaks, goals
- **Code Builds** — in-app code execution for exercises
- **Notes** — per-lesson notes, auto-saved to backend
- **Stats** — XP timeline, streak calendar, per-module completion breakdown, quiz weak areas

## Killer Features
- **AI Tutor** — answers questions in context of the current lesson
- **Code Sandbox** — write and run Bash/Python exercises inline
- **Spaced Repetition Quizzes** — SM-2 algorithm, 5 questions per lesson
- **Roadmap View** — visual skill tree showing what to learn next
- **Interview Prep Mode** — AI-generated questions with AI feedback (score: Weak/Adequate/Strong) + Quick Review flashcard mode (pre-seeded model answers, self-grade, no Claude call) + Mock Interview mode (8 random questions, 15-min countdown, self-grading, no backend writes, results card); SRS review queue; XP awards
- **Content Search** — full-text search across lesson titles and body content
- **Bookmarks** — star any lesson; accessible from the header dropdown
- **Module Quiz** — dedicated per-module quiz page
- **Lab Exercise Validation** — Check button on exercises with `expected_output`; validates stdout, awards 5 XP per exercise (idempotent)
- **Projects** — 10 multi-step interview-ready projects mixing modules; steps are Sandbox (stdout check, 10 XP) or AI Review (Claude grades Weak/Adequate/Strong, 8/15 XP); 75 XP completion bonus per project
- **Progressive Hints** — amber "Hint" button on exercises (CodePlayground), interview questions (InterviewPrep), and project steps (ProjectDetail); reveals 2 hints one at a time, resets on question change; hints stored as markdown `hint:` lines (exercises) or JSON column (interview/projects)
- **Show Answer** — gray "Show answer / Hide answer" toggle on open-ended exercises (no `expected_output`); calls `POST /sandbox/answer` with lesson slug + exercise text; Haiku generates a full solution rendered as markdown; validated exercises (with `expected_output`) never show this button

### Quick Check authoring rules
- **Python must be single-line** — markdown list indentation (3 spaces) is captured by the parser and causes `IndentationError` on multi-line blocks. Chain statements with semicolons instead.
- **Remove stale epilogue prose** — if a lesson has trailing paragraphs after its last numbered exercise (e.g. `**Goal:**`, `*This is a real pattern...*`), remove them before adding Quick Checks. If left in, the parser appends them to the last QC exercise's `text` field and `extract_code()` returns garbage. Always verify via `curl http://localhost:8000/lessons/{slug}` after editing.
- **Exercise language is per-exercise** (`LessonViewer.jsx`): python module → `python`; kubernetes/ansible/helm with `expected_output` → `bash` (bash command exercises); kubernetes/ansible/helm without `expected_output` → `yaml` (open-ended manifest writing); all other modules → `bash`. Terraform, cicd, gcp, aws always use bash. The language switcher is hidden in exercise sandboxes; a static label is shown instead.

## Tone & Style
Rigorous, direct, no fluff. Cover things properly but don't pad. Breadth and rigor equally — cast a wide net, do it well.

## Architecture Authority
Always reference `devops-study-hub-prd.md` at the project root for authoritative architecture and component specs before making any structural changes.

## Content Expansion
Use `/expand-content` to expand thin lesson content. The skill enforces code-review after patches and a single-module smoke test before the full run — do not bypass it by running `seed_curriculum.py` directly for a full batch.

To seed exercise hints: `python3 seed_exercise_hints.py [--dry-run] [--module <slug>]` — adds `hint:` lines to lesson markdown files for any Quick Check that has `expected_output` but no hints yet. To seed interview hints: `python3 seed_interview.py --hints-only [--module <slug>]`. To seed model answers for Quick Review flashcard mode: `python3 seed_interview.py --model-answers [--module <slug>]` — idempotent, skips already-answered questions.

## Documentation Currency
Run `/update-docs` after any significant change (new skill, schema change, lesson count change, new feature). It audits CLAUDE.md, the PRD, skill files, and memory against ground truth from `.claude/docs-manifest.sh` and proposes edits before committing.

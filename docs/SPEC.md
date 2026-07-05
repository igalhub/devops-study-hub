# SPEC — DevOps Study Hub

Technical spec of the current implementation. `docs/PRD.md` already
covers problem/scope/data-model/phases in depth — this fills the gap
between that and the source: the API surface, backend module
responsibilities, and the exact mechanics of a few things the PRD only
summarizes (SRS scoring, sandbox isolation).

---

## Backend module map

```
backend/main.py              FastAPI app, mounts all routers
backend/db.py                 SQLite connection + schema (CREATE TABLE IF NOT EXISTS)
backend/ai_client.py           Anthropic API wrapper (streaming + one-shot)
backend/srs.py                 SM-2 spaced-repetition scoring, two call sites
backend/routes/*.py            one router module per feature area
backend/seed*.py                idempotent content seeders
backend/reset_progress.py       wipes progress tables back to pre-seeded state
```

`db.py`'s `init_db()` is additive-only (`CREATE TABLE IF NOT EXISTS`) —
there is no migration framework. Schema changes to an existing table
require a manual `ALTER TABLE` added to `init_db()` or a one-off script;
nothing currently detects a stale schema automatically.

## API surface

All routes are mounted under the FastAPI app in `main.py`, no common
prefix beyond the router's own path:

| Router | Routes |
|---|---|
| `modules.py` | `GET /modules` |
| `lessons.py` | `GET /lessons/{slug}` |
| `quiz.py` | `GET /quiz/{lesson_slug}`, `GET /quiz/module/{module_slug}`, `GET /quiz/weak-areas`, `GET /review/queue`, `POST /quiz/attempt` |
| `interview.py` | `GET /interview/questions/{module_slug}`, `POST /interview/evaluate`, `GET /interview/review/queue`, `POST /interview/self-grade` |
| `sandbox.py` | `POST /sandbox/run`, `POST /sandbox/check`, `POST /sandbox/answer`, `GET /sandbox/completed/{lesson_slug}` |
| `projects.py` | `GET /projects`, `GET /projects/{slug}`, `POST /projects/{slug}/steps/{step_id}/sandbox`, `POST /projects/{slug}/steps/{step_id}/ai-grade` |
| `progress.py` | `GET /progress`, `POST /progress/{lesson_id}`, `GET /xp`, `GET /streaks` |
| `notes.py` | `GET /notes/{lesson_slug}`, `POST /notes/{lesson_slug}` |
| `stats.py` | `GET /stats`, `GET /stats/readiness` |
| `search.py` | `GET /search` |
| `reference.py` | `GET /reference/{module_slug}` (404-graceful for missing cards) |
| `export.py` | `GET /export/progress` |
| `ai.py` | `POST /ai/chat` (streaming AI Tutor) |

## `backend/ai_client.py`

Wraps the Anthropic API for two call shapes: streaming (AI Tutor chat)
and one-shot (interview grading, Show Answer generation, project
AI-grade steps). Model is configurable via `CLAUDE_MODEL`
(default `claude-sonnet-4-6`). Raises typed exceptions
(`AITimeoutError`, `AINotConfiguredError`) that route handlers catch and
turn into a graceful error response rather than a 500 — this is what
lets the rest of the app (lessons, quizzes, projects, sandbox) work with
zero API key configured, per the README's "Without an API key" note.

## `backend/srs.py` — SM-2 scoring, exact formula

Two independent tables share one algorithm: `srs_schedule` (quiz
questions) and `interview_srs_schedule` (interview questions).
`exercise_srs_schedule` (Quick Check lab exercises) uses a separate
function (`update_exercise_srs`, same shape, keyed by `exercise_key`
formatted `slug:index` rather than an integer ID).

```
first review:        interval=1, ease=2.5, reviews=1
correct answer:       interval = max(1, round(interval * ease))
                      ease = min(3.5, ease + 0.1)
wrong answer:         interval = 1
                      ease = max(1.3, ease - 0.2)
next_review = today + interval days
```

Every Check (pass or fail) updates the schedule — there's no
"don't count this attempt" path. `_VALID_TABLES` is an explicit
allowlist (`update_srs` raises `ValueError` on an unknown table name)
since the table name is interpolated into the SQL string — this is the
one place in the codebase doing that, and it's deliberately guarded
rather than parameterized because SQLite doesn't support parameterized
table names.

## `backend/routes/sandbox.py` — execution isolation

Real subprocess execution, not simulated output (see PRD's Code Sandbox
section for the higher-level policy). Mechanics:

- `_apply_resource_limits()` runs as `preexec_fn` in the child process:
  5s CPU time (`RLIMIT_CPU`), 256 MB virtual memory (`RLIMIT_AS` —
  sized above CPython's ~150 MB baseline), 10 MB max written file size
  (`RLIMIT_FSIZE`), capped open file descriptors.
- `_SAFE_ENV` is a stripped environment — fixed `PATH` (includes
  `/opt/homebrew/bin` for Apple Silicon Homebrew), `HOME=/tmp`
  (intentional, flagged `nosec B108` since it's a deliberate sandbox
  boundary not a real credential-adjacent path), dummy git author/
  committer identity so exercises that touch git don't inherit the
  real machine's identity.
  `TIMEOUT = 10` seconds and `MAX_OUTPUT = 50_000` bytes per stream cap
  runaway output/hangs independent of the resource limits above.
- `XP_EXERCISE_CHECK = 5` — every `/sandbox/check` call (pass or fail)
  also calls into `srs.py`'s exercise-SRS path, so lab exercises are on
  the same spaced-repetition schedule as quiz/interview questions.

## Frontend structure

```
frontend/src/
  components/   shared UI (LessonViewer, CodePlayground, ProjectDetail, ...)
  pages/        route-level views
  store/        curriculumStore.js — central state + API calls
  utils/
```

`curriculumStore.js` is the single point of contact between components
and the backend API — per CLAUDE.md's "Removing a Feature" checklist,
any component-level feature removal must also remove its now-orphaned
`export function` here (verified via
`grep -rn "<funcName>" frontend/src/ | grep -v curriculumStore.js`).

## Content authoring constraints (from CLAUDE.md, restated for reference)

- Quick Check Python exercises must be single-line (semicolon-chained)
  — the markdown parser's list-indentation handling causes
  `IndentationError` on multi-line blocks embedded in a list item.
- Exercise language is derived per-module in `LessonViewer.jsx`, not
  stored explicitly: python module → `python`; kubernetes/ansible/helm
  with `expected_output` → `bash`; same three without `expected_output`
  → `yaml`; everything else → `bash`.

## Tests

`backend/tests/test_api.py` — API-level tests against the FastAPI app
(the primary test surface; no separate unit-test layer per backend
module). `frontend/src/components/__tests__/` — component-level
frontend tests. Test count is tracked and kept in sync in `CLAUDE.md`
via `/update-docs`.

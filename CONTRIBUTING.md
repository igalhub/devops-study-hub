# Contributing

Contributions are welcome — new lessons, quiz questions, bug fixes, or sandbox improvements.

## Getting started

1. Fork the repo and clone your fork
2. Follow the [Quick start](README.md#quick-start) instructions to get a local environment running
3. Create a feature branch: `git checkout -b feat/your-feature`
4. Make your changes
5. Open a pull request with a clear description of what changed and why

Please open an issue first for large changes (new modules, architecture changes) so the approach can be discussed before you invest the time.

## Lesson content

Lessons live in `content/<module>/<lesson>.md` as Markdown with YAML frontmatter. After editing a lesson file, reseed it:

```bash
cd backend
../.venv/bin/python seed.py
```

See `CLAUDE.md` for the full authoring rules (Quick Check syntax, exercise language conventions, etc.).

## Running tests

```bash
# Backend (pytest)
cd backend && ../.venv/bin/pytest -v

# Frontend (Vitest)
cd frontend && npm test -- --run
```

All tests must pass before opening a pull request.

## Code style

- Python: follow the existing style (no formatter enforced, just keep it consistent)
- JavaScript/JSX: ESLint is configured — run `cd frontend && npm run lint` before committing

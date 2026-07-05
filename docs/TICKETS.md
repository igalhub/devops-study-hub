# TICKETS — DevOps Study Hub

`docs/PRD.md`'s "Phases" section tracks the 12 shipped phases (all ✅).
This file tracks what's still genuinely open — real gaps found during
this docs pass, not a backfilled history of already-shipped work.

---

## DSH-001 — No schema migration framework

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

## DSH-002 — Windows/WSL2 support unverified

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

## DSH-003 — Bash sandbox version gap on macOS

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
| DSH-001 | No schema migration framework | OPEN |
| DSH-002 | Windows/WSL2 support unverified | OPEN |
| DSH-003 | Bash sandbox version gap on macOS | OPEN |

"""
reset_progress.py — Wipe all user progress while preserving every seeded content row.

Run from backend/:
    python3 reset_progress.py [--yes]

What gets wiped:
    progress             — lesson completion status
    xp_log               — all XP history
    quiz_attempts        — quiz answer history and SM-2 state
    srs_schedule         — spaced-repetition schedule for quiz questions
    exercise_srs_schedule — spaced-repetition schedule for exercises
    streaks              — streak calendar
    lesson_notes         — per-lesson saved notes
    interview_attempts   — interview Q&A history
    interview_srs_schedule — spaced-repetition schedule for interview questions
    project_progress     — project step completions and AI scores

What is NOT touched:
    modules, lessons, quiz_questions, interview_questions,
    projects, project_steps

After running this script:
    - Reload the browser (or clear localStorage via browser DevTools)
    - XP, streaks, completions, notes, and quiz history will all be at zero
    - All curriculum content (questions, answers, projects) is intact
"""
import sys
from db import get_conn

PROGRESS_TABLES = [
    "srs_schedule",            # references quiz_questions (content)
    "interview_srs_schedule",  # references interview_questions (content)
    "exercise_srs_schedule",   # TEXT PK — no FK, safe to delete directly
    "interview_attempts",      # references interview_questions, modules (content)
    "quiz_attempts",           # references lessons (content)
    "project_progress",        # references projects, project_steps (content)
    "lesson_notes",            # references lessons (content)
    "progress",                # references lessons (content)
    "streaks",
    "xp_log",
]

CONTENT_TABLES = [
    ("modules", 23),
    ("lessons", 91),
    ("quiz_questions", 455),
    ("interview_questions", 184),
    ("projects", 10),
    ("project_steps", 40),
]


def _counts(conn) -> dict[str, int]:
    result = {}
    for t in PROGRESS_TABLES:
        result[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]  # nosec B608 — t is from a hardcoded constant list
    return result


def main() -> None:
    skip_confirm = "--yes" in sys.argv

    conn = get_conn()
    before = _counts(conn)
    conn.close()

    # ── Show what will be wiped ──────────────────────────────────────────────
    print("Progress reset — rows to be deleted:\n")
    any_rows = False
    for t in PROGRESS_TABLES:
        n = before[t]
        marker = "  " if n == 0 else "→ "
        print(f"  {marker}{t:<30} {n:>5} rows")
        if n > 0:
            any_rows = True

    if not any_rows:
        print("\nAll progress tables are already empty. Nothing to do.")
        return

    # ── Confirm ──────────────────────────────────────────────────────────────
    print()
    if not skip_confirm:
        answer = input("Proceed? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return

    # ── Delete ───────────────────────────────────────────────────────────────
    conn = get_conn()
    try:
        for t in PROGRESS_TABLES:
            conn.execute(f"DELETE FROM {t}")  # nosec B608 — t is from a hardcoded constant list
        conn.commit()
    finally:
        conn.close()

    # ── Verify: progress empty, content intact ───────────────────────────────
    conn = get_conn()
    after_progress = _counts(conn)

    print("\nProgress tables after reset:")
    all_clear = True
    for t in PROGRESS_TABLES:
        n = after_progress[t]
        status = "OK" if n == 0 else "FAIL (not empty!)"
        print(f"  {t:<32} {n:>4} rows  {status}")
        if n != 0:
            all_clear = False

    print("\nContent tables (must be unchanged):")
    content_ok = True
    for table, expected in CONTENT_TABLES:
        actual = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # nosec B608 — table is from a hardcoded constant list
        status = "OK" if actual == expected else f"FAIL (expected {expected})"
        print(f"  {table:<32} {actual:>4} rows  {status}")
        if actual != expected:
            content_ok = False

    conn.close()

    print()
    if all_clear and content_ok:
        print("Done. Progress cleared; content intact.")
        print()
        print("Browser cleanup — run in DevTools console to finish the reset:")
        print(
            "  ['devops_bookmarks','devops_recent','playground-editor-height']"
            ".forEach(k => localStorage.removeItem(k))"
        )
    else:
        print("WARNING: one or more checks failed — inspect output above.")
        sys.exit(1)


if __name__ == "__main__":
    main()

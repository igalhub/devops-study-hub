"""
Batch quiz seeder: generates and stores 5 questions for every lesson
that doesn't already have questions.

Run from backend/:
    python3 seed_quiz_all.py [--dry-run] [--module <slug>]

Options:
    --dry-run     List lessons that would be seeded without making API calls
    --module slug Seed only lessons for a specific module (e.g. linux)

Idempotent: skips lessons that already have questions.
"""
import json
import os
import sys
import time
from pathlib import Path

from anthropic import Anthropic
from db import get_conn, init_db

PROJECT_ROOT = Path(__file__).parent.parent
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")

PROMPT_TEMPLATE = """\
You are generating quiz questions for a DevOps study platform. The learner is \
preparing for a DevOps job and needs questions that test genuine understanding — \
not just recall of definitions.

Lesson: {title}

Content:
{content}

Generate exactly 5 multiple-choice questions. Requirements:
- Each question should test a CONCEPT or DECISION, not a definition. Prefer \
  scenario-based questions ("You have X situation, what do you do / what happens?").
- All 4 options must be plausible. Wrong options should reflect common \
  misconceptions or subtly incorrect reasoning, not obvious nonsense.
- The correct answer should require understanding WHY, not just recognising a term.
- The explanation (1-3 sentences) should clarify WHY the correct answer is right \
  AND briefly address why the most tempting wrong answer is incorrect.
- Cover different aspects of the lesson — don't write 5 questions on the same subtopic.

Return ONLY a JSON array — no prose, no markdown code fences. Schema:
[
  {{
    "question": "...",
    "options": ["option A", "option B", "option C", "option D"],
    "correct_index": 0,
    "explanation": "..."
  }}
]

correct_index is 0-based (0 = first option is correct).
"""


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        try:
            end = text.index("\n---", 3)
            return text[end + 4:].strip()
        except ValueError:
            pass
    return text


def _generate_questions(title: str, content: str, client: Anthropic) -> list[dict]:
    prompt = PROMPT_TEMPLATE.format(title=title, content=content)
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text  # drop opening ```json line
        if text.endswith("```"):
            text = text[:-3].rstrip()
    return json.loads(text.strip())


def _store_questions(lesson_id: int, questions: list[dict]) -> None:
    conn = get_conn()
    try:
        for q in questions:
            conn.execute(
                "INSERT INTO quiz_questions (lesson_id, question, options, correct_index, explanation) "
                "VALUES (?, ?, ?, ?, ?)",
                (lesson_id, q["question"], json.dumps(q["options"]), q["correct_index"], q["explanation"]),
            )
        conn.commit()
    finally:
        conn.close()


def _lessons_without_questions(module_filter: str | None) -> list[dict]:
    conn = get_conn()
    try:
        where = "AND m.slug = ?" if module_filter else ""
        params = (module_filter,) if module_filter else ()
        rows = conn.execute(
            f"""
            SELECT l.id, l.slug, l.title, l.md_path, m.slug as module_slug, m.title as module_title
            FROM lessons l
            JOIN modules m ON l.module_id = m.id
            WHERE NOT EXISTS (
                SELECT 1 FROM quiz_questions q WHERE q.lesson_id = l.id
            )
            {where}
            ORDER BY m.group_name, m.order_index, l.order_index
            """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    module_filter = None
    if "--module" in sys.argv:
        idx = sys.argv.index("--module")
        if idx + 1 < len(sys.argv):
            module_filter = sys.argv[idx + 1]

    init_db()
    lessons = _lessons_without_questions(module_filter)

    if not lessons:
        print("All lessons already have questions — nothing to seed.")
        return

    print(f"{'DRY RUN — ' if dry_run else ''}Lessons to seed: {len(lessons)}")
    print()

    if dry_run:
        current_module = None
        for lesson in lessons:
            if lesson["module_slug"] != current_module:
                current_module = lesson["module_slug"]
                print(f"  [{current_module}]")
            print(f"    {lesson['slug']}: {lesson['title']}")
        return

    client = Anthropic()
    success = 0
    failed = []

    for i, lesson in enumerate(lessons, 1):
        label = f"[{i}/{len(lessons)}] {lesson['module_slug']}/{lesson['slug']}"
        print(f"{label} ...", end=" ", flush=True)

        md_file = PROJECT_ROOT / lesson["md_path"]
        if not md_file.exists():
            print("SKIP (no .md file)")
            failed.append((lesson["slug"], "no .md file"))
            continue

        content = _strip_frontmatter(md_file.read_text())

        for attempt in range(3):
            try:
                questions = _generate_questions(lesson["title"], content, client)
                if len(questions) != 5:
                    raise ValueError(f"Expected 5 questions, got {len(questions)}")
                _store_questions(lesson["id"], questions)
                print(f"OK ({len(questions)} questions)")
                success += 1
                break
            except json.JSONDecodeError as e:
                if attempt < 2:
                    print(f"retry ({e}) ...", end=" ", flush=True)
                    time.sleep(2)
                else:
                    print(f"FAILED (JSON parse: {e})")
                    failed.append((lesson["slug"], str(e)))
            except Exception as e:
                if attempt < 2:
                    print(f"retry ({type(e).__name__}) ...", end=" ", flush=True)
                    time.sleep(5)
                else:
                    print(f"FAILED ({e})")
                    failed.append((lesson["slug"], str(e)))

        # Avoid rate-limit bursts between requests
        time.sleep(0.5)

    print()
    print(f"Done: {success} succeeded, {len(failed)} failed.")
    if failed:
        print("Failed lessons:")
        for slug, reason in failed:
            print(f"  {slug}: {reason}")


if __name__ == "__main__":
    main()

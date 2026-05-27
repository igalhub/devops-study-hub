"""
seed_interview.py — Pre-seed interview questions for all 23 modules.

Run from backend/:
    python3 seed_interview.py [options]

Options:
    --dry-run         List what would be done without making API calls
    --module <slug>   Limit to one module (e.g. linux, docker)
    --force           Re-generate even if questions already exist

What it does per module:
1. Aggregate the content of all the module's lessons (now expanded to gold standard)
2. Generate 8 scenario-based interview questions grounded in actual content
3. Store in interview_questions table

Idempotent: skips modules that already have questions unless --force.
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
QUESTIONS_PER_MODULE = 8


INTERVIEW_PROMPT = """\
You are generating DevOps job interview questions for a study platform. The \
candidate is preparing for a mid-level DevOps engineering role.

Module: {module_title}

Reference content (lesson excerpts — use this to ground your questions in \
real concepts, not surface definitions):
{content}

Generate exactly {count} interview questions. Requirements:
- Scenario-based or conceptual — test real understanding, not memorisation.
- Each question should be answerable in 2-4 spoken sentences by someone who \
  genuinely understands the topic.
- Mix styles: "How would you...", "What happens when...", "Walk me through...", \
  "What's the tradeoff between...", "You're on-call and..."
- Cover different aspects of the module — don't cluster questions on one subtopic.
- Difficulty should span: ~3 mid-level, ~3 senior-level, ~2 gotcha/edge-case.
- Do NOT include answers — questions only.

Return ONLY a JSON array of {count} strings — no prose, no markdown fences.
Example format: ["How would you ...", "What happens when ..."]
"""


def _all_modules(module_filter: str | None) -> list[dict]:
    conn = get_conn()
    try:
        where = "WHERE m.slug = ?" if module_filter else ""
        params = (module_filter,) if module_filter else ()
        rows = conn.execute(
            f"""
            SELECT m.id, m.slug, m.title,
                   (SELECT COUNT(*) FROM interview_questions WHERE module_id = m.id) AS question_count,
                   GROUP_CONCAT(l.md_path, '|') AS md_paths
            FROM modules m
            LEFT JOIN lessons l ON l.module_id = m.id
            {where}
            GROUP BY m.id
            ORDER BY m.group_name, m.order_index
            """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _build_content(md_paths_str: str | None) -> str:
    """Concatenate lesson content for a module, capped at ~12k chars."""
    if not md_paths_str:
        return "(no lesson files found)"
    paths = md_paths_str.split("|")
    chunks = []
    total = 0
    for path in paths:
        md_file = PROJECT_ROOT / path
        if not md_file.exists():
            continue
        text = md_file.read_text()
        # Strip frontmatter
        if text.startswith("---"):
            try:
                end = text.index("\n---", 3)
                text = text[end + 4:].strip()
            except ValueError:
                pass
        # Trim to 3000 chars per lesson so all lessons get represented
        chunks.append(text[:3000])
        total += len(chunks[-1])
        if total > 12000:
            break
    return "\n\n---\n\n".join(chunks)


def _generate_questions(module_title: str, content: str) -> list[str]:
    client = Anthropic()
    prompt = INTERVIEW_PROMPT.format(
        module_title=module_title,
        content=content,
        count=QUESTIONS_PER_MODULE,
    )
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text[:-3].rstrip()
    questions = json.loads(text.strip())
    if not isinstance(questions, list) or not all(isinstance(q, str) for q in questions):
        raise ValueError(f"unexpected format: {type(questions)}")
    return questions


def _store_questions(module_id: int, questions: list[str], replace: bool) -> None:
    conn = get_conn()
    try:
        if replace:
            conn.execute("DELETE FROM interview_questions WHERE module_id = ?", (module_id,))
        for q in questions:
            conn.execute(
                "INSERT INTO interview_questions (module_id, question) VALUES (?, ?)",
                (module_id, q),
            )
        conn.commit()
    finally:
        conn.close()


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv

    module_filter = None
    if "--module" in sys.argv:
        idx = sys.argv.index("--module")
        if idx + 1 < len(sys.argv):
            module_filter = sys.argv[idx + 1]

    init_db()
    modules = _all_modules(module_filter)

    if not modules:
        print("No modules found.")
        return

    prefix = "DRY RUN — " if dry_run else ""
    print(f"{prefix}{len(modules)} modules to survey\n")

    if dry_run:
        for mod in modules:
            has_q = mod["question_count"] > 0
            status = ("will regen" if force else "has questions") if has_q else "needs questions"
            print(f"  {mod['slug']}: {status} ({mod['question_count']} existing)")
        return

    ok = generated = failed = 0

    for i, mod in enumerate(modules, 1):
        label = f"[{i}/{len(modules)}] {mod['slug']}"
        print(f"{label} ...", end=" ", flush=True)

        if mod["question_count"] > 0 and not force:
            print(f"OK ({mod['question_count']} questions)")
            ok += 1
            continue

        content = _build_content(mod["md_paths"])

        for attempt in range(3):
            try:
                questions = _generate_questions(mod["title"], content)
                if len(questions) != QUESTIONS_PER_MODULE:
                    raise ValueError(f"expected {QUESTIONS_PER_MODULE}, got {len(questions)}")
                _store_questions(mod["id"], questions, replace=force)
                action = "regenerated" if (force and mod["question_count"] > 0) else "generated"
                print(f"{action} ({len(questions)} questions)")
                generated += 1
                break
            except json.JSONDecodeError as e:
                if attempt < 2:
                    print(f"retry (JSON) ...", end=" ", flush=True)
                    time.sleep(2)
                else:
                    print(f"FAILED (JSON: {e})")
                    failed += 1
            except Exception as e:
                if attempt < 2:
                    print(f"retry ({type(e).__name__}) ...", end=" ", flush=True)
                    time.sleep(5)
                else:
                    print(f"FAILED ({e})")
                    failed += 1

        time.sleep(0.3)

    print()
    print(f"Modules: {ok} OK, {generated} generated, {failed} failed")
    total = (ok + generated) * QUESTIONS_PER_MODULE
    print(f"Total interview questions in DB: ~{total}")


if __name__ == "__main__":
    main()

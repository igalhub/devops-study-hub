"""
seed_curriculum.py — Survey, expand, and quiz the entire curriculum in one pass.

Run from backend/:
    python3 seed_curriculum.py [options]

Options:
    --dry-run         List what would be done without making API calls
    --module <slug>   Limit to one module (e.g. linux, docker)
    --content-only    Only expand thin content, skip quiz generation
    --quiz-only       Only generate quiz questions, skip content check
    --force-content   Re-expand content even if lesson is already thick
    --force-quiz      Re-generate quiz questions even if 5 already exist
    --min-lines <n>   Override the thin-content threshold (default: 200)

What it does per lesson (in order):
1. Check if content is thin (< min_lines non-blank lines OR missing required sections)
2. If thin: call Claude API to expand it, write expanded markdown back to disk
3. Check if 5 quiz questions exist in DB
4. If not: generate 5 questions from (now-expanded) content, store in DB

Idempotent: skips steps that are already complete.
Auto-commits expanded content files at the end (hub.db is gitignored — quiz changes are not committed).
"""
import json
import subprocess
import sys
import time
from pathlib import Path

from ai_client import generate
from db import get_conn, init_db

PROJECT_ROOT = Path(__file__).parent.parent

REQUIRED_SECTIONS = ["## Overview", "## Concepts", "## Examples", "## Exercises"]
MIN_LINES_DEFAULT = 200

# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

EXPANSION_PROMPT = """\
You are expanding a thin lesson for a DevOps study platform. The learner is \
preparing for a DevOps job and needs thorough, practical content.

Lesson: {title}
Module: {module}

REQUIRED STRUCTURE — every section must be present:

## Overview (2-3 paragraphs)
- What this technology/concept is and why it matters for DevOps
- Core design decisions or guiding principles
- Where it fits in the broader DevOps toolchain

## Concepts (main body — multiple ### subsections)
- Each subsection covers one coherent idea
- Explain the concept, then show it in action
- Include realistic code blocks: bash commands, config files, YAML, etc.
- Use tables for comparisons and reference data
- Bold callouts for gotchas, warnings, or non-obvious behavior
- Depth: the learner should be able to answer an interview question on each subsection

## Examples (2-4 complete, runnable real-world scenarios)
- Full commands or configs, not isolated fragments
- Show the setup, the action, and how to verify it worked
- Comment non-obvious choices in code

## Exercises (3-4 hands-on tasks)
- Tasks the learner can do in a terminal or lab environment
- Each should reinforce a different concept from the lesson
- Require understanding — not just copy-pasting from the Concepts section
- Use imperative voice throughout: "Write a script that:" followed by bullets like \
"1. Accept a URL as the first argument" NOT "1. Accepts a URL as the first argument"

QUALITY ANCHOR — this is what a well-written Concepts subsection looks like:

### Metric Types

| Type | Semantics | Example use case |
|------|-----------|-----------------|
| **Counter** | Monotonically increasing integer; only goes up (resets on restart) | HTTP requests total, errors total |
| **Gauge** | Arbitrary float that can go up or down | Memory usage, queue depth |
| **Histogram** | Samples observations into configurable buckets | Request latency, response size |
| **Summary** | Pre-calculated client-side quantiles | Same as histogram, computed in app |

**Counter gotcha:** never use a counter for something that can decrease. Use a gauge. \
Counters are designed to be used with `rate()` in PromQL — that function handles resets automatically.

**Histogram vs Summary:**
- Histograms: buckets stored server-side, quantiles calculated in PromQL — aggregatable across instances.
- Summaries: quantiles computed client-side — cannot be aggregated. Prefer histograms in distributed systems.

### Labels

Labels are key-value pairs attached to a metric. Every unique combination of label \
values creates a separate time series.

```
http_requests_total{{method="GET", status="200"}} 1234
http_requests_total{{method="POST", status="500"}} 7
```

**Cardinality warning:** high-cardinality labels (user IDs, request IDs, IP addresses) \
can cause memory exhaustion — millions of series = OOM. Good labels have bounded sets: \
`method`, `status`, `region`, `env`. Bad labels: `user_id`, `request_id`, `url`.

EXISTING THIN CONTENT TO EXPAND:
{content}

OUTPUT:
- Return the complete expanded lesson as a markdown file
- Preserve the YAML frontmatter (the ---...--- block at the top) exactly
- Aim for 300-500 lines of substantive content
- No padding, no obvious filler statements
- Output only the markdown — no prose before or after it
"""

QUIZ_PROMPT = """\
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

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        try:
            end = text.index("\n---", 3)
            return text[end + 4:].strip()
        except ValueError:
            pass
    return text


def _is_thin(content: str, min_lines: int) -> tuple[bool, str]:
    non_blank = [l for l in content.splitlines() if l.strip()]
    count = len(non_blank)
    if count < min_lines:
        return True, f"{count} lines"
    missing = [s for s in REQUIRED_SECTIONS if s not in content]
    if missing:
        return True, f"missing {', '.join(missing)}"
    return False, ""


def _expand_content(title: str, module_slug: str, raw_content: str) -> str:
    prompt = EXPANSION_PROMPT.format(title=title, module=module_slug, content=raw_content)
    text = generate(prompt, max_tokens=16384)
    # Strip accidental outer markdown fence wrapper (don't split on inner code blocks)
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text  # drop opening ```markdown line
        if text.endswith("```"):
            text = text[:-3].rstrip()
    return text.strip()


def _generate_questions(title: str, content: str) -> list[dict]:
    prompt = QUIZ_PROMPT.format(title=title, content=content)
    text = generate(prompt, max_tokens=4096)
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text  # drop opening ```json line
        if text.endswith("```"):
            text = text[:-3].rstrip()
    return json.loads(text.strip())


def _store_questions(lesson_id: int, questions: list[dict], replace: bool = False) -> None:
    conn = get_conn()
    try:
        if replace:
            # srs_schedule FK-references quiz_questions; delete child rows first
            conn.execute(
                "DELETE FROM srs_schedule WHERE question_id IN "
                "(SELECT id FROM quiz_questions WHERE lesson_id = ?)",
                (lesson_id,),
            )
            conn.execute("DELETE FROM quiz_questions WHERE lesson_id = ?", (lesson_id,))
        for q in questions:
            conn.execute(
                "INSERT INTO quiz_questions (lesson_id, question, options, correct_index, explanation) "
                "VALUES (?, ?, ?, ?, ?)",
                (lesson_id, q["question"], json.dumps(q["options"]), q["correct_index"], q["explanation"]),
            )
        conn.commit()
    finally:
        conn.close()


def _all_lessons(module_filter: str | None) -> list[dict]:
    conn = get_conn()
    try:
        where = "AND m.slug = ?" if module_filter else ""
        params = (module_filter,) if module_filter else ()
        rows = conn.execute(
            f"""
            SELECT l.id, l.slug, l.title, l.md_path,
                   m.slug AS module_slug, m.title AS module_title,
                   COUNT(qq.id) AS question_count
            FROM lessons l
            JOIN modules m ON l.module_id = m.id
            LEFT JOIN quiz_questions qq ON qq.lesson_id = l.id
            WHERE 1=1 {where}
            GROUP BY l.id
            ORDER BY m.group_name, m.order_index, l.order_index
            """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _auto_commit(expanded_files: list[str]) -> None:
    if not expanded_files:
        return
    result = subprocess.run(
        ["git", "add", "--"] + expanded_files,
        cwd=PROJECT_ROOT,
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"\ngit add failed: {result.stderr.strip()}")
        return

    n = len(expanded_files)
    body = "\n".join(f"  - {f}" for f in expanded_files)
    msg = f"content: expand {n} thin lesson{'s' if n != 1 else ''} to gold standard\n\n{body}"

    result = subprocess.run(
        ["git", "commit", "-m", msg],
        cwd=PROJECT_ROOT,
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        hash_result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=PROJECT_ROOT, capture_output=True, text=True,
        )
        print(f"\nCommitted {n} expanded lesson(s) as {hash_result.stdout.strip()}")
    else:
        combined = result.stdout + result.stderr
        if "nothing to commit" in combined:
            print("\nNothing to commit (content already staged or clean).")
        else:
            print(f"\ngit commit failed: {result.stderr.strip()}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    dry_run = "--dry-run" in sys.argv
    content_only = "--content-only" in sys.argv
    quiz_only = "--quiz-only" in sys.argv
    force_content = "--force-content" in sys.argv
    force_quiz = "--force-quiz" in sys.argv

    min_lines = MIN_LINES_DEFAULT
    if "--min-lines" in sys.argv:
        idx = sys.argv.index("--min-lines")
        if idx + 1 < len(sys.argv):
            min_lines = int(sys.argv[idx + 1])

    module_filter = None
    if "--module" in sys.argv:
        idx = sys.argv.index("--module")
        if idx + 1 < len(sys.argv):
            module_filter = sys.argv[idx + 1]

    init_db()
    lessons = _all_lessons(module_filter)

    if not lessons:
        print("No lessons found.")
        return

    prefix = "DRY RUN — " if dry_run else ""
    print(f"{prefix}{len(lessons)} lessons to survey\n")

    if dry_run:
        current_module = None
        for lesson in lessons:
            if lesson["module_slug"] != current_module:
                current_module = lesson["module_slug"]
                print(f"[{current_module}]")

            md_file = PROJECT_ROOT / lesson["md_path"]
            if not md_file.exists():
                print(f"  {lesson['slug']}: SKIP (no .md file)")
                continue

            raw = md_file.read_text()
            content = _strip_frontmatter(raw)
            thin, reason = _is_thin(content, min_lines) if not quiz_only else (False, "")
            has_quiz = lesson["question_count"] > 0

            content_status = f"thin ({reason})" if (thin and not force_content) else "OK"
            if force_content and not quiz_only:
                content_status = f"will re-expand ({sum(1 for l in content.splitlines() if l.strip())} lines)"
            quiz_status = ("will regen" if force_quiz and has_quiz else "has quiz") if has_quiz else "needs quiz"
            print(f"  {lesson['slug']}: content {content_status} | {quiz_status}")
        return

    expanded_files: list[str] = []
    content_ok = content_expanded = content_failed = 0
    quiz_ok = quiz_generated = quiz_failed = 0

    for i, lesson in enumerate(lessons, 1):
        label = f"[{i}/{len(lessons)}] {lesson['module_slug']}/{lesson['slug']}"
        print(f"{label} ...", end=" ", flush=True)

        md_file = PROJECT_ROOT / lesson["md_path"]
        if not md_file.exists():
            print("SKIP (no .md file)")
            continue

        raw = md_file.read_text()
        content_body = _strip_frontmatter(raw)

        # --- Content phase ---
        content_tag = ""
        expansion_failed = False
        if not quiz_only:
            thin, reason = _is_thin(content_body, min_lines)
            if thin or force_content:
                original_lines = sum(1 for l in content_body.splitlines() if l.strip())
                for attempt in range(3):
                    try:
                        expanded = _expand_content(lesson["title"], lesson["module_slug"], raw)
                        new_body = _strip_frontmatter(expanded)
                        fm_intact = new_body != expanded.strip()
                        blocks_closed = new_body.count("```") % 2 == 0
                        missing = [s for s in REQUIRED_SECTIONS if s not in new_body]
                        issues = (
                            ([] if fm_intact else ["frontmatter lost"]) +
                            ([] if blocks_closed else ["unclosed code block"]) +
                            missing
                        )
                        if issues and attempt < 2:
                            print(f"retry ({', '.join(issues)}) ...", end=" ", flush=True)
                            time.sleep(2)
                            continue
                        if not fm_intact:
                            # Corrupted frontmatter is worse than leaving the original thin content
                            content_tag = "EXPAND FAILED (frontmatter lost)"
                            content_failed += 1
                            expansion_failed = True
                            break
                        md_file.write_text(expanded)
                        new_lines = sum(1 for l in new_body.splitlines() if l.strip())
                        content_body = new_body  # use expanded content for quiz step
                        non_fm_issues = [i for i in issues if i != "frontmatter lost"]
                        suffix = f", {', '.join(non_fm_issues)}" if non_fm_issues else ""
                        content_tag = f"expanded ({original_lines}→{new_lines} lines{suffix})"
                        expanded_files.append(lesson["md_path"])
                        content_expanded += 1
                        break
                    except Exception as e:
                        if attempt < 2:
                            print(f"retry ({type(e).__name__}) ...", end=" ", flush=True)
                            time.sleep(5)
                        else:
                            content_tag = f"EXPAND FAILED ({e})"
                            content_failed += 1
                            expansion_failed = True
            else:
                content_tag = "content OK"
                content_ok += 1

        # --- Quiz phase ---
        quiz_tag = ""
        if not content_only:
            if lesson["question_count"] > 0 and not force_quiz:
                quiz_tag = "quiz OK"
                quiz_ok += 1
            elif expansion_failed:
                quiz_tag = "quiz SKIPPED (content expansion failed)"
                quiz_failed += 1
            else:
                for attempt in range(3):
                    try:
                        questions = _generate_questions(lesson["title"], content_body)
                        if len(questions) != 5:
                            raise ValueError(f"expected 5 questions, got {len(questions)}")
                        _store_questions(lesson["id"], questions, replace=force_quiz)
                        quiz_tag = "quiz regenerated" if force_quiz else "quiz generated"
                        quiz_generated += 1
                        break
                    except json.JSONDecodeError as e:
                        if attempt < 2:
                            print(f"retry (quiz JSON) ...", end=" ", flush=True)
                            time.sleep(2)
                        else:
                            quiz_tag = f"QUIZ FAILED (JSON: {e})"
                            quiz_failed += 1
                    except Exception as e:
                        if attempt < 2:
                            print(f"retry (quiz: {type(e).__name__}) ...", end=" ", flush=True)
                            time.sleep(5)
                        else:
                            quiz_tag = f"QUIZ FAILED ({e})"
                            quiz_failed += 1

        parts = [p for p in [content_tag, quiz_tag] if p]
        print(" | ".join(parts) if parts else "OK")
        time.sleep(0.3)

    # --- Summary ---
    print()
    if not quiz_only:
        print(f"Content: {content_ok} OK, {content_expanded} expanded, {content_failed} failed")
    if not content_only:
        print(f"Quiz:    {quiz_ok} OK, {quiz_generated} generated, {quiz_failed} failed")

    _auto_commit(expanded_files)


if __name__ == "__main__":
    main()

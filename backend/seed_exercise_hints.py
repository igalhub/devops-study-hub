#!/usr/bin/env python3
"""
seed_exercise_hints.py — Add 2 progressive hints to every Quick Check exercise
that has an expected_output block but no hints yet.

Run from backend/:
    python3 seed_exercise_hints.py [options]

Options:
    --dry-run         Show what would be changed without making API calls
    --module <slug>   Limit to one module (e.g. bash, docker)
"""
import json
import os
import re
import sys
import time
from pathlib import Path

from anthropic import Anthropic
from db import get_conn, init_db

PROJECT_ROOT = Path(__file__).parent.parent
CONTENT_DIR = PROJECT_ROOT / "content"
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")

HINTS_PROMPT = """\
You are writing exercise hints for a DevOps study platform.

Module: {module_title}
Exercise: {exercise_text}
Expected output: {expected_output}

Generate exactly 2 progressive hints for a learner who is stuck:
- Hint 1: point toward the key command, concept, or approach (one sentence, general direction).
- Hint 2: name the exact command, flag, syntax, or pattern needed (one sentence, more specific).
- Do NOT reveal the full solution or repeat the expected output verbatim.

Return ONLY a JSON array of 2 strings — no prose, no markdown fences.
Example: ["Think about which command counts matching lines in a file.", "Pipe grep to wc -l, then use awk to strip the filename from the count."]
"""


def _get_modules(slug_filter: str | None) -> list[dict]:
    conn = get_conn()
    try:
        where = "WHERE m.slug = ?" if slug_filter else ""
        params = (slug_filter,) if slug_filter else ()
        rows = conn.execute(
            f"SELECT m.slug, m.title, GROUP_CONCAT(l.md_path, '|') AS md_paths "
            f"FROM modules m LEFT JOIN lessons l ON l.module_id = m.id "
            f"{where} GROUP BY m.id ORDER BY m.group_name, m.order_index",
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _find_exercises_needing_hints(filepath: Path) -> list[dict]:
    """Return list of {exercise_text, expected_output, close_line_idx} for exercises missing hints."""
    text = filepath.read_text()
    if "## Exercises" not in text:
        return []

    lines = text.splitlines(keepends=True)
    results = []
    in_exercises = False
    in_fence = False
    fence_type = ""
    fence_content: list[str] = []
    current_exercise_text = ""

    for i, line in enumerate(lines):
        stripped = line.rstrip("\n").strip()

        if not in_exercises:
            if stripped.startswith("## Exercises"):
                in_exercises = True
            continue

        if stripped.startswith("```"):
            if not in_fence:
                fence_type = stripped[3:].strip()
                in_fence = True
                fence_content = []
            else:
                if fence_type == "expected_output":
                    expected_output = "\n".join(fence_content).strip()
                    # Look ahead for existing hint
                    j = i + 1
                    while j < len(lines) and lines[j].strip() == "":
                        j += 1
                    has_hints = j < len(lines) and lines[j].strip().lower().startswith("hint:")
                    if not has_hints and expected_output:
                        results.append({
                            "exercise_text": current_exercise_text,
                            "expected_output": expected_output,
                            "close_line_idx": i,
                        })
                in_fence = False
                fence_type = ""
                fence_content = []
            continue

        if in_fence:
            fence_content.append(line.rstrip("\n"))
            continue

        m = re.match(r"^\s*\d+\.\s+(.+)", stripped)
        if m:
            current_exercise_text = m.group(1)
        elif current_exercise_text and stripped and not stripped.startswith("#") and not stripped.startswith("---"):
            current_exercise_text += " " + stripped

    return results


def _generate_hints(client: Anthropic, module_title: str, exercise_text: str, expected_output: str) -> list[str]:
    prompt = HINTS_PROMPT.format(
        module_title=module_title,
        exercise_text=exercise_text.strip()[:500],
        expected_output=expected_output.strip()[:200],
    )
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=256,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text[:-3].rstrip()
    hints = json.loads(text.strip())
    if not isinstance(hints, list) or len(hints) != 2 or not all(isinstance(h, str) for h in hints):
        raise ValueError(f"unexpected format: {hints!r}")
    return hints


def _insert_hints(filepath: Path, insertions: list[dict]) -> None:
    """Insert hint lines after each expected_output closing fence (in reverse order)."""
    lines = filepath.read_text().splitlines(keepends=True)
    for item in reversed(sorted(insertions, key=lambda x: x["close_line_idx"])):
        idx = item["close_line_idx"]
        hint_lines = ["\n"] + [f"hint: {h}\n" for h in item["hints"]]
        lines[idx + 1 : idx + 1] = hint_lines
    filepath.write_text("".join(lines))


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    module_filter = None
    if "--module" in sys.argv:
        idx = sys.argv.index("--module")
        if idx + 1 < len(sys.argv):
            module_filter = sys.argv[idx + 1]

    init_db()
    modules = _get_modules(module_filter)
    if not modules:
        print("No modules found.")
        return

    client = None if dry_run else Anthropic()
    prefix = "DRY RUN — " if dry_run else ""
    print(f"{prefix}{len(modules)} module(s)\n")

    total_added = total_failed = 0

    for mi, mod in enumerate(modules, 1):
        if not mod["md_paths"]:
            continue
        paths = [p for p in mod["md_paths"].split("|") if p]
        mod_added = mod_failed = 0

        for path in paths:
            filepath = PROJECT_ROOT / path
            if not filepath.exists():
                continue

            exercises = _find_exercises_needing_hints(filepath)
            if not exercises:
                continue

            lesson_name = filepath.stem

            if dry_run:
                print(f"  [{mod['slug']}] {lesson_name}: {len(exercises)} exercise(s) need hints")
                mod_added += len(exercises)
                continue

            insertions = []
            for ex in exercises:
                for attempt in range(3):
                    try:
                        hints = _generate_hints(client, mod["title"], ex["exercise_text"], ex["expected_output"])
                        insertions.append({"close_line_idx": ex["close_line_idx"], "hints": hints})
                        mod_added += 1
                        break
                    except Exception as e:
                        if attempt < 2:
                            time.sleep(2)
                        else:
                            print(f"\n  FAILED [{mod['slug']}:{lesson_name}] {ex['exercise_text'][:50]!r}: {e}")
                            mod_failed += 1
                time.sleep(0.3)

            if insertions:
                _insert_hints(filepath, insertions)

        total_added += mod_added
        total_failed += mod_failed
        if not dry_run and (mod_added or mod_failed):
            print(f"[{mi}/{len(modules)}] {mod['slug']}: {mod_added} hints added"
                  + (f", {mod_failed} failed" if mod_failed else ""))

    print(f"\nTotal: {total_added} hints added" + (f", {total_failed} failed" if total_failed else ""))


if __name__ == "__main__":
    main()

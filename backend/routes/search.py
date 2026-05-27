import re
from pathlib import Path
from fastapi import APIRouter
from db import get_conn

router = APIRouter()

PROJECT_ROOT = Path(__file__).parent.parent.parent


@router.get("/search")
def search(q: str):
    q = q.strip()
    if len(q) < 2:
        return []

    ql = q.lower()
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT l.slug, l.title as lesson_title, l.md_path,
                      m.slug as module_slug, m.title as module_title
               FROM lessons l JOIN modules m ON l.module_id = m.id
               ORDER BY m.order_index, l.order_index"""
        ).fetchall()
    finally:
        conn.close()

    results = []
    for row in rows:
        md_file = PROJECT_ROOT / row["md_path"]
        if not md_file.exists():
            continue
        raw = md_file.read_text(encoding="utf-8", errors="ignore")
        # strip frontmatter
        body = raw
        if raw.startswith("---"):
            try:
                end = raw.index("---", 3)
                body = raw[end + 3:]
            except ValueError:
                pass

        idx = body.lower().find(ql)
        if idx == -1:
            continue

        start = max(0, idx - 60)
        end = min(len(body), idx + len(ql) + 60)
        snippet = body[start:end].strip()
        snippet = re.sub(r"\s+", " ", snippet)
        if start > 0:
            snippet = "…" + snippet
        if end < len(body):
            snippet += "…"

        results.append({
            "module_slug": row["module_slug"],
            "module_title": row["module_title"],
            "lesson_slug": row["slug"],
            "lesson_title": row["lesson_title"],
            "snippet": snippet,
        })
        if len(results) >= 8:
            break

    return results

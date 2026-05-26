from fastapi import APIRouter, HTTPException
from pathlib import Path
from db import get_conn

router = APIRouter()

PROJECT_ROOT = Path(__file__).parent.parent.parent


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith('---'):
        return {}, text
    try:
        end = text.index('---', 3)
    except ValueError:
        return {}, text
    body = text[end + 3:].strip()
    return {}, body


@router.get('/lessons/{slug}')
def get_lesson(slug: str):
    conn = get_conn()
    row = conn.execute(
        """SELECT l.id, l.title, l.slug, l.duration_min, l.difficulty, l.md_path,
                  m.slug AS module_slug, m.title AS module_title
           FROM lessons l JOIN modules m ON l.module_id = m.id
           WHERE l.slug = ?""",
        (slug,)
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail='Lesson not found')

    md_file = PROJECT_ROOT / row['md_path']
    content = None
    if md_file.exists():
        _, content = _parse_frontmatter(md_file.read_text())

    return {
        'id': row['id'],
        'title': row['title'],
        'slug': row['slug'],
        'duration_min': row['duration_min'],
        'difficulty': row['difficulty'],
        'module_slug': row['module_slug'],
        'module_title': row['module_title'],
        'content': content,
    }

import re
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


def _parse_exercises(body: str) -> list[str]:
    if '## Exercises' not in body:
        return []
    section = body.split('## Exercises', 1)[1]
    section = re.split(r'\n## ', section)[0]
    items = []
    current = None
    for line in section.split('\n'):
        m = re.match(r'^\d+\.\s+(.+)$', line.strip())
        if m:
            if current is not None:
                items.append(current.strip())
            current = m.group(1)
        elif current is not None and line.strip():
            current += ' ' + line.strip()
    if current is not None:
        items.append(current.strip())
    return items


def _strip_exercises(body: str) -> str:
    if '## Exercises' not in body:
        return body
    before, rest = body.split('## Exercises', 1)
    next_section = re.search(r'\n## ', rest)
    if next_section:
        return before.rstrip() + '\n' + rest[next_section.start():]
    return before.rstrip()


@router.get('/lessons/{slug}')
def get_lesson(slug: str):
    conn = get_conn()
    try:
        row = conn.execute(
            """SELECT l.id, l.title, l.slug, l.duration_min, l.difficulty, l.md_path,
                      m.slug AS module_slug, m.title AS module_title
               FROM lessons l JOIN modules m ON l.module_id = m.id
               WHERE l.slug = ?""",
            (slug,)
        ).fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail='Lesson not found')

    md_file = PROJECT_ROOT / row['md_path']
    content = None
    exercises = []
    if md_file.exists():
        _, body = _parse_frontmatter(md_file.read_text())
        exercises = _parse_exercises(body)
        content = _strip_exercises(body) if exercises else body

    return {
        'id': row['id'],
        'title': row['title'],
        'slug': row['slug'],
        'duration_min': row['duration_min'],
        'difficulty': row['difficulty'],
        'module_slug': row['module_slug'],
        'module_title': row['module_title'],
        'content': content,
        'exercises': exercises,
    }

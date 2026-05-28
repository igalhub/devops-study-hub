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


def _parse_exercises(body: str) -> list[dict]:
    if '## Exercises' not in body:
        return []
    section = body.split('## Exercises', 1)[1]
    section = re.split(r'\n## ', section)[0]

    items = []
    current_text = None
    current_expected = None
    in_fence = False
    fence_tag = ''
    fence_lines: list[str] = []

    for line in section.split('\n'):
        stripped = line.strip()

        if stripped.startswith('```'):
            if not in_fence:
                fence_tag = stripped[3:].strip()
                in_fence = True
                fence_lines = []
            else:
                if fence_tag == 'expected_output':
                    current_expected = '\n'.join(fence_lines).strip()
                elif current_text is not None and fence_lines:
                    block = f'\n\n```{fence_tag}\n' + '\n'.join(fence_lines) + '\n```'
                    current_text += block
                in_fence = False
                fence_tag = ''
                fence_lines = []
            continue

        if in_fence:
            fence_lines.append(line)
            continue

        if stripped.startswith('#') or stripped == '---':
            continue

        m = re.match(r'^\d+\.\s+(.+)$', stripped)
        if m:
            if current_text is not None:
                items.append({'text': current_text.strip(), 'expected_output': current_expected})
            current_text = m.group(1)
            current_expected = None
            continue

        if current_text is not None and stripped:
            current_text += ' ' + stripped

    if current_text is not None:
        items.append({'text': current_text.strip(), 'expected_output': current_expected})

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

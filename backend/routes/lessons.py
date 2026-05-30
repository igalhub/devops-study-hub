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
    current_hints: list[str] = []
    in_fence = False
    fence_tag = ''
    fence_lines: list[str] = []
    # True when collecting a full ### Exercise N: block as a single item;
    # False in Quick Checks sections where each numbered item is its own exercise.
    in_named_exercise = False

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

        if stripped.startswith('###'):
            if re.search(r'Exercise\s+\d+', stripped, re.IGNORECASE):
                # Start of a named exercise — save previous item, begin new block
                if current_text is not None:
                    items.append({'text': current_text.strip(), 'expected_output': current_expected, 'hints': current_hints})
                current_text = ''
                current_expected = None
                current_hints = []
                in_named_exercise = True
            else:
                # e.g. ### Quick Checks — end of named exercises, switch to item mode
                if current_text is not None:
                    items.append({'text': current_text.strip(), 'expected_output': current_expected, 'hints': current_hints})
                current_text = None
                current_expected = None
                current_hints = []
                in_named_exercise = False
            continue

        if stripped.startswith('#') or stripped == '---':
            continue

        m = re.match(r'^\d+\.\s+(.+)$', stripped)
        if m:
            if in_named_exercise:
                # Sub-bullet within a named exercise — append as a list item
                if current_text is not None:
                    current_text += '\n' + line
            else:
                # Quick Check style — each numbered item is its own exercise
                if current_text is not None:
                    items.append({'text': current_text.strip(), 'expected_output': current_expected, 'hints': current_hints})
                current_text = m.group(1)
                current_expected = None
                current_hints = []
            continue

        if current_text is not None and stripped.lower().startswith('hint:'):
            current_hints.append(stripped[5:].strip())
            continue

        if current_text is not None and stripped:
            if in_named_exercise:
                sep = '\n\n' if stripped.startswith('**') else '\n'
                current_text += sep + stripped
            else:
                current_text += ' ' + stripped

    if current_text is not None:
        items.append({'text': current_text.strip(), 'expected_output': current_expected, 'hints': current_hints})

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

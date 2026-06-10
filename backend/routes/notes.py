from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from db import get_conn

router = APIRouter()


def _get_lesson_id(slug: str):
    conn = get_conn()
    try:
        row = conn.execute("SELECT id FROM lessons WHERE slug = ?", (slug,)).fetchone()
        return row["id"] if row else None
    finally:
        conn.close()


@router.get("/notes/{lesson_slug}")
def get_note(lesson_slug: str):
    lesson_id = _get_lesson_id(lesson_slug)
    if not lesson_id:
        raise HTTPException(status_code=404, detail="Lesson not found")
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT content FROM lesson_notes WHERE lesson_id = ?", (lesson_id,)
        ).fetchone()
        return {"content": row["content"] if row else ""}
    finally:
        conn.close()


class NoteBody(BaseModel):
    content: str


@router.post("/notes/{lesson_slug}")
def save_note(lesson_slug: str, body: NoteBody):
    lesson_id = _get_lesson_id(lesson_slug)
    if not lesson_id:
        raise HTTPException(status_code=404, detail="Lesson not found")
    conn = get_conn()
    try:
        conn.execute(
            """INSERT INTO lesson_notes (lesson_id, content, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(lesson_id) DO UPDATE SET
                   content = excluded.content,
                   updated_at = excluded.updated_at""",
            (lesson_id, body.content, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return {"content": body.content}
    finally:
        conn.close()

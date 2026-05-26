import json
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from anthropic import Anthropic
from db import get_conn

router = APIRouter()
client = Anthropic()

PROJECT_ROOT = Path(__file__).parent.parent.parent


def _get_lesson_row(slug: str):
    conn = get_conn()
    try:
        return conn.execute(
            "SELECT id, title, md_path FROM lessons WHERE slug = ?", (slug,)
        ).fetchone()
    finally:
        conn.close()


def _generate_and_store(lesson_id: int, title: str, content: str) -> None:
    model = os.getenv('CLAUDE_MODEL', 'claude-sonnet-4-6')
    prompt = (
        f"Generate exactly 5 multiple-choice questions for a DevOps lesson.\n\n"
        f"Lesson: {title}\n\nContent:\n{content}\n\n"
        "Return ONLY a JSON array — no other text, no markdown fences. Each item:\n"
        '{"question":"...","options":["A","B","C","D"],"correct_index":0,"explanation":"1-2 sentences why correct"}\n\n'
        "Rules: test understanding not memorisation; all 4 options must be plausible; correct_index is 0-3."
    )
    response = client.messages.create(
        model=model,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1].lstrip("json").strip() if len(parts) > 1 else text
    try:
        questions = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"Claude returned unparseable JSON: {e}")

    conn = get_conn()
    try:
        for q in questions:
            conn.execute(
                "INSERT INTO quiz_questions (lesson_id, question, options, correct_index, explanation) VALUES (?,?,?,?,?)",
                (lesson_id, q["question"], json.dumps(q["options"]), q["correct_index"], q["explanation"]),
            )
        conn.commit()
    finally:
        conn.close()


def _fetch_questions(lesson_id: int) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, question, options, correct_index, explanation FROM quiz_questions WHERE lesson_id = ?",
            (lesson_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r["id"],
            "question": r["question"],
            "options": json.loads(r["options"]),
            "correct_index": r["correct_index"],
            "explanation": r["explanation"],
        }
        for r in rows
    ]


@router.get("/quiz/{lesson_slug}")
def get_quiz(lesson_slug: str):
    lesson = _get_lesson_row(lesson_slug)
    if not lesson:
        raise HTTPException(status_code=404, detail="Lesson not found")

    cached = _fetch_questions(lesson["id"])
    if cached:
        return cached

    md_file = PROJECT_ROOT / lesson["md_path"]
    if not md_file.exists():
        raise HTTPException(status_code=422, detail="Lesson has no content — add a .md file first")

    text = md_file.read_text()
    if text.startswith("---"):
        try:
            end = text.index("---", 3)
            content = text[end + 3:].strip()
        except ValueError:
            content = text
    else:
        content = text

    _generate_and_store(lesson["id"], lesson["title"], content)
    return _fetch_questions(lesson["id"])


class AttemptRequest(BaseModel):
    question_id: int
    is_correct: bool


@router.post("/quiz/attempt")
def log_attempt(req: AttemptRequest):
    conn = get_conn()
    try:
        lesson_row = conn.execute(
            "SELECT lesson_id FROM quiz_questions WHERE id = ?", (req.question_id,)
        ).fetchone()
        if not lesson_row:
            raise HTTPException(status_code=404, detail="Question not found")
        lesson_id = lesson_row["lesson_id"]

        prior = conn.execute(
            "SELECT COUNT(*) as n FROM quiz_attempts WHERE question_id = ?", (req.question_id,)
        ).fetchone()["n"]

        xp = 0
        if req.is_correct:
            xp = 5 if prior == 0 else 2

        conn.execute(
            "INSERT INTO quiz_attempts (lesson_id, question_id, is_correct) VALUES (?,?,?)",
            (lesson_id, req.question_id, 1 if req.is_correct else 0),
        )
        if xp > 0:
            conn.execute("INSERT INTO xp_log (source, points) VALUES ('quiz', ?)", (xp,))
        conn.commit()

        xp_total = conn.execute(
            "SELECT COALESCE(SUM(points), 0) as total FROM xp_log"
        ).fetchone()["total"]
    finally:
        conn.close()

    return {"xp_earned": xp, "xp_total": xp_total}

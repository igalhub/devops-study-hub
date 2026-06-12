import json
import random
from datetime import date
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ai_client import generate
from db import get_conn
from srs import update_srs

router = APIRouter()

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
    prompt = (
        f"Generate exactly 5 multiple-choice questions for a DevOps lesson.\n\n"
        f"Lesson: {title}\n\nContent:\n{content}\n\n"
        "Return ONLY a JSON array — no other text, no markdown fences. Each item:\n"
        '{"question":"...","options":["A","B","C","D"],"correct_index":0,"explanation":"1-2 sentences why correct"}\n\n'
        "Rules: test understanding not memorisation; all 4 options must be plausible; correct_index is 0-3."
    )
    text = generate(prompt, max_tokens=2048)
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1].lstrip("json").strip() if len(parts) > 1 else text
    try:
        questions = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"Claude returned unparseable JSON: {e}")

    conn = get_conn()
    try:
        # Double-check: another concurrent request may have already inserted questions
        if conn.execute(
            "SELECT COUNT(*) as n FROM quiz_questions WHERE lesson_id = ?", (lesson_id,)
        ).fetchone()["n"] > 0:
            return

        for q in questions:
            opts = q.get("options", [])
            ci = q.get("correct_index", -1)
            if not isinstance(opts, list) or len(opts) < 2:
                continue
            if not isinstance(ci, int) or not (0 <= ci < len(opts)):
                continue
            conn.execute(
                "INSERT INTO quiz_questions (lesson_id, question, options, correct_index, explanation) VALUES (?,?,?,?,?)",
                (lesson_id, q["question"], json.dumps(opts), ci, q.get("explanation", "")),
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


@router.get("/quiz/module/{module_slug}")
def get_module_quiz(module_slug: str):
    conn = get_conn()
    try:
        mod = conn.execute(
            "SELECT id FROM modules WHERE slug = ?", (module_slug,)
        ).fetchone()
        if not mod:
            raise HTTPException(status_code=404, detail="Module not found")
        rows = conn.execute(
            """SELECT q.id, q.question, q.options, q.correct_index, q.explanation,
                      l.title as lesson_title
               FROM quiz_questions q
               JOIN lessons l ON q.lesson_id = l.id
               WHERE l.module_id = ?""",
            (mod["id"],),
        ).fetchall()
    finally:
        conn.close()

    questions = [
        {
            "id": r["id"],
            "question": r["question"],
            "options": json.loads(r["options"]),
            "correct_index": r["correct_index"],
            "explanation": r["explanation"],
            "lesson_title": r["lesson_title"],
        }
        for r in rows
    ]
    random.shuffle(questions)
    return questions[:20]


@router.get("/quiz/weak-areas")
def get_weak_area_questions():
    conn = get_conn()
    try:
        weak_lessons = conn.execute("""
            SELECT l.id AS lesson_id
            FROM (
                SELECT a.lesson_id,
                       CAST(ROUND(100.0 * SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END)
                            / COUNT(a.id)) AS INTEGER) AS accuracy
                FROM quiz_attempts a
                GROUP BY a.lesson_id
                HAVING COUNT(a.id) >= 3
            ) sub
            JOIN lessons l ON l.id = sub.lesson_id
            WHERE sub.accuracy < 70
            ORDER BY sub.accuracy ASC
            LIMIT 5
        """).fetchall()

        if not weak_lessons:
            return []

        lesson_ids = [r['lesson_id'] for r in weak_lessons]
        placeholders = ','.join('?' * len(lesson_ids))
        rows = conn.execute(f"""  # nosec B608 — placeholders is only '?' chars, values are parameterized
            SELECT q.id, q.question, q.options, q.correct_index, q.explanation,
                   l.title AS lesson_title, m.title AS module_title
            FROM quiz_questions q
            JOIN lessons l ON q.lesson_id = l.id
            JOIN modules m ON l.module_id = m.id
            WHERE q.lesson_id IN ({placeholders})
        """, lesson_ids).fetchall()

        questions = [
            {
                'id': r['id'],
                'question': r['question'],
                'options': json.loads(r['options']),
                'correct_index': r['correct_index'],
                'explanation': r['explanation'],
                'lesson_title': r['lesson_title'],
                'module_title': r['module_title'],
            }
            for r in rows
        ]
        random.shuffle(questions)
        return questions[:20]
    finally:
        conn.close()


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


def _update_srs(conn, question_id: int, is_correct: bool) -> None:
    update_srs(conn, 'srs_schedule', question_id, is_correct)


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
        _update_srs(conn, req.question_id, req.is_correct)
        conn.commit()

        xp_total = conn.execute(
            "SELECT COALESCE(SUM(points), 0) as total FROM xp_log"
        ).fetchone()["total"]
    finally:
        conn.close()

    return {"xp_earned": xp, "xp_total": xp_total}


@router.get("/review/queue")
def get_review_queue():
    conn = get_conn()
    try:
        today = date.today().isoformat()
        rows = conn.execute(
            """SELECT q.id, q.question, q.options, q.correct_index, q.explanation,
                      l.title as lesson_title, m.title as module_title
               FROM srs_schedule s
               JOIN quiz_questions q ON s.question_id = q.id
               JOIN lessons l ON q.lesson_id = l.id
               JOIN modules m ON l.module_id = m.id
               WHERE s.next_review <= ?
               ORDER BY s.next_review
               LIMIT 20""",
            (today,)
        ).fetchall()
        return [
            {
                "id": r["id"],
                "question": r["question"],
                "options": json.loads(r["options"]),
                "correct_index": r["correct_index"],
                "explanation": r["explanation"],
                "lesson_title": r["lesson_title"],
                "module_title": r["module_title"],
            }
            for r in rows
        ]
    finally:
        conn.close()

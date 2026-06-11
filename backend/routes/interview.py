import json
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ai_client import generate, AITimeoutError, AINotConfiguredError
from db import get_conn
from srs import update_srs

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_module_row(slug: str):
    conn = get_conn()
    try:
        return conn.execute(
            "SELECT id, title FROM modules WHERE slug = ?", (slug,)
        ).fetchone()
    finally:
        conn.close()


def _fetch_questions(module_id: int) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, question, hints, model_answer FROM interview_questions WHERE module_id = ?",
            (module_id,)
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r["id"],
            "question": r["question"],
            "hints": json.loads(r["hints"] or "[]"),
            "model_answer": r["model_answer"] or "",
        }
        for r in rows
    ]


def _generate_and_store(module_id: int, title: str) -> None:
    prompt = (
        f"Generate exactly 5 DevOps job interview questions on the topic: {title}.\n\n"
        "Requirements:\n"
        "- Scenario-based or conceptual, not trivia\n"
        "- Test real understanding and ability to communicate tradeoffs\n"
        "- Mix of 'explain', 'how would you', and 'what's the difference between' styles\n\n"
        "Return ONLY a JSON array of 5 strings — no other text, no markdown fences.\n"
        'Example: ["How would you debug a container that keeps crashing in production?", ...]'
    )
    text = generate(prompt, max_tokens=1024, timeout=60.0)
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1].lstrip("json").strip() if len(parts) > 1 else text
    try:
        questions = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"Claude returned unparseable JSON: {e}")
    if not isinstance(questions, list) or not all(isinstance(q, str) for q in questions):
        raise HTTPException(status_code=502, detail="Claude returned unexpected format: expected array of strings")

    conn = get_conn()
    try:
        # Double-check: another concurrent request may have already inserted questions
        if conn.execute(
            "SELECT COUNT(*) as n FROM interview_questions WHERE module_id = ?", (module_id,)
        ).fetchone()["n"] > 0:
            return
        for q in questions:
            conn.execute(
                "INSERT INTO interview_questions (module_id, question) VALUES (?, ?)",
                (module_id, q),
            )
        conn.commit()
    finally:
        conn.close()


@router.get("/interview/questions/{module_slug}")
def get_interview_questions(module_slug: str):
    mod = _get_module_row(module_slug)
    if not mod:
        raise HTTPException(status_code=404, detail="Module not found")

    cached = _fetch_questions(mod["id"])
    if cached:
        return cached

    try:
        _generate_and_store(mod["id"], mod["title"])
    except AINotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return _fetch_questions(mod["id"])


def _update_interview_srs(conn, question_id: int, is_correct: bool) -> None:
    update_srs(conn, 'interview_srs_schedule', question_id, is_correct)


class EvaluateRequest(BaseModel):
    question: str
    answer: str
    module_slug: str
    question_id: int | None = None


@router.post("/interview/evaluate")
def evaluate_answer(req: EvaluateRequest):
    mod = _get_module_row(req.module_slug)
    if not mod:
        raise HTTPException(status_code=404, detail="Module not found")
    module_title = mod["title"]

    prompt = (
        f"You are evaluating a DevOps job interview answer.\n\n"
        f"Topic: {module_title}\n"
        f"Question: {req.question}\n"
        f"Candidate's answer: {req.answer}\n\n"
        "Score the answer and return ONLY a JSON object — no other text, no markdown fences:\n"
        '{"score":"Weak|Adequate|Strong","feedback":"2-3 sentences on what was good and what was missing","model_answer":"A strong answer in 3-5 sentences"}'
    )
    result = None
    last_err = None
    for attempt in range(2):
        try:
            text = generate(prompt, max_tokens=1024, timeout=45.0)
        except AINotConfiguredError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except AITimeoutError:
            raise HTTPException(status_code=504, detail="Evaluation timed out — please try again")
        # Strip markdown fences (```json ... ``` or ``` ... ```)
        if "```" in text:
            parts = text.split("```")
            text = parts[1].lstrip("json").strip() if len(parts) > 1 else text
        # Extract first {...} block in case Claude adds prose around JSON
        start, end = text.find('{'), text.rfind('}')
        if start != -1 and end != -1:
            text = text[start:end + 1]
        try:
            result = json.loads(text)
            break
        except json.JSONDecodeError as e:
            last_err = e
            logger.warning("evaluate attempt %d: JSON parse failed: %s", attempt + 1, e)
    if result is None:
        raise HTTPException(status_code=502, detail=f"Claude returned unparseable JSON: {last_err}")

    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail=f"Claude returned unexpected type: {type(result).__name__}")
    required = {'score', 'feedback', 'model_answer'}
    missing = required - result.keys()
    if missing:
        raise HTTPException(status_code=502, detail=f"Claude response missing keys: {missing}")
    if result['score'] not in ('Weak', 'Adequate', 'Strong'):
        raise HTTPException(status_code=502, detail=f"Claude returned invalid score: {result['score']!r}")

    xp_earned = 0
    xp_total = 0
    if req.question_id is not None:
        conn = get_conn()
        try:
            q_row = conn.execute(
                "SELECT iq.id, iq.module_id FROM interview_questions iq "
                "JOIN modules m ON iq.module_id = m.id "
                "WHERE iq.id = ? AND m.slug = ?",
                (req.question_id, req.module_slug)
            ).fetchone()
            if q_row:
                score = result['score']
                is_correct = score != 'Weak'
                conn.execute(
                    "INSERT INTO interview_attempts (question_id, module_id, score, is_correct) VALUES (?, ?, ?, ?)",
                    (req.question_id, q_row['module_id'], score, int(is_correct))
                )
                _update_interview_srs(conn, req.question_id, is_correct)
                xp_points = 5 if score == 'Strong' else 2 if score == 'Adequate' else 0
                if xp_points > 0:
                    conn.execute(
                        "INSERT INTO xp_log (source, points) VALUES ('interview', ?)",
                        (xp_points,)
                    )
                conn.commit()
                xp_earned = xp_points
            else:
                logger.warning(
                    "question_id=%s not found for module_slug=%s, skipping persistence",
                    req.question_id, req.module_slug
                )
            xp_total = conn.execute(
                "SELECT COALESCE(SUM(points), 0) as t FROM xp_log"
            ).fetchone()['t']
        except Exception:
            logger.exception(
                "Failed to persist interview attempt for question_id=%s", req.question_id
            )
            conn.rollback()
            xp_earned = 0
            xp_total = 0
        finally:
            conn.close()

    return {**result, 'xp_earned': xp_earned, 'xp_total': xp_total}


@router.get("/interview/review/queue")
def get_interview_review_queue():
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT iq.id, iq.question, iq.hints, iq.model_answer,
                   m.title AS module_title, m.slug AS module_slug
            FROM interview_srs_schedule s
            JOIN interview_questions iq ON s.question_id = iq.id
            JOIN modules m ON iq.module_id = m.id
            WHERE s.next_review <= date('now')
            ORDER BY s.next_review
            LIMIT 20
        """).fetchall()
        return [
            {'id': r['id'], 'question': r['question'],
             'hints': json.loads(r['hints'] or '[]'),
             'model_answer': r['model_answer'] or '',
             'module_title': r['module_title'], 'module_slug': r['module_slug']}
            for r in rows
        ]
    finally:
        conn.close()


class SelfGradeRequest(BaseModel):
    question_id: int
    module_slug: str
    score: str


@router.post("/interview/self-grade")
def self_grade(req: SelfGradeRequest):
    if req.score not in ('Weak', 'Adequate', 'Strong'):
        raise HTTPException(status_code=400, detail="score must be Weak, Adequate, or Strong")
    mod = _get_module_row(req.module_slug)
    if not mod:
        raise HTTPException(status_code=404, detail="Module not found")

    conn = get_conn()
    try:
        q_row = conn.execute(
            "SELECT iq.id, iq.module_id, iq.model_answer FROM interview_questions iq "
            "JOIN modules m ON iq.module_id = m.id "
            "WHERE iq.id = ? AND m.slug = ?",
            (req.question_id, req.module_slug)
        ).fetchone()
        if not q_row:
            raise HTTPException(status_code=404, detail="Question not found")

        is_correct = req.score != 'Weak'
        conn.execute(
            "INSERT INTO interview_attempts (question_id, module_id, score, is_correct) VALUES (?, ?, ?, ?)",
            (req.question_id, q_row['module_id'], req.score, int(is_correct))
        )
        _update_interview_srs(conn, req.question_id, is_correct)
        xp_points = 5 if req.score == 'Strong' else 2 if req.score == 'Adequate' else 0
        if xp_points > 0:
            conn.execute(
                "INSERT INTO xp_log (source, points) VALUES ('interview', ?)", (xp_points,)
            )
        conn.commit()
        xp_total = conn.execute(
            "SELECT COALESCE(SUM(points), 0) as t FROM xp_log"
        ).fetchone()['t']
    finally:
        conn.close()

    return {
        'score': req.score,
        'model_answer': q_row['model_answer'] or '',
        'xp_earned': xp_points,
        'xp_total': xp_total,
    }

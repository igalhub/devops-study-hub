import json
import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from anthropic import Anthropic
from db import get_conn

router = APIRouter()
client = Anthropic()


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
            "SELECT id, question FROM interview_questions WHERE module_id = ?", (module_id,)
        ).fetchall()
    finally:
        conn.close()
    return [{"id": r["id"], "question": r["question"]} for r in rows]


def _generate_and_store(module_id: int, title: str) -> None:
    model = os.getenv('CLAUDE_MODEL', 'claude-sonnet-4-6')
    prompt = (
        f"Generate exactly 5 DevOps job interview questions on the topic: {title}.\n\n"
        "Requirements:\n"
        "- Scenario-based or conceptual, not trivia\n"
        "- Test real understanding and ability to communicate tradeoffs\n"
        "- Mix of 'explain', 'how would you', and 'what's the difference between' styles\n\n"
        "Return ONLY a JSON array of 5 strings — no other text, no markdown fences.\n"
        'Example: ["How would you debug a container that keeps crashing in production?", ...]'
    )
    response = client.messages.create(
        model=model,
        max_tokens=1024,
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
    if not isinstance(questions, list) or not all(isinstance(q, str) for q in questions):
        raise HTTPException(status_code=502, detail="Claude returned unexpected format: expected array of strings")

    conn = get_conn()
    try:
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

    _generate_and_store(mod["id"], mod["title"])
    return _fetch_questions(mod["id"])


class EvaluateRequest(BaseModel):
    question: str
    answer: str
    module_slug: str


@router.post("/interview/evaluate")
def evaluate_answer(req: EvaluateRequest):
    mod = _get_module_row(req.module_slug)
    module_title = mod["title"] if mod else req.module_slug

    model = os.getenv('CLAUDE_MODEL', 'claude-sonnet-4-6')
    prompt = (
        f"You are evaluating a DevOps job interview answer.\n\n"
        f"Topic: {module_title}\n"
        f"Question: {req.question}\n"
        f"Candidate's answer: {req.answer}\n\n"
        "Score the answer and return ONLY a JSON object — no other text, no markdown fences:\n"
        '{"score":"Weak|Adequate|Strong","feedback":"2-3 sentences on what was good and what was missing","model_answer":"A strong answer in 3-5 sentences"}'
    )
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1].lstrip("json").strip() if len(parts) > 1 else text
    try:
        result = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"Claude returned unparseable JSON: {e}")
    return result

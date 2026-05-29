import json
import logging
import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from anthropic import Anthropic
from db import get_conn
from routes.sandbox import _run_subprocess

logger = logging.getLogger(__name__)
router = APIRouter()
client = Anthropic()

XP_SANDBOX_PASS = 10
XP_AI_ADEQUATE = 8
XP_AI_STRONG = 15
XP_PROJECT_COMPLETE = 75


def _xp_total() -> int:
    conn = get_conn()
    try:
        return conn.execute("SELECT COALESCE(SUM(points), 0) FROM xp_log").fetchone()[0]
    finally:
        conn.close()


def _upsert_progress(project_id: int, step_id: int, status: str, score=None, answer=None):
    conn = get_conn()
    try:
        conn.execute(
            """
            INSERT INTO project_progress (project_id, step_id, status, score, answer, completed_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(project_id, step_id) DO UPDATE SET
                status=excluded.status, score=excluded.score,
                answer=excluded.answer, completed_at=excluded.completed_at
            """,
            (project_id, step_id, status, score, answer),
        )
        conn.commit()
    finally:
        conn.close()


def _check_project_complete(project_id: int):
    conn = get_conn()
    try:
        total = conn.execute(
            "SELECT COUNT(*) as n FROM project_steps WHERE project_id = ?", (project_id,)
        ).fetchone()["n"]
        done = conn.execute(
            "SELECT COUNT(*) as n FROM project_progress "
            "WHERE project_id = ? AND status IN ('passed', 'graded')",
            (project_id,),
        ).fetchone()["n"]
        if done >= total and total > 0:
            source = f"project_complete:{project_id}"
            conn.execute("BEGIN EXCLUSIVE")
            already = conn.execute(
                "SELECT 1 FROM xp_log WHERE source = ? LIMIT 1", (source,)
            ).fetchone()
            if not already:
                conn.execute(
                    "INSERT INTO xp_log (source, points) VALUES (?, ?)",
                    (source, XP_PROJECT_COMPLETE),
                )
            conn.commit()
    finally:
        conn.close()


def _get_project_and_step(slug: str, step_id: int, step_type: str):
    conn = get_conn()
    try:
        p = conn.execute("SELECT * FROM projects WHERE slug = ?", (slug,)).fetchone()
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")
        step = conn.execute(
            "SELECT * FROM project_steps WHERE id = ? AND project_id = ? AND type = ?",
            (step_id, p["id"], step_type),
        ).fetchone()
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")
        return dict(p), dict(step)
    finally:
        conn.close()


@router.get("/projects")
def list_projects():
    conn = get_conn()
    try:
        projects = conn.execute("SELECT * FROM projects ORDER BY id").fetchall()
        result = []
        for p in projects:
            steps_total = conn.execute(
                "SELECT COUNT(*) as n FROM project_steps WHERE project_id = ?", (p["id"],)
            ).fetchone()["n"]
            steps_done = conn.execute(
                "SELECT COUNT(*) as n FROM project_progress "
                "WHERE project_id = ? AND status IN ('passed', 'graded')",
                (p["id"],),
            ).fetchone()["n"]
            result.append({
                "id": p["id"],
                "slug": p["slug"],
                "title": p["title"],
                "description": p["description"],
                "modules": json.loads(p["modules"]),
                "difficulty": p["difficulty"],
                "steps_total": steps_total,
                "steps_done": steps_done,
            })
        return result
    finally:
        conn.close()


@router.get("/projects/{slug}")
def get_project(slug: str):
    conn = get_conn()
    try:
        p = conn.execute("SELECT * FROM projects WHERE slug = ?", (slug,)).fetchone()
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")
        steps = conn.execute(
            "SELECT * FROM project_steps WHERE project_id = ? ORDER BY order_index",
            (p["id"],),
        ).fetchall()
        progress_rows = conn.execute(
            "SELECT * FROM project_progress WHERE project_id = ?", (p["id"],)
        ).fetchall()
        progress_map = {r["step_id"]: dict(r) for r in progress_rows}

        steps_data = []
        for s in steps:
            prog = progress_map.get(s["id"], {})
            steps_data.append({
                "id": s["id"],
                "order_index": s["order_index"],
                "title": s["title"],
                "type": s["type"],
                "prompt": s["prompt"],
                "language": s["language"],
                "expected_output": s["expected_output"],
                "status": prog.get("status", "not_started"),
                "score": prog.get("score"),
                "answer": prog.get("answer"),
            })

        return {
            "id": p["id"],
            "slug": p["slug"],
            "title": p["title"],
            "description": p["description"],
            "modules": json.loads(p["modules"]),
            "difficulty": p["difficulty"],
            "steps": steps_data,
        }
    finally:
        conn.close()


class SandboxRequest(BaseModel):
    code: str
    language: str


@router.post("/projects/{slug}/steps/{step_id}/sandbox")
def check_sandbox_step(slug: str, step_id: int, req: SandboxRequest):
    project, step = _get_project_and_step(slug, step_id, "sandbox")

    if req.language not in ("bash", "python", "yaml"):
        return {"passed": False, "reason": "unsupported_language", "actual": "", "expected": step["expected_output"], "stderr": "", "xp_earned": 0, "xp_total": _xp_total()}
    if len(req.code) > 10_000:
        return {"passed": False, "reason": "code_too_long", "actual": "", "expected": step["expected_output"], "stderr": "", "xp_earned": 0, "xp_total": _xp_total()}

    result = _run_subprocess(req.code, req.language)
    actual = result["stdout"].strip()
    expected = (step["expected_output"] or "").strip()

    if result["exit_code"] != 0:
        _upsert_progress(project["id"], step_id, "failed", answer=req.code)
        return {
            "passed": False,
            "reason": "non_zero_exit",
            "actual": actual,
            "expected": expected,
            "stderr": result["stderr"],
            "xp_earned": 0,
            "xp_total": _xp_total(),
        }

    passed = actual == expected
    xp_earned = 0

    if passed:
        _upsert_progress(project["id"], step_id, "passed", answer=req.code)
        source = f"project_step:{step_id}"
        conn = get_conn()
        try:
            conn.execute("BEGIN EXCLUSIVE")
            already = conn.execute(
                "SELECT 1 FROM xp_log WHERE source = ? LIMIT 1", (source,)
            ).fetchone()
            if not already:
                conn.execute(
                    "INSERT INTO xp_log (source, points) VALUES (?, ?)", (source, XP_SANDBOX_PASS)
                )
                xp_earned = XP_SANDBOX_PASS
            conn.commit()
        finally:
            conn.close()
        _check_project_complete(project["id"])
    else:
        _upsert_progress(project["id"], step_id, "failed", answer=req.code)

    return {
        "passed": passed,
        "actual": actual,
        "expected": expected,
        "stderr": result["stderr"],
        "xp_earned": xp_earned,
        "xp_total": _xp_total(),
    }


class AiGradeRequest(BaseModel):
    answer: str


@router.post("/projects/{slug}/steps/{step_id}/ai-grade")
def grade_ai_step(slug: str, step_id: int, req: AiGradeRequest):
    project, step = _get_project_and_step(slug, step_id, "ai")

    model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")
    prompt = (
        f"You are evaluating a DevOps project task response.\n\n"
        f"Task: {step['title']}\n"
        f"Requirements:\n{step['prompt']}\n\n"
        f"Candidate's response:\n{req.answer}\n\n"
        "Score the response. Return ONLY a JSON object — no other text, no markdown fences:\n"
        '{"score":"Weak|Adequate|Strong","feedback":"2-3 sentences on correctness, completeness, and best-practice gaps","model_answer":"A strong example response"}'
    )
    response = client.messages.create(
        model=model,
        max_tokens=1500,
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

    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="Claude returned unexpected format")
    missing = {"score", "feedback", "model_answer"} - result.keys()
    if missing:
        raise HTTPException(status_code=502, detail=f"Claude response missing keys: {missing}")
    if result["score"] not in ("Weak", "Adequate", "Strong"):
        raise HTTPException(status_code=502, detail=f"Invalid score: {result['score']!r}")

    score = result["score"]
    _upsert_progress(project["id"], step_id, "graded", score=score, answer=req.answer)

    xp_earned = 0
    source = f"project_ai_step:{step_id}"
    conn = get_conn()
    try:
        conn.execute("BEGIN EXCLUSIVE")
        already = conn.execute(
            "SELECT 1 FROM xp_log WHERE source = ? LIMIT 1", (source,)
        ).fetchone()
        if not already and score in ("Adequate", "Strong"):
            xp_points = XP_AI_STRONG if score == "Strong" else XP_AI_ADEQUATE
            conn.execute(
                "INSERT INTO xp_log (source, points) VALUES (?, ?)", (source, xp_points)
            )
            xp_earned = xp_points
        conn.commit()
    finally:
        conn.close()

    _check_project_complete(project["id"])

    return {**result, "xp_earned": xp_earned, "xp_total": _xp_total()}

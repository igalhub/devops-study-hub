from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import datetime, date
from db import get_conn

router = APIRouter()

XP_LESSON_COMPLETE = 10
XP_MODULE_COMPLETE = 50
UNLOCK_THRESHOLD = 0.8


class ProgressUpdate(BaseModel):
    status: Literal['not_started', 'in_progress', 'complete']


@router.get('/progress')
def get_progress():
    conn = get_conn()
    try:
        rows = conn.execute("SELECT lesson_id, status FROM progress").fetchall()
        return {str(row['lesson_id']): row['status'] for row in rows}
    finally:
        conn.close()


@router.post('/progress/{lesson_id}')
def update_progress(lesson_id: int, body: ProgressUpdate):
    conn = get_conn()
    try:
        lesson = conn.execute("SELECT id, module_id FROM lessons WHERE id = ?", (lesson_id,)).fetchone()
        if not lesson:
            raise HTTPException(status_code=404, detail="Lesson not found")

        existing = conn.execute(
            "SELECT status FROM progress WHERE lesson_id = ?", (lesson_id,)
        ).fetchone()
        already_complete = existing and existing['status'] == 'complete'

        now = datetime.utcnow().isoformat()
        conn.execute(
            """INSERT INTO progress (lesson_id, status, completed_at)
               VALUES (?, ?, ?)
               ON CONFLICT(lesson_id) DO UPDATE SET
                 status=excluded.status,
                 completed_at=CASE WHEN excluded.status='complete' AND progress.status!='complete'
                                   THEN excluded.completed_at
                                   ELSE progress.completed_at END""",
            (lesson_id, body.status, now if body.status == 'complete' else None)
        )

        if body.status == 'complete' and not already_complete:
            conn.execute("INSERT INTO xp_log (source, points) VALUES ('lesson', ?)", (XP_LESSON_COMPLETE,))

            module_id = lesson['module_id']
            total = conn.execute(
                "SELECT COUNT(*) as c FROM lessons WHERE module_id = ?", (module_id,)
            ).fetchone()['c']
            done = conn.execute(
                """SELECT COUNT(*) as c FROM progress p
                   JOIN lessons l ON p.lesson_id = l.id
                   WHERE l.module_id = ? AND p.status = 'complete'""",
                (module_id,)
            ).fetchone()['c']

            if total > 0 and done == total:
                conn.execute(
                    "INSERT INTO xp_log (source, points) VALUES ('module_complete', ?)",
                    (XP_MODULE_COMPLETE,)
                )

            if total > 0 and done / total >= UNLOCK_THRESHOLD:
                next_mod = conn.execute(
                    """SELECT id FROM modules
                       WHERE order_index > (SELECT order_index FROM modules WHERE id = ?)
                       ORDER BY order_index LIMIT 1""",
                    (module_id,)
                ).fetchone()
                if next_mod:
                    conn.execute("UPDATE modules SET is_locked = 0 WHERE id = ?", (next_mod['id'],))

        today = date.today().isoformat()
        conn.execute(
            "INSERT INTO streaks (date, completed) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET completed=1",
            (today,)
        )

        conn.commit()
        xp_total = conn.execute(
            "SELECT COALESCE(SUM(points), 0) as total FROM xp_log"
        ).fetchone()['total']
        return {'status': body.status, 'xp_total': xp_total}
    finally:
        conn.close()


@router.get('/xp')
def get_xp():
    conn = get_conn()
    try:
        total = conn.execute(
            "SELECT COALESCE(SUM(points), 0) as total FROM xp_log"
        ).fetchone()['total']
        return {'xp_total': total}
    finally:
        conn.close()

from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import datetime, date, timedelta
from db import get_conn

router = APIRouter()

XP_LESSON_COMPLETE = 10
XP_MODULE_COMPLETE = 50


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

        if body.status == 'complete':
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


@router.get('/streaks')
def get_streaks():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT date FROM streaks WHERE completed = 1 ORDER BY date DESC"
        ).fetchall()
        dates = {row['date'] for row in rows}

        today = date.today()
        today_done = today.isoformat() in dates

        # Current streak: consecutive days ending today; if today not done yet,
        # yesterday is still the active tail (streak not broken until midnight)
        current = 0
        check = today if today_done else today - timedelta(days=1)
        while check.isoformat() in dates:
            current += 1
            check -= timedelta(days=1)

        # Longest streak: walk sorted dates counting consecutive runs
        longest = 0
        run = 0
        prev = None
        for d_str in sorted(dates):
            d_obj = date.fromisoformat(d_str)
            run = run + 1 if prev and (d_obj - prev).days == 1 else 1
            longest = max(longest, run)
            prev = d_obj

        return {'current_streak': current, 'longest_streak': longest, 'today_done': today_done}
    finally:
        conn.close()

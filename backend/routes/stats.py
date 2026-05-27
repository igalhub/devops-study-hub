from fastapi import APIRouter
from datetime import date, timedelta
from db import get_conn

router = APIRouter()


@router.get('/stats')
def get_stats():
    conn = get_conn()
    try:
        today = date.today()
        thirty_ago = (today - timedelta(days=29)).isoformat()

        xp_rows = conn.execute("""
            SELECT date(earned_at) as day, SUM(points) as xp
            FROM xp_log
            WHERE date(earned_at) >= ?
            GROUP BY day
        """, (thirty_ago,)).fetchall()
        xp_dict = {r['day']: r['xp'] for r in xp_rows}
        xp_by_day = [
            {'day': (today - timedelta(days=i)).isoformat(),
             'xp': xp_dict.get((today - timedelta(days=i)).isoformat(), 0)}
            for i in range(29, -1, -1)
        ]

        quiz_rows = conn.execute("""
            SELECT m.title as module_title, m.slug as module_slug, m.order_index,
                   COUNT(a.id) as total,
                   SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) as correct
            FROM quiz_attempts a
            JOIN quiz_questions q ON CAST(a.question_id AS INTEGER) = q.id
            JOIN lessons l ON q.lesson_id = l.id
            JOIN modules m ON l.module_id = m.id
            GROUP BY m.id
            HAVING total > 0
            ORDER BY m.order_index
        """).fetchall()

        total_done = conn.execute(
            "SELECT COUNT(*) as c FROM progress WHERE status = 'complete'"
        ).fetchone()['c']

        total_xp = conn.execute(
            "SELECT COALESCE(SUM(points), 0) as total FROM xp_log"
        ).fetchone()['total']

        total_attempts = conn.execute("SELECT COUNT(*) as c FROM quiz_attempts").fetchone()['c']
        correct_attempts = conn.execute(
            "SELECT COUNT(*) as c FROM quiz_attempts WHERE is_correct = 1"
        ).fetchone()['c']

        streak_dates = {
            r['date'] for r in conn.execute(
                "SELECT date FROM streaks WHERE completed = 1 ORDER BY date DESC LIMIT 31"
            ).fetchall()
        }
        today_done = today.isoformat() in streak_dates
        current = 0
        check = today if today_done else today - timedelta(days=1)
        while check.isoformat() in streak_dates:
            current += 1
            check -= timedelta(days=1)

        return {
            'xp_by_day': xp_by_day,
            'quiz_by_module': [
                {
                    'module_title': r['module_title'],
                    'module_slug': r['module_slug'],
                    'total': r['total'],
                    'correct': r['correct'],
                } for r in quiz_rows
            ],
            'summary': {
                'total_xp': total_xp,
                'lessons_done': total_done,
                'quiz_attempts': total_attempts,
                'quiz_correct': correct_attempts,
                'streak': current,
            },
        }
    finally:
        conn.close()

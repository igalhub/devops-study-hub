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
            SELECT module_title, module_slug, order_index, total, correct
            FROM (
                SELECT m.title AS module_title, m.slug AS module_slug, m.order_index,
                       COUNT(a.id) AS total,
                       SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
                FROM quiz_attempts a
                JOIN lessons l ON a.lesson_id = l.id
                JOIN modules m ON l.module_id = m.id
                GROUP BY m.id
            )
            WHERE total > 0
            ORDER BY order_index
        """).fetchall()

        # Uses a.lesson_id directly (authoritative FK on quiz_attempts) rather
        # than routing through quiz_questions. Threshold 70 must match the
        # subheading string in frontend/src/pages/Stats.jsx.
        weak_rows = conn.execute("""
            SELECT lesson_slug, lesson_title, module_slug, module_title,
                   attempt_count, wrong_count, accuracy
            FROM (
                SELECT l.slug  AS lesson_slug,
                       l.title AS lesson_title,
                       m.slug  AS module_slug,
                       m.title AS module_title,
                       COUNT(a.id) AS attempt_count,
                       SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
                       CAST(ROUND(
                           100.0 * SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END)
                           / COUNT(a.id)
                       ) AS INTEGER) AS accuracy
                FROM quiz_attempts a
                JOIN lessons l ON a.lesson_id = l.id
                JOIN modules m ON l.module_id = m.id
                GROUP BY l.id
                HAVING COUNT(a.id) >= 3
            )
            WHERE accuracy < 70
            ORDER BY accuracy ASC
            LIMIT 10
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
            'quiz_weak_lessons': [
                {
                    'lesson_slug':   r['lesson_slug'],
                    'lesson_title':  r['lesson_title'],
                    'module_slug':   r['module_slug'],
                    'module_title':  r['module_title'],
                    'accuracy':      r['accuracy'],
                    'attempt_count': r['attempt_count'],
                    'wrong_count':   r['wrong_count'],
                }
                for r in weak_rows
            ],
        }
    finally:
        conn.close()


@router.get('/stats/readiness')
def get_readiness():
    conn = get_conn()
    try:
        rows = conn.execute("""
            WITH completion AS (
                SELECT
                    m.id   AS module_id,
                    m.slug AS module_slug,
                    m.title AS module_title,
                    COUNT(l.id) AS total_lessons,
                    SUM(CASE WHEN p.status = 'complete' THEN 1 ELSE 0 END) AS completed_lessons
                FROM modules m
                JOIN lessons l ON l.module_id = m.id
                LEFT JOIN progress p ON p.lesson_id = l.id
                GROUP BY m.id
            ),
            quiz_acc AS (
                SELECT
                    m.id        AS module_id,
                    COUNT(a.id) AS total_attempts,
                    SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct_attempts
                FROM quiz_attempts a
                JOIN lessons l ON a.lesson_id = l.id
                JOIN modules m ON l.module_id = m.id
                GROUP BY m.id
            ),
            interview_cov AS (
                SELECT
                    iq.module_id,
                    COUNT(DISTINCT iq.id)          AS total_questions,
                    COUNT(DISTINCT ia.question_id) AS practiced_questions
                FROM interview_questions iq
                LEFT JOIN interview_attempts ia ON ia.question_id = iq.id
                GROUP BY iq.module_id
            )
            SELECT
                c.module_slug,
                c.module_title,
                CAST(ROUND(100.0 * c.completed_lessons / c.total_lessons) AS INTEGER) AS completion_pct,
                CASE WHEN COALESCE(q.total_attempts, 0) > 0
                     THEN CAST(ROUND(100.0 * q.correct_attempts / q.total_attempts) AS INTEGER)
                     ELSE 0 END AS quiz_pct,
                CASE WHEN COALESCE(i.total_questions, 0) > 0
                     THEN CAST(ROUND(100.0 * i.practiced_questions / i.total_questions) AS INTEGER)
                     ELSE 0 END AS interview_pct
            FROM completion c
            LEFT JOIN quiz_acc q      ON q.module_id = c.module_id
            LEFT JOIN interview_cov i ON i.module_id = c.module_id
        """).fetchall()

        results = []
        for r in rows:
            completion_pct = r['completion_pct']
            quiz_pct       = r['quiz_pct']
            interview_pct  = r['interview_pct']
            if completion_pct == 0 and quiz_pct == 0 and interview_pct == 0:
                continue
            score = round(completion_pct * 0.4 + quiz_pct * 0.4 + interview_pct * 0.2)
            results.append({
                'module_slug':    r['module_slug'],
                'module_title':   r['module_title'],
                'readiness':      score,
                'completion_pct': completion_pct,
                'quiz_pct':       quiz_pct,
                'interview_pct':  interview_pct,
            })
        return results
    finally:
        conn.close()

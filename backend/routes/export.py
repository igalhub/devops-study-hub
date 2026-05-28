from datetime import datetime, timezone
from fastapi import APIRouter
from db import get_conn

router = APIRouter()


@router.get('/export/progress')
def export_progress():
    conn = get_conn()
    try:
        progress_rows = conn.execute("""
            SELECT p.lesson_id, l.title AS lesson_title, l.slug AS lesson_slug,
                   m.title AS module_title, m.slug AS module_slug,
                   p.status, p.completed_at
            FROM progress p
            JOIN lessons l ON l.id = p.lesson_id
            JOIN modules m ON m.id = l.module_id
            ORDER BY m.order_index, l.order_index
        """).fetchall()

        xp_rows = conn.execute("""
            SELECT source, points, earned_at
            FROM xp_log
            ORDER BY earned_at
        """).fetchall()

        quiz_rows = conn.execute("""
            SELECT qa.lesson_id, l.title AS lesson_title,
                   qa.question_id, qq.question AS question_text,
                   qa.answer, qa.is_correct, qa.attempted_at
            FROM quiz_attempts qa
            JOIN lessons l ON l.id = qa.lesson_id
            LEFT JOIN quiz_questions qq ON qq.id = CAST(qa.question_id AS INTEGER)
            ORDER BY qa.attempted_at
        """).fetchall()

        notes_rows = conn.execute("""
            SELECT l.title AS lesson_title, l.slug AS lesson_slug,
                   m.title AS module_title,
                   n.content, n.updated_at
            FROM lesson_notes n
            JOIN lessons l ON l.id = n.lesson_id
            JOIN modules m ON m.id = l.module_id
            ORDER BY m.order_index, l.title
        """).fetchall()

        interview_attempt_rows = conn.execute("""
            SELECT ia.question_id, iq.question AS question_text,
                   m.slug AS module_slug, m.title AS module_title,
                   ia.score, ia.is_correct, ia.attempted_at
            FROM interview_attempts ia
            JOIN interview_questions iq ON iq.id = ia.question_id
            JOIN modules m ON m.id = ia.module_id
            ORDER BY ia.attempted_at
        """).fetchall()

        interview_srs_rows = conn.execute("""
            SELECT iq.id AS question_id, iq.question AS question_text,
                   m.slug AS module_slug, m.title AS module_title,
                   s.interval_days, s.ease, s.next_review, s.reviews
            FROM interview_srs_schedule s
            JOIN interview_questions iq ON iq.id = s.question_id
            JOIN modules m ON m.id = iq.module_id
            ORDER BY m.order_index, iq.id
        """).fetchall()

        return {
            'exported_at': datetime.now(timezone.utc).isoformat(),
            'schema_version': 1,
            'progress': [
                {
                    'lesson_id':    r['lesson_id'],
                    'lesson_title': r['lesson_title'],
                    'lesson_slug':  r['lesson_slug'],
                    'module_title': r['module_title'],
                    'module_slug':  r['module_slug'],
                    'status':       r['status'],
                    'completed_at': r['completed_at'],
                }
                for r in progress_rows
            ],
            'xp_log': [
                {
                    'source':    r['source'],
                    'points':    r['points'],
                    'earned_at': r['earned_at'],
                }
                for r in xp_rows
            ],
            'quiz_attempts': [
                {
                    'lesson_id':     r['lesson_id'],
                    'lesson_title':  r['lesson_title'],
                    'question_id':   r['question_id'],
                    'question_text': r['question_text'],
                    'answer':        r['answer'],
                    'is_correct':    bool(r['is_correct']),
                    'attempted_at':  r['attempted_at'],
                }
                for r in quiz_rows
            ],
            'lesson_notes': [
                {
                    'lesson_title': r['lesson_title'],
                    'lesson_slug':  r['lesson_slug'],
                    'module_title': r['module_title'],
                    'content':      r['content'],
                    'updated_at':   r['updated_at'],
                }
                for r in notes_rows
            ],
            'interview_attempts': [
                {
                    'question_id':   r['question_id'],
                    'question_text': r['question_text'],
                    'module_slug':   r['module_slug'],
                    'module_title':  r['module_title'],
                    'score':         r['score'],
                    'is_correct':    bool(r['is_correct']),
                    'attempted_at':  r['attempted_at'],
                }
                for r in interview_attempt_rows
            ],
            'interview_srs_schedule': [
                {
                    'question_id':   r['question_id'],
                    'question_text': r['question_text'],
                    'module_slug':   r['module_slug'],
                    'module_title':  r['module_title'],
                    'interval_days': r['interval_days'],
                    'ease':          r['ease'],
                    'next_review':   r['next_review'],
                    'reviews':       r['reviews'],
                }
                for r in interview_srs_rows
            ],
        }
    finally:
        conn.close()

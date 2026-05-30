import sqlite3
import os
import pytest
from datetime import date, timedelta
from fastapi.testclient import TestClient
from main import app
from routes.lessons import _parse_exercises
from srs import update_srs

client = TestClient(app)

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'hub.db')

EXPECTED_TABLES = {
    'modules', 'lessons', 'progress', 'quiz_questions',
    'interview_questions', 'quiz_attempts', 'xp_log', 'streaks',
    'srs_schedule', 'interview_attempts', 'interview_srs_schedule',
    'lesson_notes',
}

EXPORT_KEYS = {
    'exported_at', 'schema_version',
    'progress', 'xp_log', 'quiz_attempts',
    'lesson_notes', 'interview_attempts', 'interview_srs_schedule',
}

READINESS_KEYS = {'module_slug', 'module_title', 'readiness', 'completion_pct', 'quiz_pct', 'interview_pct'}


def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ── Layer 1: Infrastructure ──────────────────────────────────────────────────

def test_health():
    r = client.get('/health')
    assert r.status_code == 200
    assert r.json() == {'status': 'ok'}


def test_modules_count():
    r = client.get('/modules')
    assert r.status_code == 200
    assert len(r.json()) == 23


def test_lessons_count():
    modules = client.get('/modules').json()
    total = sum(len(m['lessons']) for m in modules)
    assert total == 91


def test_db_tables_exist():
    conn = db_conn()
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert EXPECTED_TABLES <= tables


def test_db_modules_columns():
    conn = db_conn()
    cols = {row[1] for row in conn.execute('PRAGMA table_info(modules)').fetchall()}
    conn.close()
    assert {'id', 'slug', 'title', 'group_name', 'order_index', 'is_locked'} <= cols


def test_db_lessons_columns():
    conn = db_conn()
    cols = {row[1] for row in conn.execute('PRAGMA table_info(lessons)').fetchall()}
    conn.close()
    assert {'id', 'module_id', 'title', 'slug', 'duration_min', 'difficulty', 'order_index', 'md_path'} <= cols


def test_stats_shape():
    r = client.get('/stats')
    assert r.status_code == 200
    data = r.json()
    assert {'xp_by_day', 'quiz_by_module', 'summary', 'quiz_weak_lessons'} <= set(data.keys())
    assert {'total_xp', 'lessons_done', 'quiz_attempts', 'quiz_correct', 'streak'} <= set(data['summary'].keys())
    assert isinstance(data['quiz_weak_lessons'], list)
    assert len(data['quiz_weak_lessons']) <= 10
    WEAK_KEYS = {'lesson_slug', 'lesson_title', 'module_slug', 'module_title', 'accuracy', 'attempt_count', 'wrong_count'}
    for item in data['quiz_weak_lessons']:
        assert WEAK_KEYS <= set(item.keys())
        assert item['attempt_count'] >= 3
        assert item['accuracy'] < 70


def test_weak_lessons_shape_with_data():
    conn = db_conn()
    lesson_id = conn.execute("SELECT id FROM lessons LIMIT 1").fetchone()['id']
    conn.executemany(
        "INSERT INTO quiz_attempts (lesson_id, question_id, answer, is_correct) VALUES (?, 'wl-test-q', 'x', 0)",
        [(lesson_id,)] * 4,
    )
    conn.commit()
    ids = [r['id'] for r in conn.execute(
        "SELECT id FROM quiz_attempts WHERE question_id = 'wl-test-q'"
    ).fetchall()]
    try:
        r = client.get('/stats')
        assert r.status_code == 200
        wl = r.json()['quiz_weak_lessons']
        assert isinstance(wl, list)
        assert len(wl) <= 10
        assert len(wl) >= 1
        WEAK_KEYS = {'lesson_slug', 'lesson_title', 'module_slug', 'module_title', 'accuracy', 'attempt_count', 'wrong_count'}
        for item in wl:
            assert WEAK_KEYS <= set(item.keys())
            assert item['attempt_count'] >= 3
            assert item['accuracy'] < 70
            assert 0 <= item['wrong_count'] <= item['attempt_count']
    finally:
        conn.execute(f"DELETE FROM quiz_attempts WHERE id IN ({','.join('?' * len(ids))})", ids)
        conn.commit()
        conn.close()


def test_readiness_endpoint():
    r = client.get('/stats/readiness')
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_export_endpoint():
    r = client.get('/export/progress')
    assert r.status_code == 200
    assert set(r.json().keys()) == EXPORT_KEYS


# ── Layer 2: Per-feature ─────────────────────────────────────────────────────

def test_export_schema_version():
    assert client.get('/export/progress').json()['schema_version'] == 1


def test_export_sections_are_lists():
    data = client.get('/export/progress').json()
    for key in ('progress', 'xp_log', 'quiz_attempts', 'lesson_notes', 'interview_attempts', 'interview_srs_schedule'):
        assert isinstance(data[key], list), f"expected list for '{key}'"


def test_readiness_scores_in_range():
    for item in client.get('/stats/readiness').json():
        assert 0 <= item['readiness'] <= 100
        assert READINESS_KEYS <= set(item.keys())


def test_readiness_formula_weights():
    # score = round(completion*0.4 + quiz*0.4 + interview*0.2)
    for item in client.get('/stats/readiness').json():
        expected = round(item['completion_pct'] * 0.4 + item['quiz_pct'] * 0.4 + item['interview_pct'] * 0.2)
        assert item['readiness'] == expected, (
            f"{item['module_slug']}: expected {expected}, got {item['readiness']}"
        )


def test_progress_complete_creates_xp():
    conn = db_conn()
    row = conn.execute("""
        SELECT l.id FROM lessons l
        WHERE NOT EXISTS (
            SELECT 1 FROM progress p WHERE p.lesson_id = l.id AND p.status = 'complete'
        )
        LIMIT 1
    """).fetchone()
    xp_count_before = conn.execute("SELECT COUNT(*) FROM xp_log").fetchone()[0]
    conn.close()

    if row is None:
        pytest.skip("All lessons already complete — cannot test progress write without corrupting data")

    lesson_id = row['id']

    r = client.post(f'/progress/{lesson_id}', json={'status': 'complete'})
    assert r.status_code == 200
    data = r.json()
    assert data['status'] == 'complete'

    conn = db_conn()
    xp_count_after = conn.execute("SELECT COUNT(*) FROM xp_log").fetchone()[0]
    assert xp_count_after > xp_count_before, "Expected new XP row(s) after completing a lesson"

    # Cleanup: reset progress and remove the new xp rows (by highest ids)
    new_rows = xp_count_after - xp_count_before
    conn.execute(
        f"DELETE FROM xp_log WHERE id IN (SELECT id FROM xp_log ORDER BY id DESC LIMIT {new_rows})"
    )
    conn.execute(
        "UPDATE progress SET status='not_started', completed_at=NULL WHERE lesson_id=?",
        (lesson_id,)
    )
    conn.commit()
    conn.close()


def test_exercises_shape():
    r = client.get('/lessons/awk-sed')
    assert r.status_code == 200
    exercises = r.json()['exercises']
    assert isinstance(exercises, list)
    assert len(exercises) > 0
    for ex in exercises:
        assert 'text' in ex
        assert 'expected_output' in ex
        assert isinstance(ex['text'], str) and ex['text']
        assert ex['expected_output'] is None or isinstance(ex['expected_output'], str)
    assert any(ex['expected_output'] is not None for ex in exercises)


def test_sandbox_check_pass_awards_xp():
    r = client.post('/sandbox/check', json={
        'code': 'echo "hello"',
        'language': 'bash',
        'expected_output': 'hello',
        'slug': 'test-lesson',
        'index': 99,
    })
    assert r.status_code == 200
    data = r.json()
    assert data['passed'] is True
    assert data['xp_earned'] == 5

    conn = db_conn()
    conn.execute("DELETE FROM xp_log WHERE source = 'exercise_check:test-lesson:99'")
    conn.commit()
    conn.close()


def test_sandbox_check_idempotent_xp():
    source = 'exercise_check:test-lesson:98'
    conn = db_conn()
    conn.execute("DELETE FROM xp_log WHERE source = ?", (source,))
    conn.commit()
    conn.close()

    payload = {'code': 'echo "hi"', 'language': 'bash', 'expected_output': 'hi', 'slug': 'test-lesson', 'index': 98}
    r1 = client.post('/sandbox/check', json=payload)
    assert r1.json()['xp_earned'] == 5

    r2 = client.post('/sandbox/check', json=payload)
    assert r2.json()['xp_earned'] == 0
    assert r2.json()['passed'] is True

    conn = db_conn()
    conn.execute("DELETE FROM xp_log WHERE source = ?", (source,))
    conn.commit()
    conn.close()


def test_sandbox_check_fail():
    r = client.post('/sandbox/check', json={
        'code': 'echo "wrong"',
        'language': 'bash',
        'expected_output': 'right',
        'slug': 'test-lesson',
        'index': 97,
    })
    assert r.status_code == 200
    data = r.json()
    assert data['passed'] is False
    assert data['xp_earned'] == 0
    assert data['expected'] == 'right'
    assert data['actual'] == 'wrong'


def test_sandbox_completed():
    source = 'exercise_check:test-lesson:77'
    conn = db_conn()
    conn.execute("DELETE FROM xp_log WHERE source = ?", (source,))
    conn.commit()
    conn.close()

    # No completions yet
    r = client.get('/sandbox/completed/test-lesson')
    assert r.status_code == 200
    assert 77 not in r.json()['completed']

    # Pass an exercise to log it
    client.post('/sandbox/check', json={
        'code': 'echo "done"', 'language': 'bash',
        'expected_output': 'done', 'slug': 'test-lesson', 'index': 77,
    })

    r2 = client.get('/sandbox/completed/test-lesson')
    assert 77 in r2.json()['completed']

    conn = db_conn()
    conn.execute("DELETE FROM xp_log WHERE source = ?", (source,))
    conn.commit()
    conn.close()


# ── Interview self-grade ──────────────────────────────────────────────────────

def _first_interview_question_id() -> int | None:
    conn = db_conn()
    try:
        row = conn.execute("SELECT id FROM interview_questions LIMIT 1").fetchone()
        return row['id'] if row else None
    finally:
        conn.close()


def _first_module_slug() -> str | None:
    conn = db_conn()
    try:
        row = conn.execute(
            "SELECT m.slug FROM modules m "
            "JOIN interview_questions iq ON iq.module_id = m.id "
            "LIMIT 1"
        ).fetchone()
        return row['slug'] if row else None
    finally:
        conn.close()


def test_self_grade_invalid_score():
    r = client.post('/interview/self-grade', json={
        'question_id': 1,
        'module_slug': 'linux',
        'score': 'Bad',
    })
    assert r.status_code == 400


def test_self_grade_unknown_module():
    r = client.post('/interview/self-grade', json={
        'question_id': 1,
        'module_slug': 'does-not-exist',
        'score': 'Strong',
    })
    assert r.status_code == 404


def test_self_grade_strong_awards_xp():
    question_id = _first_interview_question_id()
    module_slug = _first_module_slug()
    if question_id is None or module_slug is None:
        pytest.skip("no interview questions in DB")

    conn = db_conn()
    xp_before = conn.execute("SELECT COALESCE(SUM(points),0) as t FROM xp_log").fetchone()['t']
    conn.close()

    r = client.post('/interview/self-grade', json={
        'question_id': question_id,
        'module_slug': module_slug,
        'score': 'Strong',
    })
    assert r.status_code == 200
    data = r.json()
    assert data['score'] == 'Strong'
    assert data['xp_earned'] == 5
    assert data['xp_total'] == xp_before + 5
    assert 'model_answer' in data


def test_self_grade_weak_awards_no_xp():
    question_id = _first_interview_question_id()
    module_slug = _first_module_slug()
    if question_id is None or module_slug is None:
        pytest.skip("no interview questions in DB")

    conn = db_conn()
    xp_before = conn.execute("SELECT COALESCE(SUM(points),0) as t FROM xp_log").fetchone()['t']
    conn.close()

    r = client.post('/interview/self-grade', json={
        'question_id': question_id,
        'module_slug': module_slug,
        'score': 'Weak',
    })
    assert r.status_code == 200
    data = r.json()
    assert data['score'] == 'Weak'
    assert data['xp_earned'] == 0
    assert data['xp_total'] == xp_before


# ── Exercise parser unit tests ─────────────────────────────────────────────────
#
# Regression: before the fix, _parse_exercises() treated every numbered bullet
# as a new exercise, so a ### Exercise 1: block with 3 sub-bullets became
# 3 items instead of 1.  The fix introduces in_named_exercise mode.

_TICKS = '`' * 3

_NAMED_EXERCISES_MD = f"""## Exercises

### Exercise 1: Parse a log file

Parse an input file.

1. Accept the path as the first argument
2. Filter lines containing ERROR
3. Print the count

{_TICKS}expected_output
3
{_TICKS}

### Exercise 2: Generate a report

Produce a summary.

1. Sum column values
2. Print the total

### Quick Checks

1. Print "hello" using echo.

{_TICKS}expected_output
hello
{_TICKS}

2. Count lines.

{_TICKS}expected_output
5
{_TICKS}
"""


def test_parse_exercises_named_block_count():
    """### Exercise N: blocks must each parse as one item, not split on numbered sub-bullets."""
    items = _parse_exercises(_NAMED_EXERCISES_MD)
    assert len(items) == 4, f"Expected 4 (2 named + 2 QC), got {len(items)}: {[i['text'][:40] for i in items]}"


def test_parse_exercises_named_block_preserves_all_bullets():
    """All numbered sub-bullets inside a named exercise must appear in its text."""
    text = _parse_exercises(_NAMED_EXERCISES_MD)[0]['text']
    assert 'Accept' in text
    assert 'Filter' in text
    assert 'Print the count' in text


def test_parse_exercises_named_block_expected_output():
    items = _parse_exercises(_NAMED_EXERCISES_MD)
    assert items[0]['expected_output'] == '3'
    assert items[1]['expected_output'] is None


def test_parse_exercises_quick_checks_split_on_numbered_items():
    items = _parse_exercises(_NAMED_EXERCISES_MD)
    assert items[2]['text'].startswith('Print')
    assert items[2]['expected_output'] == 'hello'
    assert items[3]['text'].startswith('Count')
    assert items[3]['expected_output'] == '5'


def test_awk_sed_exercise_count():
    """Regression: parser bug returned 14 items for awk-sed; correct count is 6 (4 named + 2 QC)."""
    exercises = client.get('/lessons/awk-sed').json()['exercises']
    assert len(exercises) == 6, f"Parser regression: got {len(exercises)}: {[e['text'][:40] for e in exercises]}"


# ── Projects ──────────────────────────────────────────────────────────────────

PROJECT_LIST_KEYS = {'id', 'slug', 'title', 'description', 'modules', 'difficulty', 'steps_total', 'steps_done'}
PROJECT_DETAIL_KEYS = {'id', 'slug', 'title', 'description', 'modules', 'difficulty', 'steps'}
STEP_KEYS = {'id', 'order_index', 'title', 'type', 'prompt', 'language', 'expected_output', 'hints', 'status'}


def _first_sandbox_step() -> tuple[str, int, str] | None:
    conn = db_conn()
    try:
        row = conn.execute(
            "SELECT p.slug, s.id, s.expected_output "
            "FROM project_steps s JOIN projects p ON s.project_id = p.id "
            "WHERE s.type = 'sandbox' LIMIT 1"
        ).fetchone()
        return (row['slug'], row['id'], row['expected_output']) if row else None
    finally:
        conn.close()


def _first_ai_step() -> tuple[str, int] | None:
    conn = db_conn()
    try:
        row = conn.execute(
            "SELECT p.slug, s.id "
            "FROM project_steps s JOIN projects p ON s.project_id = p.id "
            "WHERE s.type = 'ai' LIMIT 1"
        ).fetchone()
        return (row['slug'], row['id']) if row else None
    finally:
        conn.close()


def test_projects_list():
    r = client.get('/projects')
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) == 10
    for p in data:
        assert PROJECT_LIST_KEYS <= set(p.keys())
        assert isinstance(p['modules'], list)
        assert p['steps_total'] > 0


def test_project_detail():
    r = client.get('/projects/containerize-python-app')
    assert r.status_code == 200
    data = r.json()
    assert PROJECT_DETAIL_KEYS <= set(data.keys())
    assert isinstance(data['steps'], list)
    assert len(data['steps']) == 4
    for step in data['steps']:
        assert STEP_KEYS <= set(step.keys())
        assert step['type'] in ('sandbox', 'ai')
        assert step['status'] in ('not_started', 'passed', 'failed', 'graded')


def test_project_detail_404():
    r = client.get('/projects/does-not-exist')
    assert r.status_code == 404


def test_project_sandbox_step_pass_awards_xp():
    info = _first_sandbox_step()
    if info is None:
        pytest.skip("No sandbox steps in DB")
    slug, step_id, expected_output = info

    conn = db_conn()
    conn.execute("DELETE FROM project_progress WHERE step_id = ?", (step_id,))
    conn.execute("DELETE FROM xp_log WHERE source = ?", (f"project_step:{step_id}",))
    conn.commit()
    conn.close()

    r = client.post(f'/projects/{slug}/steps/{step_id}/sandbox', json={
        'code': f'echo {expected_output}', 'language': 'bash',
    })
    assert r.status_code == 200
    data = r.json()
    assert data['passed'] is True
    assert data['xp_earned'] == 10

    conn = db_conn()
    conn.execute("DELETE FROM project_progress WHERE step_id = ?", (step_id,))
    conn.execute("DELETE FROM xp_log WHERE source = ?", (f"project_step:{step_id}",))
    conn.commit()
    conn.close()


def test_project_sandbox_step_fail():
    info = _first_sandbox_step()
    if info is None:
        pytest.skip("No sandbox steps in DB")
    slug, step_id, _ = info

    conn = db_conn()
    conn.execute("DELETE FROM project_progress WHERE step_id = ?", (step_id,))
    conn.commit()
    conn.close()

    r = client.post(f'/projects/{slug}/steps/{step_id}/sandbox', json={
        'code': 'echo wrong_answer', 'language': 'bash',
    })
    assert r.status_code == 200
    data = r.json()
    assert data['passed'] is False
    assert data['xp_earned'] == 0

    conn = db_conn()
    conn.execute("DELETE FROM project_progress WHERE step_id = ?", (step_id,))
    conn.commit()
    conn.close()


def test_project_sandbox_step_idempotent_xp():
    info = _first_sandbox_step()
    if info is None:
        pytest.skip("No sandbox steps in DB")
    slug, step_id, expected_output = info

    conn = db_conn()
    conn.execute("DELETE FROM project_progress WHERE step_id = ?", (step_id,))
    conn.execute("DELETE FROM xp_log WHERE source = ?", (f"project_step:{step_id}",))
    conn.commit()
    conn.close()

    payload = {'code': f'echo {expected_output}', 'language': 'bash'}
    r1 = client.post(f'/projects/{slug}/steps/{step_id}/sandbox', json=payload)
    assert r1.json()['xp_earned'] == 10

    r2 = client.post(f'/projects/{slug}/steps/{step_id}/sandbox', json=payload)
    assert r2.json()['xp_earned'] == 0
    assert r2.json()['passed'] is True

    conn = db_conn()
    conn.execute("DELETE FROM project_progress WHERE step_id = ?", (step_id,))
    conn.execute("DELETE FROM xp_log WHERE source = ?", (f"project_step:{step_id}",))
    conn.commit()
    conn.close()


def test_project_sandbox_step_unknown_project_404():
    r = client.post('/projects/does-not-exist/steps/1/sandbox', json={
        'code': 'echo hi', 'language': 'bash',
    })
    assert r.status_code == 404


def test_project_sandbox_step_wrong_type_404():
    # Posting to the sandbox endpoint with an AI step ID must 404
    info = _first_ai_step()
    if info is None:
        pytest.skip("No ai steps in DB")
    slug, step_id = info
    r = client.post(f'/projects/{slug}/steps/{step_id}/sandbox', json={
        'code': 'echo hi', 'language': 'bash',
    })
    assert r.status_code == 404


# ── Quiz ──────────────────────────────────────────────────────────────────────

QUESTION_KEYS = {'id', 'question', 'options', 'correct_index', 'explanation'}


def _first_quiz_question() -> tuple[int, int] | None:
    """Return (question_id, lesson_id) for the first quiz question."""
    conn = db_conn()
    try:
        row = conn.execute("SELECT id, lesson_id FROM quiz_questions LIMIT 1").fetchone()
        return (row['id'], row['lesson_id']) if row else None
    finally:
        conn.close()


def _first_quiz_lesson_slug() -> str | None:
    conn = db_conn()
    try:
        row = conn.execute(
            "SELECT l.slug FROM quiz_questions qq "
            "JOIN lessons l ON qq.lesson_id = l.id LIMIT 1"
        ).fetchone()
        return row['slug'] if row else None
    finally:
        conn.close()


def test_quiz_lesson_returns_questions():
    slug = _first_quiz_lesson_slug()
    if slug is None:
        pytest.skip("No quiz questions in DB")
    r = client.get(f'/quiz/{slug}')
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0
    for q in data:
        assert QUESTION_KEYS <= set(q.keys())
        assert isinstance(q['options'], list)
        assert 0 <= q['correct_index'] < len(q['options'])


def test_quiz_lesson_question_count():
    slug = _first_quiz_lesson_slug()
    if slug is None:
        pytest.skip("No quiz questions in DB")
    assert len(client.get(f'/quiz/{slug}').json()) == 5


def test_quiz_lesson_404():
    r = client.get('/quiz/does-not-exist')
    assert r.status_code == 404


def test_quiz_attempt_correct_first_awards_5xp():
    result = _first_quiz_question()
    if result is None:
        pytest.skip("No quiz questions in DB")
    question_id, lesson_id = result

    conn = db_conn()
    conn.execute("DELETE FROM quiz_attempts WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM srs_schedule WHERE question_id = ?", (question_id,))
    max_xp_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM xp_log").fetchone()[0]
    conn.commit()
    conn.close()

    r = client.post('/quiz/attempt', json={'question_id': question_id, 'is_correct': True})
    assert r.status_code == 200
    assert r.json()['xp_earned'] == 5

    conn = db_conn()
    conn.execute("DELETE FROM quiz_attempts WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM srs_schedule WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM xp_log WHERE id > ? AND source = 'quiz'", (max_xp_id,))
    conn.commit()
    conn.close()


def test_quiz_attempt_correct_repeat_awards_2xp():
    result = _first_quiz_question()
    if result is None:
        pytest.skip("No quiz questions in DB")
    question_id, lesson_id = result

    conn = db_conn()
    conn.execute("DELETE FROM quiz_attempts WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM srs_schedule WHERE question_id = ?", (question_id,))
    # Seed one prior attempt so "prior > 0" → xp=2
    conn.execute(
        "INSERT INTO quiz_attempts (lesson_id, question_id, is_correct) VALUES (?,?,1)",
        (lesson_id, question_id),
    )
    max_xp_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM xp_log").fetchone()[0]
    conn.commit()
    conn.close()

    r = client.post('/quiz/attempt', json={'question_id': question_id, 'is_correct': True})
    assert r.status_code == 200
    assert r.json()['xp_earned'] == 2

    conn = db_conn()
    conn.execute("DELETE FROM quiz_attempts WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM srs_schedule WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM xp_log WHERE id > ? AND source = 'quiz'", (max_xp_id,))
    conn.commit()
    conn.close()


def test_quiz_attempt_incorrect_awards_0xp():
    result = _first_quiz_question()
    if result is None:
        pytest.skip("No quiz questions in DB")
    question_id, _ = result

    conn = db_conn()
    conn.execute("DELETE FROM quiz_attempts WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM srs_schedule WHERE question_id = ?", (question_id,))
    conn.commit()
    conn.close()

    r = client.post('/quiz/attempt', json={'question_id': question_id, 'is_correct': False})
    assert r.status_code == 200
    assert r.json()['xp_earned'] == 0

    conn = db_conn()
    conn.execute("DELETE FROM quiz_attempts WHERE question_id = ?", (question_id,))
    conn.execute("DELETE FROM srs_schedule WHERE question_id = ?", (question_id,))
    conn.commit()
    conn.close()


def test_quiz_attempt_unknown_question_404():
    r = client.post('/quiz/attempt', json={'question_id': 999999, 'is_correct': True})
    assert r.status_code == 404


# ── Quiz module ────────────────────────────────────────────────────────────────

QUIZ_MODULE_QUESTION_KEYS = {'id', 'question', 'options', 'correct_index', 'explanation', 'lesson_title'}


def test_quiz_module_returns_questions():
    r = client.get(f'/quiz/module/{_first_module_slug()}')
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert len(data) <= 20
    for q in data:
        assert QUIZ_MODULE_QUESTION_KEYS <= set(q.keys())


def test_quiz_module_404():
    r = client.get('/quiz/module/does-not-exist')
    assert r.status_code == 404


# ── Interview questions ────────────────────────────────────────────────────────

INTERVIEW_QUESTION_KEYS = {'id', 'question', 'hints', 'model_answer'}


def test_interview_questions_shape():
    slug = _first_module_slug()
    if slug is None:
        pytest.skip("No modules with interview questions in DB")
    r = client.get(f'/interview/questions/{slug}')
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0
    for q in data:
        assert INTERVIEW_QUESTION_KEYS <= set(q.keys())
        assert isinstance(q['hints'], list)


def test_interview_questions_404():
    r = client.get('/interview/questions/does-not-exist')
    assert r.status_code == 404


# ── Review queues ──────────────────────────────────────────────────────────────

REVIEW_QUEUE_KEYS = {'id', 'question', 'options', 'correct_index', 'explanation', 'lesson_title', 'module_title'}
INTERVIEW_REVIEW_QUEUE_KEYS = {'id', 'question', 'hints', 'model_answer', 'module_title', 'module_slug'}


def test_review_queue_shape():
    r = client.get('/review/queue')
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    for item in data:
        assert REVIEW_QUEUE_KEYS <= set(item.keys())


def test_interview_review_queue_shape():
    r = client.get('/interview/review/queue')
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    for item in data:
        assert INTERVIEW_REVIEW_QUEUE_KEYS <= set(item.keys())


# ── Notes ──────────────────────────────────────────────────────────────────────

def _first_lesson_slug() -> str | None:
    conn = db_conn()
    try:
        row = conn.execute("SELECT slug FROM lessons LIMIT 1").fetchone()
        return row['slug'] if row else None
    finally:
        conn.close()


def test_notes_get_returns_content_field():
    slug = _first_lesson_slug()
    if slug is None:
        pytest.skip("No lessons in DB")
    r = client.get(f'/notes/{slug}')
    assert r.status_code == 200
    assert 'content' in r.json()


def test_notes_save_and_fetch():
    slug = _first_lesson_slug()
    if slug is None:
        pytest.skip("No lessons in DB")

    original = client.get(f'/notes/{slug}').json()['content']

    r = client.post(f'/notes/{slug}', json={'content': 'test note'})
    assert r.status_code == 200
    assert r.json()['content'] == 'test note'

    assert client.get(f'/notes/{slug}').json()['content'] == 'test note'

    client.post(f'/notes/{slug}', json={'content': original})


def test_notes_404_on_unknown_lesson():
    assert client.get('/notes/does-not-exist').status_code == 404
    assert client.post('/notes/does-not-exist', json={'content': 'x'}).status_code == 404


# ── Search ─────────────────────────────────────────────────────────────────────

SEARCH_RESULT_KEYS = {'lesson_id', 'module_slug', 'module_title', 'lesson_slug', 'lesson_title', 'snippet'}


def test_search_returns_results():
    r = client.get('/search', params={'q': 'docker'})
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0
    for item in data:
        assert SEARCH_RESULT_KEYS <= set(item.keys())


def test_search_short_query_returns_empty():
    r = client.get('/search', params={'q': 'd'})
    assert r.status_code == 200
    assert r.json() == []


# ── Progress, XP, Streaks ──────────────────────────────────────────────────────

def test_progress_shape():
    r = client.get('/progress')
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, dict)
    for v in data.values():
        assert v in ('not_started', 'in_progress', 'complete')


def test_xp_shape():
    r = client.get('/xp')
    assert r.status_code == 200
    data = r.json()
    assert 'xp_total' in data
    assert isinstance(data['xp_total'], int)


def test_streaks_shape():
    r = client.get('/streaks')
    assert r.status_code == 200
    data = r.json()
    assert {'current_streak', 'longest_streak', 'today_done'} <= set(data.keys())
    assert isinstance(data['current_streak'], int)
    assert isinstance(data['longest_streak'], int)
    assert isinstance(data['today_done'], bool)


# ── Sandbox run ────────────────────────────────────────────────────────────────

SANDBOX_RUN_KEYS = {'stdout', 'stderr', 'exit_code'}


def test_sandbox_run_returns_output():
    r = client.post('/sandbox/run', json={'code': 'echo hello', 'language': 'bash'})
    assert r.status_code == 200
    data = r.json()
    assert SANDBOX_RUN_KEYS <= set(data.keys())
    assert data['stdout'].strip() == 'hello'
    assert data['exit_code'] == 0


def test_sandbox_run_unsupported_language():
    r = client.post('/sandbox/run', json={'code': 'echo hi', 'language': 'ruby'})
    assert r.status_code == 200
    data = r.json()
    assert data['exit_code'] == 1
    assert data['stderr']


# ── SRS unit tests ─────────────────────────────────────────────────────────────

def _srs_conn():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE srs_schedule (
            question_id INTEGER PRIMARY KEY,
            interval_days INTEGER DEFAULT 1,
            ease REAL DEFAULT 2.5,
            next_review TEXT,
            reviews INTEGER DEFAULT 0
        )
    """)
    return conn


def test_srs_first_correct_creates_row():
    conn = _srs_conn()
    update_srs(conn, 'srs_schedule', 1, True)
    row = conn.execute("SELECT * FROM srs_schedule WHERE question_id = 1").fetchone()
    assert row is not None
    assert row['reviews'] == 1
    assert row['interval_days'] == max(1, round(1 * 2.5))  # 2
    assert abs(row['ease'] - 2.6) < 0.001
    assert row['next_review'] == (date.today() + timedelta(days=row['interval_days'])).isoformat()


def test_srs_correct_increases_interval():
    conn = _srs_conn()
    update_srs(conn, 'srs_schedule', 1, True)   # interval→2, ease→2.6
    update_srs(conn, 'srs_schedule', 1, True)   # interval→round(2*2.6)=5, ease→2.7
    row = conn.execute("SELECT * FROM srs_schedule WHERE question_id = 1").fetchone()
    assert row['interval_days'] == 5
    assert abs(row['ease'] - 2.7) < 0.001
    assert row['reviews'] == 2


def test_srs_wrong_resets_interval():
    conn = _srs_conn()
    update_srs(conn, 'srs_schedule', 1, True)    # interval→2, ease→2.6
    update_srs(conn, 'srs_schedule', 1, False)   # interval→1, ease→2.4
    row = conn.execute("SELECT * FROM srs_schedule WHERE question_id = 1").fetchone()
    assert row['interval_days'] == 1
    assert abs(row['ease'] - 2.4) < 0.001


def test_srs_ease_floor():
    conn = _srs_conn()
    for _ in range(15):
        update_srs(conn, 'srs_schedule', 1, False)
    row = conn.execute("SELECT * FROM srs_schedule WHERE question_id = 1").fetchone()
    assert row['ease'] >= 1.3


def test_srs_ease_ceiling():
    # ease starts at 2.5, gains 0.1 per correct answer, ceiling is 3.5 — 10 iterations suffices
    conn = _srs_conn()
    for _ in range(10):
        update_srs(conn, 'srs_schedule', 1, True)
    row = conn.execute("SELECT * FROM srs_schedule WHERE question_id = 1").fetchone()
    assert row['ease'] <= 3.5


def test_srs_invalid_table_raises():
    conn = _srs_conn()
    with pytest.raises(ValueError):
        update_srs(conn, 'bad_table', 1, True)


# ── Parser edge cases ──────────────────────────────────────────────────────────

_NO_EXERCISES_MD = """## Introduction

This lesson has no exercises section.
"""

_HINTS_EXERCISES_MD = f"""## Exercises

### Quick Checks

1. Print hello.

{_TICKS}expected_output
hello
{_TICKS}
hint: Use the echo command.
hint: Try echo "hello".

2. Count words.

{_TICKS}expected_output
3
{_TICKS}
"""

_QUICK_CHECKS_ONLY_MD = f"""## Exercises

### Quick Checks

1. Print hello.

{_TICKS}expected_output
hello
{_TICKS}

2. Count words.

{_TICKS}expected_output
3
{_TICKS}
"""


def test_parse_exercises_no_section_returns_empty():
    assert _parse_exercises(_NO_EXERCISES_MD) == []


def test_parse_exercises_hints_populated():
    items = _parse_exercises(_HINTS_EXERCISES_MD)
    assert items[0]['hints'] == ['Use the echo command.', 'Try echo "hello".']
    assert items[1]['hints'] == []


def test_parse_exercises_quick_checks_only():
    items = _parse_exercises(_QUICK_CHECKS_ONLY_MD)
    assert len(items) == 2
    assert items[0]['text'] == 'Print hello.'
    assert items[0]['expected_output'] == 'hello'
    assert items[1]['text'] == 'Count words.'
    assert items[1]['expected_output'] == '3'


# ── Data integrity ─────────────────────────────────────────────────────────────

def test_all_quiz_questions_valid_correct_index():
    conn = db_conn()
    rows = conn.execute(
        "SELECT id, correct_index, json_array_length(options) as opt_count FROM quiz_questions"
    ).fetchall()
    conn.close()
    bad = [r['id'] for r in rows if not (0 <= r['correct_index'] < r['opt_count'])]
    assert bad == [], f"Quiz questions with invalid correct_index: {bad}"


def test_all_modules_have_lessons():
    data = client.get('/modules').json()
    empty = [m['slug'] for m in data if len(m['lessons']) == 0]
    assert empty == [], f"Modules with no lessons: {empty}"


def test_all_projects_have_four_steps():
    for p in client.get('/projects').json():
        assert p['steps_total'] == 4, f"{p['slug']} has {p['steps_total']} steps, expected 4"


# ── Error handling on covered endpoints ───────────────────────────────────────

def test_progress_update_unknown_lesson_404():
    r = client.post('/progress/999999', json={'status': 'complete'})
    assert r.status_code == 404


def test_lessons_unknown_slug_404():
    r = client.get('/lessons/does-not-exist')
    assert r.status_code == 404


def test_sandbox_run_propagates_exit_code():
    r = client.post('/sandbox/run', json={'code': 'exit 42', 'language': 'bash'})
    assert r.status_code == 200
    assert r.json()['exit_code'] == 42


# ── Search edge cases ──────────────────────────────────────────────────────────

def test_search_no_match_returns_empty():
    r = client.get('/search', params={'q': 'xyzzy_no_match_ever'})
    assert r.status_code == 200
    assert r.json() == []


def test_search_special_chars_no_crash():
    for q in ['[linux]', '.*', 'a+b', 'a|b']:
        r = client.get('/search', params={'q': q})
        assert r.status_code == 200, f"crashed on q={q!r}"


# ── 5 quick wins ───────────────────────────────────────────────────────────────

def test_progress_update_invalid_status_422():
    r = client.post('/progress/1', json={'status': 'done'})
    assert r.status_code == 422


def test_sandbox_check_nonzero_exit_returns_failed():
    # Code exits non-zero → passed=False with reason='non_zero_exit', xp_earned=0
    r = client.post('/sandbox/check', json={
        'code': 'exit 1', 'language': 'bash',
        'expected_output': '', 'slug': 'test-lesson', 'index': 96,
    })
    assert r.status_code == 200
    data = r.json()
    assert data['passed'] is False
    assert data['reason'] == 'non_zero_exit'
    assert data['xp_earned'] == 0


def test_notes_upsert_second_save_wins():
    slug = _first_lesson_slug()
    if slug is None:
        pytest.skip("No lessons in DB")

    original = client.get(f'/notes/{slug}').json()['content']
    client.post(f'/notes/{slug}', json={'content': 'first save'})
    client.post(f'/notes/{slug}', json={'content': 'second save'})
    assert client.get(f'/notes/{slug}').json()['content'] == 'second save'
    client.post(f'/notes/{slug}', json={'content': original})


def test_interview_questions_count_per_module():
    slug = _first_module_slug()
    if slug is None:
        pytest.skip("No modules with interview questions in DB")
    assert len(client.get(f'/interview/questions/{slug}').json()) == 8


def test_search_results_capped_at_eight():
    # 'the' matches almost every lesson — verify the cap of 8 is enforced
    r = client.get('/search', params={'q': 'the'})
    assert r.status_code == 200
    assert len(r.json()) <= 8


# ── Layer 11: Targeted gap coverage ───────────────────────────────────────────

def test_sandbox_run_python():
    r = client.post('/sandbox/run', json={'code': 'print("hello")', 'language': 'python'})
    assert r.status_code == 200
    data = r.json()
    assert data['stdout'].strip() == 'hello'
    assert data['exit_code'] == 0


def test_progress_complete_updates_status():
    conn = db_conn()
    row = conn.execute("""
        SELECT l.id FROM lessons l
        WHERE NOT EXISTS (
            SELECT 1 FROM progress p WHERE p.lesson_id = l.id AND p.status = 'complete'
        )
        LIMIT 1
    """).fetchone()
    max_xp_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM xp_log").fetchone()[0]
    conn.close()

    if row is None:
        pytest.skip("All lessons already complete")

    lesson_id = row['id']
    client.post(f'/progress/{lesson_id}', json={'status': 'complete'})

    progress = client.get('/progress').json()
    assert progress.get(str(lesson_id)) == 'complete'

    conn = db_conn()
    conn.execute("UPDATE progress SET status='not_started', completed_at=NULL WHERE lesson_id=?", (lesson_id,))
    conn.execute("DELETE FROM xp_log WHERE id > ?", (max_xp_id,))
    conn.commit()
    conn.close()


def test_modules_structure():
    data = client.get('/modules').json()
    for m in data:
        assert {'id', 'slug', 'title', 'group', 'lessons'} <= set(m.keys())
        assert isinstance(m['lessons'], list)
        for lesson in m['lessons']:
            assert {'id', 'slug', 'title', 'duration_min', 'difficulty'} <= set(lesson.keys())


def test_quiz_module_caps_at_twenty():
    for m in client.get('/modules').json():
        r = client.get(f'/quiz/module/{m["slug"]}')
        assert r.status_code == 200
        assert len(r.json()) <= 20, f"{m['slug']} returned more than 20 questions"


# ── Layer 12: Full-curriculum data integrity ───────────────────────────────────

def test_all_lessons_have_five_quiz_questions():
    conn = db_conn()
    rows = conn.execute("""
        SELECT l.slug, COUNT(q.id) AS qcount
        FROM lessons l
        LEFT JOIN quiz_questions q ON q.lesson_id = l.id
        GROUP BY l.id
    """).fetchall()
    conn.close()
    bad = [(r['slug'], r['qcount']) for r in rows if r['qcount'] != 5]
    assert bad == [], f"Lessons without exactly 5 quiz questions: {bad}"


def test_all_modules_have_eight_interview_questions():
    conn = db_conn()
    rows = conn.execute("""
        SELECT m.slug, COUNT(iq.id) AS qcount
        FROM modules m
        LEFT JOIN interview_questions iq ON iq.module_id = m.id
        GROUP BY m.id
    """).fetchall()
    conn.close()
    bad = [(r['slug'], r['qcount']) for r in rows if r['qcount'] != 8]
    assert bad == [], f"Modules without exactly 8 interview questions: {bad}"


def test_sandbox_run_python_syntax_error():
    r = client.post('/sandbox/run', json={'code': 'def (', 'language': 'python'})
    assert r.status_code == 200
    data = r.json()
    assert data['exit_code'] != 0
    assert data['stderr']

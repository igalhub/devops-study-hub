import sqlite3
import os
import pytest
from fastapi.testclient import TestClient
from main import app

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

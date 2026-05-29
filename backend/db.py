import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / 'hub.db'

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    conn = get_conn()
    try:
      conn.executescript("""
        CREATE TABLE IF NOT EXISTS modules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            group_name TEXT NOT NULL,
            order_index INTEGER NOT NULL DEFAULT 0,
            is_locked INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL REFERENCES modules(id),
            title TEXT NOT NULL,
            slug TEXT NOT NULL,
            duration_min INTEGER DEFAULT 15,
            difficulty TEXT DEFAULT 'beginner',
            order_index INTEGER NOT NULL DEFAULT 0,
            md_path TEXT NOT NULL,
            UNIQUE(module_id, slug)
        );

        CREATE TABLE IF NOT EXISTS progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id INTEGER UNIQUE NOT NULL REFERENCES lessons(id),
            status TEXT NOT NULL DEFAULT 'not_started',
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS quiz_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id INTEGER NOT NULL REFERENCES lessons(id),
            question TEXT NOT NULL,
            options TEXT NOT NULL,
            correct_index INTEGER NOT NULL,
            explanation TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS interview_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL REFERENCES modules(id),
            question TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS quiz_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id INTEGER NOT NULL REFERENCES lessons(id),
            question_id TEXT NOT NULL,
            answer TEXT,
            is_correct INTEGER,
            attempted_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS xp_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            points INTEGER NOT NULL,
            earned_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS streaks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT UNIQUE NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS srs_schedule (
            question_id INTEGER PRIMARY KEY REFERENCES quiz_questions(id),
            interval_days INTEGER NOT NULL DEFAULT 1,
            ease REAL NOT NULL DEFAULT 2.5,
            next_review TEXT NOT NULL,
            reviews INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS interview_attempts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id  INTEGER NOT NULL REFERENCES interview_questions(id),
            module_id    INTEGER NOT NULL REFERENCES modules(id),
            score        TEXT    NOT NULL CHECK(score IN ('Weak', 'Adequate', 'Strong')),
            is_correct   INTEGER NOT NULL,
            attempted_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS interview_srs_schedule (
            question_id   INTEGER PRIMARY KEY REFERENCES interview_questions(id),
            interval_days INTEGER NOT NULL DEFAULT 1,
            ease          REAL    NOT NULL DEFAULT 2.5,
            next_review   TEXT    NOT NULL,
            reviews       INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS lesson_notes (
            lesson_id INTEGER PRIMARY KEY REFERENCES lessons(id),
            content TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            modules TEXT NOT NULL,
            difficulty TEXT NOT NULL DEFAULT 'intermediate'
        );

        CREATE TABLE IF NOT EXISTS project_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            order_index INTEGER NOT NULL,
            title TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('sandbox', 'ai')),
            prompt TEXT NOT NULL,
            language TEXT,
            expected_output TEXT
        );

        CREATE TABLE IF NOT EXISTS project_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            step_id INTEGER NOT NULL REFERENCES project_steps(id),
            status TEXT NOT NULL DEFAULT 'not_started',
            score TEXT,
            answer TEXT,
            completed_at TEXT,
            UNIQUE(project_id, step_id)
        );
    """)
      conn.commit()
    finally:
      conn.close()

    # Schema migrations — add columns that may not exist on older DBs
    for migration in [
        "ALTER TABLE project_steps ADD COLUMN hints TEXT DEFAULT '[]'",
        "ALTER TABLE interview_questions ADD COLUMN hints TEXT DEFAULT '[]'",
        "ALTER TABLE interview_questions ADD COLUMN model_answer TEXT DEFAULT ''",
    ]:
        conn = get_conn()
        try:
            conn.execute(migration)
            conn.commit()
        except Exception:
            pass  # column already exists
        finally:
            conn.close()

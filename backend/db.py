import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / 'hub.db'

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
            md_path TEXT NOT NULL
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
    """)
      conn.commit()
    finally:
      conn.close()

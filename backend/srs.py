from datetime import date, timedelta

_VALID_TABLES = frozenset({'srs_schedule', 'interview_srs_schedule'})


def update_srs(conn, table: str, question_id: int, is_correct: bool) -> None:
    if table not in _VALID_TABLES:
        raise ValueError(f"Unknown SRS table: {table!r}")
    row = conn.execute(
        f"SELECT interval_days, ease, reviews FROM {table} WHERE question_id = ?",
        (question_id,)
    ).fetchone()
    if row is None:
        interval, ease, reviews = 1, 2.5, 1
    else:
        interval = row['interval_days']
        ease = row['ease']
        reviews = row['reviews'] + 1
    if is_correct:
        new_interval = max(1, round(interval * ease))
        new_ease = min(3.5, ease + 0.1)
    else:
        new_interval = 1
        new_ease = max(1.3, ease - 0.2)
    next_review = (date.today() + timedelta(days=new_interval)).isoformat()
    conn.execute(
        f"""INSERT INTO {table} (question_id, interval_days, ease, next_review, reviews)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(question_id) DO UPDATE SET
                interval_days = excluded.interval_days,
                ease          = excluded.ease,
                next_review   = excluded.next_review,
                reviews       = excluded.reviews""",
        (question_id, new_interval, new_ease, next_review, reviews)
    )

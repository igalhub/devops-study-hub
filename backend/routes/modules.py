from fastapi import APIRouter
from db import get_conn

router = APIRouter()

@router.get('/modules')
def get_modules():
    conn = get_conn()
    modules = conn.execute(
        "SELECT id, slug, title, group_name, order_index, is_locked FROM modules ORDER BY order_index"
    ).fetchall()

    result = []
    for mod in modules:
        lessons = conn.execute(
            "SELECT id, slug, title, duration_min, difficulty, order_index FROM lessons WHERE module_id = ? ORDER BY order_index",
            (mod['id'],)
        ).fetchall()
        result.append({
            'id': mod['id'],
            'slug': mod['slug'],
            'title': mod['title'],
            'group': mod['group_name'],
            'order_index': mod['order_index'],
            'is_locked': bool(mod['is_locked']),
            'lessons': [dict(l) for l in lessons],
        })

    conn.close()
    return result

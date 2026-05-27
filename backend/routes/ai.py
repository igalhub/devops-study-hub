import json
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from anthropic import AsyncAnthropic
from db import get_conn

router = APIRouter()
client = AsyncAnthropic()

PROJECT_ROOT = Path(__file__).parent.parent.parent


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    lesson_slug: str
    messages: list[Message]


def _lesson_context(slug: str) -> tuple[str, str | None]:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT l.title, l.md_path FROM lessons l WHERE l.slug = ?", (slug,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return slug, None
    md_file = PROJECT_ROOT / row['md_path']
    if not md_file.exists():
        return row['title'], None
    text = md_file.read_text()
    if text.startswith('---'):
        try:
            end = text.index('---', 3)
            return row['title'], text[end + 3:].strip()
        except ValueError:
            pass
    return row['title'], text


@router.post('/ai/chat')
async def chat(request: ChatRequest):
    for m in request.messages:
        if m.role not in ('user', 'assistant'):
            raise HTTPException(status_code=400, detail=f"Invalid role: {m.role!r}. Must be 'user' or 'assistant'.")

    title, content = _lesson_context(request.lesson_slug)

    system = f"You are an AI tutor for a DevOps course. The student is studying:\n\nLesson: {title}\n\n"
    if content:
        system += f"Lesson content:\n{content}\n\n"
    system += (
        "Answer questions concisely and clearly. Use concrete examples. "
        "Stay focused on DevOps topics. Keep responses short unless the student needs depth."
    )

    model = os.getenv('CLAUDE_MODEL', 'claude-sonnet-4-6')

    async def stream_response():
        try:
            async with client.messages.stream(
                model=model,
                max_tokens=1024,
                system=system,
                messages=[{'role': m.role, 'content': m.content} for m in request.messages],
            ) as stream:
                async for text in stream.text_stream:
                    yield f"data: {json.dumps({'text': text})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'text': f'Error: {e}'})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        stream_response(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

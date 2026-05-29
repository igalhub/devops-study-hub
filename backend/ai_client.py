"""
ai_client.py — Thin wrapper over the Anthropic SDK.

All Claude API calls in this project go through here. To swap providers,
change only this file.

Public API:
    generate(prompt, *, max_tokens, timeout) -> str
    stream_text(system, messages, *, max_tokens) -> AsyncGenerator[str, None]
    AITimeoutError — raised by generate() on timeout
"""
import os
from anthropic import Anthropic, AsyncAnthropic
from anthropic import APITimeoutError as _SDKTimeoutError

_sync_client: Anthropic | None = None
_async_client: AsyncAnthropic | None = None


class AITimeoutError(Exception):
    pass


def _sync() -> Anthropic:
    global _sync_client
    if _sync_client is None:
        _sync_client = Anthropic()
    return _sync_client


def _async() -> AsyncAnthropic:
    global _async_client
    if _async_client is None:
        _async_client = AsyncAnthropic()
    return _async_client


def _model() -> str:
    return os.getenv('CLAUDE_MODEL', 'claude-sonnet-4-6')


def generate(prompt: str, *, max_tokens: int = 1024, timeout: float = 60.0) -> str:
    """Single-turn prompt → response text. Raises AITimeoutError on timeout."""
    try:
        response = _sync().messages.create(
            model=_model(),
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
            timeout=timeout,
        )
    except _SDKTimeoutError as exc:
        raise AITimeoutError("Claude request timed out") from exc
    return response.content[0].text.strip()


async def stream_text(system: str, messages: list[dict], *, max_tokens: int = 1024):
    """Yield text chunks from a streaming multi-turn response."""
    async with _async().messages.stream(
        model=_model(),
        max_tokens=max_tokens,
        system=system,
        messages=messages,
    ) as stream:
        async for chunk in stream.text_stream:
            yield chunk

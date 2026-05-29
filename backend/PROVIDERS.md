# Swapping AI Providers

All Claude API calls go through `backend/ai_client.py`. To switch providers,
rewrite only that file. Nothing else in the codebase needs to change.

## Interface contract

Any implementation must expose:

```python
def generate(prompt: str, *, max_tokens: int = 1024, timeout: float = 60.0) -> str
async def stream_text(system: str, messages: list[dict], *, max_tokens: int = 1024)
class AITimeoutError(Exception)
```

- `generate` — synchronous single-turn call; returns the response text (stripped).
  Raises `AITimeoutError` on timeout; all other errors propagate as-is.
- `stream_text` — async generator; yields text chunks (strings, not SSE frames).
- `AITimeoutError` — provider-agnostic timeout signal used by route handlers to
  return HTTP 504.

---

## OpenAI / OpenAI-compatible

```bash
pip install openai
```

```python
# ai_client.py
import os
from openai import OpenAI, AsyncOpenAI
from openai import APITimeoutError as _SDKTimeoutError

_sync_client = None
_async_client = None

class AITimeoutError(Exception):
    pass

def _sync():
    global _sync_client
    if _sync_client is None:
        _sync_client = OpenAI()          # reads OPENAI_API_KEY from env
    return _sync_client

def _async():
    global _async_client
    if _async_client is None:
        _async_client = AsyncOpenAI()
    return _async_client

def _model():
    return os.getenv('AI_MODEL', 'gpt-4o')

def generate(prompt: str, *, max_tokens: int = 1024, timeout: float = 60.0) -> str:
    try:
        response = _sync().chat.completions.create(
            model=_model(),
            max_tokens=max_tokens,
            timeout=timeout,
            messages=[{"role": "user", "content": prompt}],
        )
    except _SDKTimeoutError as exc:
        raise AITimeoutError("AI request timed out") from exc
    return response.choices[0].message.content.strip()

async def stream_text(system: str, messages: list[dict], *, max_tokens: int = 1024):
    stream = await _async().chat.completions.create(
        model=_model(),
        max_tokens=max_tokens,
        stream=True,
        messages=[{"role": "system", "content": system}, *messages],
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta
```

Works as-is for any OpenAI-compatible endpoint (Azure OpenAI, Together AI,
Groq, etc.) by setting `base_url` on the client constructor.

---

## Ollama (local, offline)

Ollama exposes an OpenAI-compatible API, so the OpenAI snippet above works
with one change to the client constructor:

```python
_sync_client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
_async_client = AsyncOpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
```

Set `AI_MODEL` to a model you have pulled locally, e.g. `llama3.2` or
`mistral`. Run `ollama pull <model>` first.

---

## AWS Bedrock

```bash
pip install boto3 anthropic[bedrock]
```

```python
# ai_client.py
import os
import boto3
from anthropic import AnthropicBedrock, AsyncAnthropicBedrock
from anthropic import APITimeoutError as _SDKTimeoutError

class AITimeoutError(Exception):
    pass

_sync_client = None
_async_client = None

def _sync():
    global _sync_client
    if _sync_client is None:
        _sync_client = AnthropicBedrock(
            aws_region=os.getenv('AWS_REGION', 'us-east-1'),
        )
    return _sync_client

def _async():
    global _async_client
    if _async_client is None:
        _async_client = AsyncAnthropicBedrock(
            aws_region=os.getenv('AWS_REGION', 'us-east-1'),
        )
    return _async_client

def _model():
    # Bedrock model IDs differ from Anthropic's — use the cross-region inference profile ID.
    return os.getenv('AI_MODEL', 'us.anthropic.claude-sonnet-4-6-v1:0')

def generate(prompt: str, *, max_tokens: int = 1024, timeout: float = 60.0) -> str:
    try:
        response = _sync().messages.create(
            model=_model(),
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
            timeout=timeout,
        )
    except _SDKTimeoutError as exc:
        raise AITimeoutError("AI request timed out") from exc
    return response.content[0].text.strip()

async def stream_text(system: str, messages: list[dict], *, max_tokens: int = 1024):
    async with _async().messages.stream(
        model=_model(),
        max_tokens=max_tokens,
        system=system,
        messages=messages,
    ) as stream:
        async for chunk in stream.text_stream:
            yield chunk
```

Credentials are read from the standard AWS chain (`~/.aws/credentials`,
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars, or instance role).
Enable the model in the Bedrock console first.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model ID for the current provider |
| `ANTHROPIC_API_KEY` | — | Required for the default Anthropic provider |
| `OPENAI_API_KEY` | — | Required for OpenAI provider |
| `AWS_REGION` | `us-east-1` | Required for Bedrock provider |

`CLAUDE_MODEL` is read on every call via `_model()`, so it can be changed at
runtime without restarting the server.

import os
import resource
import subprocess
import sys
import tempfile
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from db import get_conn
from ai_client import generate, AITimeoutError
from srs import update_exercise_srs

PROJECT_ROOT = Path(__file__).parent.parent.parent

router = APIRouter()

TIMEOUT = 10
MAX_OUTPUT = 50_000  # 50 KB per stream
XP_EXERCISE_CHECK = 5


_SAFE_ENV = {
    'PATH': '/usr/local/bin:/usr/bin:/bin',
    'HOME': '/tmp',
    'TERM': 'dumb',
    'PYTHONDONTWRITEBYTECODE': '1',
    'GIT_AUTHOR_NAME': 'sandbox',
    'GIT_AUTHOR_EMAIL': 'sandbox@devops-study-hub',
    'GIT_COMMITTER_NAME': 'sandbox',
    'GIT_COMMITTER_EMAIL': 'sandbox@devops-study-hub',
}


def _apply_resource_limits():
    """Called as preexec_fn in child process — limits memory and file writes."""
    MB = 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS,    (512 * MB, 512 * MB))   # 512 MB virtual (CPython needs ~150 MB baseline)
    resource.setrlimit(resource.RLIMIT_FSIZE, (10  * MB, 10  * MB))   # 10 MB max written file
    # RLIMIT_NPROC is per-UID and would starve other server subprocesses — intentionally omitted


def _run_subprocess(code: str, language: str) -> dict:
    """Run code in a sandboxed subprocess. Returns {stdout, stderr, exit_code}."""
    try:
        if language == 'bash':
            result = subprocess.run(
                ['bash', '--norc', '--noprofile', '-c', code],
                capture_output=True, text=True, timeout=TIMEOUT,
                preexec_fn=_apply_resource_limits,
                env=_SAFE_ENV,
            )
        elif language == 'yaml':
            validate = (
                'import yaml, sys\n'
                'try:\n'
                '    data = yaml.safe_load(sys.stdin.read())\n'
                'except yaml.YAMLError as e:\n'
                '    sys.exit(str(e))\n'
                'if data is None:\n'
                '    print("\\u26a0 Nothing to validate — your YAML is empty.")\n'
                '    print("Add your manifest below the --- line. A Kubernetes manifest")\n'
                '    print("should start with apiVersion:, kind:, metadata:, and spec:.")\n'
                '    sys.exit(1)\n'
                'n = len(data) if isinstance(data, (dict, list)) else 1\n'
                'print(f"\\u2713 Valid YAML \\u2014 {type(data).__name__} ({n} item(s))")\n'
            )
            result = subprocess.run(
                [sys.executable, '-c', validate],
                input=code,
                capture_output=True, text=True, timeout=TIMEOUT,
                preexec_fn=_apply_resource_limits,
                env=_SAFE_ENV,
            )
        else:  # python
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                f.write(code)
                tmpfile = f.name
            try:
                result = subprocess.run(
                    [sys.executable, tmpfile],
                    capture_output=True, text=True, timeout=TIMEOUT,
                    preexec_fn=_apply_resource_limits,
                    env=_SAFE_ENV,
                )
            finally:
                os.unlink(tmpfile)

        stdout = result.stdout[:MAX_OUTPUT]
        stderr = result.stderr[:MAX_OUTPUT]
        if len(result.stdout) > MAX_OUTPUT or len(result.stderr) > MAX_OUTPUT:
            stderr += '\n[output truncated at 50 KB]'
        return {'stdout': stdout, 'stderr': stderr, 'exit_code': result.returncode}
    except subprocess.TimeoutExpired:
        return {'stdout': '', 'stderr': f'Timed out after {TIMEOUT}s.', 'exit_code': 124}
    except Exception as e:
        return {'stdout': '', 'stderr': str(e), 'exit_code': 1}


def _xp_total() -> int:
    conn = get_conn()
    try:
        return conn.execute('SELECT COALESCE(SUM(points), 0) FROM xp_log').fetchone()[0]
    finally:
        conn.close()


class RunRequest(BaseModel):
    code: str
    language: str  # 'bash', 'python', or 'yaml'


class CheckRequest(BaseModel):
    code: str
    language: str
    expected_output: str
    slug: str
    index: int


@router.post('/sandbox/run')
def run_code(request: RunRequest):
    if request.language not in ('bash', 'python', 'yaml'):
        return {'stdout': '', 'stderr': f'Unsupported language: {request.language}', 'exit_code': 1}
    if len(request.code) > 10_000:
        return {'stdout': '', 'stderr': 'Code too long (10KB max).', 'exit_code': 1}
    return _run_subprocess(request.code, request.language)


@router.post('/sandbox/check')
def check_code(request: CheckRequest):
    if request.language not in ('bash', 'python', 'yaml'):
        return {'passed': False, 'reason': 'unsupported_language', 'actual': '', 'expected': request.expected_output, 'stderr': f'Unsupported language: {request.language}', 'xp_earned': 0, 'xp_total': _xp_total()}
    if len(request.code) > 10_000:
        return {'passed': False, 'reason': 'code_too_long', 'actual': '', 'expected': request.expected_output, 'stderr': '', 'xp_earned': 0, 'xp_total': _xp_total()}

    result = _run_subprocess(request.code, request.language)
    actual = result['stdout'].strip()
    expected = request.expected_output.strip()

    if result['exit_code'] != 0:
        return {
            'passed': False,
            'reason': 'non_zero_exit',
            'actual': actual,
            'expected': expected,
            'stderr': result['stderr'],
            'xp_earned': 0,
            'xp_total': _xp_total(),
        }

    passed = actual == expected
    xp_earned = 0
    exercise_key = f'{request.slug}:{request.index}'

    conn = get_conn()
    try:
        conn.execute('BEGIN EXCLUSIVE')
        if passed:
            source = f'exercise_check:{request.slug}:{request.index}'
            already = conn.execute(
                'SELECT 1 FROM xp_log WHERE source = ? LIMIT 1', (source,)
            ).fetchone()
            if not already:
                conn.execute('INSERT INTO xp_log (source, points) VALUES (?, ?)', (source, XP_EXERCISE_CHECK))
                xp_earned = XP_EXERCISE_CHECK
        update_exercise_srs(conn, exercise_key, passed)
        conn.commit()
    finally:
        conn.close()

    return {
        'passed': passed,
        'actual': actual,
        'expected': expected,
        'stderr': result['stderr'],
        'xp_earned': xp_earned,
        'xp_total': _xp_total(),
    }


class AnswerRequest(BaseModel):
    lesson_slug: str
    exercise_text: str


@router.post('/sandbox/answer')
def get_exercise_answer(request: AnswerRequest):
    conn = get_conn()
    try:
        row = conn.execute(
            'SELECT l.title, l.md_path FROM lessons l WHERE l.slug = ?',
            (request.lesson_slug,)
        ).fetchone()
    finally:
        conn.close()

    title = row['title'] if row else request.lesson_slug
    lesson_context = ''
    if row:
        md_file = PROJECT_ROOT / row['md_path']
        if md_file.exists():
            text = md_file.read_text()
            if text.startswith('---'):
                try:
                    end = text.index('---', 3)
                    text = text[end + 3:].strip()
                except ValueError:
                    pass
            lesson_context = f'\n\nLesson content (excerpt):\n{text[:2000]}'

    prompt = (
        f'You are a DevOps instructor. A student is stuck on this exercise.\n\n'
        f'Lesson: {title}{lesson_context}\n\n'
        f'Exercise: {request.exercise_text}\n\n'
        f'Provide a correct, complete solution. Show the exact YAML manifest, '
        f'bash commands, or configuration to write. Lead with the solution, '
        f'then add a 1-2 sentence explanation of the key idea.'
    )

    try:
        answer = generate(prompt, max_tokens=600)
    except AITimeoutError:
        raise HTTPException(status_code=504, detail='Request timed out — please try again')

    return {'answer': answer}


@router.get('/sandbox/exercises/due')
def exercises_due():
    today = __import__('datetime').date.today().isoformat()
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT exercise_key FROM exercise_srs_schedule WHERE next_review <= ?",
            (today,)
        ).fetchall()
    finally:
        conn.close()
    due_keys = [row['exercise_key'] for row in rows]
    return {'due_count': len(due_keys), 'due_keys': due_keys}


@router.get('/sandbox/completed/{lesson_slug}')
def completed_exercises(lesson_slug: str):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT source FROM xp_log WHERE source LIKE ?",
            (f'exercise_check:{lesson_slug}:%',)
        ).fetchall()
    finally:
        conn.close()
    indices = []
    for row in rows:
        parts = row['source'].split(':')
        if len(parts) == 3:
            try:
                indices.append(int(parts[2]))
            except ValueError:
                pass
    return {'completed': indices}

import os
import resource
import subprocess
import sys
import tempfile
from fastapi import APIRouter
from pydantic import BaseModel
from db import get_conn

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

    if passed:
        source = f'exercise_check:{request.slug}:{request.index}'
        conn = get_conn()
        try:
            conn.execute('BEGIN EXCLUSIVE')
            already = conn.execute(
                'SELECT 1 FROM xp_log WHERE source = ? LIMIT 1', (source,)
            ).fetchone()
            if not already:
                conn.execute('INSERT INTO xp_log (source, points) VALUES (?, ?)', (source, XP_EXERCISE_CHECK))
                xp_earned = XP_EXERCISE_CHECK
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

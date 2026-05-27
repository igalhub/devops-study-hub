import os
import resource
import subprocess
import sys
import tempfile
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

TIMEOUT = 10
MAX_OUTPUT = 50_000  # 50 KB per stream


_SAFE_ENV = {
    'PATH': '/usr/local/bin:/usr/bin:/bin',
    'HOME': '/tmp',
    'TERM': 'dumb',
    'PYTHONDONTWRITEBYTECODE': '1',
}


def _apply_resource_limits():
    """Called as preexec_fn in child process — limits memory and file writes."""
    MB = 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS,    (512 * MB, 512 * MB))   # 512 MB virtual (CPython needs ~150 MB baseline)
    resource.setrlimit(resource.RLIMIT_FSIZE, (10  * MB, 10  * MB))   # 10 MB max written file
    # RLIMIT_NPROC is per-UID and would starve other server subprocesses — intentionally omitted


class RunRequest(BaseModel):
    code: str
    language: str  # 'bash', 'python', or 'yaml'


@router.post('/sandbox/run')
def run_code(request: RunRequest):
    if request.language not in ('bash', 'python', 'yaml'):
        return {'stdout': '', 'stderr': f'Unsupported language: {request.language}', 'exit_code': 1}

    if len(request.code) > 10_000:
        return {'stdout': '', 'stderr': 'Code too long (10KB max).', 'exit_code': 1}

    try:
        if request.language == 'bash':
            result = subprocess.run(
                ['bash', '--norc', '--noprofile', '-c', request.code],
                capture_output=True, text=True, timeout=TIMEOUT,
                preexec_fn=_apply_resource_limits,
                env=_SAFE_ENV,
            )
        elif request.language == 'yaml':
            validate = (
                'import yaml, sys\n'
                'try:\n'
                '    data = yaml.safe_load(sys.stdin.read())\n'
                '    n = len(data) if isinstance(data, (dict, list)) else 1\n'
                '    print(f"\\u2713 Valid YAML \\u2014 {type(data).__name__} ({n} item(s))")\n'
                'except yaml.YAMLError as e:\n'
                '    sys.exit(str(e))\n'
            )
            result = subprocess.run(
                [sys.executable, '-c', validate],
                input=request.code,
                capture_output=True, text=True, timeout=TIMEOUT,
                preexec_fn=_apply_resource_limits,
                env=_SAFE_ENV,
            )
        else:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                f.write(request.code)
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
        return {
            'stdout': stdout,
            'stderr': stderr,
            'exit_code': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'stdout': '', 'stderr': f'Timed out after {TIMEOUT}s.', 'exit_code': 124}
    except Exception as e:
        return {'stdout': '', 'stderr': str(e), 'exit_code': 1}

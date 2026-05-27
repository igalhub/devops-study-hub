import os
import subprocess
import sys
import tempfile
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

TIMEOUT = 10


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
                ['bash', '-c', request.code],
                capture_output=True, text=True, timeout=TIMEOUT,
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
            )
        else:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                f.write(request.code)
                tmpfile = f.name
            try:
                result = subprocess.run(
                    [sys.executable, tmpfile],
                    capture_output=True, text=True, timeout=TIMEOUT,
                )
            finally:
                os.unlink(tmpfile)

        return {
            'stdout': result.stdout,
            'stderr': result.stderr,
            'exit_code': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'stdout': '', 'stderr': f'Timed out after {TIMEOUT}s.', 'exit_code': 124}
    except Exception as e:
        return {'stdout': '', 'stderr': str(e), 'exit_code': 1}

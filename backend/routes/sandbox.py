import os
import subprocess
import tempfile
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

TIMEOUT = 10


class RunRequest(BaseModel):
    code: str
    language: str  # 'bash' or 'python'


@router.post('/sandbox/run')
def run_code(request: RunRequest):
    if request.language not in ('bash', 'python'):
        return {'stdout': '', 'stderr': f'Unsupported language: {request.language}', 'exit_code': 1}

    if len(request.code) > 10_000:
        return {'stdout': '', 'stderr': 'Code too long (10KB max).', 'exit_code': 1}

    try:
        if request.language == 'bash':
            result = subprocess.run(
                ['bash', '-c', request.code],
                capture_output=True, text=True, timeout=TIMEOUT,
            )
        else:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                f.write(request.code)
                tmpfile = f.name
            try:
                result = subprocess.run(
                    ['python3', tmpfile],
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

---
title: Subprocess & Automation
module: python
duration_min: 20
difficulty: intermediate
tags: [python, subprocess, automation, shell, os, shlex]
exercises: 4
---

## Overview

DevOps scripts constantly need to reach outside Python and talk to the operating system: restart a service, invoke `kubectl`, check disk usage, call `git`, compress a tarball. Python's `subprocess` module is the standard, correct way to do this. It captures stdout and stderr separately, surfaces exit codes, enforces timeouts, and avoids the shell injection vulnerabilities that come with older alternatives like `os.system()` or `commands.getoutput()`. Every production automation script you write will use it.

The design philosophy of `subprocess` is explicit control. You construct the command as a list of strings — no shell interpolation, no implicit `/bin/sh` wrapper unless you ask for one. This mirrors how the kernel actually executes programs (`execve`), which means there are no surprises with quoting, globbing, or variable expansion. When you do need shell features (pipes, redirects, globs), you opt in deliberately and handle the security implications yourself.

In the broader DevOps toolchain, `subprocess` is the glue layer between your Python logic and every other CLI tool in your environment. It sits below high-level libraries like `boto3` or `kubernetes-client` (which have their own HTTP transports) but above raw `os.fork()`/`os.execve()` calls. When a dedicated SDK doesn't exist — or when you're wrapping an existing CLI tool for consistency — `subprocess` is the right abstraction. Understanding it deeply means you can reliably automate deployments, health checks, infrastructure queries, and build pipelines from a single Python process.

---

## Concepts

### subprocess.run — The Right Default

`subprocess.run()` is the high-level entry point introduced in Python 3.5. It blocks until the command completes and returns a `CompletedProcess` object. Use it for the vast majority of automation tasks.

```python
import subprocess

result = subprocess.run(
    ["ls", "-la", "/etc"],    # always a list — avoids shell injection
    capture_output=True,      # shorthand for stdout=PIPE, stderr=PIPE
    text=True,                # decode bytes → str using locale encoding
    check=False,              # don't auto-raise on non-zero exit
)

print(result.stdout)          # captured standard output
print(result.stderr)          # captured standard error
print(result.returncode)      # integer: 0 = success, anything else = failure
```

| Parameter | Effect | When to use |
|-----------|--------|-------------|
| `capture_output=True` | Captures stdout and stderr separately into strings | Almost always — lets you inspect output |
| `text=True` | Decodes bytes to str using locale encoding | Whenever you're parsing text output |
| `check=True` | Raises `CalledProcessError` on non-zero exit | When failure should abort the script |
| `timeout=N` | Raises `TimeoutExpired` after N seconds | Network calls, long builds |
| `cwd="/path"` | Sets working directory for the subprocess | Running `git`, `make`, `npm` in a project dir |
| `env=dict` | Replaces (not merges) the environment | Passing secrets, controlling PATH |
| `input="string"` | Sends string to the subprocess's stdin | Piping data between commands without a shell |
| `stdin=DEVNULL` | Closes stdin so the process can't prompt | Non-interactive scripts, CI pipelines |

**`shell=True` warning:** Setting `shell=True` passes your command to `/bin/sh -c`. This enables injection if any part of the command comes from user input or an external source. It also silently misbehaves with list arguments — only the first element is used as the command; the rest become positional parameters `$0`, `$1`, etc. inside the shell, which is almost never what you want. Use a list argument and `shell=False` (the default) unless you have a specific, documented reason otherwise.

**`env` replaces, not extends:** If you pass `env={"MY_VAR": "value"}`, the subprocess inherits *only* that variable — `PATH`, `HOME`, `USER`, and everything else vanishes. Commands like `git` or `kubectl` will fail because they can't find their own dependencies. To extend the current environment safely:

```python
import os
import subprocess

env = os.environ.copy()       # start from the full current environment
env["MY_SECRET"] = "hunter2"  # add or override specific keys
env.pop("DEBUG", None)        # remove keys you explicitly don't want to pass

subprocess.run(["my-tool"], env=env, check=True)
```

---

### Checking Exit Codes

Unix programs signal success or failure through their exit code. Zero means success; non-zero means something went wrong. Ignoring exit codes is one of the most common bugs in automation scripts — your script happily continues after a failed `kubectl apply` and leaves the cluster in a broken state.

```python
import subprocess

# Option 1 — check=True: raises CalledProcessError on failure
# Best when failure should immediately halt the script
try:
    subprocess.run(
        ["systemctl", "restart", "nginx"],
        check=True,
        capture_output=True,
        text=True,
    )
    print("nginx restarted successfully")
except subprocess.CalledProcessError as e:
    # e.returncode, e.stdout, e.stderr all available
    print(f"Restart failed (exit {e.returncode}): {e.stderr.strip()}")
    raise SystemExit(1)

# Option 2 — manual check: gives you branching logic on the result
result = subprocess.run(
    ["ping", "-c", "1", "-W", "2", "8.8.8.8"],
    capture_output=True,
    text=True,
)
if result.returncode == 0:
    print("Host reachable")
else:
    print(f"Host unreachable (exit {result.returncode})")
```

**`CalledProcessError` attributes:** when `check=True` raises, `e.stdout` and `e.stderr` are populated only if you also passed `capture_output=True`. Without capture, they are `None`, which means you lose the error message entirely. Always pair `check=True` with `capture_output=True` in production scripts so you can log exactly what went wrong.

**Exit code conventions to know:**

| Tool | Exit 0 | Exit 1 | Exit 2+ |
|------|--------|--------|---------|
| Most Unix tools | Success | Generic error | Tool-specific |
| `grep` | Match found | No match found | Error (bad args) |
| `diff` | Files identical | Files differ | Error |
| `curl` | Success | Protocol error | — |
| `kubectl` | Success | API/auth error | — |
| `ansible-playbook` | All tasks OK | One or more failures | — |

**`grep` exit 1 is not an error:** a common bug is using `check=True` when running `grep` to test for a pattern. If the pattern isn't found, `CalledProcessError` fires — not because something is broken, but because there's no match. Use `check=False` and test `result.returncode` yourself.

---

### Capturing and Parsing Output

The real power of `subprocess` in DevOps automation is turning CLI output into structured Python data. The pattern is: run the command, capture stdout, parse it with Python string operations or `json.loads`.

```python
import subprocess
import json

def get_running_services():
    """Return a list of active systemd service names."""
    result = subprocess.run(
        [
            "systemctl", "list-units",
            "--type=service",
            "--state=running",
            "--no-pager",     # disable pager so output goes to stdout
            "--plain",        # no decorative borders
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    services = []
    for line in result.stdout.splitlines():
        if ".service" in line:
            services.append(line.split()[0])   # first column is the unit name
    return services


def disk_usage_pct(mount="/"):
    """Return disk usage percentage for a mount point as an integer."""
    result = subprocess.run(
        ["df", "--output=pcent", mount],  # --output selects columns (GNU df)
        capture_output=True,
        text=True,
        check=True,
    )
    # Output: "Use%\n 45%\n"
    pct_line = result.stdout.strip().splitlines()[-1]
    return int(pct_line.strip().rstrip("%"))


def get_pod_status(namespace="default"):
    """Return pod names and their statuses from kubectl as a list of dicts."""
    result = subprocess.run(
        ["kubectl", "get", "pods", "-n", namespace, "-o", "json"],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout)   # structured output beats string parsing
    return [
        {
            "name": item["metadata"]["name"],
            "phase": item["status"].get("phase", "Unknown"),
        }
        for item in data.get("items", [])
    ]


def git_current_branch(repo_path="."):
    """Return the current git branch name."""
    result = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
        cwd=repo_path,   # run git inside the target repo directory
    )
    return result.stdout.strip()
```

**Prefer machine-friendly output flags:** many tools produce human-readable tables by default. Look for flags that disable decoration and produce stable, parseable output:

| Tool | Human output | Machine-friendly flag |
|------|-------------|----------------------|
| `systemctl` | Bordered table | `--plain --no-pager` |
| `kubectl` | Column-aligned | `-o json` or `-o jsonpath=...` |
| `docker inspect` | JSON by default | `--format '{{json .}}'` |
| `df` | Full table | `--output=pcent` |
| `git log` | Pretty log | `--format="%H %s"` or `--porcelain` |
| `aws cli` | Text table | `--output json` |

**Parsing tip:** if a tool supports `--output json` or equivalent, use it and parse with `json.loads(result.stdout)`. JSON parsing is robust to whitespace changes, column reordering, and tool version differences. String splitting breaks silently when upstream output format changes.

---

### Timeouts

Without a timeout, a subprocess that hangs (network unreachable, deadlock, interactive prompt waiting for input) will hang your entire automation script indefinitely. In CI/CD pipelines, this means a stuck job that blocks your deployment queue until someone manually cancels it.

```python
import subprocess

def check_http_health(url, timeout_sec=10):
    """Return True if the URL responds with a 2xx status."""
    try:
        result = subprocess.run(
            [
                "curl",
                "-sf",                          # -s silent, -f fail on HTTP errors
                "--max-time", str(timeout_sec), # curl-level timeout in seconds
                url,
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec + 2,            # Python-level hard kill, slightly larger
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired as e:
        print(f"Timed out after {e.timeout}s: {url}")
        # e.stdout and e.stderr may contain partial output — useful for debugging
        if e.stdout:
            print(f"Partial output: {e.stdout}")
        return False
    except subprocess.CalledProcessError as e:
        print(f"curl failed (exit {e.returncode}): {e.stderr.strip()}")
        return False


def run_with_timeout(cmd, timeout_sec=30):
    """Run a command with timeout, return (success, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        return result.returncode == 0, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return False, "", f"Command timed out after {timeout_sec}s"
```

**Two-level timeout pattern:** set both a tool-level timeout (e.g., `curl --max-time`, `ssh -o ConnectTimeout=`) *and* Python's `timeout=`. The tool-level timeout is graceful — the tool exits with an error code, stderr contains a message, and you get structured failure. The Python-level timeout is a hard `SIGKILL` for cases where the tool itself hangs and ignores signals. Set Python's timeout a few seconds higher than the tool's to give it time to exit cleanly first.

**After `TimeoutExpired`:** the child process is killed by Python. Any output buffered before the kill is available in `e.stdout` and `e.stderr` — inspect these when debugging why a command hung.

---

### Streaming Output (No Capture)

When you want real-time output — long builds, test runs, deployment scripts — don't capture. Let stdout and stderr pass directly to the terminal. This is the default behavior: omit `capture_output` entirely.

```python
import subprocess

# stdout and stderr go to the terminal in real time
# No capture_output — stdout/stderr default to inheriting from parent process
result = subprocess.run(
    ["docker", "build", "-t", "myapp:latest", "."],
    check=True,
)

# Streaming with error handling: playbooks, migrations, test runners
try:
    subprocess.run(
        ["ansible-playbook", "site.yml", "-v"],
        check=True,
        # stdin=subprocess.DEVNULL prevents the playbook from waiting for input
        stdin=subprocess.DEVNULL,
    )
except subprocess.CalledProcessError as e:
    print(f"Playbook failed with exit code {e.returncode}")
    raise SystemExit(1)

# Redirect stderr to stdout — useful when a tool writes progress to stderr
subprocess.run(
    ["make", "build"],
    stderr=subprocess.STDOUT,  # merge stderr into stdout stream
    check=True,
)
```

**Streaming + capture is complex:** if you need both real-time display *and* captured output for later analysis, you need `subprocess.Popen` with threads reading pipes simultaneously (see the `Popen` section). For most DevOps scripts, choose one: either stream to terminal for human visibility, or capture for programmatic processing. Attempting both with `subprocess.run()` alone leads to deadlocks.

**`stdin=DEVNULL` in CI:** always set this when running interactive tools (Ansible, Terraform, some test runners) in CI pipelines. Without it, a tool that accidentally prompts for input will hang indefinitely instead of failing fast.

---

### Piping Between Commands

Python's `subprocess` models Unix pipes explicitly: the output of one command becomes the input of the next via the `input=` parameter. This is safer than `shell=True` with a shell pipe because each stage is a separate, auditable process with no shell involved.

```python
import subprocess

def find_process(name):
    """Equivalent to: ps aux | grep <name> | grep -v grep"""
    ps = subprocess.run(
        ["ps", "aux"],
        capture_output=True, text=True, check=True,
    )
    grep = subprocess.run(
        ["grep", name],
        input=ps.stdout,          # pipe ps stdout to grep stdin
        capture_output=True, text=True,
        # check=False — grep exits 1 when no match; that's not an error here
    )
    result = subprocess.run(
        ["grep", "-v", "grep"],   # remove the grep process itself from results
        input=grep.stdout,
        capture_output=True, text=True,
    )
    return result.stdout.strip()
```

**Filter in Python instead:** for short outputs, capture the whole thing and filter with Python string operations. It's more readable, avoids exit-code edge cases with `grep`, and runs faster by eliminating extra process launches:

```python
def find_process_py(name):
    result = subprocess.run(["ps", "aux"], capture_output=True, text=True, check=True)
    lines = [l for l in result.stdout.splitlines() if name in l and "grep" not in l]
    return "\n".join(lines)
```

**When to use shell pipes vs Python pipes:** use Python-level chaining when security matters (any user-controlled data in the command) or when you need fine-grained error handling per stage. Use `shell=True` with a shell pipe only for quick throwaway scripts where the entire command is a hardcoded string and you need shell features like `|`, `>`, `&&`, or glob expansion.

---

### shlex — Safe Command Construction from Strings

Sometimes a command comes in as a string — from a config file, environment variable, or user input. `shlex.split()` tokenizes it the way a POSIX shell would, handling quotes and escaping correctly, without invoking a shell.

```python
import shlex
import subprocess

# From a config file or environment variable:
cmd_str = 'kubectl get pods -n production -l "app=nginx"'
cmd_list = shlex.split(cmd_str)
# → ['kubectl', 'get', 'pods', '-n', 'production', '-l', 'app=nginx']

result = subprocess.run(cmd_list, capture_output=True, text=True, check=True)

# Going the other direction: quote a list into a safe shell string for logging
safe_str = shlex.join(cmd_list)   # Python 3.8+
print(f"Running: {safe_str}")
# → Running: kubectl get pods -n production -l 'app=nginx'

# Practical use: commands stored in YAML config
import yaml

config = yaml.safe_load("""
health_check: "curl -sf http://localhost:8080/health"
pre_deploy: "python manage.py migrate --no-input"
""")

for name, cmd_str in config.items():
    cmd = shlex.split(cmd_str)
    print(f"Running {name}: {cmd}")
    subprocess.run(cmd, check=True)
```

**`shlex.split` vs `str.split()`:** `str.split()` breaks on every whitespace, mangling quoted arguments.

```python
cmd = 'kubectl exec pod-123 -- sh -c "echo hello world"'

cmd.split()        # ['kubectl', 'exec', 'pod-123', '--', 'sh', '-c', '"echo', 'hello', 'world"']
                   # 9 tokens — "echo hello world" split in two, quotes included

shlex.split(cmd)   # ['kubectl', 'exec', 'pod-123', '--', 'sh', '-c', 'echo hello world']
                   # 7 tokens — quoted string preserved correctly, quotes stripped
```

**Security note:** `shlex.split()` makes the tokenization safe, but it does not make the *content* safe. If `cmd_str` comes from untrusted input, an attacker can still inject arbitrary commands. Use `shlex.split()` only when the source of the string is trusted (your own config files, your own environment variables).

---

### os.path and pathlib — File System Operations

Subprocess handles process execution; `os.path` and `pathlib` handle the file system. In practice you use both together: locate files with pathlib, then pass their paths to subprocess commands.

```python
import os
import subprocess
from pathlib import Path

# pathlib — prefer for new code (Python 3.4+)
p = Path("/etc/nginx/nginx.conf")
p.exists()           # True/False
p.is_file()          # True if it's a regular file
p.is_dir()           # True if it's a directory
p.name               # "nginx.conf"
p.stem               # "nginx"
p.suffix             # ".conf"
p.parent             # PosixPath('/etc/nginx')
p.read_text()        # file contents as str
p.write_text("...")  # overwrite file (creates if not exists)

# Path construction — / operator is cleaner than os.path.join
config = Path("/etc") / "nginx" / "nginx.conf"

# Glob patterns
confs = list(Path("/etc/nginx").glob("*.conf"))        # immediate dir only
all_confs = list(Path("/etc/nginx").rglob("*.conf"))   # recursive

# Find large log files and report them
for path in Path("/var/log").rglob("*"):
    if path.is_file() and path.stat().st_size > 100 * 1024 * 1024:
        size_mb = path.stat().st_size // (1024 * 1024)
        print(f"Large file: {path} ({size_mb} MB)")

# Use pathlib to build subprocess commands cleanly
log_dir = Path("/var/log/nginx")
latest_log = max(log_dir.glob("access.log*"), key=lambda p: p.stat().st_mtime)

subprocess.run(
    ["tail", "-n", "100", str(latest_log)],  # str() for Python < 3.6
    check=True,
)
```

| Task | `os.path` | `pathlib` |
|------|-----------|-----------|
| Join paths | `os.path.join(a, b, c)` | `Path(a) / b / c` |
| Check existence | `os.path.exists(p)` | `Path(p).exists()` |
| Is it a file? | `os.path.isfile(p)` | `Path(p).is_file()` |
| Read file | `open(p).read()` | `Path(p).read_text()` |
| Write file | `open(p, "w").write(s)` | `Path(p).write_text(s)` |
| List directory | `os.listdir(p)` | `Path(p).iterdir()` |
| Recursive glob | `os.walk()` + manual filter | `Path(p).rglob("*.log")` |
| File size | `os.stat(p).st_size` | `Path(p).stat().st_size` |
| Make directories | `os.makedirs(p, exist_ok=True)` | `Path(p).mkdir(parents=True, exist_ok=True)` |

**`pathlib` with subprocess:** `subprocess.run()` accepts `Path` objects anywhere a string path is expected in Python 3.6+. You don't need to call `str(p)` explicitly. For Python 3.5 and below, always convert with `str(p)`.

**`exist_ok=True` is your friend:** when creating directories in automation scripts, always pass `exist_ok=True` to `mkdir()`. Without it, your script crashes on the second run because the directory already exists.

---

### subprocess.Popen — Low-Level Control

`subprocess.run()` covers 90% of automation cases. `Popen` is the lower-level class that `run()` is built on. Use it when you need to interact with a running process: feed it input incrementally, read its output in real time while it's running, or do something else concurrently while it executes.

```python
import subprocess
import threading

# Pattern 1: Start a long-running process and poll it
proc = subprocess.Popen(
    ["tail", "-f", "/var/log/syslog"],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)

# Read a fixed number of lines then terminate
for i, line in enumerate(proc.stdout):
    print(line, end="")
    if i >= 9:          # read 10 lines then stop
        break

proc.terminate()        # SIGTERM
proc.wait()             # wait for it to actually exit


# Pattern 2: Simultaneous real-time display + capture
# Requires threads because reading two pipes sequentially can deadlock
def stream_and_capture(cmd):
    """Run cmd, print output in real time, return captured output."""
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,   # merge stderr into stdout
        text=True,
    )
    captured = []

    def reader():
        for line in proc.stdout:
            print(line, end="", flush=True)   # real-time display
            captured.append(line)             # also capture

    t = threading.Thread(target=reader)
    t.start()
    proc.wait()
    t.join()
    return "".join(captured), proc.returncode


output, rc = stream_and_capture(["docker", "build", "-t", "myapp", "."])
if rc != 0:
    # Now we have the full output to log or send to an alerting system
    send_alert(f"Build failed:\n{output[-2000:]}")   # last 2000 chars
```

**Popen context manager:** always use `Popen` as a context manager (`with subprocess.Popen(...) as proc:`) or call `proc.wait()` / `proc.communicate()` explicitly. Failing to wait for the process creates a zombie process that persists until your script exits.

**`communicate()` vs manual reading:** `proc.communicate()` reads all of stdout and stderr at once and waits for the process to finish — it's equivalent to `subprocess.run()` with `capture_output=True`. Use it when you don't need real-time output. If you read `proc.stdout` manually in a loop without also reading `proc.stderr`, the process can deadlock when its stderr buffer fills up and it blocks waiting for you to read it. The threading pattern above avoids this by merging stderr into stdout first.

---

## Examples

### Example 1: Deployment Health Check Script

A complete script that deploys a Docker container, waits for it to be healthy, and rolls back on failure.

```python
#!/usr/bin/env python3
"""
deploy.py — rolling deploy with health check and rollback
Usage: python deploy.py <image_tag>
"""
import subprocess
import sys
import time
from pathlib import Path


IMAGE = "myapp"
CONTAINER = "myapp-prod"
HEALTH_URL = "http://localhost:8080/health"
HEALTH_RETRIES = 10
HEALTH_INTERVAL = 3   # seconds between retries


def run(cmd, **kwargs):
    """Wrapper: always capture output, check by default, log the command."""
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    kwargs.setdefault("check", True)
    print(f"  → {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, **kwargs)


def get_current_image():
    """Return the image currently running in the container, or None."""
    result = run(
        ["docker", "inspect", "--format", "{{.Config.Image}}", CONTAINER],
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def start_container(image_tag):
    run([
        "docker", "run", "-d",
        "--name", CONTAINER,
        "--rm",                          # auto-remove when stopped
        "-p", "8080:8080",
        f"{IMAGE}:{image_tag}",
    ])


def stop_container():
    run(["docker", "stop", CONTAINER], check=False)


def wait_for_healthy():
    """Poll the health endpoint until it responds or retries are exhausted."""
    for attempt in range(1, HEALTH_RETRIES + 1):
        result = subprocess.run(
            ["curl", "-sf", "--max-time", "5", HEALTH_URL],
            capture_output=True,
            timeout=8,
        )
        if result.returncode == 0:
            return True
        print(f"  Health check attempt {attempt}/{HEALTH_RETRIES} failed, waiting...")
        time.sleep(HEALTH_INTERVAL)
    return False


def deploy(new_tag):
    print(f"\n[deploy] Starting deployment: {IMAGE}:{new_tag}")

    # Save current image for rollback
    previous_image = get_current_image()
    print(f"[deploy] Current image: {previous_image or 'none'}")

    # Pull the new image first — fail early before touching the running container
    print("[deploy] Pulling new image...")
    run(["docker", "pull", f"{IMAGE}:{new_tag}"])

    # Stop current container
    if previous_image:
        print("[deploy] Stopping current container...")
        stop_container()

    # Start new container
    print("[deploy] Starting new container...")
    start_container(new_tag)

    # Health check
    print("[deploy] Waiting for health check...")
    if wait_for_healthy():
        print(f"[deploy] ✓ Deployment successful: {IMAGE}:{new_tag}")
        return True

    # Rollback
    print("[deploy] ✗ Health check failed — rolling back")
    stop_container()
    if previous_image:
        tag = previous_image.split(":")[-1]
        start_container(tag)
        print(f"[deploy] Rolled back to {previous_image}")
    return False


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <image_tag>")
        sys.exit(1)

    success = deploy(sys.argv[1])
    sys.exit(0 if success else 1)
```

**Verify it works:**
```bash
python deploy.py v1.2.3
echo "Exit code: $?"

# Check the running container
docker ps --filter name=myapp-prod --format "{{.Image}} {{.Status}}"
```

---

### Example 2: Git Repository Audit Tool

Scan a directory of git repositories and report branch, last commit, and whether there are uncommitted changes.

```python
#!/usr/bin/env python3
"""
git_audit.py — report git status for all repos under a root directory
Usage: python git_audit.py /path/to/repos
"""
import subprocess
import sys
from pathlib import Path


def git(cmd, cwd):
    """Run a git command in a specific directory, return stdout or None on error."""
    result = subprocess.run(
        ["git"] + cmd,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=15,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def repo_status(path):
    """Return a dict of status fields for a git repository."""
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=path)
    commit = git(["log", "-1", "--format=%h %s", "HEAD"], cwd=path)
    dirty_output = git(["status", "--porcelain"], cwd=path)

    # --porcelain produces one line per changed file; empty = clean
    is_dirty = bool(dirty_output)

    # Count commits ahead/behind the tracking branch
    ahead_behind = git(
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        cwd=path,
    )
    ahead, behind = (0, 0)
    if ahead_behind:
        parts = ahead_behind.split()
        if len(parts) == 2:
            ahead, behind = int(parts[0]), int(parts[1])

    return {
        "path": str(path),
        "branch": branch or "unknown",
        "last_commit": commit or "unknown",
        "dirty": is_dirty,
        "ahead": ahead,
        "behind": behind,
    }


def find_repos(root):
    """Find all directories containing a .git folder."""
    return [p.parent for p in Path(root).rglob(".git") if p.is_dir()]


def main(root):
    repos = find_repos(root)
    if not repos:
        print(f"No git repositories found under {root}")
        sys.exit(1)

    print(f"Found {len(repos)} repositories under {root}\n")
    print(f"{'Repository':<40} {'Branch':<20} {'Dirty':<6} {'↑':<4} {'↓':<4} Last Commit")
    print("-" * 100)

    for repo in sorted(repos):
        s = repo_status(repo)
        dirty_flag = "YES" if s["dirty"] else "no"
        short_path = str(Path(s["path"]).relative_to(root))
        print(
            f"{short_path:<40} {s['branch']:<20} {dirty_flag:<6} "
            f"{s['ahead']:<4} {s['behind']:<4} {s['last_commit']}"
        )


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    main(root)
```

**Verify it works:**
```bash
python git_audit.py ~/projects
# Expected: table with one row per repo showing branch, dirty status, ahead/behind counts
```

---

### Example 3: Disk Space Monitor with Alerting

Check disk usage across mounts, log results, and alert when thresholds are exceeded.

```python
#!/usr/bin/env python3
"""
disk_monitor.py — check disk usage and alert on thresholds
Designed to run as a cron job: */5 * * * * python /opt/scripts/disk_monitor.py
"""
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

WARN_PCT = 80
CRIT_PCT = 90
LOG_FILE = Path("/var/log/disk_monitor.json")
ALERT_CMD = ["/usr/local/bin/send-slack-alert"]   # hypothetical alerting tool


def get_disk_usage():
    """Parse `df -P` output into a list of dicts. -P uses POSIX format."""
    result = subprocess.run(
        ["df", "-P", "-x", "tmpfs", "-x", "devtmpfs"],  # exclude virtual fs
        capture_output=True,
        text=True,
        check=True,
    )
    lines = result.stdout.strip().splitlines()[1:]   # skip header row
    mounts = []
    for line in lines:
        parts = line.split()
        # POSIX df columns: Filesystem, 1024-blocks, Used, Available, Capacity%, Mounted
        pct = int(parts[4].rstrip("%"))
        mounts.append({
            "filesystem": parts[0],
            "mount": parts[5],
            "used_pct": pct,
            "available_kb": int(parts[3]),
        })
    return mounts


def send_alert(message, level="warn"):
    """Send an alert via external tool. Don't crash if alerting fails."""
    try:
        subprocess.run(
            ALERT_CMD + [f"--level={level}", message],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        # Alerting failure should not crash the monitor itself
        print(f"Warning: failed to send alert: {e}", file=sys.stderr)


def main():
    timestamp = datetime.utcnow().isoformat() + "Z"
    mounts = get_disk_usage()
    alerts = []

    for m in mounts:
        entry = {**m, "timestamp": timestamp, "status": "ok"}

        if m["used_pct"] >= CRIT_PCT:
            entry["status"] = "critical"
            msg = f"CRITICAL: {m['mount']} is {m['used_pct']}% full ({m['filesystem']})"
            print(msg)
            send_alert(msg, level="critical")
            alerts.append(msg)

        elif m["used_pct"] >= WARN_PCT:
            entry["status"] = "warning"
            msg = f"WARNING: {m['mount']} is {m['used_pct']}% full ({m['filesystem']})"
            print(msg)
            send_alert(msg, level="warn")
            alerts.append(msg)

        # Append JSON log line (one JSON object per line — easy to parse with jq)
        with LOG_FILE.open("a") as f:
            f.write(json.dumps(entry) + "\n")

    if not alerts:
        print(f"[{timestamp}] All disks OK")

    # Non-zero exit when there are critical alerts — useful for cron monitoring
    critical = any("CRITICAL" in a for a in alerts)
    sys.exit(2 if critical else 0)


if __name__ == "__main__":
    main()
```

**Verify it works:**
```bash
python disk_monitor.py
echo "Exit: $?"

# Check the log output
tail -5 /var/log/disk_monitor.json | python -m json.tool

# Parse with jq to find mounts over 50%
jq 'select(.used_pct > 50)' /var/log/disk_monitor.json
```

---

## Exercises

### Exercise 1: Service Restart with Idempotency Check

Write a Python function `ensure_service_running(service_name)` that:
1. Check whether the systemd service is currently active using `systemctl is-active`
2. If it's already running, print a message and return without doing anything
3. If it's stopped or failed, attempt to start it with `systemctl start`
4. After starting, verify the service is now active and raise an exception if it still isn't

**Constraints:** use `check=False` for the status check (the command exits non-zero when the service is not active). Use `check=True` for the start command. Handle `CalledProcessError` and print the stderr output in your error message.

**Test it:** run `ensure_service_running("cron")` (or `crond` on RHEL-based systems). Then test it against a non-existent service name to verify the error path works.

---

### Exercise 2: Find and Report Processes Over a Memory Threshold

Write a script that:
1. Run `ps aux` and capture the output
2. Parse each line to extract the process name and RSS memory usage (column 6 in `ps aux` output is RSS in KB)
3. Filter for processes using more than 100 MB of RAM
4. Print a sorted table (highest memory first) showing PID, process name, and memory in MB

**Constraints:** do all filtering and sorting in Python — do not pipe through `grep`, `awk`, or `sort`. Handle the header line (`USER PID ...`) without crashing.

**Extension:** add a `--kill` flag that sends `SIGTERM` to any process matching a name you pass on the command line, using `subprocess.run(["kill", pid])`.

---

### Exercise 3: Safe Config File Backup Before Edit

Write a function `safe_edit(config_path, new_content)` that:
1. Use `pathlib` to check the file exists before touching it
2. Create a timestamped backup by running `cp` via subprocess (e.g., `nginx.conf.bak.20240115-143022`)
3. Write `new_content` to the original file using `pathlib`'s `write_text()`
4. Verify the new content was written correctly by reading the file back and comparing
5. If the verification fails, restores the backup using subprocess and raises an exception

**Constraints:** build the backup filename in Python using `datetime.now()` and `pathlib` path manipulation. The `cp` command should use `check=True`. Test by pointing it at a throwaway file in `/tmp`.

---

### Exercise 4: Multi-Repo Git Pull Script with Timeout and Error Summary

Write a script that:
1. Accept a directory path as a command-line argument
2. Find all git repositories under that path (directories containing `.git/`)
3. Run `git pull --ff-only` in each repo with a 30-second timeout
4. Collect results: success, failure (non-zero exit), or timeout
5. Print a final summary table showing each repo and its outcome

**Constraints:** use `subprocess.run()` with `capture_output=True` and `timeout=30`. Catch both `CalledProcessError` and `TimeoutExpired` separately — they should produce different status labels in your summary. Do not use `check=True`; handle the return code manually. Run all pulls sequentially (no threading required).

**Extension:** modify the script to run all pulls in parallel using `subprocess.Popen`, collecting all process handles first and then waiting on each one.

---

### Quick Checks

1. Run a command with `subprocess.run` and capture its output.

   ```python
   import subprocess; r = subprocess.run(['echo', 'hello'], capture_output=True, text=True); print(r.stdout.strip())
   ```

   ```expected_output
   hello
   ```

hint: Think about how subprocess.run can be told to capture what a command prints to the terminal instead of letting it go directly to the screen.
hint: Use the capture_output=True argument (or stdout=subprocess.PIPE) and access the result via the .stdout attribute, decoding it with .decode() if needed.

2. Capture the exit code of a failing command.

   ```python
   import subprocess; r = subprocess.run(['bash', '-c', 'exit 42'], capture_output=True); print(r.returncode)
   ```

   ```expected_output
   42
   ```
hint: Think about how Python's subprocess module can run a command and give you access to its return code.
hint: Use subprocess.run() and check the .returncode attribute on the result object to capture what the process exited with.

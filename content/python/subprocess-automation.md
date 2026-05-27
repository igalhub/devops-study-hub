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

In the broader DevOps toolchain, `subprocess` is the glue layer between your Python logic and every other CLI tool in your environment. It sits below high-level libraries like `boto3` or `kubernetes-client` (which have their own HTTP transports) but above raw `os.fork()`/`os.execve()` calls. When a dedicated SDK doesn't exist — or when you're wrapping an existing CLI tool for consistency — `subprocess` is the right abstraction.

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
| `capture_output=True` | Captures stdout and stderr separately | Almost always — lets you inspect output |
| `text=True` | Decodes bytes to str | Whenever you're parsing text output |
| `check=True` | Raises `CalledProcessError` on non-zero exit | When failure should abort the script |
| `timeout=N` | Raises `TimeoutExpired` after N seconds | Network calls, long builds |
| `cwd="/path"` | Sets working directory for the subprocess | Running `git`, `make`, `npm` in a project dir |
| `env=dict` | Replaces (not merges) the environment | Passing secrets, controlling PATH |

**`shell=True` warning:** Setting `shell=True` passes your command to `/bin/sh -c`. This enables injection if any part of the command comes from user input or an external source. It also silently misbehaves with list arguments — only the first element is used as the command; the rest become `$0`, `$1`, etc. inside the shell, which is almost never what you want. Use a list argument and `shell=False` (the default) unless you have a specific reason otherwise.

**`env` replaces, not extends:** If you pass `env={"MY_VAR": "value"}`, the subprocess inherits *only* that variable — `PATH`, `HOME`, and everything else vanishes. To extend the current environment safely:

```python
import os

env = os.environ.copy()
env["MY_SECRET"] = "hunter2"
subprocess.run(["my-tool"], env=env, check=True)
```

---

### Checking Exit Codes

Unix programs signal success or failure through their exit code. Zero means success; non-zero means something went wrong. Ignoring exit codes is one of the most common bugs in automation scripts.

```python
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

**`CalledProcessError` attributes:** when `check=True` raises, `e.stdout` and `e.stderr` are populated only if you also passed `capture_output=True`. Without capture, they are `None`. Always pair `check=True` with `capture_output=True` in production scripts so you can log what went wrong.

**Exit code conventions:** most tools follow the convention that exit 1 is a generic error, but many use specific codes — `grep` exits 1 if no match is found (not an error in most contexts), `diff` exits 1 if files differ. Know your tool's exit code semantics before deciding whether to use `check=True`.

---

### Capturing and Parsing Output

The real power of `subprocess` in DevOps automation is turning CLI output into structured Python data.

```python
import subprocess

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

**Parsing tip:** prefer CLI flags that produce machine-friendly output (`--plain`, `--no-headers`, `--porcelain`, `--output=json`, `-q`) over scraping human-readable tables. Many tools have a JSON output mode (`docker inspect --format json`, `kubectl get pod -o json`) — use it when available and parse with `json.loads(result.stdout)` instead of string splitting.

---

### Timeouts

Without a timeout, a subprocess that hangs (network unreachable, deadlock, stuck prompt) will hang your entire automation script indefinitely. Always set timeouts on anything involving I/O.

```python
import subprocess

def check_http_health(url, timeout_sec=10):
    try:
        result = subprocess.run(
            ["curl", "-sf", "--max-time", str(timeout_sec), url],
            capture_output=True,
            text=True,
            timeout=timeout_sec + 2,  # Python-level timeout slightly larger than curl's
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired as e:
        # The process is still running when this fires — subprocess kills it
        print(f"Timed out after {e.timeout}s: {url}")
        return False
```

**Two-level timeout:** set both `curl --max-time` (or equivalent) *and* Python's `timeout=`. The tool-level timeout is more graceful (returns a non-zero exit code); the Python-level timeout is a hard kill for cases where the tool itself hangs. Set Python's timeout a few seconds higher than the tool's.

**After `TimeoutExpired`:** the child process is killed, but `e.stdout` and `e.stderr` may contain partial output captured before the timeout. This is useful for debugging.

---

### Streaming Output (No Capture)

When you want real-time output — long builds, test runs, deployment scripts — don't capture. Let stdout and stderr pass directly through to the terminal.

```python
import subprocess

# No capture_output — stdout and stderr go to the terminal in real time
result = subprocess.run(
    ["docker", "build", "-t", "myapp:latest", "."],
    check=True,
    # stdout and stderr default to None, which means "inherit from parent"
)

# If you want streaming output but also need to detect failure:
try:
    subprocess.run(["ansible-playbook", "site.yml", "-v"], check=True)
except subprocess.CalledProcessError as e:
    print(f"Playbook failed with exit code {e.returncode}")
    raise SystemExit(1)
```

**Streaming + capture is complex:** if you need both real-time display *and* captured output, you need `subprocess.Popen` with threads reading from `stdout` and `stderr` pipes simultaneously. For most DevOps scripts, choose one or the other. The `subprocess.run()` abstraction doesn't support simultaneous stream-and-capture cleanly.

---

### Piping Between Commands

Python's `subprocess` models Unix pipes explicitly: the output of one command becomes the input of the next via the `input=` parameter. This is safer than `shell=True` with a shell pipe because each stage is a separate process with no shell involved.

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
        input=ps.stdout,         # pipe ps stdout to grep stdin
        capture_output=True, text=True,
    )
    result = subprocess.run(
        ["grep", "-v", "grep"],  # remove the grep process itself
        input=grep.stdout,
        capture_output=True, text=True,
    )
    return result.stdout.strip()
```

**`grep` exit codes in pipes:** `grep` returns exit 1 when there are no matches — not an error in this context. If you use `check=True` on the grep stage, your function will raise when the process isn't found. Use `check=False` and test `result.returncode` yourself, or use Python string methods on the captured output instead.

**Alternative — filter in Python:** for short outputs, capture the whole thing and filter in Python. It's more readable and avoids exit-code edge cases:

```python
def find_process_py(name):
    result = subprocess.run(["ps", "aux"], capture_output=True, text=True, check=True)
    lines = [l for l in result.stdout.splitlines() if name in l and "grep" not in l]
    return "\n".join(lines)
```

---

### shlex — Safe Command Construction from Strings

Sometimes a command comes in as a string (from config, user input, an env variable). `shlex.split()` tokenizes it the way a POSIX shell would — handling quotes and escaping correctly — without invoking a shell.

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
```

**`shlex.split` vs `str.split()`:** `str.split()` breaks on every space, mangling quoted arguments. `'kubectl exec pod-123 -- sh -c "echo hello world"'.split()` produces 7 tokens where the quoted string is split into two. `shlex.split()` produces the correct 6 tokens with `"echo hello world"` intact.

---

### os.path and pathlib — File System Operations

Subprocess handles process execution; `os.path` and `pathlib` handle the file system. In practice you use both together: locate a file with pathlib, then pass its path to a subprocess command.

```python
import os
from pathlib import Path

# os.path — still common in older codebases
os.path.exists("/etc/nginx/nginx.conf")      # True/False
os.path.isfile("/etc/nginx/nginx.conf")      # True
os.path.isdir("/etc/nginx")                  # True
os.path.join("/etc", "nginx", "nginx.conf")  # "/etc/nginx/nginx.conf"
os.path.basename("/etc/nginx/nginx.conf")    # "nginx.conf"
os.path.dirname("/etc/nginx/nginx.conf")     # "/etc/nginx"

# pathlib — prefer for new code (Python 3.4+)
p = Path("/etc/nginx/nginx.conf")
p.exists()                      # True
p.is_file()                     # True
p.name                          # "nginx.conf"
p.stem                          # "nginx"
p.suffix                        # ".conf"
p.parent                        # PosixPath('/etc/nginx')
p.read_text()                   # file contents as str
p.write_text("new content")     # overwrite file

# Path construction with / operator
config = Path("/etc") / "nginx" / "nginx.conf"

# Glob patterns
confs = list(Path("/etc/nginx").glob("*.conf"))        # immediate dir
all_confs = list(Path("/etc/nginx").rglob("*.conf"))   # recursive

# Walk a tree and find large files
for path in Path("/var/log").rglob("*"):
    if path.is_file() and path.stat().st_size > 100 * 1024 * 1024:
        size_mb = path.stat().st_size // (1024 * 1024)
        print(f"Large file: {path} ({size_mb} MB)")
```

| Task | `os.path` | `pathlib` |
|------|-----------|-----------|
| Join paths | `os.path.join(a, b, c)` | `Path(a) / b / c` |
| Check existence | `os.path.exists(p)` | `Path(p).exists()` |
| Read file | `open(p).read()` | `Path(p).read_text()` |
| List directory | `os.listdir(p)` | `Path(p).iterdir()` |
| Recursive glob | `os.walk()` + manual filter | `Path(p).rglob("*.log")` |
| File metadata | `os.stat(p).st_size` | `Path(p).stat().st_size` |

**`pathlib` with subprocess:** `subprocess.run()` accepts `Path` objects anywhere a string path is expected — you don't need to call `str(p)` explicitly in modern Python (3.6+).

---

### subprocess.Popen — Low-Level Control

`subprocess.run()` covers 90% of cases, but `Popen` is available
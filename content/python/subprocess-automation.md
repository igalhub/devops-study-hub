---
title: Subprocess & Automation
module: python
duration_min: 20
difficulty: intermediate
tags: [python, subprocess, automation, shell, os, shlex]
exercises: 4
---

## Overview
DevOps scripts constantly need to run shell commands — restart a service, run `kubectl`, check disk usage, call `git`. Python's `subprocess` module does this properly: captures output, checks exit codes, and avoids the shell injection vulnerabilities that come with `os.system()`. This lesson covers subprocess patterns you'll use in every real automation script.

## Concepts

### subprocess.run — The Right Default
```python
import subprocess

result = subprocess.run(
    ["ls", "-la", "/etc"],
    capture_output=True,   # capture stdout and stderr
    text=True,             # decode bytes to str automatically
    check=False,           # don't raise on non-zero exit (handle manually)
)

print(result.stdout)
print(result.stderr)
print(result.returncode)   # 0 = success
```

**Never use `shell=True` with untrusted input** — it passes the command to `/bin/sh`, enabling injection. `shell=True` with a list argument is a silent footgun: only the first element is treated as the command. Either use a list (safe) or `shlex.split()` when you must construct from a string.

### Checking Exit Codes
```python
# Option 1: check=True raises subprocess.CalledProcessError on failure
try:
    subprocess.run(["systemctl", "restart", "nginx"], check=True, capture_output=True, text=True)
    print("nginx restarted")
except subprocess.CalledProcessError as e:
    print(f"Failed (exit {e.returncode}): {e.stderr.strip()}")

# Option 2: check return code manually
result = subprocess.run(["ping", "-c", "1", "8.8.8.8"], capture_output=True, text=True)
if result.returncode != 0:
    print("Host unreachable")
```

### Capturing and Parsing Output
```python
def get_running_services():
    result = subprocess.run(
        ["systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--plain"],
        capture_output=True, text=True, check=True
    )
    services = []
    for line in result.stdout.splitlines():
        if ".service" in line:
            services.append(line.split()[0])
    return services

# Parse disk usage
def disk_usage_pct(mount="/"):
    result = subprocess.run(["df", "-h", mount], capture_output=True, text=True, check=True)
    # Second line: Filesystem  Size  Used  Avail  Use%  Mount
    line = result.stdout.splitlines()[1]
    pct = int(line.split()[4].rstrip("%"))
    return pct
```

### Timeouts
Long-running commands need timeouts to prevent scripts from hanging:
```python
try:
    result = subprocess.run(
        ["curl", "-s", "https://api.example.com/health"],
        capture_output=True, text=True,
        timeout=10  # seconds
    )
except subprocess.TimeoutExpired:
    print("Request timed out")
```

### Streaming Output (no capture)
When you want the command's output to print in real time (e.g., a long build):
```python
# Let stdout/stderr pass through to the terminal
result = subprocess.run(["docker", "build", "-t", "myapp:latest", "."], check=True)
```

### Piping Between Commands
```python
import shlex

# Equivalent to: ps aux | grep nginx | grep -v grep
ps = subprocess.run(["ps", "aux"], capture_output=True, text=True)
grep = subprocess.run(["grep", "nginx"], input=ps.stdout, capture_output=True, text=True)
result = subprocess.run(["grep", "-v", "grep"], input=grep.stdout, capture_output=True, text=True)
print(result.stdout)
```

### os.path — File System Operations
```python
import os

# Path operations
os.path.exists("/etc/nginx/nginx.conf")     # True / False
os.path.isfile("/etc/nginx/nginx.conf")     # True
os.path.isdir("/etc/nginx")                 # True
os.path.basename("/etc/nginx/nginx.conf")   # "nginx.conf"
os.path.dirname("/etc/nginx/nginx.conf")    # "/etc/nginx"
os.path.join("/etc", "nginx", "nginx.conf") # "/etc/nginx/nginx.conf"

# Walk a directory tree
for root, dirs, files in os.walk("/var/log"):
    for filename in files:
        full_path = os.path.join(root, filename)
        size = os.path.getsize(full_path)
        if size > 100 * 1024 * 1024:  # >100 MB
            print(f"Large file: {full_path} ({size // 1024 // 1024} MB)")
```

### pathlib — Modern Alternative (Python 3.4+)
```python
from pathlib import Path

p = Path("/etc/nginx/nginx.conf")
p.exists()          # True
p.is_file()         # True
p.name              # "nginx.conf"
p.parent            # PosixPath("/etc/nginx")
p.suffix            # ".conf"
p.stem              # "nginx"
p.read_text()       # file contents as string
p.write_text("...")
list(p.parent.glob("*.conf"))  # all .conf files

# Construct paths safely
base = Path("/var/log")
log = base / "nginx" / "access.log"   # pathlib overloads /
```

## Examples

### Script: Health Check and Restart
```python
#!/usr/bin/env python3
import subprocess
import sys

SERVICE = sys.argv[1] if len(sys.argv) > 1 else "nginx"

def service_active(name):
    result = subprocess.run(
        ["systemctl", "is-active", name],
        capture_output=True, text=True
    )
    return result.stdout.strip() == "active"

def restart_service(name):
    subprocess.run(["systemctl", "restart", name], check=True, capture_output=True, text=True)

if not service_active(SERVICE):
    print(f"{SERVICE} is down — restarting...")
    try:
        restart_service(SERVICE)
        print(f"{SERVICE} restarted successfully")
    except subprocess.CalledProcessError as e:
        print(f"Restart failed: {e.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
else:
    print(f"{SERVICE} is running")
```

### Script: Rotate Old Logs
```python
#!/usr/bin/env python3
import subprocess
from pathlib import Path
from datetime import datetime, timedelta

LOG_DIR = Path("/var/log/myapp")
MAX_AGE_DAYS = 7

cutoff = datetime.now() - timedelta(days=MAX_AGE_DAYS)
removed = 0

for log_file in LOG_DIR.glob("*.log.*"):
    mtime = datetime.fromtimestamp(log_file.stat().st_mtime)
    if mtime < cutoff:
        log_file.unlink()
        removed += 1
        print(f"Removed: {log_file}")

print(f"Cleaned up {removed} log files")
```

## Exercises

1. Write a function `run_cmd(cmd: list) -> tuple[int, str, str]` that runs a command and returns `(exit_code, stdout, stderr)`, never raising exceptions.
2. Write a script that checks disk usage on all mounted filesystems (`df -h`) and prints a warning for any mount point above 80% usage.
3. Write a function that checks whether a given process name is running (using `pgrep` or parsing `ps aux`), and returns its PID list.
4. Write a script that takes a directory path and removes all files older than N days (N from CLI arg), printing each file path before deleting it. Add a `--dry-run` flag that prints but doesn't delete.

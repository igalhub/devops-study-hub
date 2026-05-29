---
title: Scripting Fundamentals
module: python
duration_min: 30
difficulty: beginner
tags: [python, variables, functions, loops, conditionals, types]
exercises: 4
---

## Overview

Python is the lingua franca of DevOps automation. Every major tool — Ansible, AWS CDK, Airflow, SaltStack — either uses Python or provides a Python SDK. Unlike Bash, Python scales: it handles JSON, YAML, HTTP APIs, and complex logic without becoming unreadable. Unlike Go or Java, it requires no compilation step and ships on virtually every Linux system. This combination — readable, available, batteries-included — is why Python dominates the automation layer of the DevOps toolchain.

This lesson covers the subset of Python that matters most for scripting: variables and types, control flow, functions, file I/O, and accepting input from the environment. These aren't academic exercises. The patterns here appear directly in CI/CD scripts, health checkers, log parsers, and deployment tools. Understanding them deeply means you can write a working script from scratch in an interview, contribute to an existing automation codebase on day one, and debug tools like Ansible or Fabric when they fail.

Python sits between the shell and a full application framework in the DevOps toolchain. Use Bash for one-liners, command chaining, and wrapping CLI tools. Use Python when you need data structures, error handling, reusable functions, or anything involving APIs and file parsing. Use a full framework (Flask, FastAPI) only when you need persistent services. Most DevOps scripts live firmly in Python territory.

## Concepts

### Variables and Types

Python is dynamically typed — the variable holds a reference to an object, and the type follows the object, not the variable name. There are no declarations.

```python
name = "nginx"          # str
port = 8080             # int
ratio = 0.95            # float
enabled = True          # bool
tags = ["web", "prod"]  # list  — ordered, mutable
config = {"host": "db", "port": 5432}  # dict — key/value, mutable
coords = (10, 20)       # tuple — ordered, immutable
unique_envs = {"prod", "staging"}  # set — unordered, unique values
nothing = None          # NoneType — explicit absence of a value
```

Use `type()` for debugging and `isinstance()` for logic — `isinstance` handles inheritance correctly.

```python
isinstance(port, int)            # True
isinstance(tags, list)           # True
isinstance(nothing, type(None))  # True — or: nothing is None
```

| Type | Mutable | Ordered | Use case |
|------|---------|---------|----------|
| `str` | No | Yes | Hostnames, log lines, config values |
| `int` / `float` | No | — | Ports, timeouts, ratios |
| `list` | Yes | Yes | Server lists, CLI args, log lines |
| `dict` | Yes | Yes (3.7+) | Config objects, JSON payloads |
| `tuple` | No | Yes | Fixed pairs like `(host, port)` |
| `set` | Yes | No | Deduplication, membership tests |
| `None` | — | — | Missing values, unset variables |

**Dynamic typing gotcha:** Python will not warn you if you reassign a variable to a different type. `port = "8080"` followed by `port + 1` raises `TypeError` at runtime, not at parse time. For scripts longer than ~50 lines, consider adding type hints (`port: int = 8080`) — they don't enforce types at runtime but make intent clear and enable editor checking with `mypy`.

### Strings

Strings are immutable sequences. In DevOps scripts you constantly construct URLs, log messages, shell commands, and config file content from string parts.

```python
host = "api.example.com"
port = 443

# f-strings (Python 3.6+) — preferred, readable, fast
url = f"https://{host}:{port}/health"

# Format expressions inside f-strings
pad = f"{'nginx':>20}"         # right-align in a 20-char field
truncated = f"{host[:10]}..."  # slice inside the braces

# Common methods for log/config parsing
"  hello  ".strip()                     # "hello" — remove whitespace both sides
"  hello  ".lstrip()                    # "hello  " — left only
"a,b,c".split(",")                      # ["a", "b", "c"]
"a,b,,c".split(",")                     # ["a", "b", "", "c"] — empty strings included
",".join(["a", "b", "c"])               # "a,b,c"
"Error: disk full".startswith("Error")  # True
"main.py".endswith(".py")               # True
"nginx".upper()                         # "NGINX"
"NGINX".lower()                         # "nginx"
"host=db".replace("=", ": ")           # "host: db"
"line\n".rstrip("\n")                   # "line" — strip trailing newline
```

**`split()` vs `split(",")` difference:** `"a  b".split()` (no argument) splits on any whitespace and discards empty strings. `"a  b".split(" ")` splits on exactly one space and produces empty strings. For log parsing, the no-argument form is almost always what you want for tokenizing whitespace-delimited lines.

```python
# Parsing a log line — whitespace split is cleaner
line = '192.168.1.1 - - [15/Jan/2024] "GET /api" 200 512'
parts = line.split()
ip     = parts[0]              # "192.168.1.1"
method = parts[5].lstrip('"')  # "GET"
status = int(parts[8])         # 200
```

### Lists and Dicts

These two types do the heavy lifting in DevOps scripts. Lists hold sequences of things (servers, log lines, file paths). Dicts represent structured data (config objects, API responses, environment mappings).

```python
# Lists
servers = ["web01", "web02", "web03"]
servers.append("web04")          # add to end
servers.insert(0, "lb01")        # insert at index
servers.remove("web02")          # remove by value — raises ValueError if missing
popped = servers.pop()           # remove and return last element
servers.sort()                   # in-place sort
sorted_copy = sorted(servers)    # returns new list, original unchanged

servers[0]          # first element
servers[-1]         # last element
servers[1:3]        # slice: index 1 up to (not including) 3
len(servers)        # count
"web01" in servers  # membership test — O(n) for lists, O(1) for sets

# Dicts
config = {}
config["host"] = "localhost"
config["port"] = 5432
config.get("timeout", 30)        # 30 — safe get with default; no KeyError
config.setdefault("retries", 3)  # sets key only if not already present
del config["port"]               # remove a key — KeyError if missing

config.keys()    # dict_keys(["host", "retries"])
config.values()  # dict_values(["localhost", 3])
config.items()   # dict_items([("host", "localhost"), ("retries", 3)])

# Merge dicts (Python 3.9+)
defaults  = {"timeout": 5, "retries": 3}
overrides = {"timeout": 10, "host": "db"}
merged = defaults | overrides    # {"timeout": 10, "retries": 3, "host": "db"}

# Pre-3.9 equivalent
merged = {**defaults, **overrides}
```

**Dict key access vs `.get()`:** `config["missing_key"]` raises `KeyError`. `config.get("missing_key")` returns `None`. `config.get("missing_key", "default")` returns `"default"`. In scripts that read external data (API responses, config files), always use `.get()` unless you explicitly want the script to crash on a missing key.

**Set for deduplication:**
```python
all_tags = ["web", "prod", "web", "db", "prod"]
unique_tags = list(set(all_tags))  # ["web", "prod", "db"] — order not guaranteed
```

### Control Flow

```python
exit_code = 1

# if / elif / else — comparison operators: == != < > <= >= in not in is is not
if exit_code == 0:
    print("success")
elif exit_code in (1, 2):
    print("error")
else:
    print(f"unexpected exit code: {exit_code}")

# Truthy/falsy — empty string, 0, [], {}, None all evaluate as False
hosts = []
if not hosts:
    print("No hosts configured")   # this runs

# for — iterates any iterable
servers = ["web01", "web02", "web03"]
for server in servers:
    print(f"Checking {server}")

# enumerate — when you need both index and value
for i, server in enumerate(servers, start=1):
    print(f"{i}/{len(servers)}: {server}")

# zip — iterate two sequences in parallel
ports = [80, 80, 5432]
for server, port in zip(servers, ports):
    print(f"{server}:{port}")

# while — use for retry loops and polling
retries = 0
while retries < 3:
    retries += 1
    print(f"Attempt {retries}")

# break and continue
log_lines = ["", "INFO started", "FATAL disk full", "INFO ignored"]
for line in log_lines:
    if line.strip() == "":
        continue      # skip blank lines
    if "FATAL" in line:
        break         # stop processing on fatal error
    print(line)
```

**`range()` usage:** `range(n)` produces `0` through `n-1`. `range(start, stop)` produces `start` through `stop-1`. `range(start, stop, step)` controls the step. Directly iterating a list (`for item in list`) is cleaner than `for i in range(len(list))` — use `enumerate` when you need the index.

### List Comprehensions

List comprehensions replace `for` loops that build new lists. They're concise and — for simple cases — faster than an explicit loop because Python can optimize them internally.

```python
servers = ["web01", "old-web02", "web03", "old-db01"]

# Filter: keep only servers that don't start with "old"
active = [s for s in servers if not s.startswith("old")]
# ["web01", "web03"]

# Transform: convert string ports to ints
ports = [int(p) for p in ["80", "443", "8080"]]
# [80, 443, 8080]

# Filter + transform combined — skip empty strings before converting
active_ports = [int(p) for p in ["80", "", "443"] if p]
# [80, 443]

# Dict comprehension — build a hostname-to-port lookup
port_map = {server: 80 for server in active}
# {"web01": 80, "web03": 80}

# Set comprehension — unique status codes from log entries
log_lines = ["192.168.1.1 - GET /api 200", "10.0.0.1 - POST /api 500"]
statuses = {int(line.split()[-1]) for line in log_lines}
# {200, 500}
```

**When to use a regular loop instead:** if the body requires more than one expression, or if you need exception handling inside the iteration, use a regular `for` loop. Comprehensions that span more than two logical conditions become hard to read and debug. Readability is not optional in scripts that teammates must maintain.

### Functions

Functions are the primary unit of reuse in scripts. A good DevOps script is mostly a collection of small, focused functions with a short `main()` that calls them in sequence.

```python
def check_port(host, port, timeout=5):
    """
    Returns True if TCP connection to host:port succeeds within timeout seconds.
    Catches common network errors — does not re-raise.
    """
    import socket
    try:
        socket.create_connection((host, port), timeout).close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False

# Positional args
check_port("localhost", 8080)

# Keyword args — order doesn't matter, intent is clear
check_port(host="localhost", port=8080, timeout=2)

# Default args evaluated ONCE at definition time — mutable defaults are a trap
def bad(items=[]):       # DO NOT DO THIS — list is shared across all calls
    items.append(1)
    return items

def good(items=None):    # correct pattern: use None as sentinel
    if items is None:
        items = []
    items.append(1)
    return items
```

**Return values:** a function with no `return` statement returns `None`. Return early to avoid deep nesting — it's easier to read and reason about:

```python
def parse_port(value):
    """Returns int port or None if invalid."""
    if not value:
        return None
    try:
        port = int(value)
    except ValueError:
        return None
    if not (1 <= port <= 65535):
        return None
    return port
```

**`*args` and `**kwargs`** for flexible interfaces:

```python
def log(level, *messages, prefix="[script]"):
    """
    log("INFO", "started", "pid=123") → [script] INFO: started pid=123
    *messages collects any number of positional args after level.
    prefix is keyword-only because it comes after *.
    """
    print(f"{prefix} {level}: {' '.join(str(m) for m in messages)}")

log("INFO", "started", "pid=123")
log("ERROR", "connection failed", prefix="[health-check]")
```

### Error Handling

In shell scripts, errors often silently pass. In Python you have `try/except` — use it to handle expected failures gracefully and let unexpected ones crash loudly. The goal is not to suppress errors but to control how the script responds to them.

```python
import sys

def read_config(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        print(f"Config not found: {path}", file=sys.stderr)
        sys.exit(1)
    except PermissionError:
        print(f"Cannot read: {path}", file=sys.stderr)
        sys.exit(1)

# Catch and re-raise with context — preserves original traceback
def connect(host, port):
    import socket
    try:
        return socket.create_connection((host, port), timeout=3)
    except ConnectionRefusedError as e:
        raise RuntimeError(f"Service down at {host}:{port}") from e

# finally — runs whether or not an exception occurred; use for cleanup
conn = None
try:
    conn = connect("db", 5432)
    # ... use conn
except RuntimeError as e:
    print(f"Error: {e}", file=sys.stderr)
finally:
    if conn:
        conn.close()
```

| Except pattern | When to use |
|----------------|-------------|
| `except ValueError` | Catch one specific exception type |
| `except (ValueError, TypeError)` | Catch a group of related exceptions |
| `except Exception as e` | Catch any non-system-exit exception; always log `e` |
| bare `except:` | Almost never — catches `SystemExit` and `KeyboardInterrupt` too |

**Don't silence exceptions without logging.** `except Exception: pass` hides bugs permanently. At minimum: `except Exception as e: print(e, file=sys.stderr)`. In production scripts, use Python's `logging` module so errors appear in log aggregators.

### File I/O

```python
# Read entire file into a string
with open("/etc/hosts") as f:
    content = f.read()

# Read into a list of lines (newlines included)
with open("/etc/hosts") as f:
    lines = f.readlines()

# Iterate line by line — memory-efficient for large files (logs, CSVs)
with open("/var/log/syslog") as f:
    for line in f:
        if "ERROR" in line:
            print(line.strip())

# Write (truncates existing file)
with open("/tmp/report.txt", "w") as f:
    f.write("Status: OK\n")

# Append
with open("/tmp/report.txt", "a") as f:
    f.write("Checked at: 2024-01-15\n")

# Always set encoding in production scripts — avoids surprises on non-UTF-8 systems
with open("/tmp/data.csv", encoding="utf-8") as f:
    content = f.read()
```

**Always use `with`:** it calls `f.close()` automatically, even if an exception is raised inside the block. A file handle left open in a long-running script leaks OS resources and can prevent other processes from writing to the file on some systems.

**Working with paths using `pathlib` (preferred over `os.path` for new code):**

```python
from pathlib import Path

log_dir  = Path("/var/log/nginx")
log_file = log_dir / "access.log"   # / operator joins paths cleanly

log_file.exists()                   # True/False
log_file.stat().st_size             # file size in bytes
log_file.read_text(encoding="utf-8")  # read entire file as string
log_file.write_text("data\n")         # write string to file

# Glob — find all .log files recursively
for f in log_dir.glob("*.log"):
    print(f.name)                   # just the filename, not full path

# Safely create a directory and parents
Path("/tmp/myapp/logs").mkdir(parents=True, exist_ok=True)
```

### Environment Variables and sys.argv

Scripts need to accept external configuration — credentials, hostnames, flags — without hardcoding values. Two primary mechanisms: environment variables (for secrets and config) and `sys.argv` (for command-line arguments).

```python
import os
import sys

# Read an environment variable
db_host = os.environ.get("DB_HOST", "localhost")   # default if not set
db_pass = os.environ["DB_PASSWORD"]                # raises KeyError if missing — good for required values

# Check presence without reading the value
if "CI" in os.environ:
    print("Running in CI pipeline")

# sys.argv — raw command-line arguments
# script.py deploy web01 --dry-run
# sys.argv = ["script.py", "deploy", "web01", "--dry-run"]
script_name = sys.argv[0]
if len(sys.argv) < 3:
    print(f"Usage: {script_name} <action> <target>", file=sys.stderr)
    sys.exit(1)

action = sys.argv[1]   # "deploy"
target = sys.argv[2]   # "web01"
dry_run = "--dry-run" in sys.argv
```

**For anything beyond two or three arguments, use `argparse`** from the standard library. It generates `--help` output automatically, handles types, and produces clear error messages:

```python
import argparse

parser = argparse.ArgumentParser(description="Deploy a service to a target host")
parser.add_argument("action", choices=["deploy", "rollback", "check"])
parser.add_argument("target", help="Hostname or IP of the target server")
parser.add_argument("--timeout", type=int, default=30, help="Timeout in seconds")
parser.add_argument("--dry-run", action="store_true", help="Print actions without executing")

args = parser.parse_args()
# args.action, args.target, args.timeout, args.dry_run
```

**Never hardcode credentials.** Reading from environment variables (set by a secrets manager, CI/CD platform, or `.env` file excluded from version control) is the minimum acceptable practice. Credentials in source code will be found in git history even after deletion.

### The `main()` Pattern

All non-trivial scripts should use the `if __name__ == "__main__":` guard. This makes the script importable as a module — other scripts and tests can import its functions without triggering execution.

```python
import sys
import argparse

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("host")
    parser.add_argument("--port", type=int, default=80)
    return parser.parse_args()

def run_check(host, port):
    # ... actual logic here
    return True

def main():
    args = parse_args()
    ok = run_check(args.host, args.port)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
```

**Why this matters in DevOps:** CI/CD pipelines check exit codes. `sys.exit(0)` signals success; anything non-zero signals failure and halts the pipeline. A script that always exits with `0` regardless of outcome is indistinguishable from a passing step — this is a common and dangerous bug.

---

## Examples

### Example 1: Log Error Rate Checker

Parses an Nginx access log, counts total requests and 5xx errors, and exits non-zero if the error rate exceeds a threshold. Suitable for use as a CI/CD gate or cron health check.

```python
#!/usr/bin/env python3
"""
check_error_rate.py — exit 1 if 5xx rate exceeds threshold.
Usage: ./check_error_rate.py /var/log/nginx/access.log --threshold 0.05
"""
import sys
import argparse
from pathlib import Path

def parse_args():
    p = argparse.ArgumentParser(description="Check Nginx 5xx error rate")
    p.add_argument("logfile", help="Path to Nginx access log")
    p.add_argument("--threshold", type=float, default=0.05,
                   help="Max acceptable error rate (default: 0.05 = 5%%)")
    return p.parse_args()

def count_requests(path: Path):
    total = 0
    errors = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 9:
                continue          # skip malformed lines silently
            total += 1
            try:
                status = int(parts[8])
            except ValueError:
                continue          # status field not an int — skip
            if status >= 500:
                errors += 1
    return total, errors

def main():
    args = parse_args()
    log_path = Path(args.logfile)

    if not log_path.exists():
        print(f"ERROR: log file not found: {log_path}", file=sys.stderr)
        sys.exit(2)               # exit 2 = usage/config error, distinct from check failure

    total, errors = count_requests(log_path)

    if total == 0:
        print("WARNING: no requests found in log", file=sys.stderr)
        sys.exit(0)               # no data is not a failure

    rate = errors / total
    print(f"Total: {total}  Errors: {errors}  Rate: {rate:.2%}")

    if rate > args.threshold:
        print(f"FAIL: error rate {rate:.2%} exceeds threshold {args.threshold:.2%}",
              file=sys.stderr)
        sys.exit(1)

    print(f"OK: error rate within threshold")
    sys.exit(0)

if __name__ == "__main__":
    main()
```

**Setup and verification:**
```bash
# Create a sample log with known content
cat > /tmp/test_access.log << 'EOF'
192.168.1.1 - - [15/Jan/2024] "GET /api" 200 512
192.168.1.2 - - [15/Jan/2024] "POST /api" 500 128
192.168.1.3 - - [15/Jan/2024] "GET /health" 200 20
192.168.1.4 - - [15/Jan/2024] "GET /api" 502 64
EOF

# 2 errors out of 4 = 50% — should fail with default threshold
python3 check_error_rate.py /tmp/test_access.log
echo "Exit code: $?"   # expect 1

# Pass with a higher threshold
python3 check_error_rate.py /tmp/test_access.log --threshold 0.6
echo "Exit code: $?"   # expect 0
```

---

### Example 2: Environment Config Validator

Reads required configuration from environment variables, validates types and ranges, and prints a clear summary. Useful as the first step in a deployment script to fail fast before touching infrastructure.

```python
#!/usr/bin/env python3
"""
validate_env.py — verify required env vars are present and valid before deploying.
Source this check at the top of any deployment pipeline stage.
"""
import os
import sys

REQUIRED = {
    "APP_ENV":       {"choices": ["production", "staging", "dev"]},
    "DB_HOST":       {"type": str},
    "DB_PORT":       {"type": int, "min": 1, "max": 65535},
    "DEPLOY_TIMEOUT":{"type": int, "min": 10, "max": 600},
}

def validate():
    errors = []

    for var, rules in REQUIRED.items():
        raw = os.environ.get(var)

        if raw is None:
            errors.append(f"{var}: not set")
            continue

        # Type coercion check
        expected_type = rules.get("type", str)
        try:
            value = expected_type(raw)
        except ValueError:
            errors.append(f"{var}: cannot convert '{raw}' to {expected_type.__name__}")
            continue

        # Choices check
        if "choices" in rules and value not in rules["choices"]:
            errors.append(f"{var}: '{value}' not in {rules['choices']}")
            continue

        # Range check for numeric types
        if "min" in rules and value < rules["min"]:
            errors.append(f"{var}: {value} below minimum {rules['min']}")
        if "max" in rules and value > rules["max"]:
            errors.append(f"{var}: {value} above maximum {rules['max']}")

    return errors

def main():
    errors = validate()
    if errors:
        print("Configuration errors:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    print("All required environment variables are valid.")
    sys.exit(0)

if __name__ == "__main__":
    main()
```

**Setup and verification:**
```bash
# Run with missing and invalid values
export APP_ENV=production
export DB_HOST=db.internal
export DB_PORT=99999       # out of range
# DB_PASSWORD and DEPLOY_TIMEOUT intentionally omitted

python3 validate_env.py
# Expect: errors listed, exit code 1

# Run with all valid values
export DB_PORT=5432
export DEPLOY_TIMEOUT=60
python3 validate_env.py
# Expect: "All required environment variables are valid.", exit code 0
echo "Exit: $?"
```

---

### Example 3: Retry Wrapper with Exponential Backoff

A reusable function that retries a callable on failure, with configurable attempts and exponential backoff. This pattern appears constantly in deployment scripts that call APIs or wait for services to start.

```python
#!/usr/bin/env python3
"""
retry.py — generic retry wrapper used in health checkers and deploy scripts.
"""
import time
import socket
import sys

def retry(func, args=(), kwargs=None, attempts=5, backoff=2, exceptions=(Exception,)):
    """
    Call func(*args, **kwargs) up to `attempts` times.
    On failure, wait backoff^attempt seconds before retrying.
    Raises the last exception if all attempts are exhausted.

    backoff=2 means: wait 2s, 4s, 8s, 16s between attempts.
    """
    if kwargs is None:
        kwargs = {}

    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return func(*args, **kwargs)
        except exceptions as e:
            last_exc = e
            if attempt == attempts:
                break                          # don't sleep after final attempt
            wait = backoff ** attempt
            print(f"Attempt {attempt}/{attempts} failed: {e}. Retrying in {wait}s...",
                  file=sys.stderr)
            time.sleep(wait)

    raise RuntimeError(f"All {attempts} attempts failed") from last_exc


def check_tcp(host, port, timeout=3):
    """Raises OSError-derived exceptions on failure — compatible with retry()."""
    conn = socket.create_connection((host, port), timeout=timeout)
    conn.close()
    return True


def main():
    import os
    host = os.environ.get("TARGET_HOST", "localhost")
    port = int(os.environ.get("TARGET_PORT", "8080"))

    print(f"Waiting for {host}:{port} to become available...")
    try:
        retry(
            check_tcp,
            args=(host, port),
            attempts=5,
            backoff=2,
            exceptions=(OSError,),    # socket errors only — don't retry programming errors
        )
        print(f"{host}:{port} is up.")
        sys.exit(0)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

**Setup and verification:**
```bash
# Test against a port that isn't listening — should retry and fail
TARGET_HOST=localhost TARGET_PORT=19999 python3 retry.py
# Expect: 5 attempts with increasing wait times, then exit 1

# Start a listener in another terminal, then run again
python3 -m http.server 8080 &
TARGET_HOST=localhost TARGET_PORT=8080 python3 retry.py
# Expect: success on first attempt, exit 0
kill %1   # stop the test server
```

---

## Exercises

### Exercise 1: Parse a CSV and Compute Statistics

Write a script `disk_report.py` that reads the following CSV from stdin or a file argument, filters out any row where `used_pct` exceeds 90%, and prints the hostname and usage for those hosts. Then print the average used percentage across all hosts.

```
hostname,total_gb,used_gb,used_pct
web01,100,45,45.0
web02,100,92,92.0
db01,500,480,96.0
cache01,50,10,20.0
```

Requirements:
- Accept the filename as `sys.argv[1]`; print a usage message and exit 1 if not provided
- Skip the header row
- Use a list of dicts to store the parsed rows
- Compute the average with a list comprehension
- Print output to stdout; errors to stderr

**Verify:** running against the sample CSV should flag `web02` and `db01`, and print an average of `63.25%`.

---

### Exercise 2: Port Scanner with Retry

Write a script `scan_hosts.py` that accepts a list of `host:port` pairs (one per line) from a file, attempts a TCP connection to each, and writes two output files: `reachable.txt` and `unreachable.txt`.

Requirements:
- Read the input file path from an environment variable `HOSTS_FILE`; exit with a clear error if unset
- Use a function `is_reachable(host, port, timeout=2)` that returns a bool (no exceptions should propagate from it)
- Use `pathlib.Path` for all file operations
- Each output file should contain one `host:port` per line

**Verify:** create a `hosts.txt` with a mix of real and fake endpoints (e.g., `localhost:22` and `localhost:19998`). After running, check that the contents of both output files are correct and that the script exits 0.

---

### Exercise 3: Config Merger

Write a function `merge_config(base_path, override_path)` that:
1. Reads two files, each containing `key=value` lines (one per line, `#` lines are comments)
2. Parses each into a dict
3. Returns a merged dict where override values take precedence over base values
4. Writes the merged result to `/tmp/merged.conf` in the same `key=value` format

Then write a `main()` that accepts the two file paths as positional CLI arguments using `argparse`.

Sample `base.conf`:
```
# base configuration
timeout=30
retries=3
host=localhost
port=5432
```

Sample `override.conf`:
```
# production overrides
timeout=10
host=db.prod.internal
```

**Verify:** the merged output should contain `timeout=10`, `host=db.prod.internal`, `retries=3`, and `port=5432`. Comment lines should not appear in the output.

---

### Exercise 4: Deployment Dry-Run Simulator

Write a script `deploy.py` that simulates a multi-step deployment. It should:

1. Accept `--env` (choices: `dev`, `staging`, `prod`) and `--dry-run` flags via `argparse`
2. Define a list of deployment steps as a list of dicts: `{"name": str, "cmd": str}`
3. Iterate through the steps, printing `[DRY RUN] Would run: <cmd>` if `--dry-run` is set, or `[RUNNING] <cmd>` otherwise
4. For `prod`, require a confirmation prompt (`input("Deploy to prod? [yes/no]: ")`) before proceeding — exit 0 immediately if the answer is not `"yes"`
5. Simulate a random failure: import `random`; if `random.random() < 0.3` on any non-dry-run step, print an error and exit 1

Sample steps:
```python
steps = [
    {"name": "Build image",    "cmd": "docker build -t myapp:latest ."},
    {"name": "Push image",     "cmd": "docker push myapp:latest"},
    {"name": "Update service", "cmd": "kubectl set image deploy/myapp myapp=myapp:latest"},
    {"name": "Verify rollout", "cmd": "kubectl rollout status deploy/myapp"},
]
```

**Verify:**
- `python3 deploy.py --env dev --dry-run` prints all steps prefixed with `[DRY RUN]` and exits 0
- `python3 deploy.py --env prod` prompts for confirmation and aborts on `"no"`
- `python3 deploy.py --env staging` runs steps and may randomly exit 1 (run a few times to confirm)

---

### Quick Checks

1. Sum the values of a dictionary.

   ```python
   data = {'a': 1, 'b': 2}; print(sum(data.values()))
   ```

   ```expected_output
   3
   ```

hint: Think about how Python lets you aggregate all the values in a dictionary with a single built-in function.
hint: Use the sum() function combined with the .values() method on your dictionary, like sum(d.values()).

2. Deduplicate a list and sort it.

   ```python
   items = [3, 1, 4, 1, 5]; print(sorted(set(items)))
   ```

   ```expected_output
   [1, 3, 4, 5]
   ```
hint: Think about how Python's built-in data structures can automatically eliminate duplicate values from a collection.
hint: Convert the list to a set() to remove duplicates, then wrap it with sorted() to return an ordered list.

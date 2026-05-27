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
isinstance(port, int)        # True
isinstance(tags, list)       # True
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
pad = f"{'nginx':>20}"        # right-align in a 20-char field
truncated = f"{host[:10]}..."  # slice inside the braces

# Common methods for log/config parsing
"  hello  ".strip()              # "hello" — remove whitespace
"  hello  ".lstrip()             # "hello  " — left only
"a,b,c".split(",")               # ["a", "b", "c"]
"a,b,,c".split(",")              # ["a", "b", "", "c"] — empty strings included
",".join(["a", "b", "c"])        # "a,b,c"
"Error: disk full".startswith("Error")   # True
"main.py".endswith(".py")        # True
"nginx".upper()                  # "NGINX"
"NGINX".lower()                  # "nginx"
"host=db".replace("=", ": ")    # "host: db"
"line\n".rstrip("\n")            # "line" — strip trailing newline
```

**`split()` vs `split(",")` difference:** `"a  b".split()` (no argument) splits on any whitespace and discards empty strings. `"a  b".split(" ")` splits on exactly one space and produces empty strings. For log parsing, the no-argument form is almost always what you want for tokenizing whitespace-delimited lines.

```python
# Parsing a log line — whitespace split is cleaner
line = '192.168.1.1 - - [15/Jan/2024] "GET /api" 200 512'
parts = line.split()
ip     = parts[0]   # "192.168.1.1"
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
"web01" in servers  # membership test — O(n) for lists

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
defaults = {"timeout": 5, "retries": 3}
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
for line in log_lines:
    if line.strip() == "":
        continue      # skip blank lines
    if "FATAL" in line:
        break         # stop processing on fatal error
```

**`range()` usage:** `range(n)` produces `0` through `n-1`. `range(start, stop)` produces `start` through `stop-1`. `range(start, stop, step)` controls step. Directly iterating a list (`for item in list`) is cleaner than `for i in range(len(list))` — use `enumerate` when you need the index.

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

# Filter + transform combined
active_ports = [int(p) for p in ["80", "", "443"] if p]
# [80, 443]

# Dict comprehension — build a lookup map
port_map = {server: 80 for server in active}
# {"web01": 80, "web03": 80}

# Set comprehension — unique status codes from log lines
statuses = {int(line.split()[8]) for line in log_lines if len(line.split()) > 8}
```

**When to use a regular loop instead:** if the body requires more than one expression, or if you need exception handling inside the iteration, use a regular `for` loop. List comprehensions that span more than two logical conditions become hard to read and debug.

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

# Default args evaluated once at definition time — mutable defaults are a trap
def bad(items=[]):          # DO NOT DO THIS — list is shared across all calls
    items.append(1)
    return items

def good(items=None):       # correct pattern
    if items is None:
        items = []
    items.append(1)
    return items
```

**Return values:** a function with no `return` statement returns `None`. Return early to avoid deep nesting:

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
    """log("INFO", "started", "pid=123") → [script] INFO: started pid=123"""
    print(f"{prefix} {level}: {' '.join(str(m) for m in messages)}")

log("INFO", "started", "pid=123")
log("ERROR", "connection failed", prefix="[health-check]")
```

### Error Handling

In shell scripts, errors often silently pass. In Python you have `try/except` — use it to handle expected failures gracefully and let unexpected ones crash loudly.

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

# Catch and re-raise with context
def connect(host, port):
    import socket
    try:
        return socket.create_connection((host, port), timeout=3)
    except ConnectionRefusedError as e:
        raise RuntimeError(f"Service down at {host}:{port}") from e

# finally — runs whether or not an exception occurred
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
|---------------|-------------|
| `except ValueError` | Catch one specific exception |
| `except (ValueError, TypeError)` | Catch a group of exceptions |
| `except Exception as e` | Catch any non-system-exit exception; log `e` |
| bare `except:` | Almost never — catches `SystemExit` and `KeyboardInterrupt` |

**Don't silence exceptions without logging.** `except Exception: pass` hides bugs. At minimum do `except Exception as e: print(e, file=sys.stderr)`.

### File I/O

```python
# Read entire file into a string
with open("/etc/hosts") as f:
    content = f.read()

# Read into a list of lines (newlines included)
with open("/etc/hosts") as f:
    lines = f.readlines()

# Iterate line by line — memory-efficient for large files
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

# Read with explicit encoding — always set in production scripts
with open("/tmp/data.csv", encoding="utf-8") as f:
    content = f.read()
```

**Always use `with`:** it calls `f.close()` automatically, even if an exception is raised inside the block. A file handle left open in a long-running script leaks resources.

**Working with paths using `pathlib` (preferred over `os.path` for new code):**

```python
from pathlib import Path

log_dir = Path("/var/log/nginx")
log_file = log_dir / "access.log"    # path joining with
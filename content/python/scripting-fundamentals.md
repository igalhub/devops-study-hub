---
title: Scripting Fundamentals
module: python
duration_min: 30
difficulty: beginner
tags: [python, variables, functions, loops, conditionals, types]
exercises: 4
---

## Overview
Python is the lingua franca of DevOps automation. Every major tool — Ansible, AWS CDK, Airflow, SaltStack — either uses Python or provides a Python SDK. This lesson covers the subset of Python that matters most for scripting: variables, control flow, functions, and file I/O. You'll write small scripts that are immediately useful for real tasks.

## Concepts

### Variables and Types
Python is dynamically typed — no declarations, type follows the value.

```python
name = "nginx"          # str
port = 8080             # int
ratio = 0.95            # float
enabled = True          # bool
tags = ["web", "prod"]  # list
config = {"host": "db", "port": 5432}  # dict
nothing = None          # NoneType
```

Check the type of anything with `type()` or `isinstance()`:
```python
isinstance(port, int)       # True
isinstance(tags, list)      # True
```

### Strings
```python
host = "api.example.com"
port = 443

# f-strings (preferred, Python 3.6+)
url = f"https://{host}:{port}"

# Useful string methods
"  hello  ".strip()         # "hello"
"a,b,c".split(",")          # ["a", "b", "c"]
",".join(["a", "b", "c"])   # "a,b,c"
"nginx".upper()             # "NGINX"
"Error: disk full".startswith("Error")  # True
```

### Lists and Dicts
```python
servers = ["web01", "web02", "web03"]
servers.append("web04")
servers[0]                  # "web01"
servers[-1]                 # "web04" (last element)
len(servers)                # 4
"web01" in servers          # True

# Dict
config = {}
config["host"] = "localhost"
config.get("port", 5432)    # 5432 (default if key missing)
config.keys()               # dict_keys(["host"])
config.items()              # dict_items([("host", "localhost")])
```

### Control Flow
```python
# if / elif / else
exit_code = 1
if exit_code == 0:
    print("success")
elif exit_code == 1:
    print("error")
else:
    print(f"unknown exit code: {exit_code}")

# for loop — iterate anything iterable
for server in servers:
    print(f"Checking {server}...")

# range — when you need indexes
for i in range(len(servers)):
    print(f"{i}: {servers[i]}")

# while
retries = 0
while retries < 3:
    retries += 1
    print(f"Attempt {retries}")
```

### List Comprehensions
```python
# Instead of a for loop that builds a list:
active = [s for s in servers if not s.startswith("old")]

# With transformation:
ports = [int(p) for p in ["80", "443", "8080"]]
```

### Functions
```python
def check_port(host, port, timeout=5):
    """Returns True if the port is open."""
    import socket
    try:
        s = socket.create_connection((host, port), timeout)
        s.close()
        return True
    except (socket.timeout, ConnectionRefusedError):
        return False

# Keyword arguments — order doesn't matter
check_port("localhost", 8080, timeout=2)
check_port(port=8080, host="localhost")
```

### File I/O
```python
# Read entire file
with open("/etc/hosts") as f:
    content = f.read()

# Read line by line
with open("/var/log/syslog") as f:
    for line in f:
        if "ERROR" in line:
            print(line.strip())

# Write
with open("/tmp/report.txt", "w") as f:
    f.write("Status: OK\n")

# Append
with open("/tmp/report.txt", "a") as f:
    f.write("Checked at: 2024-01-15\n")
```

Always use `with` — it closes the file automatically, even if an exception occurs.

### sys.argv and Environment Variables
```python
import sys
import os

# Command-line arguments (sys.argv[0] is the script name)
if len(sys.argv) < 2:
    print(f"Usage: {sys.argv[0]} <hostname>")
    sys.exit(1)
host = sys.argv[1]

# Environment variables
db_password = os.environ.get("DB_PASSWORD")
if not db_password:
    print("DB_PASSWORD not set", file=sys.stderr)
    sys.exit(1)
```

## Examples

### Script: Check Multiple Hosts
```python
#!/usr/bin/env python3
import socket
import sys

HOSTS = [
    ("web01.example.com", 80),
    ("web02.example.com", 80),
    ("db.example.com", 5432),
]

def is_up(host, port, timeout=3):
    try:
        socket.create_connection((host, port), timeout).close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False

failed = []
for host, port in HOSTS:
    status = "UP" if is_up(host, port) else "DOWN"
    if status == "DOWN":
        failed.append(f"{host}:{port}")
    print(f"[{status}] {host}:{port}")

if failed:
    print(f"\nFailed: {', '.join(failed)}", file=sys.stderr)
    sys.exit(1)
```

### Script: Parse a Log File
```python
#!/usr/bin/env python3
import sys
from collections import Counter

log_file = sys.argv[1] if len(sys.argv) > 1 else "/var/log/syslog"
errors = Counter()

with open(log_file) as f:
    for line in f:
        if "ERROR" in line or "CRITICAL" in line:
            parts = line.split()
            if len(parts) > 4:
                service = parts[4].rstrip(":")
                errors[service] += 1

for service, count in errors.most_common(10):
    print(f"{count:4d}  {service}")
```

## Exercises

1. Write a script that reads `/etc/passwd`, extracts all usernames (field 1, colon-delimited), and prints only those whose shell (field 7) is `/bin/bash`.
2. Write a function `retry(fn, attempts=3, delay=1)` that calls `fn()` up to `attempts` times, sleeping `delay` seconds between tries, and returns the result or raises the last exception.
3. Write a script that takes a directory path as a CLI argument and prints the 5 largest files in that directory (hint: `os.scandir` or `os.listdir` + `os.path.getsize`).
4. Parse the following log line format and count HTTP status codes: `192.168.1.1 - - [15/Jan/2024:09:00:00] "GET /api/v1/health HTTP/1.1" 200 512` — output a dict like `{200: 45, 404: 3, 500: 1}`.

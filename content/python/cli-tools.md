---
title: Writing CLI Tools
module: python
duration_min: 20
difficulty: intermediate
tags: [python, argparse, cli, click, typer, scripts]
exercises: 4
---

## Overview
A good CLI tool has flags, help text, sensible defaults, and exits with the right code. `argparse` is the standard library solution — zero dependencies, ships with Python. This lesson covers building production-quality CLI tools that other engineers can actually use without reading the source code.

## Concepts

### argparse Basics
```python
import argparse

parser = argparse.ArgumentParser(
    description="Check service health and optionally restart it."
)
# Positional argument (required)
parser.add_argument("service", help="Service name to check")

# Optional flag with value
parser.add_argument("--port", type=int, default=80, help="Port to probe (default: 80)")
parser.add_argument("--timeout", type=float, default=5.0, help="Timeout in seconds")

# Boolean flag
parser.add_argument("--restart", action="store_true", help="Restart if unhealthy")
parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

args = parser.parse_args()

# Access values
print(args.service)     # "nginx"
print(args.port)        # 80
print(args.restart)     # True / False
```

Running `python check.py --help` auto-generates:
```
usage: check.py [-h] [--port PORT] [--timeout TIMEOUT] [--restart] [--verbose] service

Check service health and optionally restart it.

positional arguments:
  service               Service name to check

options:
  -h, --help            show this help message and exit
  --port PORT           Port to probe (default: 80)
  ...
```

### Argument Types and Choices
```python
parser.add_argument("--env", choices=["dev", "staging", "prod"], default="dev")
parser.add_argument("--count", type=int)
parser.add_argument("--config", type=argparse.FileType("r"))  # opens the file
parser.add_argument("--output", type=argparse.FileType("w"), default="-")  # "-" = stdout
```

### Subcommands
Many DevOps tools use subcommands: `git commit`, `kubectl get`, `docker build`. Argparse supports this with subparsers:

```python
parser = argparse.ArgumentParser(description="myapp CLI")
subparsers = parser.add_subparsers(dest="command", required=True)

# deploy subcommand
deploy_parser = subparsers.add_parser("deploy", help="Deploy the application")
deploy_parser.add_argument("env", choices=["staging", "prod"])
deploy_parser.add_argument("--dry-run", action="store_true")

# status subcommand
status_parser = subparsers.add_parser("status", help="Show deployment status")
status_parser.add_argument("env", nargs="?", default="prod")

args = parser.parse_args()

if args.command == "deploy":
    deploy(args.env, dry_run=args.dry_run)
elif args.command == "status":
    show_status(args.env)
```

### Exit Codes
Exit codes matter — CI pipelines and shell scripts check them:
```python
import sys

# 0 = success, anything else = failure
sys.exit(0)    # success
sys.exit(1)    # general error
sys.exit(2)    # misuse of shell command (argparse uses this automatically for bad args)

# Convention for operational scripts:
# 0 = healthy / success
# 1 = unhealthy / failure
# 2 = usage error
```

### Output: stdout vs stderr
```python
import sys

# Informational output → stdout (can be piped or redirected)
print("Deployment successful")

# Errors, warnings → stderr (doesn't pollute piped output)
print("ERROR: config file not found", file=sys.stderr)

# Verbose/debug output — only when --verbose
if args.verbose:
    print(f"[debug] connecting to {host}:{port}...", file=sys.stderr)
```

### Logging Instead of Print
For longer-lived scripts, use `logging` — it adds timestamps, levels, and can write to files:
```python
import logging

logging.basicConfig(
    level=logging.DEBUG if args.verbose else logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

logging.info("Starting health check")
logging.warning("Response time above threshold: %.1fs", 4.2)
logging.error("Service unreachable: %s", host)
```

### Config from Environment + CLI
The standard pattern: environment variables set defaults, CLI flags override:
```python
import os

DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", "5432"))

parser.add_argument("--db-host", default=DB_HOST)
parser.add_argument("--db-port", type=int, default=DB_PORT)
```

## Examples

### Complete CLI Tool
```python
#!/usr/bin/env python3
"""
healthcheck — probe service endpoints and report status.
"""
import argparse
import sys
import socket
import logging

def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("hosts", nargs="+", metavar="HOST:PORT",
                   help="Hosts to check, e.g. web01:80 db:5432")
    p.add_argument("--timeout", type=float, default=3.0)
    p.add_argument("--verbose", "-v", action="store_true")
    return p.parse_args()

def check(host, port, timeout):
    try:
        socket.create_connection((host, port), timeout).close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False

def main():
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(message)s",
    )

    failures = 0
    for target in args.hosts:
        try:
            host, port_str = target.rsplit(":", 1)
            port = int(port_str)
        except ValueError:
            logging.error("Invalid format (expected HOST:PORT): %s", target)
            failures += 1
            continue

        up = check(host, port, args.timeout)
        status = "UP  " if up else "DOWN"
        print(f"[{status}] {target}")
        if not up:
            failures += 1

    sys.exit(1 if failures else 0)

if __name__ == "__main__":
    main()
```

Usage:
```bash
./healthcheck web01:80 db:5432 redis:6379
./healthcheck web01:80 --timeout 1 --verbose
echo $?   # 0 if all up, 1 if any down
```

## Exercises

1. Extend the healthcheck tool above to accept a `--retries N` flag that retries a failed connection up to N times with a 1-second delay before marking it down.
2. Write a CLI tool `logfilter` that takes a log file path, a `--level` flag (`ERROR`, `WARNING`, `INFO`), and a `--since` flag (e.g. `2024-01-15 10:00:00`), and prints matching lines to stdout.
3. Write a CLI tool with two subcommands: `backup <directory>` (creates a timestamped `.tar.gz` archive) and `restore <archive> <destination>` (extracts it). Use `subprocess` to run `tar`.
4. Write a `--dry-run` version of any file-moving or deletion script. The flag should print what would happen without actually doing it — implement this as a helper that wraps file operations so the same code path runs in both modes.

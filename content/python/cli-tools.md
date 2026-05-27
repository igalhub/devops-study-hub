---
title: Writing CLI Tools
module: python
duration_min: 20
difficulty: intermediate
tags: [python, argparse, cli, click, typer, scripts]
exercises: 4
---

## Overview

Command-line tools are the connective tissue of DevOps automation. Deployment scripts, health checkers, log parsers, secret rotators — they are almost always CLI programs that other tools invoke, pipe together, or schedule via cron and CI systems. A well-written CLI tool behaves like a Unix citizen: it reads from stdin when appropriate, writes data to stdout and diagnostics to stderr, returns meaningful exit codes, and documents itself through `--help`. A poorly-written one forces engineers to read source code before they can use it safely in production.

Python's `argparse` is the right default starting point: it ships with the standard library, generates help text automatically, validates types and choices, and handles subcommands. For more complex tools, `click` and `typer` offer decorator-based APIs that reduce boilerplate, but they add dependencies. Understanding `argparse` deeply first means you can reason about what the higher-level libraries are doing under the hood — and it's what you'll reach for when writing tools that need to run in minimal environments without a pip install.

CLI tools in the DevOps toolchain occupy a specific role: they are the human-facing and script-facing interface to automation. They get invoked by CI pipelines, Makefiles, Ansible tasks, and cron jobs — all of which depend on exit codes and clean output to make decisions. Getting those contracts right is what separates a script that works on your laptop from one that can be trusted in a pipeline.

---

## Concepts

### argparse Basics

`argparse` gives you three things for free: argument parsing, type coercion, and help text generation. Build a parser by declaring what arguments your tool expects, then call `parse_args()` to get a namespace object back.

```python
import argparse

parser = argparse.ArgumentParser(
    description="Check service health and optionally restart it."
)

# Positional argument — required, no flag prefix
parser.add_argument("service", help="Service name to check")

# Optional arguments — keyword style, prefixed with --
parser.add_argument("--port", type=int, default=80, help="Port to probe (default: 80)")
parser.add_argument("--timeout", type=float, default=5.0, help="Timeout in seconds")

# Boolean flags — store_true sets the value to True when the flag is present
parser.add_argument("--restart", action="store_true", help="Restart if unhealthy")
parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

args = parser.parse_args()

print(args.service)   # "nginx"
print(args.port)      # 80 (int, not string)
print(args.restart)   # True or False
```

Running `python check.py --help` generates:

```
usage: check.py [-h] [--port PORT] [--timeout TIMEOUT] [--restart] [--verbose] service

Check service health and optionally restart it.

positional arguments:
  service               Service name to check

options:
  -h, --help            show this help message and exit
  --port PORT           Port to probe (default: 80)
  --timeout TIMEOUT     Timeout in seconds
  --restart             Restart if unhealthy
  --verbose, -v         Verbose output
```

**Naming gotcha:** `argparse` converts hyphens in flag names to underscores in the namespace. `--db-host` becomes `args.db_host`. Using hyphens in CLI flags is conventional Unix style; using underscores in Python is PEP 8 style — `argparse` bridges the two automatically.

### Argument Types, Choices, and Nargs

`argparse` coerces values to a Python type before they reach your code. If coercion fails, it prints a usage error and exits with code 2 — before your code runs.

| Pattern | Declaration | Behavior |
|---|---|---|
| String value | `type=str` (default) | No coercion |
| Integer value | `type=int` | Fails on non-integer input |
| Float value | `type=float` | Fails on non-numeric input |
| Restricted set | `choices=["dev","staging","prod"]` | Fails if value not in set |
| Open file for reading | `type=argparse.FileType("r")` | Opens the file, returns handle |
| Stdout or file | `type=argparse.FileType("w"), default="-"` | `"-"` resolves to stdout |
| List of values | `nargs="+"` | One or more; returns a list |
| Optional value | `nargs="?"` | Zero or one |
| Fixed count | `nargs=2` | Exactly two; returns a list |

```python
# Accept one or more target hosts
parser.add_argument("hosts", nargs="+", help="Hosts to probe")

# Accept a restricted environment name
parser.add_argument("--env", choices=["dev", "staging", "prod"], default="dev")

# Write output to a file, defaulting to stdout
parser.add_argument("--output", type=argparse.FileType("w"), default="-")

# Read a config file
parser.add_argument("--config", type=argparse.FileType("r"))
```

**FileType gotcha:** `argparse.FileType` opens the file as soon as arguments are parsed — before your code runs. If the file doesn't exist, `argparse` prints the error and exits. This is usually what you want for required inputs, but it means you cannot lazily validate the path yourself.

### Subcommands

Tools with multiple operations (deploy, status, rollback) should use subcommands rather than overloading a single command with flags. This matches the pattern users already know from `git`, `kubectl`, and `docker`.

```python
parser = argparse.ArgumentParser(description="myapp CLI")
subparsers = parser.add_subparsers(dest="command", required=True)

# --- deploy subcommand ---
deploy_parser = subparsers.add_parser("deploy", help="Deploy the application")
deploy_parser.add_argument("env", choices=["staging", "prod"])
deploy_parser.add_argument("--dry-run", action="store_true",
                           help="Print actions without executing them")
deploy_parser.add_argument("--image-tag", default="latest")

# --- status subcommand ---
status_parser = subparsers.add_parser("status", help="Show deployment status")
status_parser.add_argument("env", nargs="?", default="prod",
                            help="Environment to check (default: prod)")

args = parser.parse_args()

if args.command == "deploy":
    deploy(args.env, dry_run=args.dry_run, tag=args.image_tag)
elif args.command == "status":
    show_status(args.env)
```

**`required=True` on subparsers:** In Python 3.7+, subparsers are optional by default — omitting the subcommand will not raise an error unless you set `required=True`. Always set it explicitly or check `args.command is None` and print help manually.

A cleaner pattern for larger tools is to attach a function directly to each subparser using `set_defaults(func=...)`, which eliminates the if/elif chain:

```python
deploy_parser.set_defaults(func=deploy)
status_parser.set_defaults(func=show_status)

args = parser.parse_args()
args.func(args)   # dispatches to the right function automatically
```

### Exit Codes

Exit codes are the return value of your CLI tool. Every downstream system — CI/CD pipelines, shell conditionals, monitoring systems — uses them to determine success or failure. Getting them wrong silently hides failures.

| Code | Meaning | Convention |
|---|---|---|
| `0` | Success | Always |
| `1` | General error / unhealthy | Operational scripts |
| `2` | Misuse / bad arguments | `argparse` uses this automatically |
| `3-125` | Tool-specific error codes | Document them in `--help` |
| `126` | Command not executable | Shell |
| `127` | Command not found | Shell |
| `130` | Interrupted by Ctrl-C | Shell (128 + SIGINT) |

```python
import sys

sys.exit(0)    # success
sys.exit(1)    # failure — something went wrong at runtime

# Handle Ctrl-C cleanly — don't print a traceback
try:
    main()
except KeyboardInterrupt:
    print("\nInterrupted", file=sys.stderr)
    sys.exit(130)
```

**Pipeline gotcha:** In bash, `set -e` causes the shell to exit on any non-zero exit code. If your tool exits with 1 to mean "no results found" (not an error), it will abort pipelines unexpectedly. Choose exit codes that match the semantic intent — 0 for expected outcomes, non-zero for genuine failures.

### stdout vs stderr

Unix tools separate data from diagnostics by using two output streams. This contract lets users pipe your output to other programs without mixing in log messages.

| Stream | Use for | Redirection |
|---|---|---|
| `stdout` | Data output — the result of the command | `> file`, `\| next-command` |
| `stderr` | Errors, warnings, progress, debug info | `2> file`, `2>/dev/null` |

```python
import sys

# Results go to stdout — these can be piped or redirected
print("web01:80 UP")
print("db:5432 DOWN")

# Diagnostics go to stderr — these don't pollute piped output
print("ERROR: connection refused on db:5432", file=sys.stderr)
print(f"[debug] timeout set to {args.timeout}s", file=sys.stderr)

# A helper to keep the pattern consistent
def info(msg):
    print(msg, file=sys.stderr)

def error(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
```

**Testing stderr separation:** Run `./tool 2>/dev/null | wc -l` — if your tool is well-behaved, only actual data lines are counted. Run `./tool > /dev/null` to see only diagnostics.

### Structured Logging with the `logging` Module

For tools that run unattended (cron, CI, systemd), `print` statements are insufficient. The `logging` module adds severity levels, timestamps, and the ability to route output to files or external systems — all configurable without changing your code.

```python
import logging
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--verbose", "-v", action="store_true")
args = parser.parse_args()

logging.basicConfig(
    level=logging.DEBUG if args.verbose else logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stderr,   # keep logs off stdout
)

log = logging.getLogger(__name__)

log.debug("Connecting to %s:%d", host, port)   # only shown with --verbose
log.info("Health check started for %d hosts", len(args.hosts))
log.warning("Response time %.1fs exceeds threshold", elapsed)
log.error("Service unreachable: %s", host)
```

**Why `getLogger(__name__)`?** It names the logger after the module, so when your tool grows into a package with multiple files, log messages identify their source. Using the root logger directly (`logging.info(...)`) works for single-file tools but doesn't scale.

| Level | Numeric value | Use for |
|---|---|---|
| `DEBUG` | 10 | Detailed diagnostic info — off by default |
| `INFO` | 20 | Confirmation that things are working |
| `WARNING` | 30 | Something unexpected but non-fatal |
| `ERROR` | 40 | A failure — the operation did not complete |
| `CRITICAL` | 50 | The tool cannot continue at all |

### Config from Environment Variables and CLI Flags

The twelve-factor app pattern for configuration: environment variables set the baseline, CLI flags allow per-invocation overrides. This lets the same tool work in CI (where config comes from environment variables) and interactively (where engineers pass flags).

```python
import os
import argparse

# Read from environment, with hard-coded fallback
DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", "5432"))
API_TOKEN = os.environ.get("API_TOKEN")  # no default — must be set

parser = argparse.ArgumentParser()
parser.add_argument("--db-host", default=DB_HOST,
                    help=f"Database host (default: $DB_HOST or '{DB_HOST}')")
parser.add_argument("--db-port", type=int, default=DB_PORT,
                    help=f"Database port (default: $DB_PORT or {DB_PORT})")
parser.add_argument("--token", default=API_TOKEN,
                    help="API token (default: $API_TOKEN)")

args = parser.parse_args()

# Validate required values early — fail before doing any work
if not args.token:
    parser.error("--token is required (or set $API_TOKEN)")
```

**`parser.error()`** prints a usage message and exits with code 2 — the standard exit code for argument errors. Use it for validation failures that are conceptually argument problems (missing required config, invalid combinations).

**Security note:** never put secrets in CLI flags in production. Flags appear in `ps aux` output and shell history. Environment variables or file-based secrets (`--token-file`) are safer.

### Dry-Run Pattern

Dry-run is a first-class feature for any tool that modifies state. The pattern: wrap all side-effecting operations in a function that either executes or logs based on a flag.

```python
def run(cmd, dry_run=False):
    """Execute a shell command, or print it if dry_run is True."""
    import subprocess
    if dry_run:
        print(f"[dry-run] would run: {' '.join(cmd)}", file=sys.stderr)
        return 0
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logging.error("Command failed: %s\n%s", ' '.join(cmd), result.stderr)
    return result.returncode

def move_file(src, dst, dry_run=False):
    """Move a file, or print what would happen."""
    import shutil
    if dry_run:
        print(f"[dry-run] would move: {src} → {dst}", file=sys.stderr)
        return
    shutil.move(src, dst)
```

The key design principle: the same code path runs in both modes. Do not write `if not dry_run: do_thing(); else: log_thing()` scattered throughout your business logic — that leads to divergence between the modes. Push the conditional into the side-effecting primitives and let the rest of the code be unaware of it.

---

## Examples

### Example 1: Production Health Check Tool

A complete, runnable tool that checks TCP connectivity for multiple hosts, supports retries, and exits correctly for use in CI.

```python
#!/usr/bin/env python3
"""
healthcheck — probe TCP endpoints and report status.

Exit codes:
  0  All hosts reachable
  1  One or more hosts unreachable
  2  Invalid arguments
"""
import argparse
import socket
import sys
import time
import logging

def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,  # preserves the exit codes block
    )
    p.add_argument("hosts", nargs="+", metavar="HOST:PORT",
                   help="Endpoints to probe, e.g. web01:80 db:5432")
    p.add_argument("--timeout", type=float, default=3.0,
                   help="TCP connection timeout in seconds (default: 3.0)")
    p.add_argument("--retries", type=int, default=0,
                   help="Retry failed connections N times before marking down (default: 0)")
    p.add_argument("--retry-delay", type=float, default=1.0,
                   help="Seconds between retries (default: 1.0)")
    p.add_argument("--verbose", "-v", action="store_true")
    return p.parse_args()

def check_tcp(host, port, timeout):
    """Return True if TCP connection succeeds."""
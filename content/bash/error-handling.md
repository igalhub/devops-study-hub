---
title: Error Handling
module: bash
duration_min: 15
difficulty: intermediate
tags: [bash, error-handling, set-e, trap, exit-codes, pipefail]
exercises: 4
---

## Overview

Bash's default behavior is dangerous: it continues executing after errors. A failed `cp` in the middle of a deployment script doesn't stop the script — it silently proceeds to the next line, potentially leaving your system in a half-deployed, inconsistent state. This matters in DevOps because scripts drive production deployments, database migrations, infrastructure provisioning, and backup jobs. A script that fails silently is worse than one that crashes loudly, because you may not discover the problem until you need the backup or the migration result.

The core design principle is *fail fast, clean up always*. The combination of `set -euo pipefail` makes the shell treat errors like a typed language would: undefined variables and failed commands are hard stops, not warnings. The `trap` builtin adds the cleanup guarantee — you register a function once, and the shell calls it whether the script succeeds, hits an error, or receives a signal. This turns Bash from a fragile sequence of commands into something with predictable lifecycle semantics.

In the broader DevOps toolchain, robust error handling in Bash is foundational. CI/CD pipelines (Jenkins, GitHub Actions, GitLab CI) execute shell steps and use exit codes to determine pass/fail. Infrastructure tools like Ansible run shell commands and check return codes. Docker `ENTRYPOINT` and `RUN` instructions are shell commands — a `RUN` step that exits non-zero breaks the image build. Understanding Bash error handling is not just a scripting skill; it's a prerequisite for understanding how every other tool in the ecosystem signals success and failure.

---

## Concepts

### set -e — Exit on Error

```bash
set -e   # or: set -o errexit
```

With `set -e`, the shell exits immediately when any simple command returns a non-zero exit code. Without it, failures are silently ignored:

```bash
# Without set -e — dangerous in a deployment context
mkdir /nonexistent/path          # fails, returns exit code 1
cp important.file /nonexistent/  # also fails
echo "Deployment complete"       # still runs — you think it succeeded
```

With `set -e`, the script stops at the first failure and the false "success" message never prints.

**Exception — commands whose exit codes are explicitly tested are not subject to `set -e`:**

| Context | Subject to `set -e`? |
|---|---|
| Simple command: `cp a b` | Yes |
| Condition in `if`: `if grep -q x file` | No |
| Left side of `&&` or `\|\|` | No |
| Commands in `while`/`until` condition | No |
| Last command in a pipeline (without `pipefail`) | Yes |

```bash
set -e

# These are all safe — exit codes are intentionally tested:
if ! grep -q "nginx" /etc/services; then
    echo "nginx not in services"
fi

systemctl is-active nginx || echo "nginx is down"

# To exempt a single command without wrapping it in if:
some_command_that_may_fail || true
```

**`set -e` gotcha — subshell command substitution:** `set -e` does not trigger on failures inside `$(...)` when the substitution is part of a variable assignment. The assignment itself returns 0 even if the subshell fails. This is one of the most common sources of hidden bugs.

```bash
set -e

# This does NOT exit even if git log fails (e.g., not a git repo):
LAST_COMMIT=$(git log -1 --format=%H)

# Safe approach: run first, then capture
git log -1 --format=%H > /dev/null   # will exit on failure
LAST_COMMIT=$(git log -1 --format=%H)
```

**`set -e` gotcha — functions:** `set -e` applies inside functions, but if a function call appears in a compound context (like `if myfunc; then`), failures inside the function are suppressed. Test functions directly as simple commands, not inside conditions, if you want `set -e` to catch their internal failures.

---

### set -u — Undefined Variables are Errors

```bash
set -u   # or: set -o nounset
```

Without `set -u`, referencing an unset variable silently expands to an empty string. The consequences range from wrong output to catastrophic data loss:

```bash
# Without set -u:
echo "$UNSET_VAR/config"    # prints: /config  (wrong path)
rm -rf "$UNSET_VAR/"        # becomes: rm -rf /  (disaster)
```

With `set -u`, the script exits immediately with `bash: UNSET_VAR: unbound variable`.

**Providing safe defaults with parameter expansion:**

| Syntax | Behavior |
|---|---|
| `${VAR:-default}` | Use `default` if VAR is unset **or empty** |
| `${VAR-default}` | Use `default` only if VAR is unset (empty string passes through) |
| `${VAR:?error msg}` | Exit with error message if VAR is unset or empty |
| `${VAR:=default}` | Assign `default` to VAR if unset or empty, then expand |
| `${VAR:+alternate}` | Use `alternate` if VAR is set and non-empty; otherwise empty string |

```bash
set -u

DEPLOY_ENV="${DEPLOY_ENV:-staging}"                          # default to staging
LOG_LEVEL="${LOG_LEVEL:-info}"                               # optional with default
CONFIG_FILE="${CONFIG_FILE:?CONFIG_FILE must be set}"        # hard requirement — exits with message
OPTIONAL_FLAG="${OPTIONAL_FLAG:+--flag=${OPTIONAL_FLAG}}"   # only include if set
```

**`set -u` gotcha with arrays:** accessing an unset array or referencing `$@` when no positional arguments were passed triggers the error. The idiomatic safe expansion for arrays and `$@` is the `${array[@]+"${array[@]}"}` pattern:

```bash
set -u

# Wrong — fails if script receives no arguments:
for arg in "$@"; do echo "$arg"; done

# Safe — expands to nothing when $@ is empty:
for arg in "${@+"$@"}"; do echo "$arg"; done

# Same pattern for optional arrays:
EXTRA_ARGS=()
rsync "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" /src/ /dst/
```

---

### set -o pipefail — Catch Pipe Failures

```bash
set -o pipefail
```

Without `pipefail`, the exit code of a pipeline is the exit code of the **last command only**. This means failures earlier in the pipe are silently discarded, even with `set -e` active:

```bash
# Without pipefail:
cat /nonexistent_file | grep "ERROR" | wc -l
# cat exits 1 (file not found)
# grep exits 1 (no input, no match)
# wc exits 0
# Pipeline exit code = 0 — script continues as if everything succeeded
```

With `pipefail`, the pipeline exit code is the exit code of the **rightmost command that failed**:

```bash
set -eo pipefail
cat /nonexistent_file | grep "ERROR" | wc -l
# Pipeline exit code = 1 (from cat) — script exits here
```

**`pipefail` interaction with `grep`:** `grep` returns exit code 1 when it finds no matches — this is often correct behavior, not an error. With `pipefail` active, a pipeline ending in grep will exit 1 when there are no matches, which `set -e` will treat as a failure.

```bash
set -eo pipefail

# This exits the script if grep finds no matches — probably not what you want:
journalctl -u nginx | grep "error"

# If "no matches" is acceptable, suppress with || true:
ERROR_COUNT=$(journalctl -u nginx | grep -c "error" || true)
echo "Found $ERROR_COUNT errors"
```

**Inspecting individual pipe stage exit codes:** the `PIPESTATUS` array captures the exit code of each stage in the most recent pipeline. Use it when you need to distinguish which stage failed.

```bash
set -o pipefail

generate_report | compress | upload_to_s3
pipe_codes=("${PIPESTATUS[@]}")

echo "generate_report: ${pipe_codes[0]}"
echo "compress:        ${pipe_codes[1]}"
echo "upload_to_s3:    ${pipe_codes[2]}"
```

---

### The Standard Header

Every production Bash script should start with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

Using `/usr/bin/env bash` instead of `/bin/bash` is more portable — it finds bash on `$PATH`, which matters on macOS (where `/bin/bash` is an ancient Bash 3.2), NixOS, and container images where bash lives in a non-standard location.

Some teams extend this header with:

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'   # safer word splitting: only newline and tab, not space
```

Changing `IFS` prevents word-splitting bugs on filenames or values that contain spaces. Without it, a loop like `for f in $(ls)` will break on filenames with spaces. It's especially valuable in scripts that process file lists, user input, or external command output. The tradeoff is that some idioms (space-delimited string splitting) stop working — but those idioms are usually better replaced with arrays anyway.

---

### trap — Cleanup on Exit

`trap` registers a command or function to execute when the shell receives a signal or exits. The most important use in scripts is guaranteed cleanup — temporary files, locks, and partially-modified state are cleaned up whether the script succeeds, errors, or is interrupted.

```bash
#!/usr/bin/env bash
set -euo pipefail

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT   # runs no matter how the script ends

cp source_data.csv "$TMPDIR/"
process "$TMPDIR/source_data.csv" > output.csv
# $TMPDIR removed automatically — success, error, or signal
```

**Trap signal targets:**

| Signal/Pseudo-signal | When it fires |
|---|---|
| `EXIT` | Script exits for any reason (normal, error, or signal) |
| `ERR` | Any command returns non-zero (only with `set -e` reliably) |
| `INT` | User presses Ctrl+C (SIGINT, signal 2) |
| `TERM` | Process receives SIGTERM (e.g., `kill <pid>`) |
| `HUP` | Terminal hangup (SIGHUP, e.g., SSH session drops) |

**Prefer `EXIT` over `ERR`** for cleanup. `ERR` does not fire in all failure contexts (it's suppressed in some compound commands), while `EXIT` fires unconditionally whenever the script terminates.

**`trap` gotcha — `$?` in the trap handler:** inside an `EXIT` trap, `$?` holds the exit code that triggered the exit. Capture it immediately as the first operation in your cleanup function — any command executed after that, including `echo`, will overwrite `$?`.

```bash
cleanup() {
    local exit_code=$?    # capture FIRST — any command below will overwrite $?
    rm -rf "$TMPDIR"
    if [ "$exit_code" -ne 0 ]; then
        echo "Script failed with exit code $exit_code" >&2
    fi
    exit "$exit_code"     # propagate the original exit code to the caller
}
trap cleanup EXIT
```

**Stacking traps — each `trap` call replaces the previous one for that signal.** To add behavior without losing existing cleanup, chain functions explicitly:

```bash
cleanup_files() { rm -rf "$TMPDIR"; }
release_lock()  { rm -f /var/run/myscript.lock; }

# Wrong: this silently replaces cleanup_files:
trap release_lock EXIT

# Right: define a single handler that calls both in the right order:
cleanup_all() {
    release_lock
    cleanup_files
}
trap cleanup_all EXIT
```

**`trap` and subshells:** traps are not inherited by subshells created with `(...)`. If you spawn a subshell, define its own traps inside it. Child processes created with `$(...)` or `&` also do not inherit traps.

---

### Exit Codes

Exit codes are the universal interface between processes in Unix. Every command returns one. Scripts that are called from CI/CD systems, Ansible, Docker, or other scripts must return meaningful exit codes — returning 0 on failure breaks every caller silently.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General error (convention) |
| `2` | Misuse of shell command or bad arguments |
| `126` | Command found but not executable (permissions) |
| `127` | Command not found |
| `128+n` | Script terminated by signal `n` (e.g., `130` = Ctrl+C = 128+2) |

Exit codes above 125 are reserved by the shell. **Do not use exit codes above 125 in your own scripts** — they collide with shell-reserved meanings and will confuse callers.

**Checking exit codes — prefer `if` over `$?`:**

```bash
# Fragile: $? is overwritten by every command, including [
cp file.txt /backup/
if [ $? -ne 0 ]; then    # risky: inserting any command between cp and [ breaks this
    echo "Backup failed" >&2
    exit 1
fi

# Idiomatic: test the command directly — no gap for $? to be overwritten
if ! cp file.txt /backup/; then
    echo "Backup failed" >&2
    exit 1
fi

# For chains: use && / || with explicit error handling
cp file.txt /backup/ && echo "Backup OK" || { echo "Backup failed" >&2; exit 1; }
```

**Propagating exit codes:** when your script calls another script, preserve its exit code. Using bare `exit` (with no argument) exits with the code of the last executed command. In trap handlers, always re-exit with the captured code so the calling process sees the real result.

---

### Meaningful Error Messages

Good error messages tell the operator *what failed*, *where*, and ideally *what to do next*. All error output goes to stderr (`>&2`) so it doesn't pollute stdout, can be captured separately, and won't be swallowed when stdout is redirected to a file or pipe.

```bash
# Reusable die() helper — include in every production script
die() {
    local exit_code="${1:-1}"
    shift
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') ${BASH_SOURCE[1]}:${BASH_LINENO[0]} — $*" >&2
    exit "$exit_code"
}

# Usage patterns:
[ -f "$CONFIG" ]      || die 1 "Config file not found: $CONFIG — copy from config.example"
[ $# -ge 1 ]          || die 2 "Usage: $0 <environment> [version]"
command -v docker     || die 127 "docker not found — install Docker Engine and ensure it is on PATH"
[ "$EUID" -eq 0 ]     || die 1 "This script must be run as root (current UID: $EUID)"
```

**Include context in error messages.** A message like `"File not found"` forces the operator to re-read the script to understand what file. A message like `"Expected config at /etc/myapp/config.yml — copy from /etc/myapp/config.example before deploying"` is immediately actionable.

```bash
# Bad:
die "Connection failed"

# Good:
die "Failed to connect to database at ${DB_HOST}:${DB_PORT} — check DB_HOST and DB_PORT environment variables and verify the database is running"
```

---

### Debugging

| Technique | Command | When to use |
|---|---|---|
| Trace execution | `set -x` / `bash -x script.sh` | Step through logic, see variable expansion in real time |
| Syntax check only | `bash -n script.sh` | Catch parse errors without running — safe for production scripts |
| Verbose mode | `set -v` | Print each line before word-splitting (less readable than `-x`) |
| Check exit code inline | `some_cmd; echo "exit: $?"` | After a specific suspect command |
| Trace a section only | `set -x; ...; set +x` | Reduce noise in long scripts |
| Dry-run pattern | `DRY_RUN=true` guard in functions | Simulate destructive actions without executing them |

```bash
#!/usr/bin/env bash
set -euo pipefail

# Trace only the risky section — keeps output manageable:
set -x
rsync -avz /src/ user@host:/dst/
set +x

echo "rsync completed"
```

**`$BASH_SOURCE`, `$LINENO`, and `$FUNCNAME`** are available in trap handlers and error functions, enabling stack-trace-style output that tells you exactly where in a multi-file script system an error occurred:

```bash
err_report() {
    echo "[TRACE] Error on line $1 in ${BASH_SOURCE[0]}" >&2
    # Print a simple call stack if inside nested functions:
    local i
    for i in "${!FUNCNAME[@]}"; do
        echo "  [$i] ${FUNCNAME[$i]} (${BASH_SOURCE[$i+1]:-main}:${BASH_LINENO[$i]})" >&2
    done
}
trap 'err_report $LINENO' ERR
```

**`PS4` customization:** the `PS4` variable controls the prefix printed by `set -x`. The default is `+`. Setting it to include the script name and line number makes traces dramatically more useful:

```bash
export PS4='+(${BASH_SOURCE}:${LINENO}): ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -x
```

---

## Examples

### Example 1: Robust Deployment Script with Automatic Rollback

```bash
#!/usr/bin/env bash
# deploy.sh — deploy a versioned release with automatic rollback on failure
# Usage: ./deploy.sh <service> <version>
set -euo pipefail

SERVICE="${1:?Usage: $0 <service> <version>}"
VERSION="${2:?Usage: $0 <service> <version>}"

BACKUP_DIR="/opt/backups/${SERVICE}"
DEPLOY_DIR="/opt/apps/${SERVICE}"
RELEASE_DIR="/opt/releases/${SERVICE}/${VERSION}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"

die() {
    local code="${1:-1}"; shift
    echo "[ERROR] $*" >&2
    exit "$code"
}

# Preflight checks — fail early before making any changes
[ -d "$DEPLOY_DIR" ]  || die 1 "Deploy dir not found: $DEPLOY_DIR"
[ -d "$RELEASE_DIR" ] || die 1 "Release not found: $RELEASE_DIR — build it first"
command -v rsync >/dev/null 2>&1 || die 127 "rsync required but not installed"
systemctl is-enabled "$SERVICE" >/dev/null 2>&1 || die 1 "Systemd service '$SERVICE' does not exist"

# cleanup() runs on any exit — checks whether to roll back
cleanup() {
    local exit_code=$?   # capture before any other command overwrites it
    if [ "$exit_code" -ne 0 ]; then
        echo "[ROLLBACK] Deployment failed (exit $exit_code) — rolling back..." >&2
        if [ -d "$BACKUP_PATH" ]; then
            rsync -a --delete "${BACKUP_PATH}/" "${DEPLOY_DIR}/"
            systemctl restart "$SERVICE" || true   # best-effort; don't mask original error
            echo "[ROLLBACK] Complete. Service restored from $BACKUP_PATH" >&2
        else
            echo "[ROLLBACK] No backup at $BACKUP_PATH — manual recovery required" >&2
        fi
    fi
    exit "$exit_code"
}
trap cleanup EXIT

# Step 1: back up current deployment
mkdir -p "$BACKUP_PATH"
rsync -a "${DEPLOY_DIR}/" "${BACKUP_PATH}/"
echo "[1/3] Backed up current deployment → $BACKUP_PATH"

# Step 2: deploy new release
systemctl stop "$SERVICE"
rsync -a --delete "${RELEASE_DIR}/" "${DEPLOY_DIR}/"
systemctl start "$SERVICE"
echo "[2/3] Deployed ${SERVICE}@${VERSION}"

# Step 3: health check — give the service time to initialize
sleep 5
systemctl is-active --quiet "$SERVICE" \
    || die 1 "Service $SERVICE is not active after deployment — check: journalctl -u $SERVICE"

echo "[3/3] Health check passed. ${SERVICE}@${VERSION} is live."
```

**Verify it works:**
```bash
# Test rollback by pointing to a nonexistent version:
./deploy.sh myapp 99.99.99
# Expected: preflight check exits with "Release not found" before any changes

# Test mid-deployment failure by making the release dir unreadable:
chmod 000 /opt/releases/myapp/2.0.0
./deploy.sh myapp 2.0.0
# Expected: rsync fails, cleanup fires, original version restored
echo "Exit code: $?"   # should be non-zero
```

---

### Example 2: Log Processing Pipeline with Full Error Handling

```bash
#!/usr/bin/env bash
# parse_errors.sh — extract and count error patterns from an application log
# Usage: ./parse_errors.sh <logfile> [output_file]
set -euo pipefail

LOGFILE="${1:?Usage: $0 <logfile> [output_file]}"
OUTFILE="${2:-/dev/stdout}"

die() { echo "[ERROR] $*" >&2; exit 1; }

[ -f "$LOGFILE" ]    || die "Log file not found: $LOGFILE"
[ -r "$LOGFILE" ]    || die "Log file not readable: $LOGFILE (check permissions)"
command -v awk >/dev/null 2>&1 || die "awk is required"

# Use a temp file so a partial run doesn't corrupt the output file
TMPOUT=$(mktemp)
trap 'rm -f "$TMPOUT"' EXIT

echo "Processing: $LOGFILE" >&2

# grep exits 1 on no matches — || true prevents set -e from treating that as failure
# We capture the count separately so a pipeline failure in grep is distinguishable
# from a failure in awk or sort
ERROR_LINES=$(grep -i "error\|exception\|critical" "$LOGFILE" || true)

if [ -z "$ERROR_LINES" ]; then
    echo "No errors found in $LOGFILE" >&2
    echo "# No errors found — $(date)" > "$TMPOUT"
else
    # Count occurrences of each unique error pattern
    # awk groups by the first field after the log level keyword
    echo "$ERROR_LINES" \
        | awk '{
            # Extract the word immediately after ERROR/EXCEPTION/CRITICAL as the key
            for (i=1; i<=NF; i++) {
                if (tolower($i) ~ /error|exception|critical/) {
                    key = $(i+1)
                    counts[key]++
                    break
                }
            }
          }
          END {
            for (k in counts) printf "%6d  %s\n", counts[k], k
          }' \
        | sort -rn \
        > "$TMPOUT"

    TOTAL=$(wc -l < "$TMPOUT")
    echo "Found $TOTAL distinct error patterns" >&2
fi

# Atomically move temp output to final destination (avoids partial writes)
if [ "$OUTFILE" = "/dev/stdout" ]; then
    cat "$TMPOUT"
else
    mv "$TMPOUT" "$OUTFILE"
    echo "Report written to $OUTFILE" >&2
fi
```

**Verify it works:**
```bash
# Create a sample log:
cat > /tmp/test.log <<'EOF'
2024-01-15 10:01:00 INFO  Server started
2024-01-15 10:01:05 ERROR ConnectionRefused connecting to db:5432
2024-01-15 10:01:06 ERROR ConnectionRefused connecting to db:5432
2024-01-15 10:01:10 CRITICAL DiskFull /var/data has 0 bytes free
2024-01-15 10:01:15 ERROR TimeoutError waiting for upstream
EOF

./parse_errors.sh /tmp/test.log
# Expected: counts for ConnectionRefused, DiskFull, TimeoutError

# Test missing file:
./parse_errors.sh /tmp/nonexistent.log
# Expected: [ERROR] Log file not found — exits 1
```

---

### Example 3: Infrastructure Preflight Check Script

```bash
#!/usr/bin/env bash
# preflight.sh — validate environment before running a deployment
# Exits non-zero if any required condition is not met.
# Designed to be sourced or called from a CI pipeline step.
set -euo pipefail

REQUIRED_VARS=(DB_HOST DB_PORT DEPLOY_ENV AWS_REGION)
REQUIRED_CMDS=(aws kubectl helm jq)
MIN_DISK_GB=5
MIN_MEM_GB=2

PASS=0
FAIL=0

check() {
    local description="$1"
    local result="$2"   # "ok" or an error message
    if [ "$result" = "ok" ]; then
        echo "  [PASS] $description"
        (( PASS++ )) || true   # increment even under set -e (arithmetic returns 1 on 0)
    else
        echo "  [FAIL] $description — $result" >&2
        (( FAIL++ )) || true
    fi
}

echo "=== Environment Variables ==="
for var in "${REQUIRED_VARS[@]}"; do
    if [ -n "${!var:-}" ]; then   # indirect expansion: value of variable named by $var
        check "$var is set" "ok"
    else
        check "$var is set" "unset or empty"
    fi
done

echo "=== Required Commands ==="
for cmd in "${REQUIRED_CMDS[@]}"; do
    if command -v "$cmd" >/dev/null 2>&1; then
        check "$cmd available" "ok"
    else
        check "$cmd available" "not found on PATH"
    fi
done

echo "=== System Resources ==="
# Disk: df reports in 1K blocks; convert to GB
DISK_FREE_GB=$(df / | awk 'NR==2 {printf "%d", $4/1024/1024}')
if [ "$DISK_FREE_GB" -ge "$MIN_DISK_GB" ]; then
    check "Disk free >= ${MIN_DISK_GB}GB (found: ${DISK_FREE_GB}GB)" "ok"
else
    check "Disk free >= ${MIN_DISK_GB}GB" "only ${DISK_FREE_GB}GB free"
fi

# Memory: /proc/meminfo in kB
MEM_FREE_GB=$(awk '/MemAvailable/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_FREE_GB" -ge "$MIN_MEM_GB" ]; then
    check "Memory available >= ${MIN_MEM_GB}GB (found: ${MEM_FREE_GB}GB)" "ok"
else
    check "Memory available >= ${MIN_MEM_GB}GB" "only ${MEM_FREE_GB}GB available"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    echo "Preflight FAILED — resolve the above issues before deploying." >&2
    exit 1
fi

echo "Preflight PASSED."
exit 0
```

**Verify it works:**
```bash
# Run with a missing variable to trigger a failure:
unset DB_HOST
./preflight.sh
# Expected: [FAIL] DB_HOST is set, Results: X passed, 1+ failed, exit code 1

# Run with all vars set and commands present:
export DB_HOST=db.internal DB_PORT=5432 DEPLOY_ENV=staging AWS_REGION=us-east-1
./preflight.sh
# Expected: all PASSes (assuming tools are installed), exit code 0
```

---

## Exercises

### Exercise 1: Find the Silent Failures

The script below has three error-handling bugs that would cause silent failures in production. Without running it, identify each bug and explain what could go wrong. Then fix the script.

```bash
#!/usr/bin/env bash

BACKUP_DIR="/backups"
DB_NAME="$1"

mkdir -p "$BACKUP_DIR"
pg_dump "$DB_NAME" | gzip > "$BACKUP_DIR/${DB_NAME}.sql.gz"
echo "Backup of $DB_NAME complete: $BACKUP_DIR/${DB_NAME}.sql.gz"
```

**What to find:**
1. What happens if this script is called with no arguments?
2. What happens if `pg_dump` fails mid-stream — for example, if the database doesn't exist?
3. What happens to the output file if `gzip` fails?

After identifying the bugs, rewrite the script with `set -euo pipefail`, a `trap` for cleanup, and a preflight check for the argument. Test it by passing a non-existent database name.

---

### Exercise 2: Build a Reusable Error Library

Create a file called `lib/error.sh` that can be sourced by other scripts. It should provide:

1. A `die <exit_code> <message>` function that prints to stderr and exits
2. A `require_cmd <command>` function that exits with code 127 if the command is not on `$PATH`
3. A `require_var <varname>` function that exits with code 1 if the named variable is unset or empty (use indirect expansion `${!varname}`)
4. A `setup_traps` function that registers an `EXIT` trap printing the exit code and the line number where the script exited (use `$BASH_LINENO`)

Then write a second script `deploy_check.sh` that sources `lib/error.sh`, calls `setup_traps`, uses `require_var` to validate `DEPLOY_ENV` and `APP_VERSION`, uses `require_cmd` to validate `docker` and `kubectl`, and calls `die` with a descriptive message if `DEPLOY_ENV` is not one of `staging`, `production`.

Test it with missing variables, missing commands, and an invalid environment name.

---

### Exercise 3: Debug a Broken Pipeline

The following script is intended to count HTTP 5xx errors in an nginx access log and alert if the count exceeds a threshold. It has a bug related to `pipefail` and `grep` exit codes that causes it to always exit with an error even when the log has no 5xx entries.

```bash
#!/usr/bin/env bash
set -euo pipefail

LOGFILE="${1:?Usage: $0 <logfile>}"
THRESHOLD="${2:-10}"

COUNT=$(grep " 5[0-9][0-9] " "$LOGFILE" | wc -l)

if [ "$COUNT" -gt "$THRESHOLD" ]; then
    echo "ALERT: $COUNT 5xx errors exceed threshold of $THRESHOLD" >&2
    exit 2
fi

echo "OK: $COUNT 5xx errors (threshold: $THRESHOLD)"
```

**Tasks:**
1. Reproduce the bug by creating a log file with no 5xx lines and running the script.
2. Explain exactly which command is failing and why.
3. Fix the script without disabling `pipefail` globally. The fix should preserve error detection for real failures (like the log file not being readable).
4. Add handling for the case where the log file exists but is empty.

---

### Exercise 4: Simulate a Deployment with Staged Failures

Write a script `staged_deploy.sh` that simulates a four-stage deployment (validate → build → push → restart) using functions. Each stage should:

- Print a `[STAGE n/4]` header before executing
- Accept a `FAIL_AT_STAGE` environment variable (1–4) that causes the specified stage to fail with exit code 1
- Use `trap` to print which stage failed and how long the deployment ran before failing (use `$SECONDS` which Bash increments automatically)
- Clean up a temp directory created at startup regardless of which stage fails

Run the script four times, setting `FAIL_AT_STAGE` to 1, 2, 3, and 4 in turn, and verify that:
- The correct stage name appears in the failure message each time
- The temp directory is always removed (check with `ls /tmp/deploy_*` before and after)
- The exit code is non-zero for all four runs
- A fifth run with `FAIL_AT_STAGE` unset completes successfully with exit code 0
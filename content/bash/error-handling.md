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

**`set -e` gotcha:** it does not trigger on failures inside subshells that are part of a variable assignment with `$(...)`. The assignment itself returns 0 even if the subshell fails. Always check the result separately when the value matters:

```bash
set -e
# This does NOT exit even if git log fails:
LAST_COMMIT=$(git log -1 --format=%H)   # subshell failure masked

# Safe approach: let the subshell run as a plain command first,
# then capture it — or check $? explicitly.
```

---

### set -u — Undefined Variables are Errors

```bash
set -u   # or: set -o nounset
```

Without `set -u`, referencing an unset variable silently expands to an empty string. The consequences range from wrong output to catastrophic data loss:

```bash
# Without set -u:
echo "$UNSET_VAR/config"    # prints: /config  (wrong)
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

```bash
set -u

DEPLOY_ENV="${DEPLOY_ENV:-staging}"          # default to staging
LOG_LEVEL="${LOG_LEVEL:-info}"
CONFIG_FILE="${CONFIG_FILE:?CONFIG_FILE must be set}"   # hard requirement
```

**`set -u` gotcha with arrays:** accessing an unset array or an unset array index triggers the error. A common workaround for optional array arguments:

```bash
set -u
EXTRA_ARGS=("${@:2}")    # capture args 2+ as array — empty if not provided
# Use "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" to safely expand possibly-empty arrays
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

**`pipefail` interaction with `grep`:** `grep` returns exit code 1 when it finds no matches. This is often correct behavior, not an error. Be explicit:

```bash
set -eo pipefail

# This exits the script if grep finds no matches:
journalctl -u nginx | grep "error"

# If "no matches" is acceptable, use || true or capture into a variable:
ERRORS=$(journalctl -u nginx | grep "error" || true)
[ -z "$ERRORS" ] && echo "No errors found"
```

---

### The Standard Header

Every production Bash script should start with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

Using `/usr/bin/env bash` instead of `/bin/bash` is more portable — it finds bash on `$PATH`, which matters on macOS, NixOS, and systems where bash isn't at `/bin/bash`.

Some teams extend this with:

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'   # safer word splitting: only newline and tab, not space
```

Changing `IFS` prevents word-splitting bugs on filenames or values that contain spaces. It's especially valuable in scripts that process file lists or user input.

---

### trap — Cleanup on Exit

`trap` registers a command or function to execute when the shell receives a signal or exits. The most important use in scripts is guaranteed cleanup:

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
| `HUP` | Terminal hangup (SIGHUP) |

**`trap` gotcha — `$?` in the trap handler:** inside an `EXIT` trap, `$?` holds the exit code that triggered the exit. Capture it immediately or it will be overwritten:

```bash
cleanup() {
    local exit_code=$?    # capture FIRST — any command below will overwrite $?
    rm -rf "$TMPDIR"
    if [ "$exit_code" -ne 0 ]; then
        echo "Script failed with exit code $exit_code" >&2
    fi
    exit "$exit_code"     # propagate the original exit code
}
trap cleanup EXIT
```

**Stacking traps — each `trap` call replaces the previous one for that signal.** To add behavior without losing existing cleanup, call prior functions from within the new trap:

```bash
cleanup_files() { rm -rf "$TMPDIR"; }
cleanup_lock()  { rm -f /var/run/myscript.lock; }

# Wrong: this replaces cleanup_files:
trap cleanup_lock EXIT

# Right: chain them:
cleanup_all() {
    cleanup_files
    cleanup_lock
}
trap cleanup_all EXIT
```

---

### Exit Codes

Exit codes are the universal interface between processes in Unix. Every command you run returns one.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General error (convention) |
| `2` | Misuse of shell command or bad arguments |
| `126` | Command found but not executable |
| `127` | Command not found |
| `128+n` | Script terminated by signal `n` (e.g., `130` = Ctrl+C = 128+2) |

**Checking exit codes — prefer `if` over `$?`:**

```bash
# Fragile: $? is overwritten by every command, including [
cp file.txt /backup/
if [ $? -ne 0 ]; then    # risky if you add any command between cp and this
    echo "Backup failed" >&2
    exit 1
fi

# Idiomatic: test the command directly
if ! cp file.txt /backup/; then
    echo "Backup failed" >&2
    exit 1
fi
```

**Propagating exit codes:** when a script is sourced or called from another script, its exit code matters. Always exit with a meaningful code, and never let a script that failed return 0:

```bash
# Always use 'exit $?' or just 'exit' at the end of a trap to preserve the code
# 'exit' with no argument exits with the code of the last command executed
```

---

### Meaningful Error Messages

Good error messages tell the operator *what failed*, *why*, and often *what to do next*. All error output goes to stderr (`>&2`) so it doesn't pollute stdout and can be captured separately.

```bash
# Minimal die() helper — used throughout production scripts
die() {
    echo "ERROR: $*" >&2
    exit 1
}

# die() with configurable exit code
die() {
    local exit_code="${1:-1}"
    shift
    echo "ERROR: $*" >&2
    exit "$exit_code"
}

# Usage:
[ -f "$CONFIG" ]    || die 1 "Config file not found: $CONFIG"
[ $# -ge 1 ]        || die 2 "Usage: $0 <environment>"
command -v docker   || die 127 "docker not installed or not on PATH"
```

**Include context in error messages:** the script name, the file or resource involved, and what was expected:

```bash
# Bad:
die "File not found"

# Good:
die "Expected config at $CONFIG_PATH — create it from config.example before deploying"
```

---

### Debugging

| Technique | Command | When to use |
|---|---|---|
| Trace execution | `set -x` / `bash -x script.sh` | Step through logic, see variable expansion |
| Syntax check only | `bash -n script.sh` | Catch parse errors without running |
| Verbose mode | `set -v` | Print each line before word-splitting |
| Check exit code | `echo $?` | After a specific command you suspect |
| Trace a section | `set -x; ...; set +x` | Reduce noise in long scripts |

```bash
#!/usr/bin/env bash
set -euo pipefail

# Trace only the risky section:
set -x
rsync -avz /src/ user@host:/dst/
set +x

echo "rsync completed"
```

**`$BASH_SOURCE`, `$LINENO`, and `$FUNCNAME`** are available in trap handlers and error functions, making it possible to produce stack-trace-style output:

```bash
err_report() {
    echo "Error on line $1 in $BASH_SOURCE" >&2
}
trap 'err_report $LINENO' ERR
```

---

## Examples

### Example 1: Robust Deployment Script with Rollback

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: ./deploy.sh <service> <version>
# Backs up the current deployment, deploys a new version,
# and rolls back automatically if anything fails.

SERVICE="${1:?Usage: $0 <service> <version>}"
VERSION="${2:?Usage: $0 <service> <version>}"

BACKUP_DIR="/opt/backups/${SERVICE}"
DEPLOY_DIR="/opt/apps/${SERVICE}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -d "$DEPLOY_DIR" ] || die "Deploy dir not found: $DEPLOY_DIR"
command -v rsync >/dev/null || die "rsync is required but not installed"

cleanup() {
    local exit_code=$?
    if [ "$exit_code" -ne 0 ]; then
        echo "Deployment failed (exit $exit_code) — attempting rollback..." >&2
        # Only roll back if we actually made a backup
        if [ -d "$BACKUP_PATH" ]; then
            rsync -a --delete "${BACKUP_PATH}/" "${DEPLOY_DIR}/"
            systemctl restart "$SERVICE" || true   # best-effort restart
            echo "Rollback complete" >&2
        else
            echo "No backup found at $BACKUP_PATH — manual intervention required" >&2
        fi
    fi
    exit "$exit_code"
}
trap cleanup EXIT

# Step 1: backup
mkdir -p "$BACKUP_PATH"
rsync -a "${DEPLOY_DIR}/" "${BACKUP_PATH}/"
echo "Backed up current deployment to $BACKUP_PATH"

# Step 2: deploy
systemctl stop "$SERVICE"
rsync -a --delete "/releases/${VERSION}/" "${DEPLOY_DIR}/"
systemctl start "$SERVICE"

# Step 3: health check — give the service 5 seconds to start
sleep 5
systemctl is-active --quiet "$SERVICE" || die "Service $SERVICE failed to start after deployment"

echo "Successfully deployed ${SERVICE}@${VERSION}"
```

**Verify it works:**
```bash
# Simulate a bad release by deploying a version that doesn't exist:
./deploy.sh myapp 9.9.9
# Expected: rsync fails, cleanup rolls back, exit code non-zero
echo "Exit code: $?"
```

---

### Example 2: Log Processing Pipeline with Full Error Handling

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: ./parse_errors.sh <logfile> [output_file]
# Extracts error lines from an application log,
# counts occurrences by error type, and writes a report.

LOGFILE="${1:?Usage: $0 <logfile> [output_file]}"
OUTFILE="${2:-/dev/stdout}"

die
---
title: Error Handling
module: bash
duration_min: 15
difficulty: intermediate
tags: [bash, error-handling, set-e, trap, exit-codes, pipefail]
exercises: 4
---

## Overview
Bash's default behavior is dangerous: it continues executing after errors. A failed `cp` in the middle of a deployment script doesn't stop the script — it just silently proceeds to the next line. `set -euo pipefail` and `trap` turn Bash into a language that fails fast and cleans up after itself.

## Concepts

### set -e — Exit on Error
```bash
set -e   # or: set -o errexit
```

With `set -e`, the shell exits immediately when any command returns a non-zero exit code. Without it:
```bash
# Without set -e — dangerous
mkdir /nonexistent/path     # fails silently
cp important.file /nonexistent/path   # also fails
echo "Done"   # still runs!
```

With `set -e`, the script stops at the first failure.

**Exception:** commands in `if`, `while`, `until`, `&&`/`||` chains are not subject to `set -e` — their exit codes are expected to vary.

```bash
set -e
if ! grep -q "nginx" /etc/services; then   # OK — inside if
    echo "nginx not in services"
fi

systemctl is-active nginx || true   # || true exempts a command from set -e
```

### set -u — Undefined Variables are Errors
```bash
set -u   # or: set -o nounset
```

Without it:
```bash
echo "$UNSET_VAR/important"   # silently expands to "/important" — wrong!
rm -rf "$UNSET_VAR/"          # becomes rm -rf / — catastrophic
```

With `set -u`, referencing an unset variable is an immediate error.

**Providing defaults safely:**
```bash
set -u
# ${VAR:-default} — use "default" if VAR is unset or empty
DIR="${DEPLOY_DIR:-/opt/app}"
# ${VAR-default} — use "default" only if VAR is unset (empty string is allowed)
```

### set -o pipefail — Catch Pipe Failures
```bash
set -o pipefail
```

Without it, `set -e` doesn't catch failures in the middle of a pipe:
```bash
# Without pipefail:
cat /nonexistent | grep "pattern"   # cat fails, but grep returns 1, so exit code = 1
# Actually: exit code of the pipeline = exit code of LAST command (grep)
# grep exits 1 (no match), which might mask cat's error OR succeed (grep found nothing)

# With pipefail:
# exit code = exit code of the RIGHTMOST command that failed
```

### The Standard Header
Put this at the top of every production script:
```bash
#!/usr/bin/env bash
set -euo pipefail
```

Some teams add:
```bash
set -x   # print each command before executing (useful for debugging)
```

### trap — Cleanup on Exit
`trap` registers a function to run when the script exits, regardless of why it exits (success, error, signal):

```bash
#!/usr/bin/env bash
set -euo pipefail

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT   # always clean up

# Work with temp files
cp important_file.txt "$TMPDIR/"
process_file "$TMPDIR/important_file.txt"
# $TMPDIR is removed automatically when script exits
```

**Trap signals:**
```bash
trap 'echo "Interrupted"; exit 130' INT TERM   # Ctrl+C or kill
trap 'echo "Script failed at line $LINENO"' ERR   # any error (with set -e)
trap cleanup EXIT   # cleanup function called on exit
```

**Multiple traps:**
```bash
cleanup() {
    local exit_code=$?
    rm -rf "$TMPDIR"
    if [ $exit_code -ne 0 ]; then
        echo "Script failed with exit code $exit_code" >&2
    fi
    exit $exit_code
}
trap cleanup EXIT
```

### Exit Codes
```bash
# Standard conventions:
# 0    success
# 1    general error
# 2    misuse of shell command / bad arguments
# 126  command found but not executable
# 127  command not found
# 128  invalid exit argument
# 130  script terminated by Ctrl+C (128 + signal 2)

# $? — exit code of last command
cp file.txt /backup/
if [ $? -ne 0 ]; then
    echo "Backup failed" >&2
    exit 1
fi

# Idiomatic: use if directly
if ! cp file.txt /backup/; then
    echo "Backup failed" >&2
    exit 1
fi
```

### Meaningful Error Messages
```bash
die() {
    echo "ERROR: $*" >&2
    exit 1
}

[ -f "$CONFIG" ] || die "Config file not found: $CONFIG"
[ $# -ge 1 ] || die "Usage: $0 <environment>"
```

### Debugging
```bash
# Print each command before executing
set -x
# Turn it off for specific sections
set +x

# Trace from a specific point
bash -x script.sh    # trace entire script
bash -n script.sh    # syntax check only (no execution)
```

## Examples

### Robust Deployment Script
```bash
#!/usr/bin/env bash
set -euo pipefail

SERVICE="$1"
VERSION="$2"

BACKUP_DIR="/opt/backups/$SERVICE"
DEPLOY_DIR="/opt/apps/$SERVICE"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

die() { echo "ERROR: $*" >&2; exit 1; }

# Validate
[ $# -eq 2 ] || die "Usage: $0 <service> <version>"
[ -d "$DEPLOY_DIR" ] || die "Deploy dir not found: $DEPLOY_DIR"

# Cleanup trap
cleanup() {
    local code=$?
    if [ $code -ne 0 ]; then
        echo "Deployment failed — rolling back..." >&2
        if [ -d "$BACKUP_DIR/$TIMESTAMP" ]; then
            cp -r "$BACKUP_DIR/$TIMESTAMP/." "$DEPLOY_DIR/"
            systemctl restart "$SERVICE" || true
        fi
    fi
}
trap cleanup EXIT

# Backup current
mkdir -p "$BACKUP_DIR/$TIMESTAMP"
cp -r "$DEPLOY_DIR/." "$BACKUP_DIR/$TIMESTAMP/"

# Deploy
systemctl stop "$SERVICE"
rsync -a --delete "/releases/$VERSION/" "$DEPLOY_DIR/"
systemctl start "$SERVICE"

# Verify
sleep 2
systemctl is-active --quiet "$SERVICE" || die "Service didn't start"

echo "Deployed $SERVICE@$VERSION successfully"
```

## Exercises

1. Write a script with `set -euo pipefail` that creates a temp directory, does some work (create a file, write some text), and guarantees cleanup with `trap`. Verify it works by checking the temp dir is gone after the script exits.
2. Rewrite this unsafe script to be safe: `LOGFILE=$1; grep "ERROR" $LOGFILE | awk '{print $5}' | sort | uniq -c`. Add proper error checking, quoting, and pipefail.
3. Write a `die()` function that accepts an exit code as the first argument and a message as the rest. It should print the message to stderr and exit with the given code.
4. Write a script that uses `trap ... ERR` to log the line number of any error that occurs (`$LINENO` is available in the trap handler), then intentionally trigger errors at different lines to test it.

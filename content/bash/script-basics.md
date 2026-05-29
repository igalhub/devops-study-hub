---
title: Script Writing Basics
module: bash
duration_min: 20
difficulty: beginner
tags: [bash, scripting, variables, loops, conditionals, functions]
exercises: 4
---

## Overview

Bash is the connective tissue of DevOps infrastructure. It's not a general-purpose language — it's a coordination layer. A bash script can wire together `curl`, `jq`, `systemctl`, `aws`, `kubectl`, and a dozen other tools into a single repeatable operation. That's its power: not computation, but orchestration. Every deployment pipeline, log rotation job, health check, and on-call runbook eventually bottoms out in shell commands. Understanding bash means understanding how those operations actually execute.

The language itself is small. Variables, conditionals, loops, functions, and a handful of special idioms cover 90% of real scripts. But bash has sharp edges — unquoted variables, silent failures, subshell scoping — that cause production incidents. The guiding principle of good bash is **defensive programming**: always quote variables, always handle failure, always validate inputs. Scripts that work in a dev environment and silently corrupt data in production are worse than no script at all.

In the DevOps toolchain, bash sits at the foundation. It runs inside Dockerfiles, CI/CD pipeline steps, Ansible tasks, Kubernetes init containers, and cron jobs. Even when you graduate to Python or Go for complex automation, bash remains the glue for invoking those tools. Getting it right pays dividends across every platform you'll work on.

## Concepts

### The Shebang, Strict Mode, and Permissions

The shebang line tells the kernel which interpreter to use. Without it, the script runs in whatever shell the user happens to be in — which may not be bash at all.

```bash
#!/bin/bash
# Hard path — only works if bash is at /bin/bash (true on Linux, not always on macOS/BSD)

#!/usr/bin/env bash
# Portable — finds bash in $PATH. Preferred for cross-platform scripts.
```

Immediately after the shebang, set strict mode:

```bash
set -euo pipefail
```

| Flag | Meaning | Why it matters |
|------|---------|----------------|
| `-e` | Exit on any unhandled non-zero return code | Prevents silent failures from propagating |
| `-u` | Treat unset variables as errors | Catches typos in variable names before they cause damage |
| `-o pipefail` | Pipeline fails if any command in it fails | Without this, `false \| true` exits 0 |

**`-e` gotcha:** it does not trigger inside `if` conditions, `while` conditions, or expressions after `&&`/`||`. That's by design — those contexts explicitly handle failure. But it means `set -e` is not a complete safety net. You still need explicit checks for critical operations.

Make the script executable and run it:

```bash
chmod +x deploy.sh
./deploy.sh

# Or invoke directly without chmod:
bash deploy.sh
```

**Prefer `./script.sh` over `bash script.sh`** in production. The former uses the shebang, so the script controls its own interpreter version. `bash script.sh` ignores the shebang entirely.

---

### Variables: Assignment, Quoting, and Scope

Variable assignment has no spaces around `=`. This is not a style choice — spaces are a syntax error.

```bash
NAME="nginx"           # string
PORT=8080              # number (still stored as string)
TIMESTAMP=$(date +%s)  # result of a command

# Double quotes: expand variables and command substitutions
MSG="Deploying $NAME on port $PORT"

# Single quotes: literal — nothing is expanded
LITERAL='Cost is $5, not $PORT'

# Brace syntax: required when the variable name is adjacent to other text
echo "${NAME}_backup"  # "nginx_backup" — without braces, bash looks for $NAME_backup
echo "$NAME_backup"    # empty or wrong — $NAME_backup is a different variable
```

**Always double-quote variable expansions.** Unquoted variables undergo word splitting (split on spaces/tabs/newlines) and glob expansion (a `*` expands to filenames). This causes bugs that only appear with certain inputs.

```bash
FILE="my report.pdf"

rm $FILE    # runs: rm my report.pdf — two arguments, tries to delete "my" and "report.pdf"
rm "$FILE"  # runs: rm "my report.pdf" — correct
```

**Variable scope:** all variables are global by default. Inside functions, use `local` to prevent collisions.

```bash
RESULT="outer"

my_func() {
    local RESULT="inner"  # does not overwrite the outer RESULT
    echo "$RESULT"        # prints "inner"
}

my_func
echo "$RESULT"            # prints "outer"
```

Bash also supports several parameter expansion forms for setting defaults and transforming values:

| Syntax | Behavior |
|--------|----------|
| `${VAR:-default}` | Use `default` if `VAR` is unset or empty |
| `${VAR:=default}` | Assign and use `default` if `VAR` is unset or empty |
| `${VAR:?message}` | Exit with `message` if `VAR` is unset or empty |
| `${VAR:+other}` | Use `other` if `VAR` is set and non-empty; otherwise empty |
| `${#VAR}` | Length of `VAR` |
| `${VAR%%pattern}` | Strip longest matching suffix |
| `${VAR##pattern}` | Strip longest matching prefix |

```bash
# Common DevOps patterns
ENV="${DEPLOY_ENV:-dev}"              # default to dev if not set in environment
LOG_DIR="${LOG_DIR:=/var/log/app}"    # set and use default
: "${REQUIRED_VAR:?REQUIRED_VAR must be set}"  # fail fast if missing
```

---

### Special Variables

These are set by bash itself and are read-only (or have special behavior on assignment):

| Variable | Value |
|----------|-------|
| `$0` | Script name (path as invoked) |
| `$1`, `$2`, ... | Positional arguments |
| `$@` | All positional arguments as separate words |
| `$*` | All positional arguments as a single word |
| `$#` | Number of positional arguments |
| `$?` | Exit code of the last command |
| `$$` | PID of the current shell |
| `$!` | PID of the last background process |
| `$SECONDS` | Seconds since the shell started |
| `$LINENO` | Current line number (useful in error messages) |

**`$@` vs `$*`:** always use `"$@"` when forwarding arguments to another command. `"$@"` preserves argument boundaries; `"$*"` collapses all args into one string.

```bash
# Correct: each argument passed as a separate word
run_command() {
    some_tool "$@"
}

run_command "file with spaces" other_arg
# some_tool receives two arguments: "file with spaces" and "other_arg"

# Wrong: collapses to one argument
run_command() {
    some_tool "$*"
}
# some_tool receives one argument: "file with spaces other_arg"
```

---

### Command Substitution and Exit Codes

Command substitution captures the stdout of a command into a variable:

```bash
DATE=$(date +%Y-%m-%d)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
FREE_MB=$(df -m / | awk 'NR==2{print $4}')
```

**The backtick syntax `` `command` `` is legacy.** Use `$(...)` — it's easier to read and can be nested.

Exit codes are the primary way commands signal success or failure:

```bash
cp source.txt dest.txt
if [ $? -ne 0 ]; then
    echo "Copy failed" >&2
    exit 1
fi

# Cleaner equivalent — use the command directly in the condition:
if ! cp source.txt dest.txt; then
    echo "Copy failed" >&2
    exit 1
fi
```

**Always send error messages to stderr** with `>&2`. This keeps stdout clean for piping and lets the caller separate diagnostic output from data output.

```bash
error() {
    echo "[ERROR] $*" >&2
}

info() {
    echo "[INFO] $*"
}
```

**Exit code conventions:**

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Misuse of shell or command (bad arguments) |
| `126` | Command found but not executable |
| `127` | Command not found |
| `128+N` | Fatal signal N received (e.g., `130` = Ctrl-C, SIGINT) |

Scripts should use `1` for runtime errors and `2` for usage errors (wrong arguments). This lets callers distinguish between "the script ran but something went wrong" and "the script was called incorrectly."

---

### Conditionals: `[ ]`, `[[ ]]`, and the Difference

Bash has two test syntaxes. Know when to use each:

| Feature | `[ ]` (POSIX `test`) | `[[ ]]` (bash built-in) |
|---------|---------------------|------------------------|
| Portability | Works in `sh`, `dash`, `ksh` | Bash only |
| Word splitting on variables | Yes — must quote | No — safe without quotes |
| Pattern matching | No | Yes: `[[ $VAR == *.log ]]` |
| Regex matching | No | Yes: `[[ $VAR =~ ^[0-9]+$ ]]` |
| `&&` / `\|\|` inside | Syntax error | Supported |
| `<` / `>` string comparison | Must escape: `\<` | No escaping needed |

**Prefer `[[ ]]` for all bash scripts.** Use `[ ]` only when writing POSIX sh that must run in minimal containers or BusyBox environments.

```bash
# Numeric comparisons — use -eq, -ne, -lt, -gt, -le, -ge (both syntaxes)
if [ "$COUNT" -gt 10 ]; then echo "high"; fi

# String comparison
if [[ "$ENV" == "production" ]]; then echo "prod"; fi

# Regex match
if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Valid semver"
fi

# File tests
[ -f "$FILE" ]    # exists and is a regular file
[ -d "$DIR" ]     # exists and is a directory
[ -r "$FILE" ]    # readable
[ -w "$FILE" ]    # writable
[ -x "$FILE" ]    # executable
[ -s "$FILE" ]    # exists and is non-empty
[ -z "$VAR" ]     # string is empty (zero length)
[ -n "$VAR" ]     # string is not empty

# Combining conditions
if [[ -f "$CONFIG" && -r "$CONFIG" ]]; then
    source "$CONFIG"
fi
```

`case` statements are cleaner than long `if/elif` chains when matching one variable against multiple patterns:

```bash
case "$ENV" in
    dev|development)
        echo "Development mode"
        DEBUG=true
        ;;
    staging)
        echo "Staging mode"
        ;;
    prod|production)
        echo "Production mode"
        DEBUG=false
        ;;
    *)
        echo "Unknown environment: $ENV" >&2
        exit 2
        ;;
esac
```

---

### Loops

```bash
# for — over a static list
for ENV in dev staging prod; do
    echo "Deploying to $ENV"
done

# for — over command output (safe pattern: read into array first)
mapfile -t SERVERS < <(aws ec2 describe-instances --query '...' --output text)
for SERVER in "${SERVERS[@]}"; do
    echo "Checking $SERVER"
done

# for — glob over files (safer than parsing ls)
for CONF in /etc/nginx/sites-enabled/*.conf; do
    [[ -f "$CONF" ]] || continue   # skip if glob matched nothing
    nginx -t -c "$CONF"
done

# while — condition-based retry loop
ATTEMPT=0
MAX=5
while [[ $ATTEMPT -lt $MAX ]]; do
    deploy && break
    ATTEMPT=$((ATTEMPT + 1))
    echo "Attempt $ATTEMPT failed, retrying in 2s..."
    sleep 2
done

if [[ $ATTEMPT -eq $MAX ]]; then
    echo "Deploy failed after $MAX attempts" >&2
    exit 1
fi

# while read — process a file line by line (the correct way)
while IFS= read -r LINE; do
    echo "Host: $LINE"
done < hosts.txt
```

**`while IFS= read -r LINE`** is the canonical pattern for reading files:
- `IFS=` prevents leading/trailing whitespace from being stripped
- `-r` prevents backslash escapes from being interpreted
- `< file` redirects the file into the loop without a subshell

**Subshell trap:** a pipeline like `cat file | while read LINE` runs the `while` loop in a subshell. Variables set inside the loop are invisible after it ends. Always use `while read ... done < file` or process substitution `< <(command)` to keep the loop in the current shell.

```bash
# Wrong — COUNT is lost after loop ends
cat hosts.txt | while IFS= read -r HOST; do
    COUNT=$((COUNT + 1))
done
echo "Processed $COUNT hosts"  # prints 0

# Correct — loop runs in current shell
COUNT=0
while IFS= read -r HOST; do
    COUNT=$((COUNT + 1))
done < hosts.txt
echo "Processed $COUNT hosts"  # correct
```

**`break` and `continue`:** `break` exits the innermost loop; `continue` skips to the next iteration. Both accept a numeric argument to affect outer loops: `break 2` exits two levels of nested loops.

---

### Functions

Functions are defined before they are called. There is no forward declaration.

```bash
# Both syntax forms are valid; the first is more portable
my_function() {
    local ARG1="$1"
    local ARG2="${2:-default_value}"  # default if $2 is unset or empty
    echo "Got: $ARG1 and $ARG2"
    return 0   # optional; last command's exit code is the implicit return value
}

# Call it
my_function "hello" "world"

# Capture its output
RESULT=$(my_function "hello")
```

Functions share the calling script's environment but have their own local scope with `local`. They return exit codes (0–255), not values. To return a string, echo it and capture with `$()`.

```bash
# Pattern: return data via stdout, status via exit code
get_latest_release() {
    local REPO="$1"
    local TAG
    TAG=$(curl -sf "https://api.github.com/repos/$REPO/releases/latest" \
        | jq -r '.tag_name') || return 1
    echo "$TAG"
}

if VERSION=$(get_latest_release "hashicorp/terraform"); then
    echo "Latest terraform: $VERSION"
else
    echo "Failed to fetch release" >&2
    exit 1
fi
```

**`local` must be on its own statement when capturing command output.** Combining declaration and assignment masks the exit code:

```bash
# Wrong — local always returns 0; the failing command's exit code is lost
local VERSION=$(failing_command)

# Correct — declare first, assign second
local VERSION
VERSION=$(failing_command) || return 1
```

---

### Argument Parsing

For scripts with more than two arguments, use a `while`/`case` loop for long options or `getopts` for POSIX-style short options:

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 << EOF
Usage: $0 --env <dev|staging|prod> --version <version> [--dry-run]

Options:
  --env       Target environment (required)
  --version   Version to deploy (required)
  --dry-run   Print actions without executing them
  --help      Show this message
EOF
    exit 2
}

ENV=""
VERSION=""
DRY_RUN=false

# Long-option parsing with while/case
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)
            ENV="$2"
            shift 2
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            ;;
    esac
done

# Validate required arguments
[[ -n "$ENV" && -n "$VERSION" ]] || usage
[[ "$ENV" =~ ^(dev|staging|prod)$ ]] || { echo "Invalid env: $ENV" >&2; exit 2; }
```

**`shift N`** removes the first N positional parameters. After `shift 2`, what was `$3` becomes `$1`. This is the standard way to consume paired `--flag value` arguments.

---

### Here Documents and String Templating

Here documents let you write multiline strings inline, with variable expansion:

```bash
# Variables expand inside EOF (no quotes around the delimiter)
cat > /etc/nginx/conf.d/app.conf << EOF
upstream backend {
    server 127.0.0.1:${APP_PORT};
    keepalive 32;
}

server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://backend;
    }
}
EOF

# Suppress variable expansion by quoting the delimiter
cat << 'EOF'
This is literal: $HOME and $(date) won't expand
EOF

# Indented here-doc (bash 4+): strip leading tabs with <<-
# Note: only strips TABs, not spaces — your editor must use real tabs here
if true; then
    cat <<- EOF
	This text can be indented with tabs
	and the tabs are stripped from output
	EOF
fi
```

Here documents write to stdout, so they can be piped, redirected to a file, or passed to a command. This makes them the standard approach for generating config files from templates in deployment scripts.

---

### Error Handling Patterns

`set -e` catches many failures but not all. Build explicit error handling for critical paths:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Trap: run a function on exit (always — even on error)
cleanup() {
    local EXIT_CODE=$?
    rm -f /tmp/deploy.lock
    if [[ $EXIT_CODE -ne 0 ]]; then
        echo "Script failed with exit code $EXIT_CODE" >&2
    fi
    exit "$EXIT_CODE"
}
trap cleanup EXIT

# Trap specific signals — restore terminal state or cancel background jobs
trap 'echo "Interrupted" >&2; exit 130' INT TERM

# Acquire a lock to prevent concurrent runs
LOCKFILE=/tmp/deploy.lock
if ! mkdir "$LOCKFILE" 2>/dev/null; then
    echo "Another deploy is running (lock: $LOCKFILE)" >&2
    exit 1
fi
# cleanup trap will remove the lock on exit
```

**Use `mkdir` for locking, not `touch`.** `mkdir` is atomic on local filesystems; `touch` is not. If two processes race to create a directory, only one succeeds.

**`trap` order matters:** only one trap per signal is active at a time. If you set a new `trap EXIT` inside a function, it replaces the original. Set all traps at the top of the script.

---

## Examples

### Example 1: Service Health Check with Alerting

Checks a list of services and sends a summary to a Slack webhook if any are down.

```bash
#!/usr/bin/env bash
set -euo pipefail

SERVICES=("nginx" "postgresql" "redis")
WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"   # injected from environment
FAILED=()

check_service() {
    local SVC="$1"
    # is-active exits 0 if active, non-zero otherwise; --quiet suppresses output
    systemctl is-active --quiet "$SVC"
}

notify_slack() {
    local MSG="$1"
    if [[ -z "$WEBHOOK_URL" ]]; then
        echo "WEBHOOK_URL not set — skipping notification" >&2
        return 0
    fi
    curl -sf -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"text\": \"$MSG\"}" > /dev/null
}

for SVC in "${SERVICES[@]}"; do
    if check_service "$SVC"; then
        echo "[OK]   $SVC"
    else
        echo "[FAIL] $SVC" >&2
        FAILED+=("$SVC")
    fi
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
    MSG=":red_circle: Services down on $(hostname): ${FAILED[*]}"
    notify_slack "$MSG"
    exit 1
fi

echo "All services healthy."
```

**Verify it works:**

```bash
# Stop a service and run the script
sudo systemctl stop redis
SLACK_WEBHOOK_URL="https://hooks.slack.com/..." ./health_check.sh
# Expected: "[FAIL] redis" on stderr, Slack message sent, exit code 1

sudo systemctl start redis
./health_check.sh
# Expected: three [OK] lines, exit code 0
```

---

### Example 2: Automated Deployment with Rollback

Deploys a Docker image to a target environment and rolls back if the health check fails.

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- Config ---
REGISTRY="registry.example.com"
APP="myapp"
HEALTH_URL="http://localhost:8080/health"
MAX_WAIT=30   # seconds to wait for health check to pass

usage() {
    echo "Usage: $0 --env <dev|staging|prod> --tag <image-tag>" >&2
    exit 2
}

ENV=""
TAG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)    ENV="$2"; shift 2 ;;
        --tag)    TAG="$2"; shift 2 ;;
        *)        usage ;;
    esac
done

[[ -n "$ENV" && -n "$TAG" ]] || usage

IMAGE="${REGISTRY}/${APP}:${TAG}"
CONTAINER_NAME="${APP}-${ENV}"

# --- Save previous image tag for rollback ---
PREVIOUS_TAG=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null \
    | awk -F: '{print $NF}') || PREVIOUS_TAG=""

rollback() {
    if [[ -n "$PREVIOUS_TAG" ]]; then
        echo "Rolling back to ${PREVIOUS_TAG}..." >&2
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker run -d --name "$CONTAINER_NAME" --rm \
            "${REGISTRY}/${APP}:${PREVIOUS_TAG}"
    fi
}

# --- Deploy ---
echo "Pulling ${IMAGE}..."
docker pull "$IMAGE"

echo "Stopping old container..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true

echo "Starting new container..."
docker run -d --name "$CONTAINER_NAME" --rm "$IMAGE"

# --- Health check with timeout ---
ELAPSED=0
until curl -sf "$HEALTH_URL" > /dev/null; do
    if [[ $ELAPSED -ge $MAX_WAIT ]]; then
        echo "Health check timed out after ${MAX_WAIT}s" >&2
        rollback
        exit 1
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
done

echo "Deploy complete: ${IMAGE} is healthy after ${ELAPSED}s."
```

**Verify it works:**

```bash
./deploy.sh --env staging --tag v1.4.2
# Watch docker ps to confirm container is running
# Introduce a bad image tag to test rollback:
./deploy.sh --env staging --tag broken-image
# Expected: health check fails, rollback to previous tag, exit code 1
```

---

### Example 3: Log Rotation and Archive Script

Rotates application logs, compresses files older than 7 days, and deletes archives older than 30 days.

```bash
#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${1:?Usage: $0 <log-dir>}"
COMPRESS_AFTER_DAYS=7
DELETE_AFTER_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

[[ -d "$LOG_DIR" ]] || { echo "Not a directory: $LOG_DIR" >&2; exit 1; }

echo "Rotating logs in $LOG_DIR"

# Compress uncompressed logs older than COMPRESS_AFTER_DAYS
find "$LOG_DIR" -maxdepth 1 -name "*.log" -mtime +"$COMPRESS_AFTER_DAYS" | \
while IFS= read -r LOGFILE; do
    echo "Compressing: $LOGFILE"
    gzip "$LOGFILE"
done

# Delete compressed archives older than DELETE_AFTER_DAYS
find "$LOG_DIR" -maxdepth 1 -name "*.log.gz" -mtime +"$DELETE_AFTER_DAYS" | \
while IFS= read -r ARCHIVE; do
    echo "Deleting: $ARCHIVE"
    rm -f "$ARCHIVE"
done

# Count remaining files for audit log
REMAINING=$(find "$LOG_DIR" -maxdepth 1 -name "*.log*" | wc -l)
echo "Done. $REMAINING log files remain in $LOG_DIR."
```

**Verify it works:**

```bash
# Create test log files with old mtimes
mkdir -p /tmp/testlogs
touch -d "10 days ago" /tmp/testlogs/app.log
touch -d "35 days ago" /tmp/testlogs/old.log.gz
touch /tmp/testlogs/recent.log

./rotate_logs.sh /tmp/testlogs
# Expected:
#   app.log → app.log.gz  (10 days old, compressed)
#   old.log.gz → deleted  (35 days old)
#   recent.log → untouched
ls /tmp/testlogs
```

---

### Example 4: Config File Generator with Validation

Generates environment-specific config files from a template, validating required variables before writing.

```bash
#!/usr/bin/env bash
set -euo pipefail

ENV="${1:?Usage: $0 <env>}"
OUTPUT_DIR="/etc/myapp"
TEMPLATE_DIR="/opt/myapp/templates"

# Required variables per environment — fail fast if any are missing
declare -A REQUIRED_VARS=(
    [APP_PORT]="TCP port the application listens on"
    [DB_HOST]="Database hostname"
    [DB_NAME]="Database name"
    [LOG_LEVEL]="Logging level (debug|info|warn|error)"
)

ERRORS=()
for VAR in "${!REQUIRED_VARS[@]}"; do
    if [[ -z "${!VAR:-}" ]]; then   # indirect expansion: value of the variable named $VAR
        ERRORS+=("  $VAR: ${REQUIRED_VARS[$VAR]}")
    fi
done

if [[ ${#ERRORS[@]} -gt 0 ]]; then
    echo "Missing required environment variables:" >&2
    printf '%s\n' "${ERRORS[@]}" >&2
    exit 2
fi

# Validate LOG_LEVEL is one of the allowed values
if [[ ! "$LOG_LEVEL" =~ ^(debug|info|warn|error)$ ]]; then
    echo "Invalid LOG_LEVEL: $LOG_LEVEL — must be debug|info|warn|error" >&2
    exit 2
fi

mkdir -p "$OUTPUT_DIR"

# Write config — variables expand because delimiter is unquoted
cat > "${OUTPUT_DIR}/app.conf" << EOF
# Generated by $0 on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Environment: ${ENV}

[server]
port = ${APP_PORT}

[database]
host = ${DB_HOST}
name = ${DB_NAME}

[logging]
level = ${LOG_LEVEL}
EOF

echo "Config written to ${OUTPUT_DIR}/app.conf"
```

**Verify it works:**

```bash
# With all vars set
export APP_PORT=8080 DB_HOST=db.internal DB_NAME=myapp LOG_LEVEL=info
./gen_config.sh production
cat /etc/myapp/app.conf

# With a missing var — should fail with a clear message
unset DB_HOST
./gen_config.sh production
# Expected: "Missing required environment variables: DB_HOST: ..." and exit 2
```

---

## Exercises

### Exercise 1: Fix a Broken Script

The following script is supposed to back up a directory and print how many files were backed up, but it has four bugs related to quoting, exit code handling, and variable scope. Find and fix them without changing the overall logic.

```bash
#!/bin/bash

SOURCE=/home/ubuntu/data
DEST=/mnt/backup/data-$(date +%Y%m%d)

mkdir $DEST

count=0
for FILE in $SOURCE/*; do
    cp $FILE $DEST/
    count=$((count + 1))
done | while read x; do true; done

echo "Backed up $count files to $DEST"

if [ $? != 0 ]; then
    echo "Backup failed"
fi
```

Once fixed, create test files in `~/data` with names that include spaces (e.g., `my document.txt`) and confirm the script handles them correctly.

---

### Exercise 2: Write a Retry Wrapper Function

Write a bash script containing a reusable function `retry` that accepts a max-attempts count and a command to run. It should:

1. Re-run the command up to N times on failure, with a 2-second delay between attempts.
2. Print the attempt number before each try.
3. Exit with code `0` if the command eventually succeeds, or code `1` after all attempts are exhausted.
4. Work correctly when the command itself has arguments (e.g., `retry 3 curl -sf https://example.com`).

Test it with a command that fails the first two times and succeeds on the third — you can simulate this with a counter file in `/tmp`.

---

### Exercise 3: Argument-Driven Deployment Script

Write a script called `fake_deploy.sh` that accepts `--env`, `--version`, and an optional `--dry-run` flag. Requirements:

1. Validate that `--env` is one of `dev`, `staging`, or `prod`.
2. Validate that `--version` matches semantic versioning (`X.Y.Z`).
3. In dry-run mode, print what would happen without executing anything.
4. In normal mode, simulate a deploy by `echo`-ing each step with a 1-second `sleep` between steps: pull image → stop old container → start new container → run health check.
5. Print usage and exit `2` if required arguments are missing or invalid.

Run it with valid arguments, invalid arguments, and `--dry-run` to confirm all branches work.

---

### Exercise 4: Log Parser with Summary Report

Write a script that reads an Nginx access log (or any space-delimited log) and produces a summary report. The log format is:

```
<ip> - - [<date>] "<method> <path> <protocol>" <status> <bytes>
```

The script must:

1. Accept the log file path as a positional argument; fail with a usage message if not provided or if the file doesn't exist.
2. Count total requests.
3. Count requests per HTTP status code (200, 301, 404, 500, etc.) and print them sorted by count, highest first.
4. Print the top 5 most-requested paths.
5. Use only `bash`, `awk`, `sort`, and `uniq` — no Python, no Perl.

Test with a sample log file you generate using a loop that writes fake log lines. Confirm the counts match what you wrote.

---

### Quick Checks

5. Assign `NAME="nginx"` and print the value with `_backup` appended using brace syntax. Write it as a one-liner with a semicolon.

```expected_output
nginx_backup
```

hint: Use `${VAR}` brace expansion — brace syntax lets you append a suffix directly without a space.
hint: Try `NAME="nginx"; echo "${NAME}_backup"`.

6. Print the result of 2 raised to the power of 10 using bash arithmetic expansion.

```expected_output
1024
```

hint: Bash arithmetic expansion uses `$(( ))` — look for the exponentiation operator `**` inside it.
hint: Try `echo $((2**10))`.
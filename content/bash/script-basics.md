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
```

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

# while — condition-based
ATTEMPT=0
MAX=5
while [[ $ATTEMPT -lt $MAX ]]; do
    deploy && break
    ATTEMPT=$((ATTEMPT + 1))
    echo "Attempt $ATTEMPT failed, retrying..."
    sleep 2
done

# while read — process a file line by line (the correct way)
while IFS= read -r LINE; do
    echo "Host: $LINE"
done < hosts.txt
```

**`while IFS= read -r LINE`** is the canonical pattern for reading files:
- `IFS=` prevents leading/trailing whitespace from being stripped
- `-r` prevents backslash escapes from being interpreted
- `< file` redirects the file into the loop without a subshell (important: a `| while read` loop runs in a subshell, so variables set inside it are lost after the loop)

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

---

### Argument Parsing

For scripts with more than two arguments, use `getopts` or a `while`/`case` loop:

```bash
#!/bin/bash
set -euo pipefail

usage() {
    echo "Usage: $0 --env <dev|staging|prod> --version <version>" >&2
    exit 2
}

ENV=""
VERSION=""

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
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            ;;
    esac
done

# Validate
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
# Note: only strips TABs, not spaces
if true; then
    cat <<- EOF
	This text can be indented with tabs
	and the tabs are stripped from output
	EOF
fi
```

---

### Error Handling Patterns

`set -e` catches many failures but not all. Build explicit error handling for critical paths:

```bash
# Trap: run a function on exit (always — even on error)
cleanup() {
    local EXIT_CODE=$?
    rm -f /tmp/deploy.lock
    if [[ $EXIT_CODE -ne 0 ]]; then
        echo "Script failed with exit code $EXIT_CODE" >&2
        # notify Slack, PagerDuty, etc.
    fi
}
trap cleanup EXIT

# Trap specific signals
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

---

## Examples

### Example 1: Service Health Check with Alerting

Checks a list of services and sends a summary to a webhook if any are down.

```bash
#!/bin/bash
set -euo pipefail

SERVICES=("nginx" "postgresql" "redis")
WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"   # set in environment
FAILED=()

check_service() {
    local SVC="$1"
    # is-active exits 0 if active, non-zero otherwise
    systemctl is-active --quiet "$SVC"
}

notify() {
    local MSG="$1"
    if [[ -z "$WEBHOOK_URL" ]]; then
        echo "WEBHOOK_URL not set — skipping notification" >&2
        return 0
    fi
    curl -sf -X POST "$WEBHOOK_URL" \
        -
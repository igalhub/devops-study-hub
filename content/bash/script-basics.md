---
title: Script Writing Basics
module: bash
duration_min: 20
difficulty: beginner
tags: [bash, scripting, variables, loops, conditionals, functions]
exercises: 4
---

## Overview
Bash scripts glue tools together — run a deployment, rotate a log, check a cluster's health. The core is simple: variables, conditionals, loops, and functions. Get those right and you can write any ops script. This lesson covers the fundamentals with real patterns, not toy examples.

## Concepts

### The Shebang and Permissions
```bash
#!/bin/bash
# First line tells the kernel which interpreter to use.
# #!/usr/bin/env bash is portable — works even if bash isn't in /bin
```

Make executable and run:
```bash
chmod +x script.sh
./script.sh
```

### Variables
```bash
NAME="nginx"           # no spaces around =
PORT=8080
GREETING="Hello, $NAME"    # double quotes expand variables
LITERAL='Hello, $NAME'     # single quotes don't expand

echo "$NAME"           # always quote variables — prevents word splitting
echo "${NAME}_backup"  # braces delimit variable name from surrounding text
```

**Always quote variables.** Unquoted variables split on whitespace and expand globs — this causes silent bugs with filenames containing spaces.

### Special Variables
```bash
$0          # script name
$1, $2 ...  # positional arguments
$@          # all arguments as separate words (quote it: "$@")
$#          # number of arguments
$?          # exit code of last command (0 = success)
$$          # current process PID
$!          # PID of last background job
```

### Command Substitution
```bash
DATE=$(date +%Y-%m-%d)
FILES=$(ls /etc/*.conf | wc -l)
HOSTNAME=$(hostname -f)

echo "Today is $DATE, found $FILES config files on $HOSTNAME"
```

### Arithmetic
```bash
COUNT=5
echo $((COUNT + 1))    # 6
echo $((COUNT * 2))    # 10
echo $((10 / 3))       # 3 (integer division)
echo $((10 % 3))       # 1 (modulo)

# Increment
COUNT=$((COUNT + 1))
(( COUNT++ ))          # also works
```

### Conditionals
```bash
# if / elif / else
if [ "$EXIT_CODE" -eq 0 ]; then
    echo "success"
elif [ "$EXIT_CODE" -eq 1 ]; then
    echo "error"
else
    echo "unknown: $EXIT_CODE"
fi

# Common test operators
[ -f "$FILE" ]        # file exists and is a regular file
[ -d "$DIR" ]         # directory exists
[ -z "$VAR" ]         # string is empty
[ -n "$VAR" ]         # string is not empty
[ "$A" = "$B" ]       # strings equal
[ "$A" != "$B" ]      # strings not equal
[ "$N" -eq 5 ]        # numbers equal (use -eq, -ne, -lt, -gt, -le, -ge)

# [[ ]] — bash-specific, safer for strings, supports && || patterns
if [[ "$ENV" == "prod" && "$DEPLOY" == "true" ]]; then
    echo "Deploying to production"
fi
```

### Loops
```bash
# for — iterate items
SERVERS="web01 web02 web03"
for SERVER in $SERVERS; do
    echo "Pinging $SERVER..."
    ping -c 1 "$SERVER"
done

# for — iterate files
for FILE in /etc/nginx/sites-enabled/*; do
    echo "Config: $FILE"
done

# while
COUNT=0
while [ $COUNT -lt 3 ]; do
    echo "Attempt $((COUNT + 1))"
    COUNT=$((COUNT + 1))
done

# C-style for
for (( i=0; i<5; i++ )); do
    echo "i=$i"
done
```

### Functions
```bash
# Define before calling
log() {
    echo "[$(date +%H:%M:%S)] $*"
}

check_service() {
    local SERVICE="$1"          # local — scoped to function
    systemctl is-active --quiet "$SERVICE"
    return $?                   # explicit return (optional — last exit code propagates)
}

log "Starting deployment"
if check_service nginx; then
    log "nginx is running"
else
    log "nginx is not running"
fi
```

`local` prevents variable name collisions between functions. Always use it for function-internal variables.

### Here Documents
```bash
# Multiline string without a file
cat << EOF
server {
    listen 80;
    server_name $HOSTNAME;
}
EOF

# Write to file
cat > /etc/nginx/conf.d/app.conf << EOF
upstream app {
    server 127.0.0.1:$PORT;
}
EOF
```

## Examples

### Deployment Script
```bash
#!/bin/bash
set -euo pipefail   # exit on error, undefined var, pipe failure

APP_DIR="/opt/myapp"
BACKUP_DIR="/opt/backups"
SERVICE="myapp"

log() { echo "[$(date +%T)] $*"; }

backup() {
    local TS
    TS=$(date +%Y%m%d-%H%M%S)
    log "Backing up to $BACKUP_DIR/$SERVICE-$TS.tar.gz"
    tar -czf "$BACKUP_DIR/$SERVICE-$TS.tar.gz" "$APP_DIR"
}

deploy() {
    local VERSION="$1"
    log "Deploying version $VERSION"
    systemctl stop "$SERVICE"
    cp -r "/releases/$VERSION/." "$APP_DIR/"
    systemctl start "$SERVICE"
    log "Deployed $VERSION"
}

# Validate arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <version>" >&2
    exit 1
fi

VERSION="$1"
backup
deploy "$VERSION"
log "Done"
```

### Wait for a Service
```bash
#!/bin/bash
wait_for() {
    local HOST="$1" PORT="$2" TIMEOUT="${3:-30}"
    local END=$((SECONDS + TIMEOUT))
    while [ $SECONDS -lt $END ]; do
        if nc -z "$HOST" "$PORT" 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}

if wait_for db.internal 5432 60; then
    echo "Database is up"
else
    echo "Timed out waiting for database" >&2
    exit 1
fi
```

## Exercises

1. Write a script that accepts a directory as an argument and prints the total size (in MB) of all `.log` files in it, recursively. Use `find` and `du`.
2. Write a function `retry <attempts> <delay> <command...>` that runs the command and retries up to `attempts` times with `delay` seconds between tries. Print the attempt number on each retry.
3. Write a script that loops over a list of hostnames (from a file, one per line, passed as an argument) and outputs `[UP] hostname` or `[DOWN] hostname` based on whether `ping -c 1` succeeds.
4. Write a deployment script that takes `--env` (dev/staging/prod) and `--version` as arguments, validates both, and prints what it would deploy. Exit with code 2 on bad arguments, 0 on success.

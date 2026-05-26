---
title: Pipes & Redirects
module: bash
duration_min: 10
difficulty: beginner
tags: [bash, pipes, redirects, stdin, stdout, stderr, tee]
exercises: 4
---

## Overview
Pipes and redirects are the foundation of Unix composability — small tools chained together to process data. Every DevOps script uses them. Understanding file descriptors 0, 1, and 2 (stdin, stdout, stderr) and how to route them is essential for writing scripts that work correctly in automated environments.

## Concepts

### File Descriptors
Every process has three standard streams:
| FD | Name | Default |
|----|------|---------|
| 0 | stdin | keyboard input |
| 1 | stdout | terminal output |
| 2 | stderr | terminal (errors) |

### Output Redirection
```bash
# Redirect stdout to file (overwrite)
ls -la > files.txt

# Append stdout to file
echo "new entry" >> access.log

# Redirect stderr to file
grep "ERROR" app.log 2> errors.txt

# Redirect stderr to same place as stdout
ls /nonexistent 2>&1 | grep "No such"

# Redirect both stdout and stderr to a file
command > output.txt 2>&1
command &> output.txt       # bash shorthand (same thing)

# Discard output
command > /dev/null          # discard stdout
command 2>/dev/null          # discard stderr
command &>/dev/null          # discard everything
```

**Order matters:** `2>&1 > file` is wrong — it redirects stderr to current stdout (terminal), then stdout to file. Use `> file 2>&1` or `&> file`.

### Input Redirection
```bash
# Feed file as stdin
grep "CRITICAL" < syslog.txt
mysql mydb < schema.sql

# Here-string (single line)
base64 <<< "hello world"

# Here-doc (multiline)
mysql mydb << SQL
  INSERT INTO events (msg) VALUES ('deploy started');
SQL
```

### Pipes
A pipe connects stdout of one command to stdin of the next:
```bash
# Count error lines in a log
grep "ERROR" /var/log/app.log | wc -l

# Find top 10 largest files
du -sh /var/log/* | sort -rh | head -10

# List listening ports, sort by port number
ss -tlnp | sort -k4 -t: -n

# Count unique IP addresses in an nginx access log
awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20
```

### tee — Write to File AND Continue the Pipe
```bash
# Log output while still seeing it on terminal
./deploy.sh | tee deploy.log

# Append
./deploy.sh | tee -a deploy.log

# Split output: one branch to file, continue piping
curl -s https://api.example.com/data | tee raw.json | jq '.results[]'
```

### Process Substitution
```bash
# Use a command's output as if it were a file
diff <(ssh host1 cat /etc/hosts) <(ssh host2 cat /etc/hosts)

# Feed two commands' outputs as files to a third
comm -13 <(sort file1.txt) <(sort file2.txt)   # lines only in file2
```

### Named Pipes (FIFOs)
Rarely needed but useful for inter-process communication:
```bash
mkfifo /tmp/mypipe
command1 > /tmp/mypipe &
command2 < /tmp/mypipe
rm /tmp/mypipe
```

### Combining Redirects in Scripts
```bash
#!/usr/bin/env bash
set -euo pipefail

LOG="/var/log/myapp/deploy.log"

# Log everything to file; errors also to stderr
exec > >(tee -a "$LOG") 2>&1

echo "Starting deployment..."    # goes to log + terminal
```

```bash
# Redirect only errors to a log, keep stdout clean
./build.sh 2>> errors.log

# Silence a specific command
noisy_command 2>/dev/null
```

## Examples

### Log Rotation Helper
```bash
#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/var/log/myapp"
KEEP=7   # keep last 7 days

find "$LOG_DIR" -name "*.log" -mtime +"$KEEP" -print0 | \
    xargs -0 rm -f

# Compress logs older than 1 day
find "$LOG_DIR" -name "*.log" -mtime +1 -not -name "*.gz" -print0 | \
    xargs -0 gzip -f
```

### Capture Both Streams
```bash
#!/usr/bin/env bash
# Run a command, capture stdout and stderr separately, check exit code

STDOUT=$(command 2>/tmp/stderr_$$)
EXIT=$?
STDERR=$(cat /tmp/stderr_$$; rm -f /tmp/stderr_$$)

if [ $EXIT -ne 0 ]; then
    echo "Command failed:" >&2
    echo "$STDERR" >&2
fi
```

## Exercises

1. Write a one-liner that finds all `.conf` files under `/etc`, prints their paths and line counts, sorts by line count descending, and shows the top 5.
2. Write a script that runs a command passed as arguments, captures its stdout to a variable and its stderr to another variable, and prints both labeled (without temp files — use process substitution).
3. Write a pipeline that reads `/var/log/auth.log` (or `/var/log/secure`), extracts lines containing "Failed password", counts occurrences per source IP, and outputs the top 10 sorted by count.
4. Use `tee` to write a script that runs a long command and simultaneously logs all output (stdout + stderr) to a timestamped file while still showing it on the terminal.

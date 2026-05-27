---
title: Pipes & Redirects
module: bash
duration_min: 10
difficulty: beginner
tags: [bash, pipes, redirects, stdin, stdout, stderr, tee]
exercises: 4
---

## Overview

Pipes and redirects are the foundation of Unix composability — the design philosophy that small, focused tools should be chainable into larger workflows. Instead of building monolithic programs, Unix provides primitives that let `grep`, `awk`, `sort`, `cut`, and hundreds of other utilities collaborate through shared data streams. For DevOps engineers, this is not an academic concept: every log parser, deployment script, health check, and CI pipeline step relies on correctly routing data between processes. Getting it wrong silently discards errors, breaks pipelines, or produces misleading output in automated environments where no human is watching.

The underlying mechanism is the file descriptor — a numbered handle that the kernel assigns to every open resource a process has. The three standard ones (stdin, stdout, stderr) are present in every process by default. Redirects rewire where those handles point; pipes connect one process's stdout directly to another's stdin through an in-kernel buffer. Because these are kernel-level abstractions, they work the same whether you are running a local script, a remote SSH command, or a container entrypoint — making them universally applicable across the DevOps toolchain.

In the broader DevOps context, pipes and redirects appear in: CI/CD pipeline scripts (capturing build output, separating errors from progress), log processing (extracting, filtering, and aggregating log streams), infrastructure automation (feeding configuration into tools like `mysql`, `kubectl`, or `terraform`), and observability workflows (tailing, parsing, and forwarding log data). Mastering them is a force multiplier for everything else you do in bash.

## Concepts

### File Descriptors

Every process inherits three open file descriptors from its parent:

| FD | Name   | Default destination | Typical use |
|----|--------|---------------------|-------------|
| 0  | stdin  | Keyboard / terminal | Input data, prompts |
| 1  | stdout | Terminal            | Normal output, results |
| 2  | stderr | Terminal            | Errors, warnings, diagnostics |

File descriptors are just integers. The kernel maps them to an underlying resource — a terminal, a file, a pipe, a socket, or `/dev/null`. Redirects change that mapping. When you write `> file`, you are telling the kernel: "for this process, file descriptor 1 should point to `file` instead of the terminal." The process itself calls `write(1, ...)` exactly as it always would — it has no idea the destination changed.

**Why stderr is separate from stdout:** Tools output results on stdout and diagnostics on stderr so that downstream consumers (other commands or files) receive clean data. If `grep` mixed its "no matches" message into its output stream, scripts that pipe grep's results into further processing would silently corrupt data. Always respect this convention in your own scripts: use `echo "error" >&2` for errors, not plain `echo`.

**File descriptors beyond 0/1/2:** Bash lets you open and use arbitrary FDs (3, 4, ...) with `exec`. This is useful in scripts that need to log to a file while also reading user input, or that maintain a long-lived connection. You will rarely need this at first, but knowing it exists prevents confusion when you see `>&3` in advanced scripts.

---

### Output Redirection

Redirection operators tell the shell where to send a file descriptor before the command runs.

```bash
# Overwrite stdout to a file (creates or truncates)
ls -la > files.txt

# Append stdout — never truncates
echo "$(date) deploy ok" >> deploy.log

# Redirect stderr only — stdout still goes to terminal
make 2> build_errors.txt

# Redirect stderr to wherever stdout currently points
ls /nonexistent 2>&1 | grep "No such"

# Redirect both stdout and stderr to the same file (two equivalent forms)
command > output.txt 2>&1   # POSIX-compatible
command &> output.txt       # bash shorthand — not available in sh

# Discard stdout (useful for commands run for side effects)
apt-get update > /dev/null

# Discard stderr (suppress error noise from expected failures)
rm -f /tmp/cache 2>/dev/null

# Discard everything (silent execution)
noisy_command &>/dev/null
```

**Order matters — this is the most common redirect mistake:**

```bash
# WRONG — redirects stderr to terminal (current stdout), then stdout to file
command 2>&1 > file.txt

# RIGHT — redirects stdout to file first, then stderr to wherever stdout now points (the file)
command > file.txt 2>&1
```

The shell processes redirects left to right. `2>&1` means "point FD 2 at whatever FD 1 currently points to." If you write `2>&1` before `> file`, FD 1 still points to the terminal at that moment, so stderr goes to the terminal. Then `> file` moves stdout to the file — but stderr is already wired to the old terminal target. Use `&>` to avoid this confusion entirely in bash scripts.

**Truncation on redirect open:** The `>` operator opens and truncates the file before the command runs. This means `sort file > file` will destroy `file` before `sort` reads it — you get an empty file. Use a temp file or `sponge` (from `moreutils`) when transforming a file in place.

---

### Input Redirection

Input redirection feeds a file (or inline text) into a command's stdin.

```bash
# Feed a file as stdin — functionally equivalent to: cat schema.sql | mysql mydb
mysql mydb < schema.sql

# Here-string: pass a single string as stdin
base64 <<< "hello world"
wc -w <<< "count these words"

# Here-document: multiline inline input; delimiter must appear alone on a line
mysql mydb << SQL
  CREATE TABLE IF NOT EXISTS events (
    id   INT AUTO_INCREMENT PRIMARY KEY,
    msg  TEXT NOT NULL,
    ts   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
SQL

# Indented here-doc (<<-): strips leading tabs (not spaces)
cat <<-MSG
	This line has a leading tab that will be stripped.
	So does this one.
MSG
```

**Here-doc quoting rules:** If the delimiter is unquoted (`<< SQL`), variable expansion and command substitution happen inside the body. Quote the delimiter (`<< 'SQL'`) to treat the body as a literal string — useful when the SQL or config content contains `$` signs you do not want expanded.

```bash
# Variables expand — $USER is substituted
cat << EOF
Deploying as $USER on $(hostname)
EOF

# Literal — $USER is printed as-is
cat << 'EOF'
No expansion: $USER $(hostname)
EOF
```

**`< file` vs `cat file |`:** Using `< file` avoids spawning an extra `cat` process. This is called "useless use of cat" (UUOC) — it is not catastrophic, but it adds process overhead and is considered poor style. Prefer `command < file` when the command accepts stdin directly.

---

### Pipes

A pipe (`|`) connects stdout of the left command to stdin of the right command through a kernel buffer. Both processes run concurrently — the left writes, the right reads, and the kernel manages flow control. This is fundamentally different from capturing output to a variable and then processing it; pipes are streaming and memory-efficient for large inputs.

```bash
# Count error lines in an application log
grep "ERROR" /var/log/app.log | wc -l

# Find the 10 largest directories under /var/log
du -sh /var/log/* | sort -rh | head -10

# Show listening TCP ports sorted numerically by port
ss -tlnp | awk '{print $4}' | sort -t: -k2 -n

# Top 20 IPs hitting an nginx server (common during incident triage)
awk '{print $1}' /var/log/nginx/access.log \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -20

# Extract HTTP status codes and count occurrences
awk '{print $9}' /var/log/nginx/access.log \
    | sort \
    | uniq -c \
    | sort -rn
```

**Exit codes in pipelines:** By default, a pipeline's exit code is the exit code of the *last* command. If `grep` finds nothing (exit 1) but `wc -l` succeeds (exit 0), the pipeline exits 0 — the error is invisible. This is dangerous in scripts using `set -e`.

```bash
# Fix: set pipefail so any failing command in the pipe propagates failure
set -o pipefail

# Now this will fail if grep exits non-zero
grep "PATTERN" file.log | wc -l
```

**`set -o pipefail` caveats:** `grep` exits 1 when it finds no matches (not an error in the traditional sense, but a non-zero exit). With `pipefail`, a grep-in-a-pipe that finds nothing will cause your script to exit if you also have `set -e`. Wrap such cases explicitly:

```bash
count=$(grep "PATTERN" file.log | wc -l || true)
```

**Pipes and subshells:** Each side of a pipe runs in a subshell. Variables set inside a pipe do not propagate to the parent shell.

```bash
count=0
grep "ERROR" app.log | while read -r line; do
    count=$((count + 1))   # modifies subshell's count, not parent's
done
echo "$count"  # prints 0 — this is a classic bash gotcha
```

Use process substitution or `mapfile` to avoid this when you need to accumulate results.

---

### tee — Write to File AND Continue the Pipe

`tee` reads stdin and writes it to both stdout and one or more files simultaneously. It is named after the T-junction pipe fitting. It is indispensable for logging: you want to capture a command's output to a file for later review while still seeing it in real time.

```bash
# Show output on terminal AND save to file
./deploy.sh | tee deploy.log

# Append to file instead of overwriting
./deploy.sh | tee -a deploy.log

# Write to multiple files at once
command | tee file1.log file2.log > /dev/null   # suppress terminal output

# Branch a pipeline: save raw data and continue processing
curl -s https://api.example.com/metrics \
    | tee raw_metrics.json \
    | jq '.[] | select(.value > 100)'
```

**Capturing stderr through tee:** `tee` only sees what arrives on its stdin, which is connected to the previous command's stdout. To capture stderr as well, redirect stderr into stdout before piping:

```bash
# Merge stderr into stdout before tee sees it
./deploy.sh 2>&1 | tee -a deploy.log
```

**Using `tee` as a script-wide logger:** The `exec` builtin can rewire the script's own file descriptors, routing all subsequent output through `tee` without annotating every `echo`:

```bash
#!/usr/bin/env bash
set -euo pipefail

LOGFILE="/var/log/myapp/deploy-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$(dirname "$LOGFILE")"

# From this point on, stdout AND stderr go to terminal and logfile
exec > >(tee -a "$LOGFILE") 2>&1

echo "Deployment started at $(date)"
# ... rest of script — all output is automatically logged
```

**`> >(tee ...)` explained:** `>(tee -a "$LOGFILE")` is process substitution (see below) — it creates a background process running `tee` and returns a path like `/dev/fd/63`. `exec > /dev/fd/63` points the script's stdout at that pipe. This is the canonical pattern for script-wide logging.

---

### Process Substitution

Process substitution lets you use a command's output as if it were a file. Bash creates a named pipe or `/dev/fd/N` handle and passes its path to the outer command. This is useful when a command requires file arguments and does not accept stdin, or when you need to compare two live data streams.

```bash
# Compare /etc/hosts on two different servers
diff <(ssh web1 cat /etc/hosts) <(ssh web2 cat /etc/hosts)

# Find lines present in file2 but not file1 (both must be sorted)
comm -13 <(sort file1.txt) <(sort file2.txt)

# Compare current package list against a baseline
diff <(dpkg --get-selections | sort) <(sort baseline_packages.txt)

# Merge two sorted log files by timestamp (both already sorted)
sort -m <(grep "ERROR" app1.log) <(grep "ERROR" app2.log)
```

**`<(...)` vs `$(...)` vs `|`:**

| Form | What it produces | Use when |
|------|-----------------|----------|
| `$(cmd)` | String (captured output) | You need the result as a variable or inline value |
| `\| cmd` | Pipe to next command's stdin | Single linear pipeline |
| `<(cmd)` | File-like path to command's output | Command needs a filename, or you need two inputs |
| `>(cmd)` | File-like path to command's stdin | Command needs a filename to write to |

**Process substitution is bash-specific.** It does not work in POSIX `sh`. If your shebang is `#!/bin/sh`, use temp files instead. Always use `#!/usr/bin/env bash` when you need this feature.

---

### Named Pipes (FIFOs)

A FIFO (First In, First Out) is a special file that acts like a pipe but has a name in the filesystem. It allows unrelated processes — even ones started at different times — to communicate through a common path.

```bash
# Create a named pipe
mkfifo /tmp/logpipe

# Writer: send data into the FIFO (runs in background)
tail -f /var/log/app.log > /tmp/logpipe &

# Reader: consume from the FIFO
grep --line-buffered "ERROR" < /tmp/logpipe >> /tmp/errors.log

# Clean up
rm /tmp/logpipe
```

FIFOs block: a writer blocks until a reader opens the other end, and vice versa. This makes them a natural synchronization primitive.

**When to use FIFOs vs pipes:** Use anonymous pipes (`|`) for linear, single-script pipelines. Use FIFOs when: two separate processes need to communicate, you need to feed the same data stream to a process that cannot be expressed as a pipeline, or you are building a simple producer/consumer system in bash. In most DevOps scripts, process substitution covers the use cases where you might reach for FIFOs.

---

### Combining Redirects in Scripts

Real scripts combine multiple redirection techniques. Here are the patterns you will encounter most often:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Pattern 1: Separate stdout and stderr to different files
./build.sh > build_output.txt 2> build_errors.txt

# Pattern 2: Capture stdout to variable, let stderr pass through to terminal
output=$(./check_health.sh)   # stderr still visible; only stdout captured

# Pattern 3: Capture stdout, discard stderr
output=$(./noisy_command.sh 2>/dev/null)

# Pattern 4: Capture stdout to variable AND show it on terminal
output=$(./deploy.sh | tee /dev/tty)   # /dev/tty is always the terminal

# Pattern 5: Redirect only errors to a log, keep stdout clean for downstream
./lint.sh 2>> /var/log/lint_errors.log | jq .

# Pattern 6: Run a background job, redirect its streams, capture its PID
./long_job.sh > /tmp/job.out 2>&1 &
JOB_PID=$!
echo "Job running as PID $JOB_PID"
wait $JOB_PID && echo "Job succeeded" || echo "Job failed"
```

**Capturing stdout AND stderr into separate variables (without temp files):**

```bash
# Uses process substitution to avoid temp files
{
    IFS=$'\n' read -r -d '' STDERR
    IFS=$'\n' read -r -d '' STDOUT
} < <(
    { stdout=$(./command.sh); echo "$stdout"; } 2>&1 1>&3 3>&1
)
```

This pattern is complex. In practice, using a temp file for stderr is more readable and just as correct. Reserve variable capture tricks for situations where temp files are truly unavailable.

---

## Examples

### Example
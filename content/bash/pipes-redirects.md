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

---

## Concepts

### File Descriptors

Every process inherits three open file descriptors from its parent:

| FD | Name   | Default destination | Typical use |
|----|--------|---------------------|-------------|
| 0  | stdin  | Keyboard / terminal | Input data, prompts |
| 1  | stdout | Terminal            | Normal output, results |
| 2  | stderr | Terminal            | Errors, warnings, diagnostics |

File descriptors are just integers. The kernel maps them to an underlying resource — a terminal, a file, a pipe, a socket, or `/dev/null`. Redirects change that mapping. When you write `> file`, you are telling the kernel: "for this process, file descriptor 1 should point to `file` instead of the terminal." The process itself calls `write(1, ...)` exactly as it always would — it has no idea the destination changed.

**Why stderr is separate from stdout:** Tools output results on stdout and diagnostics on stderr so that downstream consumers (other commands or files) receive clean data. If `grep` mixed its "no matches" message into its output stream, scripts that pipe grep's results into further processing would silently corrupt data. Always respect this convention in your own scripts: use `echo "error message" >&2` for errors, not plain `echo`.

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
command > output.txt 2>&1   # POSIX-compatible — works in sh and bash
command &> output.txt       # bash shorthand — not available in /bin/sh

# Discard stdout (useful for commands run purely for side effects)
apt-get update > /dev/null

# Discard stderr (suppress error noise from expected failures)
rm -f /tmp/cache 2>/dev/null

# Discard everything (completely silent execution)
noisy_command &>/dev/null
```

**Order matters — this is the most common redirect mistake:**

```bash
# WRONG — redirects stderr to terminal (current stdout), THEN moves stdout to file
# Result: stderr still goes to terminal, stdout goes to file
command 2>&1 > file.txt

# RIGHT — redirects stdout to file first, then stderr to wherever stdout now points
# Result: both stdout and stderr go to file
command > file.txt 2>&1
```

The shell processes redirects left to right. `2>&1` means "point FD 2 at whatever FD 1 currently points to *right now*." If you write `2>&1` before `> file`, FD 1 still points to the terminal at that moment, so stderr goes to the terminal. Use `&>` to avoid this confusion entirely in bash scripts.

**Truncation on redirect open:** The `>` operator opens and truncates the file before the command runs. This means `sort file > file` will destroy the file's contents before `sort` reads it — you get an empty output file. Use a temp file or `sponge` (from `moreutils`) when transforming a file in place:

```bash
# Safe in-place sort using a temp file
sort file.txt > file.txt.tmp && mv file.txt.tmp file.txt

# Or with sponge — buffers entire input before writing
sort file.txt | sponge file.txt
```

---

### Input Redirection

Input redirection feeds a file (or inline text) into a command's stdin.

```bash
# Feed a file as stdin — functionally equivalent to: cat schema.sql | mysql mydb
mysql mydb < schema.sql

# Here-string: pass a single string as stdin (no file needed)
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

# Indented here-doc (<<-): strips leading tabs (not spaces) for readable scripts
cat <<-MSG
	This line has a leading tab that will be stripped.
	So does this one.
MSG
```

**Here-doc quoting rules:** If the delimiter is unquoted (`<< EOF`), variable expansion and command substitution happen inside the body. Quote the delimiter (`<< 'EOF'`) to treat the body as a literal string — critical when heredoc content contains `$` signs you do not want expanded (SQL queries, Kubernetes YAML, Terraform configs):

```bash
# Variables expand — $USER and $(hostname) are substituted at runtime
cat << EOF
Deploying as $USER on $(hostname) at $(date)
EOF

# Literal — $USER is printed as-is, no substitution occurs
cat << 'EOF'
No expansion: $USER $(hostname)
This is useful for generating scripts that contain their own variables.
EOF
```

**`< file` vs `cat file |`:** Using `< file` avoids spawning an extra `cat` process and is called avoiding "useless use of cat" (UUOC). It is not catastrophic, but adds process overhead and is considered poor style. Prefer `command < file` when the command accepts stdin directly.

---

### Pipes

A pipe (`|`) connects stdout of the left command to stdin of the right command through a kernel buffer. Both processes run concurrently — the left writes, the right reads, and the kernel manages flow control. This is fundamentally different from capturing output to a variable and processing it; pipes are streaming and memory-efficient for large inputs.

```bash
# Count error lines in an application log
grep "ERROR" /var/log/app.log | wc -l

# Find the 10 largest directories under /var/log
du -sh /var/log/* | sort -rh | head -10

# Show listening TCP ports sorted numerically
ss -tlnp | awk '{print $4}' | sort -t: -k2 -n

# Top 20 IPs hitting an nginx server (common during incident triage)
awk '{print $1}' /var/log/nginx/access.log \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -20

# Count HTTP status code distribution from nginx access log
awk '{print $9}' /var/log/nginx/access.log \
    | sort \
    | uniq -c \
    | sort -rn
```

**Exit codes in pipelines:** By default, a pipeline's exit code is the exit code of the *last* command only. If `grep` finds nothing (exit 1) but `wc -l` succeeds (exit 0), the pipeline exits 0 — the upstream failure is invisible. This is dangerous in scripts using `set -e`.

```bash
# Default behavior — pipeline exit code = exit code of wc -l (0), grep failure ignored
grep "PATTERN" file.log | wc -l
echo $?   # prints 0 even if grep found nothing

# Fix: set pipefail — pipeline fails if ANY command in it fails
set -o pipefail

# Now the pipeline exits non-zero if grep exits non-zero
grep "PATTERN" file.log | wc -l
```

**`set -o pipefail` interaction with grep:** `grep` exits 1 when it finds no matches — not a program error, but a non-zero exit. With `pipefail` and `set -e` both active, a zero-match grep inside a pipe will abort your script. Handle this explicitly when zero matches is a valid outcome:

```bash
# || true prevents a no-match from aborting the script
count=$(grep "PATTERN" file.log | wc -l || true)
echo "Found $count matches"
```

**Pipes and subshells:** Each side of a pipe runs in a subshell. Variables set inside a pipe stage do not propagate to the parent shell — this is one of the most common bash bugs in production scripts:

```bash
count=0
grep "ERROR" app.log | while read -r line; do
    count=$((count + 1))   # modifies the subshell's copy of count, not the parent's
done
echo "$count"  # always prints 0 — the subshell's changes are discarded

# Fix: use process substitution to avoid the subshell on the reading side
count=0
while read -r line; do
    count=$((count + 1))
done < <(grep "ERROR" app.log)
echo "$count"  # correctly prints the error count
```

---

### tee — Write to File AND Continue the Pipe

`tee` reads stdin and writes it to both stdout and one or more files simultaneously. It is named after the T-junction pipe fitting. It is indispensable when you want to capture output to a file for later review while still seeing it in real time — or when you need to branch a pipeline.

```bash
# Show output on terminal AND save to file
./deploy.sh | tee deploy.log

# Append to file instead of overwriting (safe for ongoing logs)
./deploy.sh | tee -a deploy.log

# Write to multiple files simultaneously, suppress terminal output
command | tee file1.log file2.log > /dev/null

# Branch a pipeline: save raw API response AND continue processing it
curl -s https://api.example.com/metrics \
    | tee raw_metrics.json \
    | jq '.[] | select(.value > 100)'
```

**Capturing stderr through tee:** `tee` only sees what arrives on its stdin, which is connected to the previous command's stdout. To capture stderr as well, merge it into stdout before the pipe:

```bash
# Without 2>&1: stderr bypasses tee and goes directly to terminal, not the log
./deploy.sh | tee -a deploy.log          # stderr missing from log

# With 2>&1: both streams are captured
./deploy.sh 2>&1 | tee -a deploy.log     # stderr and stdout both in log
```

**Using `tee` as a script-wide logger:** The `exec` builtin can rewire the script's own file descriptors, routing all subsequent output through `tee` without annotating every `echo`:

```bash
#!/usr/bin/env bash
set -euo pipefail

LOGFILE="/var/log/myapp/deploy-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$(dirname "$LOGFILE")"

# From this point on, all stdout AND stderr go to terminal AND logfile
exec > >(tee -a "$LOGFILE") 2>&1

echo "Deployment started at $(date)"
# All subsequent output — including errors — is automatically logged
```

**`> >(tee ...)` explained:** `>(tee -a "$LOGFILE")` is process substitution — bash creates a background `tee` process and returns a path like `/dev/fd/63`. `exec > /dev/fd/63` then points the script's stdout at that pipe input. This is the canonical pattern for adding logging to an existing script without modifying every output statement.

---

### Process Substitution

Process substitution lets you use a command's output as if it were a file. Bash creates a named pipe or `/dev/fd/N` handle and passes its path to the outer command. This is useful when a command requires filename arguments and does not accept stdin, or when you need to feed two live data streams into a command that expects two files.

```bash
# Compare /etc/hosts across two servers without creating temp files
diff <(ssh web1 cat /etc/hosts) <(ssh web2 cat /etc/hosts)

# Find lines present in file2 but not file1 (both must be sorted)
comm -13 <(sort file1.txt) <(sort file2.txt)

# Compare current installed packages against a known-good baseline
diff <(dpkg --get-selections | sort) <(sort baseline_packages.txt)

# Merge two sorted error logs by timestamp
sort -m <(grep "ERROR" app1.log) <(grep "ERROR" app2.log)
```

**`<(...)` vs `$(...)` vs `|` — choosing the right form:**

| Form | What it produces | Use when |
|------|-----------------|----------|
| `$(cmd)` | String (captured output) | You need the result as a variable or inline argument |
| `\| cmd` | Pipe connected to next command's stdin | Single linear pipeline, one data stream |
| `<(cmd)` | File-like path to command's output stream | Command needs a filename, or you need two input streams |
| `>(cmd)` | File-like path to command's input stream | Command needs a filename to write output to |

**Process substitution is bash-specific.** It does not work in POSIX `sh`. If portability matters and your shebang is `#!/bin/sh`, use temp files with `mktemp` instead. Always use `#!/usr/bin/env bash` when you need process substitution.

---

### Named Pipes (FIFOs)

A FIFO (First In, First Out) is a special file that acts like a pipe but has a name in the filesystem. It allows unrelated processes — even ones started at different times — to communicate through a common path, which anonymous pipes cannot do.

```bash
# Create a named pipe
mkfifo /tmp/logpipe

# Writer: send log data into the FIFO (runs in background)
tail -f /var/log/app.log > /tmp/logpipe &

# Reader: consume from the FIFO and filter
grep --line-buffered "ERROR" < /tmp/logpipe >> /tmp/errors.log

# Clean up when done
rm /tmp/logpipe
```

FIFOs block: a writer blocks until a reader opens the other end, and vice versa. This makes them a natural synchronization primitive for producer/consumer patterns.

**When to use FIFOs vs anonymous pipes:**

| Scenario | Use |
|----------|-----|
| Linear single-script pipeline | Anonymous pipe (`\|`) |
| Two unrelated processes communicating | FIFO (`mkfifo`) |
| Command needs a filename, not stdin | Process substitution `<(...)` |
| Persistent cross-session channel | FIFO |

In most DevOps scripts, process substitution covers the use cases where you might otherwise reach for FIFOs. Reserve FIFOs for situations involving separate processes that cannot be expressed as a single bash pipeline.

---

### Combining Redirects in Scripts

Real scripts combine multiple redirection techniques. These are the patterns you will encounter and write most often:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Pattern 1: Separate stdout and stderr to different files
./build.sh > build_output.txt 2> build_errors.txt

# Pattern 2: Capture stdout to variable; let stderr pass through to terminal
output=$(./check_health.sh)   # stderr still visible to operator; only stdout captured

# Pattern 3: Capture stdout, silently discard stderr
output=$(./noisy_command.sh 2>/dev/null)

# Pattern 4: Capture stdout to variable AND show it on terminal simultaneously
output=$(./deploy.sh | tee /dev/tty)   # /dev/tty always refers to the real terminal

# Pattern 5: Pipe clean stdout downstream, append errors to a log file
./lint.sh 2>> /var/log/lint_errors.log | jq .

# Pattern 6: Start background job with redirected streams, then wait on it
./long_job.sh > /tmp/job.out 2>&1 &
JOB_PID=$!
echo "Job running as PID $JOB_PID, output in /tmp/job.out"
wait "$JOB_PID" && echo "Job succeeded" || echo "Job failed with code $?"
```

**Always pair `set -euo pipefail` with deliberate error handling** — the combination of `-e` (exit on error), `-u` (exit on undefined variable), and `-o pipefail` (fail on pipe errors) catches the majority of silent failure modes that plague production scripts.

---

## Examples

### Example 1: Parsing Nginx Access Logs During an Incident

**Scenario:** An alert fires indicating elevated 5xx error rates. You need to quickly identify which endpoints and client IPs are generating errors from a live log file.

```bash
#!/usr/bin/env bash
# incident-triage.sh — run against a live or archived nginx access log
# Usage: ./incident-triage.sh /var/log/nginx/access.log

set -euo pipefail

LOGFILE="${1:?Usage: $0 <logfile>}"
REPORT="/tmp/incident-report-$(date +%Y%m%d-%H%M%S).txt"

echo "=== Incident Triage Report: $(date) ===" | tee "$REPORT"
echo "Log file: $LOGFILE" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# Extract only 5xx responses (field 9 in combined log format is the status code)
echo "--- Top 5xx endpoints (method + URI) ---" | tee -a "$REPORT"
awk '$9 ~ /^5/ {print $6, $7}' "$LOGFILE" \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -20 \
    | tee -a "$REPORT"

echo "" | tee -a "$REPORT"

# Find the client IPs generating the most 5xx errors
echo "--- Top client IPs generating 5xx errors ---" | tee -a "$REPORT"
awk '$9 ~ /^5/ {print $1}' "$LOGFILE" \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -10 \
    | tee -a "$REPORT"

echo "" | tee -a "$REPORT"

# Count total 5xx vs total requests for a quick error rate
total=$(wc -l < "$LOGFILE")
errors=$(awk '$9 ~ /^5/' "$LOGFILE" | wc -l || true)
echo "--- Summary ---" | tee -a "$REPORT"
echo "Total requests : $total" | tee -a "$REPORT"
echo "5xx errors     : $errors" | tee -a "$REPORT"

echo ""
echo "Full report saved to: $REPORT"
```

**Verify it worked:**
```bash
chmod +x incident-triage.sh
./incident-triage.sh /var/log/nginx/access.log

# Check the report file was created and has content
wc -l /tmp/incident-report-*.txt
```

---

### Example 2: Deployment Script with Full Audit Logging

**Scenario:** A deployment script that logs everything — stdout and stderr — to a timestamped file while still showing output to the operator in real time. On failure, the log file path is printed for post-mortem review.

```bash
#!/usr/bin/env bash
# deploy.sh — deploys a Docker image and logs all output
set -euo pipefail

APP="${1:?Usage: $0 <app-name>}"
IMAGE_TAG="${2:?Usage: $0 <app-name> <image-tag>}"
LOGDIR="/var/log/deploys"
LOGFILE="${LOGDIR}/${APP}-$(date +%Y%m%d-%H%M%S).log"

mkdir -p "$LOGDIR"

# Wire all subsequent stdout and stderr to both terminal and logfile
exec > >(tee -a "$LOGFILE") 2>&1

echo "[$(date)] Starting deployment: $APP @ $IMAGE_TAG"

# Pull the image and capture any pull errors
echo "[$(date)] Pulling image..."
docker pull "$IMAGE_TAG"

# Rolling update — stderr from kubectl goes to log too
echo "[$(date)] Applying rollout..."
kubectl set image "deployment/$APP" "$APP=$IMAGE_TAG" --record

# Wait for rollout to complete (times out after 3 minutes)
echo "[$(date)] Waiting for rollout to complete..."
kubectl rollout status "deployment/$APP" --timeout=3m

echo "[$(date)] Deployment succeeded."
echo "[$(date)] Log saved to: $LOGFILE"
```

**Verify it worked:**
```bash
# Run the deployment
./deploy.sh my-api registry.example.com/my-api:v1.2.3

# Confirm the log file was created and contains both stdout and any errors
ls -lh /var/log/deploys/
tail -20 /var/log/deploys/my-api-*.log

# Simulate a failure and confirm it was captured in the log
kubectl set image deployment/nonexistent foo=bar:latest 2>&1 || true
grep "Error\|error\|failed" /var/log/deploys/my-api-*.log
```

---

### Example 3: Feeding Dynamic Configuration into a Running Container

**Scenario:** You need to apply a SQL schema migration to a MySQL container using a here-document, without writing a temporary SQL file to disk. The schema body contains environment variables that should be expanded at runtime.

```bash
#!/usr/bin/env bash
# migrate.sh — applies a schema migration using a here-document
set -euo pipefail

DB_HOST="${DB_HOST:?DB_HOST not set}"
DB_NAME="${DB_NAME:?DB_NAME not set}"
DB_USER="${DB_USER:?DB_USER not set}"
DB_PASS="${DB_PASS:?DB_PASS not set}"
APP_ENV="${APP_ENV:-production}"

echo "Applying migration to $DB_NAME on $DB_HOST (env: $APP_ENV)..."

# The heredoc delimiter is unquoted, so $APP_ENV expands at script runtime.
# The resulting SQL is piped directly into mysql — no temp file needed.
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" << SQL
  -- Migration applied by: $USER at $(date)
  -- Environment: $APP_ENV

  CREATE TABLE IF NOT EXISTS feature_flags (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    flag_name   VARCHAR(128) NOT NULL UNIQUE,
    enabled     TINYINT(1)   NOT NULL DEFAULT 0,
    environment VARCHAR(64)  NOT NULL DEFAULT '$APP_ENV',
    updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );

  INSERT IGNORE INTO feature_flags (flag_name, environment)
  VALUES ('new_dashboard', '$APP_ENV'),
         ('beta_api',      '$APP_ENV');
SQL

echo "Migration complete."
```

**Verify it worked:**
```bash
export DB_HOST=localhost DB_NAME=myapp DB_USER=root DB_PASS=secret APP_ENV=staging
./migrate.sh

# Confirm the table and rows exist
mysql -h localhost -u root -psecret myapp -e "SELECT * FROM feature_flags;"
```

---

### Example 4: Comparing Live Kubernetes State Against a Declared Baseline

**Scenario:** During a compliance check, you want to confirm that the set of running pods in a namespace matches a known-good baseline recorded last week, and output only the differences.

```bash
#!/usr/bin/env bash
# k8s-drift-check.sh — detect pod image drift from a baseline snapshot
set -euo pipefail

NAMESPACE="${1:?Usage: $0 <namespace>}"
BASELINE="${2:?Usage: $0 <namespace> <baseline-file>}"

echo "Checking pod image drift in namespace: $NAMESPACE"
echo "Baseline file: $BASELINE"
echo ""

# Use process substitution to avoid temp files.
# <(...) gives diff two "files" to compare without writing to disk.
# Both sides are sorted so diff produces a stable comparison.
DIFF_OUTPUT=$(diff \
    <(kubectl get pods -n "$NAMESPACE" \
        -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}' \
        | sort) \
    <(sort "$BASELINE") \
    || true)   # diff exits 1 when files differ — don't abort with set -e

if [[ -z "$DIFF_OUTPUT" ]]; then
    echo "✓ No drift detected. Live state matches baseline."
else
    echo "✗ Drift detected:"
    echo ""
    # Lines starting with < are in live state but not baseline (new/changed)
    # Lines starting with > are in baseline but not live (removed)
    echo "$DIFF_OUTPUT" | grep "^<" | sed 's/^< /  LIVE (not in baseline): /'
    echo "$DIFF_OUTPUT" | grep "^>" | sed 's/^> /  BASELINE (not in live): /'
    exit 1
fi
```

**Verify it worked:**
```bash
# Capture current state as a baseline
kubectl get pods -n production \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}' \
    | sort > baseline-production.txt

# Run the check against itself — should report no drift
./k8s-drift-check.sh production baseline-production.txt

# Manually edit the baseline to simulate drift, then re-run
echo "fake-pod	registry.example.com/old-image:v0.9" >> baseline-production.txt
./k8s-drift-check.sh production baseline-production.txt
```

---

## Exercises

### Exercise 1: Redirect Ordering and FD Wiring

**Goal:** Internalise the left-to-right evaluation of redirects and the difference between `2>&1 > file` and `> file 2>&1`.

1. Create a script `fd-test.sh` that deliberately writes to both stdout and stderr:
   ```bash
   #!/usr/bin/env bash
   echo "this is stdout"
   echo "this is stderr" >&2
   ```
2. Run the script three ways and observe where each stream ends up:
   ```bash
   ./fd-test.sh > out.txt 2>&1          # both to file
   ./fd-test.sh 2>&1 > out.txt          # only stdout to file; where does stderr go?
   ./fd-test.sh > stdout.txt 2> stderr.txt  # separated
   ```
3. After each run, use `cat out.txt`, `cat stdout.txt`, `cat stderr.txt` to confirm your prediction. Write a one-sentence explanation of *why* the second form sends stderr to the terminal.
4. Modify the script to use `set -euo pipefail` and add a `grep` pipeline that matches nothing. Confirm without `pipefail` vs with `pipefail` whether the script exits non-zero.

---

### Exercise 2: Log Analysis Pipeline

**Goal:** Build a multi-stage pipeline that extracts, transforms, and summarises data from a log file without using any temporary files.

1. Generate a synthetic access log:
   ```bash
   for i in $(seq 1 200); do
       STATUS=$(shuf -n1 -e 200 200 200 404 500 502)
       IP="10.0.0.$(( RANDOM % 10 + 1 ))"
       echo "$IP - - [$(date '+%d/%b/%Y:%H:%M:%S +0000')] \"GET /path/$i HTTP/1.1\" $STATUS 512"
   done > access.log
   ```
2. Write a single pipeline (no intermediate files) that:
   - Extracts only 5xx status code lines
   - Counts how many times each unique IP appears in those lines
   - Sorts by frequency descending
   - Shows only the top 5
3. Extend the pipeline with `tee` so the raw 5xx lines are saved to `errors_raw.log` while the sorted summary still prints to the terminal.
4. Confirm `errors_raw.log` contains only 5xx lines: `awk '{print $9}' errors_raw.log | sort -u` should output only 5xx codes.

---

### Exercise 3: Here-Documents and Input Redirection

**Goal:** Practice heredoc quoting rules and understand when variable expansion should and should not occur.

1. Write a script that uses a heredoc to generate an nginx `location` block config. The script should accept `$APP_NAME` and `$UPSTREAM_PORT` as environment variables and expand them into the config body:
   ```
   location /api {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;   # <- this $ must NOT be expanded
   }
   ```
   The challenge: `$APP_NAME` and `$UPSTREAM_PORT` must expand, but `$host` must appear literally. Solve this by escaping `$host` as `\$host` inside an unquoted heredoc — do not quote the entire delimiter.

2. Write a second version using a quoted delimiter (`<< 'EOF'`) and explain why that approach fails for this use case.

3. Use a here-string to test a one-liner: pass the string `"Error: disk full on /dev/sda1"` as stdin to `grep` and extract just the device path using only a pipe and `grep -oP` (or `sed`).

---

### Exercise 4: Subshell Variable Scope and Process Substitution

**Goal:** Directly experience the pipe subshell gotcha and fix it using process substitution.

1. Run this snippet and observe that the final `echo` prints `0`:
   ```bash
   total=0
   echo -e "apple\nbanana\napple\norange\napple" | while read -r fruit; do
       if [[ "$fruit" == "apple" ]]; then
           total=$((total + 1))
       fi
   done
   echo "Apples counted: $total"
   ```
2. Rewrite the loop to use process substitution (`< <(...)`) so `total` is correctly incremented in the parent shell.

---

### Quick Checks

3. Count the number of unique words in the string `"one two three two one"` using a pipeline. Print only the integer count. Hint: `echo "..." | tr ' ' '\n' | sort -u | wc -l | awk '{print $1}'`

```expected_output
3
```

hint: Think about how you can split the string into individual words, remove duplicates, and then count what remains using a pipeline.
hint: Use `tr ' ' '\n'` to put each word on its own line, then pipe through `sort -u` to deduplicate, and finally `wc -l` to count the lines.

4. Extract the second column from each row of this CSV using `awk -F,`. Pipe from: `printf 'alice,30,engineer\nbob,25,designer\ncarol,35,manager\n'`

```expected_output
30
25
35
```
hint: Think about how awk uses field separators to split each line into numbered columns you can reference.
hint: Use awk -F, '{print $2}' to tell awk the comma is the delimiter and to print the second field of each line.

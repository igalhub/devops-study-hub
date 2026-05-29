---
title: Cron Jobs
module: linux
duration_min: 10
difficulty: beginner
tags: [cron, crontab, scheduling, automation]
exercises: 3
---

## Overview

Cron is Linux's built-in task scheduler, present on virtually every Unix-like system since the 1970s. It executes commands or scripts at defined times or intervals without any human intervention. For DevOps engineers, cron is the simplest reliable tool for recurring operational work: rotating logs, running database backups, syncing files to object storage, pruning old Docker images, polling external APIs, and triggering health checks. It requires no additional infrastructure and is available the moment a machine boots.

Cron's design is deliberately minimal. Each job is a single line in a plain text file. There is no dependency graph, no retry logic, no distributed coordination — just "run this command at this time." That simplicity is both its strength and its limitation. Cron is the right tool when your schedule is predictable, your job is self-contained, and failure is either tolerable or handled inside the script itself. When you need retries, alerting on failure, job chaining, or distributed execution, you outgrow cron and reach for tools like Airflow, Kubernetes CronJobs, or Systemd timers. Understanding exactly where cron's limits are is part of knowing when to use it.

In the broader DevOps toolchain, cron sits at the foundation. It predates containers and CI/CD pipelines, but it is still used in both. Containerized environments like Kubernetes replace it with `CronJob` resources that offer restartability and observability — but those resources follow the same five-field time syntax cron established. Ansible, Puppet, and Chef all have modules that manage crontabs. Knowing cron cold means you can read and reason about any system's scheduled work, regardless of the abstraction layer on top of it.

---

## Concepts

### Crontab Syntax

Every cron job is a single line with five time fields followed by the command to execute. The fields are positional and whitespace-separated.

```
┌─ minute        (0–59)
│ ┌─ hour         (0–23)
│ │ ┌─ day of month  (1–31)
│ │ │ ┌─ month        (1–12 or Jan–Dec)
│ │ │ │ ┌─ day of week   (0–7, both 0 and 7 = Sunday; or Sun–Sat)
│ │ │ │ │
* * * * *  /path/to/command --args
```

Reading a cron expression is a skill that comes up constantly — in code review, in runbooks, in incident investigations. Practice reading them right-to-left: "on what days of the week, in what months, on what days of the month, at what hours, at what minutes." For example:

```
30 2 * * 1   →  "at minute 30 of hour 2, any day of month, any month, on Monday"
             →  Every Monday at 2:30 AM
```

**Day-of-month and day-of-week interaction:** If you specify a non-`*` value in *both* the day-of-month and the day-of-week fields, cron runs the job when *either* condition is true — not both. This surprises most people.

```bash
# This does NOT mean "on the 1st if it's a Monday"
# It means "on the 1st of any month OR any Monday"
0 9 1 * 1   /usr/bin/script.sh
```

Use [crontab.guru](https://crontab.guru) to sanity-check expressions before deploying them. Pasting a broken expression into production is a common source of jobs that silently never run.

---

### Field Value Syntax

| Symbol | Meaning | Example | Reads as |
|--------|---------|---------|----------|
| `*` | Any / every | `* * * * *` | Every minute |
| `,` | List of values | `0,30 * * * *` | At :00 and :30 of every hour |
| `-` | Inclusive range | `0 9-17 * * *` | At :00 of every hour from 9 AM to 5 PM |
| `/` | Step interval | `*/15 * * * *` | Every 15 minutes |
| `/` with range | Step within range | `0 8-18/2 * * *` | Every 2 hours between 8 AM and 6 PM |

Steps and ranges can combine. `*/15` is shorthand for `0-59/15`. `0-23/6` means "every 6 hours starting at 0": 0, 6, 12, 18.

**Named shortcuts** — some cron implementations (Vixie cron, cronie) support these strings instead of the five fields:

| Shortcut | Equivalent | Meaning |
|----------|------------|---------|
| `@reboot` | *(none)* | Once at startup |
| `@hourly` | `0 * * * *` | Every hour at :00 |
| `@daily` | `0 0 * * *` | Every day at midnight |
| `@midnight` | `0 0 * * *` | Alias for @daily |
| `@weekly` | `0 0 * * 0` | Every Sunday at midnight |
| `@monthly` | `0 0 1 * *` | First of month at midnight |
| `@yearly` | `0 0 1 1 *` | January 1st at midnight |

**`@reboot` gotcha:** `@reboot` jobs run when the cron daemon starts, not strictly when the OS boots. If crond restarts mid-session, the job runs again. Don't use it for truly one-time initialization.

---

### Where Cron Jobs Live

Cron jobs are not all in one place. The location determines who owns the job, what user it runs as, and how it gets deployed.

| Location | Purpose | User field required | Deployed by |
|----------|---------|---------------------|-------------|
| `crontab -e` (per-user) | User's personal scheduled tasks | No (implicit) | The user themselves |
| `/etc/crontab` | System-wide single file | **Yes** | Root / config management |
| `/etc/cron.d/` | System-wide, one file per application | **Yes** | Packages, config management |
| `/etc/cron.hourly/` | Scripts run hourly | No | Drop executable script |
| `/etc/cron.daily/` | Scripts run daily | No | Drop executable script |
| `/etc/cron.weekly/` | Scripts run weekly | No | Drop executable script |
| `/etc/cron.monthly/` | Scripts run monthly | No | Drop executable script |

**`/etc/cron.d/` is the right place for application-owned jobs in production.** When you deploy an application via a package, Ansible, or Chef, you drop a file in `/etc/cron.d/` named after your app. This keeps jobs discoverable, auditable, and version-controlled. Files in `/etc/cron.d/` must be owned by root and must not be world-writable — cron silently ignores files that fail this permission check.

**`crontab -e` is for personal or ad hoc jobs.** Jobs installed this way live in `/var/spool/cron/crontabs/<username>`. They disappear if the user is deleted. Avoid using personal crontabs for production workloads — no one else knows they exist.

The `cron.daily/` directories run at a time defined in `/etc/crontab` (often `6:25 AM` on Debian/Ubuntu). The exact time is controlled by `anacron` on desktop systems, which compensates for machines that aren't running 24/7. On servers you typically want explicit times via `cron.d` rather than relying on the daily/weekly directories.

---

### The Environment Problem

This is the single most common source of cron failures. When cron runs a job, it does **not** load your shell's startup files. There is no `~/.bashrc`, no `~/.profile`, no `/etc/profile`. The environment is nearly empty.

**Default cron environment (approximate):**
```
HOME=/root          (or the user's home)
LOGNAME=username
USER=username
SHELL=/bin/sh       (not bash — /bin/sh)
PATH=/usr/bin:/bin  (nothing else)
```

This causes two categories of failures:

1. **Command not found** — `/usr/local/bin/python3`, `aws`, `node`, `docker` are not in `/usr/bin:/bin`
2. **Wrong behavior** — the script works interactively because it sources config that sets `AWS_REGION`, `JAVA_HOME`, `VIRTUAL_ENV`, etc.

**Fix 1 — set variables explicitly at the top of the crontab:**

```bash
# /etc/cron.d/myapp
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin
MAILTO=oncall@example.com
AWS_DEFAULT_REGION=us-east-1

30 2 * * * deploy /usr/local/bin/backup.sh
```

**Fix 2 — use absolute paths everywhere in the command itself:**

```bash
30 2 * * * deploy /usr/bin/aws s3 sync /data s3://mybucket/ >> /var/log/backup.log 2>&1
```

**Fix 3 — source the environment inside the script:**

```bash
#!/bin/bash
# backup.sh
source /etc/profile.d/myapp.sh
export JAVA_HOME=/usr/lib/jvm/java-17
# ... rest of script
```

**Debugging tip:** If a job works manually but fails under cron, reproduce the minimal environment with:

```bash
env -i HOME=/root SHELL=/bin/bash PATH=/usr/bin:/bin /bin/bash --noprofile --norc /usr/local/bin/yourscript.sh
```

This strips the environment down to roughly what cron sees and usually reveals the missing variable or binary immediately.

---

### Handling Output and Logging

By default, if a cron job produces any output (stdout or stderr), cron tries to email it to the user via the local MTA. On most servers there is no MTA, so the output is silently discarded. On servers that do have one, you get flooded with emails. Either way, you need an explicit output strategy.

```bash
# BAD — output goes to local mail or nowhere. You'll never know if it failed.
30 2 * * * /usr/bin/backup.sh

# GOOD — append stdout and stderr to a log file
30 2 * * * /usr/bin/backup.sh >> /var/log/backup.log 2>&1

# GOOD — timestamp each run, then append output
30 2 * * * { echo "=== $(date -Iseconds) ==="; /usr/bin/backup.sh; } >> /var/log/backup.log 2>&1

# OK — suppress all output (only if the script handles its own logging)
*/5 * * * * /usr/bin/healthcheck.sh > /dev/null 2>&1

# GOOD — send errors to a specific address (requires working MTA)
MAILTO=alerts@example.com
30 2 * * * /usr/bin/backup.sh > /dev/null  # stdout suppressed; stderr mailed
```

**`2>&1` order matters.** It must appear after the redirect: `>> /var/log/backup.log 2>&1`. The reverse — `2>&1 >> /var/log/backup.log` — redirects stderr to the terminal first, then redirects stdout to the file. Stderr ends up in the wrong place and you lose error output.

**Log rotation** — if your cron job appends to a log file indefinitely, the file will grow unboundedly. Either manage this inside the script, or add a logrotate config in `/etc/logrotate.d/`:

```
/var/log/backup.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    create 0640 root root
}
```

---

### Preventing Overlapping Runs

Cron has no awareness of whether a previous instance of a job is still running. If your backup job takes 70 minutes and runs at 2 AM daily, it will still try to start a new instance at 3 AM — two backup processes competing for the same database, the same lock files, or the same output path.

**Use `flock` for file-based locking:**

```bash
# -n = non-blocking (exit immediately if lock is held, don't queue)
# /tmp/backup.lock is created automatically if it doesn't exist
30 2 * * * flock -n /tmp/backup.lock /usr/bin/backup.sh >> /var/log/backup.log 2>&1
```

**Use `flock` with a timeout:**

```bash
# Wait up to 10 seconds for the lock; if still held, give up
30 2 * * * flock -w 10 /tmp/backup.lock /usr/bin/backup.sh >> /var/log/backup.log 2>&1
```

**Self-locking pattern inside a script:**

```bash
#!/bin/bash
# backup.sh — self-locking via file descriptor
LOCKFILE=/tmp/backup.lock

exec 9>"${LOCKFILE}"
flock -n 9 || { echo "[$(date -Iseconds)] Already running, exiting."; exit 1; }

# All work happens here; lock released automatically on exit
echo "[$(date -Iseconds)] Starting backup..."
```

**`flock` gotcha:** the lock is tied to the file descriptor, not the file path. The lock is released automatically when the process exits — even abnormally (crash, kill signal). This means no stale lock files to clean up manually, unlike `mkdir`-based or `pidfile`-based locking patterns that require cleanup logic.

| Locking method | Stale lock risk | Works across scripts | Notes |
|---------------|----------------|----------------------|-------|
| `flock` | None (kernel-managed) | Yes | Preferred; available on all Linux systems |
| `mkdir` | Yes — must clean up | No | Fragile; avoid |
| PID file | Yes — must validate PID | Yes | More complex; used by some daemons |

---

### Crontab Management Commands

```bash
# Edit your crontab (uses $EDITOR or $VISUAL, defaults to vi/nano)
crontab -e

# List your current crontab
crontab -l

# Remove all your cron jobs — NO CONFIRMATION PROMPT
crontab -r

# Remove with confirmation (supported on most modern systems)
crontab -i -r

# Edit another user's crontab (must be root)
crontab -u www-data -e

# List another user's crontab
crontab -u deploy -l

# Install a crontab from a file (replaces existing entirely)
crontab /path/to/mycrontab.txt

# Pipe a crontab in (useful in provisioning scripts)
echo "*/5 * * * * /usr/bin/healthcheck.sh > /dev/null 2>&1" | crontab -
```

**`crontab -r` vs `-e` gotcha:** `-r` (remove) and `-e` (edit) are adjacent on the keyboard. Mistyping `-r` instead of `-e` deletes all cron jobs with no confirmation and no undo. Always keep crontabs in version control (an Ansible task, a file in your repo) so recovery is `git checkout` rather than reconstruction from memory.

---

### Verifying That Cron Ran

A job not producing output is not the same as a job running. Always verify in logs.

```bash
# Ubuntu/Debian — cron logs to syslog
grep CRON /var/log/syslog | tail -30

# RedHat/CentOS — dedicated cron log
tail -30 /var/log/cron

# systemd-based systems — via journald
journalctl -u cron --since "1 hour ago"
journalctl -u crond -f          # follow in real time (RHEL/CentOS uses crond)
journalctl -u cron --since today --grep "backup"

# Example syslog output showing successful launch:
# Jun 15 02:30:01 server CRON[12345]: (root) CMD (/usr/bin/backup.sh >> /var/log/backup.log 2>&1)
```

The syslog entry confirms cron *launched* the job. Whether the job *succeeded* is a separate question — you need the job's own log output or exit code for that. A common pattern is to emit a final `echo "SUCCESS $(date -Iseconds)"` at the end of a script and then grep for it to confirm completion.

**Checking for silent failures:**

```bash
# Confirm the last run left a success marker
grep "SUCCESS" /var/log/backup.log | tail -1

# Alert if the backup log hasn't been written to in over 25 hours
find /var/log/backup.log -mmin +1500 && echo "ALERT: backup may not have run"
```

**Dead Man's Snitch / Healthchecks.io pattern:** For critical cron jobs, send an HTTP ping to an external monitoring service at the end of the script. If the ping doesn't arrive within the expected window, the service alerts you. This catches both missed runs and silent failures.

```bash
#!/bin/bash
# backup.sh — with dead man's snitch
set -e
/usr/bin/pg_dump mydb | gzip > /backups/mydb-$(date +%Y%m%d).sql.gz
# Only reached if the above succeeded (set -e)
curl -fsS --retry 3 https://hc-ping.com/your-uuid-here > /dev/null
```

---

### Cron Security Considerations

Cron jobs run with real user permissions. A misconfigured job can be a privilege escalation vector.

**`/etc/cron.allow` and `/etc/cron.deny`** control which users may use `crontab`. If `/etc/cron.allow` exists, only listed users can schedule jobs. If only `/etc/cron.deny` exists, everyone except listed users can. If neither exists, behavior is implementation-defined (usually root-only or all users depending on distro).

```bash
# Check who is allowed to schedule cron jobs
cat /etc/cron.allow 2>/dev/null || echo "cron.allow not present"
cat /etc/cron.deny  2>/dev/null || echo "cron.deny not present"
```

**World-writable script called by root cron = privilege escalation.** If root's crontab calls `/opt/scripts/backup.sh` and that file is writable by a non-root user, that user can inject arbitrary commands to run as root.

```bash
# Audit: find scripts called by root crontab that are writable by others
crontab -u root -l | grep -oP '/[^ ]+\.sh' | xargs ls -l
```

**Always verify permissions on scripts called by cron:**

```bash
chmod 750 /opt/scripts/backup.sh
chown root:root /opt/scripts/backup.sh
```

---

## Examples

### Example 1: Nightly Database Backup with Locking and Logging

This example drops a complete production-style cron config into `/etc/cron.d/` for a PostgreSQL backup job. It uses flock to prevent overlapping runs, timestamps every run, and rotates logs.

```bash
# Step 1: Create the backup script
cat > /usr/local/bin/pg-backup.sh << 'EOF'
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/postgres"
DB_NAME="appdb"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTFILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[${TIMESTAMP}] Starting backup of ${DB_NAME}"
pg_dump -U postgres "${DB_NAME}" | gzip > "${OUTFILE}"
echo "[$(date -Iseconds)] Backup complete: ${OUTFILE} ($(du -sh "${OUTFILE}" | cut -f1))"

# Prune backups older than 30 days
find "${BACKUP_DIR}" -name "*.sql.gz" -mtime +30 -delete
echo "[$(date -Iseconds)] Old backups pruned"

# Signal success to monitoring
curl -fsS --retry 3 "https://hc-ping.com/your-uuid" > /dev/null || true
EOF

chmod 750 /usr/local/bin/pg-backup.sh
chown root:root /usr/local/bin/pg-backup.sh
```

```bash
# Step 2: Create the cron.d file
cat > /etc/cron.d/pg-backup << 'EOF'
# PostgreSQL nightly backup — owned by platform team
# Runs at 2:30 AM daily as the postgres user
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""

30 2 * * * postgres flock -n /tmp/pg-backup.lock /usr/local/bin/pg-backup.sh >> /var/log/pg-backup.log 2>&1
EOF

chmod 644 /etc/cron.d/pg-backup
chown root:root /etc/cron.d/pg-backup
```

```bash
# Step 3: Add logrotate config
cat > /etc/logrotate.d/pg-backup << 'EOF'
/var/log/pg-backup.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 0640 root root
}
EOF
```

```bash
# Step 4: Verify it's loaded — cron picks up /etc/cron.d/ automatically, no reload needed
# Simulate the run manually to confirm the script works before waiting for 2:30 AM
sudo -u postgres /usr/local/bin/pg-backup.sh

# Verify log output
tail -5 /var/log/pg-backup.log

# After 2:30 AM passes, confirm cron launched it
grep "pg-backup" /var/log/syslog
```

---

### Example 2: Docker Image Cleanup Every 6 Hours

Old Docker images accumulate quickly on CI workers and app servers. This job prunes dangling images every 6 hours with staggered timing to avoid hitting the Docker daemon at peak CI load.

```bash
# Step 1: Create the cleanup script
cat > /usr/local/bin/docker-prune.sh << 'EOF'
#!/bin/bash
set -euo pipefail

echo "[$(date -Iseconds)] Starting Docker prune"

# Remove dangling images (untagged, not referenced by any container)
REMOVED=$(docker image prune -f 2>&1)
echo "${REMOVED}"

# Remove stopped containers older than 24h
docker container prune -f --filter "until=24h" 2>&1

echo "[$(date -Iseconds)] Docker prune complete"
EOF

chmod 750 /usr/local/bin/docker-prune.sh
chown root:root /usr/local/bin/docker-prune.sh
```

```bash
# Step 2: Install the cron job
# Runs at 1:15, 7:15, 13:15, 19:15 — offset from the hour to reduce contention
cat > /etc/cron.d/docker-prune << 'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""

15 1,7,13,19 * * * root flock -n /tmp/docker-prune.lock /usr/local/bin/docker-prune.sh >> /var/log/docker-prune.log 2>&1
EOF

chmod 644 /etc/cron.d/docker-prune
chown root:root /etc/cron.d/docker-prune
```

```bash
# Step 3: Verify
# Run manually first
/usr/local/bin/docker-prune.sh
tail /var/log/docker-prune.log

# Check the cron entry parsed correctly (no syntax errors cause cron to ignore the file)
# cron does not provide a --check flag; watch syslog for parse errors after saving
journalctl -u cron --since "1 minute ago"
```

---

### Example 3: Environment-Sensitive Health Check with Python

This example deliberately exercises the environment problem. A Python-based health check uses a virtualenv and reads a secret from a file — both things that break under naive cron setup.

```bash
# Step 1: The health check script
cat > /opt/myapp/healthcheck.py << 'EOF'
#!/usr/bin/env python3
import os, sys, requests

API_URL = os.environ["MYAPP_API_URL"]
TOKEN   = open("/etc/myapp/api-token").read().strip()

try:
    r = requests.get(f"{API_URL}/health", headers={"Authorization": f"Bearer {TOKEN}"}, timeout=10)
    r.raise_for_status()
    print(f"OK: {r.status_code}")
    sys.exit(0)
except Exception as e:
    print(f"FAIL: {e}", file=sys.stderr)
    sys.exit(1)
EOF

chmod 750 /opt/myapp/healthcheck.py
```

```bash
# Step 2: Wrapper script that sets up the environment before calling Python
# This is Fix 3 from the Environment Problem section — source inside the script
cat > /usr/local/bin/myapp-healthcheck.sh << 'EOF'
#!/bin/bash
set -euo pipefail

# Activate virtualenv — not in cron's PATH
source /opt/myapp/venv/bin/activate

# Set required env var — not inherited from any shell profile
export MYAPP_API_URL="https://api.internal.example.com"

exec /opt/myapp/healthcheck.py
EOF

chmod 750 /usr/local/bin/myapp-healthcheck.sh
```

```bash
# Step 3: Install the cron job — note MAILTO catches stderr if the exit code is non-zero
cat > /etc/cron.d/myapp-healthcheck << 'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=oncall@example.com

*/5 * * * * deploy flock -n /tmp/myapp-hc.lock /usr/local/bin/myapp-healthcheck.sh >> /var/log/myapp-healthcheck.log 2>&1
EOF

chmod 644 /etc/cron.d/myapp-healthcheck
chown root:root /etc/cron.d/myapp-healthcheck
```

```bash
# Step 4: Simulate the cron environment to verify before waiting 5 minutes
# This is the env -i debugging technique from the Environment Problem section
sudo -u deploy env -i HOME=/home/deploy SHELL=/bin/bash PATH=/usr/bin:/bin \
  /bin/bash --noprofile --norc /usr/local/bin/myapp-healthcheck.sh

# If it passes here, it will pass under cron
tail /var/log/myapp-healthcheck.log
```

---

## Exercises

### Exercise 1: Audit and Fix a Broken Cron Job

You are given the following cron job that was installed by a previous engineer. It works when run manually as the `deploy` user, but the cron logs show it launches and then produces no output, and the backup files are never created.

```
*/30 * * * * deploy backup.sh > /var/log/backup.log
```

**Tasks:**

1. List at least three distinct problems with this cron entry and explain why each causes a failure.
2. Rewrite the entry so it runs correctly. The backup script lives at `/usr/local/bin/backup.sh`. It must run every 30 minutes, append output with timestamps, and capture both stdout and stderr.
3. Write the `env -i` command you would use to simulate the cron environment for the `deploy` user and test the script before deploying your fix.
4. Where should this entry live if it's part of a deployed application — your personal crontab or `/etc/cron.d/`? Explain the operational reason.

---

### Exercise 2: Design a Schedule Without Overlaps

A report generation script takes between 8 and 25 minutes to run depending on data volume. It must run at least once per hour. The script is not idempotent — if two instances run simultaneously, the output file is corrupted.

**Tasks:**

1. Write the cron entry with `flock` that prevents overlapping runs. Use `/tmp/report-gen.lock` as the lock file.
2. Explain what happens if the script is still running when cron tries to start the next instance. What does the user see in the log? What does NOT happen (i.e., what would you need to add yourself if you wanted an alert)?
3. Modify your entry so that if the script fails (non-zero exit), an email is sent to `reports-team@example.com`. What must be configured on the system for this to work?
4. Using `journalctl`, write the exact command that would show you every time this job was launched in the last 24 hours.

---

### Exercise 3: Write and Deploy a Full Cron Job from Scratch

Build a complete log archiving solution using cron. Requirements:

- Every day at 3:45 AM, compress all `.log` files in `/var/log/myapp/` that are older than 7 days into a tarball named `myapp-archive-YYYYMMDD.tar.gz` in `/var/backups/myapp/`.
- Tarballs older than 90 days should be deleted.
- The job runs as the `root` user.
- Each run appends a timestamped entry to `/var/log/myapp-archive.log`.
- The log file is rotated weekly, keeping 8 weeks of history.

**Deliverables:**

1. The shell script at `/usr/local/bin/myapp-archive.sh` — complete and runnable.
2. The file at `/etc/cron.d/myapp-archive` — including all necessary environment variables and correct permissions (`chmod 644`, owned by `root:root`).
3. The logrotate config at `/etc/logrotate.d/myapp-archive`.
4. The exact command to verify the job ran after its first scheduled execution, without waiting — i.e., how do you confirm the syslog shows cron launched it AND the log file shows it completed successfully?

---

### Quick Checks

1. Count the number of fields in a cron expression.

   ```bash
   echo "30 */2 * * 1-5" | awk '{print NF}'
   ```

   ```expected_output
   5
   ```

hint: Think about how you can split a cron expression into its individual parts and count those parts.
hint: Use echo with the cron expression string and pipe it to awk, using NF to print the number of fields.

2. Extract the minute field from a cron expression.

   ```bash
   echo "*/15 6-22 * * 1-5" | awk '{print $1}'
   ```

   ```expected_output
   */15
   ```
hint: Think about how you can isolate a specific field from a delimited string in Linux.
hint: Use the cut command with the -d flag to set the delimiter and -f1 to select the first field from the cron expression.

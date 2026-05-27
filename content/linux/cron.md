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

Use [crontab.guru](https://crontab.guru) to sanity-check expressions before deploying them. Pasting a broken expression into production is a common source of jobs that silently never run.

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

**`/etc/cron.d/` is the right place for application-owned jobs in production.** When you deploy an application via a package, Ansible, or Chef, you drop a file in `/etc/cron.d/` named after your app. This keeps jobs discoverable, auditable, and version-controlled.

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
2. **Wrong behavior** — the script works interactively because it sources config that sets `AWS_REGION`, `JAVA_HOME`, etc.

**Fix — set everything explicitly at the top of the crontab:**

```bash
# crontab -e
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin
MAILTO=oncall@example.com
AWS_DEFAULT_REGION=us-east-1

30 2 * * * /usr/bin/backup.sh
```

**Fix — use absolute paths everywhere in the command itself:**

```bash
30 2 * * * /usr/bin/aws s3 sync /data s3://bucket/ >> /var/log/backup.log 2>&1
```

**Fix — source the environment inside the script:**

```bash
#!/bin/bash
# backup.sh
source /etc/profile.d/myapp.sh
# ... rest of script
```

---

### Handling Output and Logging

By default, if a cron job produces any output (stdout or stderr), cron tries to email it to the user via the local MTA. On most servers there is no MTA, so the output is lost. On servers that do have one, you get flooded with emails. Either way, you need an explicit output strategy.

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

**`2>&1` order matters.** It must appear after the redirect: `>> /var/log/backup.log 2>&1`. The reverse — `2>&1 >> /var/log/backup.log` — redirects stderr to the terminal first, then redirects stdout to the file. Stderr ends up in the wrong place.

**Log rotation** — if your cron job appends to a log file indefinitely, the file will grow unboundedly. Either manage this inside the script (keep last N lines), or add a logrotate config in `/etc/logrotate.d/`:

```
/var/log/backup.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
```

---

### Preventing Overlapping Runs

Cron has no awareness of whether a previous instance of a job is still running. If your backup job takes 70 minutes and runs at 2 AM daily, it will still try to start a new instance at 3 AM — two backup processes competing for the same database.

**Use `flock` for file-based locking:**

```bash
# -n = non-blocking (exit immediately if lock is held)
# -e 1 = exit code 1 if lock is unavailable
30 2 * * * flock -n /tmp/backup.lock /usr/bin/backup.sh >> /var/log/backup.log 2>&1
```

**Use `flock` with a timeout:**

```bash
# Wait up to 10 seconds for the lock; if still held, give up
30 2 * * * flock -w 10 /tmp/backup.lock /usr/bin/backup.sh >> /var/log/backup.log 2>&1
```

**Inside a script, `flock` with the script locking itself:**

```bash
#!/bin/bash
# backup.sh — self-locking
exec 9>/tmp/backup.lock
flock -n 9 || { echo "Already running, exiting."; exit 1; }

# ... actual work here
```

**`flock` gotcha:** the lock is released when the file descriptor closes — which happens when the process exits, even abnormally. No stale lock files to clean up manually, unlike `mkdir`-based locking.

---

### Crontab Management Commands

```bash
# Edit your crontab (uses $EDITOR or $VISUAL, defaults to vi/nano)
crontab -e

# List your current crontab
crontab -l

# Remove all your cron jobs — NO CONFIRMATION PROMPT
crontab -r

# Edit another user's crontab (must be root)
crontab -u www-data -e

# List another user's crontab
crontab -u deploy -l

# Install a crontab from a file (replaces existing)
crontab /path/to/mycrontab.txt
```

**`crontab -r` vs `-e` gotcha:** `-r` (remove) and `-e` (edit) look similar and are adjacent on the keyboard. Several engineers have accidentally deleted all their production cron jobs. Some systems support `crontab -i` which prompts for confirmation before removing. Always use `-i` if your system supports it, and always keep crontabs in version control.

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
journalctl -u crond -f   # follow in real time (RHEL/CentOS uses crond)

# Example syslog output showing successful execution:
# Jun 15 02:30:01 server CRON[12345]: (root) CMD (/usr/bin/backup.sh >> /var/log/backup.log 2>&1)
```

The syslog entry confirms cron *launched* the job. Whether the job *succeeded* depends on your script's own logging. That's why output redirection to a log file matters — it's your primary debugging tool.

---

## Examples

### Example 1: Daily Database Backup with Locking and Logging

**Scenario:** Dump a PostgreSQL database to disk every night at 2:30 AM, keep 7 days of backups, and log everything with timestamps. Prevent overlap if the dump takes longer than a day.

```bash
# /etc/cron.d/postgres-backup
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=dba-alerts@example.com

# minute hour day month weekday user command
30 2 * * * postgres flock -n /tmp/pg-backup.lock /usr/local/bin/pg-backup.sh >> /var/log/pg-backup.log 2>&1
```

```bash
#!/bin/bash
# /usr/local/bin/pg-backup.sh

set -euo pipefail   # exit on error, undefined vars, pipe failures

BACKUP_DIR="/var/backups/postgres"
DB_NAME="appdb"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.dump"
KEEP_DAYS=7

echo "[$(date -Iseconds)] Starting backup of ${DB_NAME}"

# Create backup directory if it doesn't exist
mkdir -p "${BACKUP_DIR}"

# Dump in custom format (compressed, supports selective restore)
pg_dump --format=custom --file="${BACKUP_FILE}" "${DB_NAME}"

echo "[$(date -Iseconds)] Backup written to ${BACKUP_FILE} ($(du -sh "${BACKUP_FILE}" | cut -f1))"
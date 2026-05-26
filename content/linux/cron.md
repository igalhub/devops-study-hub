---
title: Cron Jobs
module: linux
duration_min: 10
difficulty: beginner
tags: [cron, crontab, scheduling, automation]
exercises: 3
---

## Overview
Cron is Linux's built-in task scheduler — it runs commands or scripts at fixed times or intervals without manual intervention. In DevOps it's used for backups, log rotation, report generation, cleanup tasks, and health checks. Understanding cron syntax and pitfalls is a basic competency.

## Concepts

### Crontab Syntax
Each cron job is one line with 5 time fields followed by the command:

```
┌─ minute       (0–59)
│ ┌─ hour        (0–23)
│ │ ┌─ day of month (1–31)
│ │ │ ┌─ month       (1–12 or Jan–Dec)
│ │ │ │ ┌─ day of week  (0–7, 0 and 7 = Sunday, or Sun–Sat)
│ │ │ │ │
* * * * *  command to run
```

### Field Values
| Symbol | Meaning | Example |
|--------|---------|---------|
| `*` | Any value | `* * * * *` — every minute |
| `,` | List | `0,30 * * * *` — at :00 and :30 |
| `-` | Range | `0 9-17 * * *` — hourly, 9am–5pm |
| `/` | Step | `*/15 * * * *` — every 15 minutes |

### Where Cron Jobs Live
| Location | Who | Notes |
|----------|-----|-------|
| `crontab -e` | Per-user crontab | Runs as that user |
| `/etc/crontab` | System-wide | Has an extra `user` field |
| `/etc/cron.d/` | System-wide, drop-in | Separate files per app |
| `/etc/cron.daily/` | Scripts | Runs daily (exact time in `/etc/crontab`) |
| `/etc/cron.hourly/` | Scripts | Runs hourly |

### Common Gotchas
- **PATH is minimal in cron** — always use absolute paths (`/usr/bin/python3`, not `python3`)
- **No terminal** — redirect output or jobs fail silently
- **Environment variables** — cron doesn't load your `.bashrc`/`.profile`. Set them explicitly in the crontab.

## Examples

### Editing Your Crontab
```bash
# Edit (uses $EDITOR, defaults to nano or vi)
crontab -e

# List current jobs
crontab -l

# Remove all jobs (careful — no confirmation)
crontab -r

# Edit another user's crontab (as root)
crontab -u www-data -e
```

### Common Schedules
```bash
# Every minute
* * * * *  /usr/bin/check-health.sh

# Every 5 minutes
*/5 * * * *  /usr/bin/check-health.sh

# Every day at 2:30 AM
30 2 * * *  /usr/bin/backup.sh

# Every Monday at 9 AM
0 9 * * 1  /usr/bin/weekly-report.sh

# First day of each month at midnight
0 0 1 * *  /usr/bin/monthly-cleanup.sh

# Every weekday at 8 AM
0 8 * * 1-5  /usr/bin/notify-standup.sh

# Every 6 hours
0 */6 * * *  /usr/bin/sync-data.sh
```

### Handling Output — Don't Run Blind
By default, cron emails output to the local user. In practice: redirect to a log file.

```bash
# Redirect stdout and stderr to a log file
30 2 * * * /usr/bin/backup.sh >> /var/log/backup.log 2>&1

# Suppress all output (only do this if you're sure the job works)
*/5 * * * * /usr/bin/check-health.sh > /dev/null 2>&1

# Append with timestamp
30 2 * * * echo "--- $(date) ---" >> /var/log/backup.log && /usr/bin/backup.sh >> /var/log/backup.log 2>&1
```

### Setting Environment Variables in Crontab
```bash
# At the top of crontab -e, before any jobs:
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=igal@example.com   # email output here instead of local mail

# Or inline per job:
30 2 * * * AWS_PROFILE=prod /usr/bin/aws s3 sync /data s3://my-bucket/
```

### /etc/cron.d/ Drop-in Format
Drop-in files require an explicit username field:
```
# /etc/cron.d/myapp
SHELL=/bin/bash
PATH=/usr/bin:/bin

# minute hour day month weekday user command
*/5 * * * * www-data /opt/myapp/bin/healthcheck >> /var/log/myapp-health.log 2>&1
```

### Verifying Cron Ran
```bash
# Check system cron logs (Ubuntu/Debian)
grep CRON /var/log/syslog | tail -20

# Or via journald
journalctl -u cron -f
```

## Exercises

1. Write a cron job that appends the current date and disk usage (`df -h`) to `/tmp/disk-report.log` every day at 6 AM.
2. Write a cron job that runs every 10 minutes and logs `uptime` output to `/tmp/uptime.log`. Use `>>` to append and include a timestamp.
3. Identify a potential problem with this cron line and fix it:
   `0 3 * * * python3 backup.py >> backup.log`

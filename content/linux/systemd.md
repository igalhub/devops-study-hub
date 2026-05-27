---
title: systemd & Service Management
module: linux
duration_min: 20
difficulty: intermediate
tags: [systemd, systemctl, journald, services, units]
exercises: 4
---

## Overview

systemd is the init system and service manager that ships as PID 1 on every major Linux distribution — Ubuntu, Debian, RHEL, CentOS, Fedora, Arch, and more. Because it is the first process the kernel hands control to after boot, it is responsible for bringing up every other process on the system: mounting filesystems, starting network interfaces, launching daemons, and reaching the login prompt. For DevOps engineers, this means systemd is the layer you interact with whenever you deploy an application, configure automatic restarts, chase down a crashed service, or wire up scheduled tasks on a Linux host — whether that host is a VM, a bare-metal server, or a container running with a full init process.

systemd's design philosophy centers on parallelism, dependency declaration, and unified logging. Unlike the sequential SysV init scripts it replaced, systemd builds a dependency graph from unit files and starts units in parallel wherever possible, cutting boot times significantly. All unit configuration lives in declarative INI-style files rather than shell scripts, which makes behavior predictable and auditable. Logging is centralized through journald, which captures stdout, stderr, and kernel messages into a structured binary journal — giving you a single tool (`journalctl`) to query logs for any service with rich filtering.

In the broader DevOps toolchain, systemd sits at the infrastructure layer beneath your application orchestration. Even when you run workloads in Docker, Kubernetes, or Ansible-managed environments, the underlying hosts use systemd to run the Docker daemon, the kubelet, the SSH server, and other foundational services. When a node-level issue occurs — a service crashes, a daemon won't start, a dependency cycle breaks boot — systemd is where you diagnose it. Understanding systemd deeply makes you faster at debugging production incidents and more confident writing deployment automation.

---

## Concepts

### Unit Types and File Locations

Everything systemd manages is called a *unit*. Units are described by plain-text configuration files with a type-specific extension. The six unit types you will encounter most often:

| Type | Extension | Purpose |
|------|-----------|---------|
| **Service** | `.service` | A daemon or one-shot process |
| **Timer** | `.timer` | Cron replacement — triggers a `.service` on a schedule |
| **Socket** | `.socket` | Socket activation — starts a service on first connection |
| **Mount** | `.mount` | Filesystem mounts managed by systemd |
| **Target** | `.target` | Synchronization points / groups of units (like runlevels) |
| **Path** | `.path` | Triggers a service when a filesystem path changes |

Unit files are loaded from several directories in priority order (highest to lowest):

| Directory | Purpose |
|-----------|---------|
| `/etc/systemd/system/` | Local admin overrides and custom units — **write here** |
| `/run/systemd/system/` | Runtime-generated units (transient; lost on reboot) |
| `/lib/systemd/system/` | Package-installed units — **never edit directly** |

When the same filename appears in multiple directories, the highest-priority location wins. A file in `/etc/systemd/system/nginx.service` completely shadows `/lib/systemd/system/nginx.service`.

**Drop-in directories** are the safer override mechanism. For a unit named `nginx.service`, systemd automatically merges every `.conf` file found in `/etc/systemd/system/nginx.service.d/` on top of the base unit. This lets you change one stanza without copying and maintaining the entire upstream file.

```bash
# List all loaded unit files and their source locations
systemctl list-unit-files --type=service

# Show exactly which file systemd is using for a unit
systemctl cat nginx.service

# Show the final merged configuration after drop-ins are applied
systemctl show nginx.service
```

### Service States

A service unit has two orthogonal state dimensions: its *load/enable state* (what happens at boot) and its *active state* (what it's doing right now).

**Active states:**

| State | Meaning |
|-------|---------|
| `active (running)` | One or more processes are running |
| `active (exited)` | One-shot service completed successfully; systemd considers it done |
| `active (waiting)` | Service is waiting for a triggering event |
| `inactive (dead)` | Not running, no failure |
| `failed` | Exited with non-zero code, killed by signal, or hit a timeout |
| `activating` | In the process of starting up |
| `deactivating` | In the process of shutting down |

**Enable states:**

| State | Meaning |
|-------|---------|
| `enabled` | Symlink exists in the appropriate `.wants/` or `.requires/` directory — starts at boot |
| `disabled` | No symlink — won't start at boot, but can be started manually |
| `static` | No `[Install]` section — cannot be enabled/disabled; started only as a dependency |
| `masked` | Symlinked to `/dev/null` — cannot be started by any means until unmasked |

**Masking vs disabling:** `systemctl disable` removes the boot symlink but leaves the unit startable manually. `systemctl mask` makes the unit completely inert — even `systemctl start` will refuse. Use masking for services you want to ensure never run (e.g., a conflicting service installed by a package).

```bash
# Full status: active state, enable state, recent log lines, PID, memory
systemctl status nginx.service

# Check if a service is active/enabled in scripts (exits 0 or non-zero)
systemctl is-active nginx.service
systemctl is-enabled nginx.service

# Mask and unmask
systemctl mask snapd.service
systemctl unmask snapd.service
```

### Unit File Anatomy

A `.service` unit file has three sections. Understanding every common directive makes writing and debugging unit files much faster.

```ini
[Unit]
# Human-readable description shown in status output and logs
Description=My Application Server

# Ordering: start after these units, but don't require them
After=network-online.target

# Weak dependency: pull in this unit if it exists, but don't fail if it doesn't
Wants=network-online.target

# Hard dependency: if postgresql.service fails to start, this unit fails too
Requires=postgresql.service

# Restart this unit if another unit restarts (useful for sidecar patterns)
PartOf=myapp-stack.target

[Service]
# Type controls how systemd tracks the service as "ready"
# simple:  ready immediately when ExecStart forks (default; use for most daemons)
# forking: legacy; ready after the process double-forks (old-style daemons)
# notify:  ready when the process sends sd_notify(READY=1)
# oneshot: for scripts; systemd waits for the process to exit before marking active
# exec:    like simple but waits until the exec() call succeeds
Type=simple

User=myapp
Group=myapp
WorkingDirectory=/opt/myapp

ExecStart=/opt/myapp/bin/server --port 8080
# ExecReload sends SIGHUP to $MAINPID — only use if your app handles it
ExecReload=/bin/kill -HUP $MAINPID
# ExecStartPre runs before ExecStart; non-zero exit blocks service start
ExecStartPre=/usr/bin/myapp-check-config

# Restart policies
Restart=on-failure     # restart if exit code != 0 or killed by signal
RestartSec=5s          # wait 5s before restarting

# Environment
Environment=NODE_ENV=production
EnvironmentFile=/etc/myapp/env   # key=value pairs, one per line; # comments OK

# Resource limits (overrides /etc/security/limits.conf for this service)
LimitNOFILE=65536

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes         # isolated /tmp — processes can't see each other's temp files
ProtectSystem=strict   # mounts / and /usr read-only for this service
ReadWritePaths=/var/lib/myapp /var/log/myapp

[Install]
# Which target "wants" this service — effectively which runlevel it belongs to
WantedBy=multi-user.target   # standard for nearly all server daemons
```

**`Type=simple` vs `Type=notify` gotcha:** If you use `Type=simple` with a service that takes time to become ready (e.g., loads a large model, runs DB migrations), systemd will consider it "started" the instant the process is exec'd. Any services declared `After=myapp.service` will start immediately, potentially connecting before myapp is ready. If your application uses a library that supports `sd_notify` (Node.js `systemd-notify`, Go `coreos/go-systemd`, Python `sdnotify`), switch to `Type=notify` for correct readiness signaling.

**`Requires` vs `Wants`:** `Requires` is a hard dependency — if `postgresql.service` fails, your service fails. `Wants` is soft — postgres failure is ignored. In most real deployments, `Wants` + `After` is the right combination: express ordering without coupling failure modes unnecessarily.

**`After` does not imply `Wants`:** `After=postgresql.service` alone only orders startup — it does not cause postgres to be started. You must combine `After` with `Wants` or `Requires` to both pull in the dependency and order correctly.

### Restart Policies in Depth

| Policy | Restarts on clean exit (0)? | Restarts on failure? | Restarts on SIGTERM? |
|--------|----------------------------|---------------------|---------------------|
| `no` | No | No | No |
| `on-success` | Yes | No | No |
| `on-failure` | No | Yes | No |
| `on-abnormal` | No | Yes (signals, watchdog, timeout) | Yes |
| `on-abort` | No | Uncaught signals only | No |
| `always` | Yes | Yes | Yes |

For long-running application servers, `Restart=on-failure` is the standard choice — it recovers from crashes and OOM kills without looping if you do a deliberate `systemctl stop`.

**Restart loop protection:** If a service restarts too frequently, systemd will stop trying. The defaults are 5 restarts within 10 seconds. Configure with:

```ini
[Unit]
StartLimitIntervalSec=60s   # observation window
StartLimitBurst=5           # max restarts in that window
StartLimitAction=none       # or reboot-force, reboot, poweroff
```

**`RestartSec` interacts with `StartLimitBurst`:** A `RestartSec=30s` with `StartLimitBurst=5` means the limit won't be hit unless 5 crashes happen within 60 seconds even with 30s delays — tune both together.

**Placement gotcha:** `StartLimitIntervalSec` and `StartLimitBurst` belong in the `[Unit]` section in newer systemd versions (≥ 230), not `[Service]`. On older systems they live in `[Service]`. The wrong placement is silently ignored — always verify with `systemctl show myapp.service | grep StartLimit`.

```bash
# After hitting the restart limit, reset the failure counter to allow manual restart
systemctl reset-failed myapp.service
systemctl start myapp.service
```

### Targets (Runlevels)

Targets are synchronization points — named milestones the boot process passes through. They replace SysV runlevels.

| SysV Runlevel | systemd Target | Meaning |
|--------------|---------------|---------|
| 0 | `poweroff.target` | Halt |
| 1 | `rescue.target` | Single-user / recovery mode |
| 3 | `multi-user.target` | Multi-user, no GUI (typical server) |
| 5 | `graphical.target` | Multi-user + display manager |
| 6 | `reboot.target` | Reboot |

```bash
# Check current default target
systemctl get-default

# Change default target (e.g., headless server)
systemctl set-default multi-user.target

# Switch to rescue mode without rebooting (interactive systems only)
systemctl isolate rescue.target

# See all units pulled into a target and their dependency relationships
systemctl list-dependencies multi-user.target
```

When you `systemctl enable myapp.service`, systemd creates a symlink at `/etc/systemd/system/multi-user.target.wants/myapp.service` (assuming `WantedBy=multi-user.target`). The target "wants" the service, so when the system reaches `multi-user.target`, it starts your service.

**`enable` does not start:** `systemctl enable` only creates the symlink for next boot. Use `systemctl enable --now` to enable and start in a single command. Forgetting `--now` is one of the most common deployment mistakes — the service looks configured but is not actually running.

### Timers — The Cron Replacement

systemd timers are two-unit pairs: a `.timer` unit that defines the schedule, and a corresponding `.service` unit that does the actual work. Compared to cron, timers integrate with journald (full log capture), support dependency ordering, have monotonic (boot-relative) and calendar (wall-clock) schedules, and can be inspected with standard `systemctl` tooling.

```ini
# /etc/systemd/system/db-backup.service
[Unit]
Description=Database Backup

[Service]
Type=oneshot
User=backup
ExecStart=/usr/local/bin/db-backup.sh
# No [Install] section — this service is only invoked by the timer, never enabled directly
```

```ini
# /etc/systemd/system/db-backup.timer
[Unit]
Description=Run database backup daily at 02:00

[Timer]
# Calendar expression: daily at 02:00 local time
OnCalendar=*-*-* 02:00:00
# If the system was off at 02:00, run the job within 15 minutes of next boot
Persistent=true
# Randomize start time within a 10-minute window to avoid thundering herd
RandomizedDelaySec=10min
# Which service to trigger (defaults to same name with .service extension)
Unit=db-backup.service

[Install]
WantedBy=timers.target
```

```bash
# Enable and start the timer (not the service directly)
systemctl enable --now db-backup.timer

# List all timers, their next/last trigger times
systemctl list-timers --all

# Manually trigger the job right now without waiting for the schedule
systemctl start db-backup.service

# Verify the last run via the journal
journalctl -u db-backup.service -n 50
```

**`Persistent=true` is the cron equivalent of `@reboot` catch-up:** Without it, a job missed because the system was down is simply skipped. With it, systemd runs the job once on the next boot if the last trigger was missed. Essential for backup and maintenance jobs on systems that aren't always on.

| Timer Type | Directive | Example | Meaning |
|-----------|-----------|---------|---------|
| Calendar (wall clock) | `OnCalendar` | `Mon *-*-* 09:00:00` | Every Monday at 09:00 |
| Boot-relative | `OnBootSec` | `OnBootSec=5min` | 5 minutes after boot |
| Activation-relative | `OnActiveSec` | `OnActiveSec=1h` | 1 hour after timer starts |
| Unit-active-relative | `OnUnitActiveSec` | `OnUnitActiveSec=30min` | 30 min after last run completes |

### journalctl — Querying the Journal

journald collects stdout, stderr, syslog messages, kernel messages, and audit records into a structured binary journal stored under `/var/log/journal/` (persistent) or `/run/log/journal/` (volatile — lost on reboot). The binary format allows rich server-side filtering before any data is sent to your terminal.

```bash
# --- Basic service filtering ---
journalctl -u nginx                          # all logs for nginx.service
journalctl -u nginx -f                       # follow (like tail -f)
journalctl -u nginx -n 100                   # last 100 lines
journalctl -u nginx -b                       # since last boot
journalctl -u nginx -b -1                    # the boot before last

# --- Time filtering ---
journalctl -u nginx --since "2024-01-15 10:00:00"
journalctl -u nginx --since "1 hour ago"
journalctl -u nginx --since today --until "2024-01-15 12:00:00"

# --- Priority filtering (syslog levels) ---
journalctl -u nginx -p err                   # errors and above (emerg, alert, crit, err)
journalctl -u nginx -p warning..err          # range: warning to err

# --- Multiple units ---
journalctl -u nginx -u php-fpm               # logs interleaved from both services

# --- Output formats ---
journalctl -u nginx -o json-pretty           # structured JSON — great for parsing
journalctl -u nginx -o cat                   # message text only, no metadata
journalctl -u nginx --no-pager               # don't page; useful in scripts

# --- Kernel / system-wide ---
journalctl -k                                # kernel messages only (dmesg equivalent)
journalctl -b                                # all messages from current boot
journalctl --list-boots                      # show available boot records

# --- Disk usage and cleanup ---
journalctl --disk-usage
journalctl --vacuum-size=500M               # trim journal to 500MB
journalctl --vacuum-time=30d                # remove entries older than 30 days
```

**Persistence gotcha:** On a fresh Debian/Ubuntu install, the journal may be volatile (stored in `/run/`) and lost on reboot. To make it persistent:

```bash
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
```

Or set `Storage=persistent` in `/etc/systemd/journald.conf`.

**Rate limiting:** journald rate-limits log lines per service by default (`RateLimitIntervalSec=30s`, `RateLimitBurst=10000`). A chatty service that exceeds this will have log lines dropped, and you'll see `Suppressed N messages from myapp.service` in the journal. Raise the limits in `/etc/systemd/journald.conf` for noisy but important services, or fix the application's log verbosity.

**Forwarding to syslog/external systems:** For centralized log shipping (e.g., to Elasticsearch, Loki, Splunk), set `ForwardToSyslog=yes` in `journald.conf` or use `journalctl -o json` piped to your log shipper. Many modern agents (Promtail, Filebeat, Fluentd) can read the journal natively via the journal API without touching files at all.

### Overriding Package Unit Files

The correct override workflow is drop-in files, not editing `/lib/systemd/system/` directly (package upgrades will overwrite your changes with no warning).

```bash
# Preferred: use systemctl edit — opens $EDITOR, saves to the right place automatically
systemctl edit nginx
# Saves to: /etc/systemd/system/nginx.service.d/override.conf

# To override the entire unit (not just add stanzas), use --full
systemctl edit --full nginx
# Saves to: /etc/systemd/system/nginx.service (a full copy)
# Warning: you now own the full file — upstream changes won't reach you
```

A drop-in only needs the stanzas you want to change. systemd merges them on top of the base file:

```ini
# /etc/systemd/system/nginx.service.d/limits.conf
[Service]
LimitNOFILE=65536
LimitCORE=infinity
```

**Clearing a directive:** To unset a directive inherited from the base unit, set it to empty first, then set your value. This is mandatory for list-type directives like `ExecStart` — appending a second `ExecStart` without clearing adds a second execution, not a replacement:

```ini
[Service]
# Clear the upstream ExecStart before setting your own — required for ExecStart
ExecStart=
ExecStart=/usr/sbin/nginx -c /etc/nginx/nginx-custom.conf
```

After any unit file change:

```bash
systemctl daemon-reload    # re-read all unit files from disk
systemctl restart nginx    # apply changes to the running service
```

**`daemon-reload` is mandatory.** Editing a unit file on disk has zero effect until you reload. Forgetting this step is a very common source of confusion — you change the file, restart the service, and the old behavior persists because systemd is still running from its cached version.

### Diagnosing Boot and Dependency Problems

When a service fails to start, the debugging sequence follows a predictable path:

```bash
# Step 1: Check status — shows last few log lines inline
systemctl status myapp.service

# Step 2: Get full logs for this boot
journalctl -u myapp.service -b

# Step 3: Check what systemd thinks happened — exit code, signal, timing
systemctl show myapp.service --property=ExecMainStatus,ExecMainCode,Result

# Step 4: Inspect the dependency graph to find ordering problems
systemctl list-dependencies myapp.service
systemctl list-dependencies myapp.service --reverse  # what depends ON myapp?

# Step 5: Check for failed units system-wide
systemctl --failed

# Step 6: Analyze boot time for slow units
systemd-analyze blame             # sorted list of units by startup time
systemd-analyze critical-chain    # the critical path that determined total boot time
systemd-analyze verify myapp.service  # static lint check of the unit file
```

**`Result` field meanings:** When a service fails, `systemctl show` exposes a `Result` field that tells you *why* it failed:

| Result | Meaning |
|--------|---------|
| `success` | Exited cleanly |
| `exit-code` | Non-zero exit status |
| `signal` | Killed by a signal (check `ExecMainCode`) |
| `core-dump` | Process dumped core |
| `watchdog` | Watchdog timeout expired |
| `start-limit-hit` | Restart loop limit was reached |
| `oom-kill` | Killed by the OOM killer |

**`oom-kill` in production:** If you see `Result=oom-kill`, the kernel ran out of memory and killed your process — this is not a systemd restart. Check `journalctl -k | grep oom` for the kernel OOM killer's own log lines, which include memory stats at the time of the kill. The fix is at the application level (memory leak, oversized heap) or the host level (more RAM, cgroups memory limits).

---

## Examples

### Example 1: Deploying a Node.js API as a systemd Service

**Scenario:** You have a Node.js application at `/opt/api/server.js` that should run as a dedicated user, restart on failure, and start at boot.

```bash
# Create a dedicated system user (no home directory, no login shell)
useradd --system --no-create-home --shell /usr/sbin/nologin apiuser

# Create the environment file (keep secrets out of the unit file)
mkdir -p /etc/api
cat > /etc/api/env <<'EOF'
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://user:pass@localhost/mydb
EOF
chmod 600 /etc/api/env
chown root:apiuser /etc/api/env
```

```ini
# /etc/systemd/system/api.service
[Unit]
Description=My Node.js API Server
Documentation=https://github.com/myorg/api
After=network-online.target postgresql.service
Wants=network-online.target
# Soft dep on postgres — if it's not running, we'll fail at connection time
# but systemd won't block our start waiting for it
Requires=postgresql.service

[Service]
Type=simple
User=apiuser
Group=apiuser
WorkingDirectory=/opt/api

# Load secrets from a root-owned file — process inherits them as env vars
EnvironmentFile=/etc/api/env

ExecStartPre=/usr/bin/node --check /opt/api/server.js   # syntax check before starting
ExecStart=/usr/bin/node /opt/api/server.js

# Restart on crash, OOM kill, or signal — but NOT on clean exit (systemctl stop)
Restart=on-failure
RestartSec=10s

# Restart loop: if it crashes 5 times in 2 minutes, give up
StartLimitIntervalSec=120s
StartLimitBurst=5

# Security: drop capabilities and isolate filesystem
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/log/api /var/lib/api

# Logging: stdout/stderr go directly to journald — no log file needed
StandardOutput=journal
StandardError=journal
SyslogIdentifier=api-server

[Install]
WantedBy=multi-user.target
```

```bash
# Install and start the service
systemctl daemon-reload
systemctl enable --now api.service

# Verify it came up correctly
systemctl status api.service

# Check startup logs
journalctl -u api.service -b -n 50

# Test that it survives a simulated crash
kill -9 $(systemctl show api.service --property=MainPID --value)
# Wait 10 seconds (RestartSec), then check it restarted
sleep 12 && systemctl status api.service
```

---

### Example 2: Replacing a Cron Job with a systemd Timer

**Scenario:** A cron job runs `/usr/local/bin/cleanup-old-logs.sh` every day at 3 AM. Migrate it to a systemd timer so failures appear in `systemctl --failed` and logs are captured in journald.

```ini
# /etc/systemd/system/cleanup-logs.service
[Unit]
Description=Clean up application logs older than 30 days
After=local-fs.target

[Service]
Type=oneshot
# Run as root because logs are in /var/log with mixed ownership
User=root
ExecStart=/usr/local/bin/cleanup-old-logs.sh
# On success, write a timestamp so we can verify last run
ExecStartPost=/bin/sh -c 'date > /var/run/cleanup-logs-last-run'

# If the script fails, send an alert via a notification script
OnFailure=notify-on-failure@%n.service

# No [Install] section — started exclusively by the timer
```

```ini
# /etc/systemd/system/cleanup-logs.timer
[Unit]
Description=Daily log cleanup at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
# Randomize within 20 minutes to avoid all servers hitting storage simultaneously
RandomizedDelaySec=20min
# Run once on next boot if last scheduled run was missed (e.g., server was down)
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
# Remove the old cron job first
crontab -l | grep -v cleanup-old-logs | crontab -

# Deploy the timer
systemctl daemon-reload
systemctl enable --now cleanup-logs.timer

# Confirm it's scheduled
systemctl list-timers cleanup-logs.timer

# Test the service immediately without waiting for 3AM
systemctl start cleanup-logs.service

# Check the result
systemctl status cleanup-logs.service
journalctl -u cleanup-logs.service -n 30
cat /var/run/cleanup-logs-last-run
```

---

### Example 3: Overriding a Package-Installed Service with a Drop-In

**Scenario:** The package-installed `postgresql.service` uses a default memory configuration. You need to set `POSTGRES_HUGE_PAGES=try` and raise the open file limit without owning the entire unit file.

```bash
# Inspect what the package provides
systemctl cat postgresql.service

# Create a drop-in — systemctl edit opens $EDITOR automatically
# and places the file in the correct .d/ directory
systemctl edit postgresql.service
```

```ini
# systemctl edit places this at:
# /etc/systemd/system/postgresql.service.d/override.conf

[Service]
# Raise file descriptor limit for many concurrent connections
LimitNOFILE=102400

# Add an environment variable on top of whatever the package sets
# (note: we are NOT clearing Environment= first, so this is additive)
Environment=POSTGRES_HUGE_PAGES=try

# Run a pre-start check that the data directory has correct ownership
ExecStartPre=/bin/sh -c 'stat -c "%U" /var/lib/postgresql/data | grep -q postgres || exit 1'
```

```bash
# Reload systemd and apply changes
systemctl daemon-reload

# Verify the merged configuration shows your additions
systemctl cat postgresql.service      # shows base + drop-in markers
systemctl show postgresql.service --property=LimitNOFILE,Environment

# Restart to apply
systemctl restart postgresql.service
systemctl status postgresql.service
```

---

### Example 4: Diagnosing a Service That Fails to Start

**Scenario:** After a deployment, `myapp.service` shows `failed` state. Walk through the full diagnosis.

```bash
# Step 1: Quick overview — note the exit code and the last few log lines
systemctl status myapp.service
# Output shows: "code=exited, status=1/FAILURE"

# Step 2: Full logs from this boot to see the complete error
journalctl -u myapp.service -b --no-pager
# Output: "Error: cannot open config file /etc/myapp/config.yaml: no such file"

# Step 3: Confirm the result code programmatically
systemctl show myapp.service --property=Result,ExecMainStatus
# Result=exit-code
# ExecMainStatus=1

# Step 4: Check if ExecStartPre failed (common cause — pre-check exits non-zero)
journalctl -u myapp.service -b -p err

# Step 5: Verify the binary and config exist where the unit expects them
systemctl cat myapp.service | grep Exec
# ExecStart=/opt/myapp/bin/server --config /etc/myapp/config.yaml

ls -la /etc/myapp/config.yaml
# ls: cannot access '/etc/myapp/config.yaml': No such file or directory

# Fix: restore the config file from your configuration management or backup
cp /etc/myapp/config.yaml.example /etc/myapp/config.yaml
chown myapp:myapp /etc/myapp/config.yaml

# Restart and verify
systemctl start myapp.service
systemctl status myapp.service
# Active: active (running) since ...

# Step 6: If restart loop was hit, reset the failure counter first
systemctl reset-failed myapp.service
systemctl start myapp.service
```

---

## Exercises

### Exercise 1: Write and Deploy a Custom Service Unit

Create a minimal web server using Python's built-in HTTP server and manage it as a proper systemd service.

1. Create a system user `webdemo` with no login shell.
2. Write `/etc/systemd/system/webdemo.service` that:
   - Runs `python3 -m http.server 8888` from `/var/www/html` as the `webdemo` user.
   - Sets `Restart=on-failure` and `RestartSec=5s`.
   - Enables with `WantedBy=multi-user.target`.
   - Sets `NoNewPrivileges=yes` and `PrivateTmp=yes`.
3. Enable and start the service. Verify with `systemctl status` and `curl localhost:8888`.
4. Simulate a crash by sending `SIGKILL` to the main PID. Confirm the service restarts within 10 seconds.
5. Check the journal for the restart event. What log lines does systemd emit between the crash and the successful restart?

**What to figure out:** How do you find the MainPID without hardcoding it? What does `systemctl show` expose? Why does `PrivateTmp=yes` not affect `curl` running in your shell?

---

### Exercise 2: Investigate and Fix a Broken Service

**Setup:** Run this to create a broken service:

```bash
cat > /etc/systemd/system/broken.service <<'EOF'
[Unit]
Description=Intentionally Broken Service

[Service]
Type=simple
ExecStart=/usr/local/bin/nonexistent-binary
Restart=on-failure
RestartSec=2s
StartLimitBurst=3
StartLimitIntervalSec=30s

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl start broken.service || true
```

**Tasks:**

1. Use `systemctl status` and `journalctl` to determine exactly why the service failed. What is the `Result` value?
2. After the restart loop exhausts itself, what does `systemctl status` show as the final state?
3. Fix the service by creating `/usr/local/bin/nonexistent-binary` as a script that prints "hello" and exits 0. What additional step is required before systemd will find the fix?
4. The service is now stuck in the restart limit. How do you clear it and start fresh without rebooting?
5. Move `StartLimitBurst` and `StartLimitIntervalSec` to the `[Unit]` section. Run `systemd-analyze verify broken.service`. What does this tell you about your unit file?

---

### Exercise 3: Build a systemd Timer to Replace a Cron Job

**Scenario:** You have this cron job: `*/5 * * * * /usr/local/bin/health-check.sh >> /var/log/health-check.log 2>&1`

1. Write `health-check.sh` — it should check if port 80 is open on localhost using `nc` or `curl` and exit non-zero if it's not.
2. Write a `health-check.service` (Type=oneshot) and `health-check.timer` that runs every 5 minutes. Do **not** redirect output to a file — let journald capture it.
3. Enable the timer and verify `systemctl list-timers` shows the next trigger time.
4. Deliberately stop nginx (or any service on port 80) and manually trigger `systemctl start health-check.service`. Confirm the failure appears in `systemctl --failed` and in `journalctl -u health-check.service`.
5. Answer: why is a systemd timer with `Persistent=true` more reliable than cron for a job on a laptop or a spot instance that may not always be running at the scheduled time?

---

### Exercise 4: Practice Drop-In Overrides and Inspect Merged Configuration

1. Find the package-installed unit file for `ssh.service` (or `sshd.service`). Display it with `systemctl cat`.
2. Use `systemctl edit sshd.service` to add a drop-in that:
   - Sets `RestartSec=10s` and `Restart=always`.
   - Adds `Environment=MY_CUSTOM_VAR=devops-practice`.
3. Without restarting sshd yet, use `systemctl show sshd.service` to confirm your changes are reflected in the merged configuration. What command shows you only the `Restart` and `RestartSec` properties?
4. Apply the changes by reloading and restarting sshd. Verify the service is still reachable via SSH.
5. Now undo your changes cleanly: delete the drop-in file, reload the daemon, and confirm `systemctl cat sshd.service` no longer shows your override. What is the path of the file you need to remove?
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
# simple: ready immediately when ExecStart forks (default; use for most daemons)
# forking: legacy; ready after the process double-forks (old-style daemons)
# notify: ready when the process sends sd_notify(READY=1)
# oneshot: for scripts; systemd waits for the process to exit before marking active
# exec: like simple but waits until the exec() call succeeds
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
[Service]
StartLimitIntervalSec=60s   # observation window
StartLimitBurst=5           # max restarts in that window
# What to do when the limit is hit:
StartLimitAction=reboot-force   # or none (default), reboot, poweroff
```

**`RestartSec` interacts with `StartLimitBurst`:** A `RestartSec=30s` with `StartLimitBurst=5` means the limit won't be hit unless 5 crashes happen within 60 seconds even with 30s delays — tune both together.

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
```

When you `systemctl enable myapp.service`, systemd creates a symlink at `/etc/systemd/system/multi-user.target.wants/myapp.service` (assuming `WantedBy=multi-user.target`). The target "wants" the service, so when the system reaches `multi-user.target`, it starts your service.

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
journalctl -u nginx --since today

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

# --- Disk usage ---
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

**Clearing a directive:** To unset a directive inherited from the base unit, set it to empty first, then set your value:

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

### Timers (Cron Replacement)

A systemd timer consists of two units: a `.timer` that defines the schedule and a `.service` that does the work. This separation gives you full service features (logging, restart policies, sandboxing) for scheduled tasks.

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Database Backup

[Service]
Type=oneshot
User=backup
ExecStart=/usr/local/bin/backup.sh
```

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Run database backup daily at 2am

[Timer]
# Calendar syntax: DayOfWeek Year-Month-Day Hour:Minute:Second
OnCalendar=*-*-* 02:00:00
# Randomize start within a 10-minute window to avoid thundering herd
RandomizedDelaySec=600
# Catch up on missed runs (e.g., if system was off at 2am)
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now backup.timer

# Monitor timers
systemctl list-timers --all          # shows next/last trigger time for all timers

# Test a timer's service manually without waiting for the schedule
systemctl start backup.service
journalctl -u backup.service -n 50
```

**`OnCalendar` syntax quick reference:**

| Expression | Meaning |
|-----------|---------|
| `daily` | Every day at midnight |
| `hourly` | Top of every hour |
| `Mon *-*-* 08:00:00` | Every Monday at 8am |
| `*-*-* 02,14:00:00` | 2am and 2pm every day |
| `*-*
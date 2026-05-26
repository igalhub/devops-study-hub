---
title: systemd & Service Management
module: linux
duration_min: 20
difficulty: intermediate
tags: [systemd, systemctl, journald, services, units]
exercises: 4
---

## Overview
systemd is the init system and service manager used by all major Linux distributions (Ubuntu, Debian, RHEL, CentOS, Fedora). It starts as PID 1 at boot, manages services as *units*, and replaces older init scripts. Understanding systemd is non-negotiable for DevOps work — it controls how services start, restart, and log.

## Concepts

### Units
Everything systemd manages is a *unit*. The most common types:
| Type | Extension | Purpose |
|------|-----------|---------|
| Service | `.service` | A daemon or one-shot process |
| Timer | `.timer` | Cron replacement — triggers services on a schedule |
| Socket | `.socket` | Socket activation — starts a service on first connection |
| Mount | `.mount` | Filesystem mounts |
| Target | `.target` | Groups of units — like runlevels |

Unit files live in:
- `/lib/systemd/system/` — package-installed units (don't edit)
- `/etc/systemd/system/` — your overrides and custom units (edit here)

### Service States
- **active (running)** — process is running
- **active (exited)** — one-shot service completed successfully
- **inactive** — not running
- **failed** — exited with error or killed
- **enabled** — starts automatically at boot
- **disabled** — won't start at boot (but can be started manually)

### Restart Policies
In the `[Service]` section of a unit file:
- `Restart=no` — never restart (default)
- `Restart=on-failure` — restart if exit code is non-zero
- `Restart=always` — always restart, even on clean exit

## Examples

### Core systemctl Commands
```bash
# Start / stop / restart a service
systemctl start nginx
systemctl stop nginx
systemctl restart nginx
systemctl reload nginx        # reload config without full restart (if supported)

# Enable / disable at boot
systemctl enable nginx        # creates symlink → starts on boot
systemctl disable nginx       # removes symlink

# Combine: enable and start now
systemctl enable --now nginx

# Check status
systemctl status nginx

# List all running services
systemctl list-units --type=service --state=running

# List failed units
systemctl list-units --failed
```

### Reading Status Output
```bash
$ systemctl status sshd
● ssh.service - OpenBSD Secure Shell server
     Loaded: loaded (/lib/systemd/system/ssh.service; enabled; vendor preset: enabled)
     Active: active (running) since Mon 2024-01-15 09:00:00 UTC; 2h 30min ago
   Main PID: 1234 (sshd)
      Tasks: 1 (limit: 4915)
     CGroup: /system.slice/ssh.service
             └─1234 sshd: /usr/sbin/sshd -D
```
Key fields: `Loaded` (unit file found + boot setting), `Active` (current state + uptime), `Main PID`.

### Reading Logs with journalctl
systemd captures all service stdout/stderr in the *journal* — a structured binary log store.

```bash
# Logs for a specific service
journalctl -u nginx

# Follow live (like tail -f)
journalctl -u nginx -f

# Last 50 lines
journalctl -u nginx -n 50

# Since last boot
journalctl -u nginx -b

# Since a specific time
journalctl -u nginx --since "2024-01-15 10:00:00" --until "2024-01-15 11:00:00"

# All logs from last boot, newest first
journalctl -b -r

# Kernel messages only
journalctl -k
```

### Writing a Custom Service Unit
Create `/etc/systemd/system/myapp.service`:

```ini
[Unit]
Description=My Application Server
After=network.target          # start after network is up
Requires=postgresql.service   # hard dependency

[Service]
Type=simple
User=myapp
WorkingDirectory=/opt/myapp
ExecStart=/opt/myapp/bin/server --port 8080
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production
EnvironmentFile=/etc/myapp/env   # load env vars from file

[Install]
WantedBy=multi-user.target    # target to enable under (standard for most services)
```

After creating or modifying a unit file:
```bash
systemctl daemon-reload        # reload unit file changes
systemctl enable --now myapp
```

### Overriding Package Unit Files
Never edit files in `/lib/systemd/system/` — they'll be overwritten on package updates. Use drop-in overrides:

```bash
systemctl edit nginx           # opens an editor, saves to /etc/systemd/system/nginx.service.d/override.conf
```

Or create manually:
```bash
mkdir -p /etc/systemd/system/nginx.service.d/
cat > /etc/systemd/system/nginx.service.d/limits.conf << EOF
[Service]
LimitNOFILE=65536
EOF
systemctl daemon-reload
```

## Exercises

1. Find the unit file for the `cron` service and identify its `Restart` policy.
2. Check what services failed since the last boot: `systemctl list-units --failed`
3. Create a one-shot service unit that runs `echo "hello from systemd" >> /tmp/systemd-test.log` on demand. Start it manually and verify the log file was written.
4. Use `journalctl` to show all log entries from the `ssh` service in the last 10 minutes.

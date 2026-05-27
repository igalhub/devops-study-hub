---
title: Agents & Templates
module: zabbix
duration_min: 20
difficulty: intermediate
tags: [zabbix, agent, templates, lld, userparameter, discovery]
exercises: 3
---

## Overview

The Zabbix Agent is the primary collection mechanism for host-level metrics. It runs as a lightweight daemon on monitored systems and communicates with the Zabbix server through a structured key-value protocol. Unlike SNMP polling or agentless SSH checks, the agent has direct access to the host's kernel, filesystem, processes, and logs — making it the most capable and performant collection method for Linux and Windows systems. At scale, the difference between a well-configured agent deployment and a poorly planned one is the difference between a monitoring system that works and one that falls over under its own polling load.

Templates are Zabbix's configuration reuse mechanism. Instead of manually defining items, triggers, and graphs for each host, you define them once in a template and link that template to as many hosts as needed. Updates propagate automatically. Templates compose — a production web server template might link together an OS template, a network template, and an Nginx template, all managed independently. Low-Level Discovery (LLD) extends templates further by generating monitoring objects dynamically at runtime, removing the need to predict in advance how many disks, interfaces, or containers a host will have.

In the broader DevOps toolchain, these three features — agents, templates, and LLD — are what allow Zabbix to scale from 10 hosts to 10,000 without proportional administrative overhead. Infrastructure-as-code practices apply directly: templates can be exported as YAML, stored in Git, and imported via the API, enabling the same GitOps workflows used for application deployments. Understanding these components deeply is the prerequisite for treating Zabbix as a managed service rather than a manually operated tool.

## Concepts

### Active vs Passive Agents

This distinction determines who initiates the TCP connection for each check, and it has significant consequences for network architecture, scalability, and what types of checks are even possible.

| Mode | Who initiates | Direction | Listening port |
|------|--------------|-----------|----------------|
| Passive | Zabbix Server polls the agent | Server → Agent | 10050 (on agent) |
| Active | Agent sends data to server | Agent → Server | 10051 (on server) |

**Passive mode** is the simpler mental model: the server connects to the agent on port 10050 and requests a specific metric value. The agent responds and closes the connection. The server controls the schedule entirely. The downside is that the server must be able to reach every agent directly — this breaks in NAT environments, cloud VPCs with restrictive security groups, or any topology where agents are behind an egress-only firewall.

**Active mode** works the other way. On startup, the agent connects to the server on port 10051 and fetches a list of all active checks assigned to it. It then runs those checks locally on schedule and pushes the results back to the server. The server never initiates a connection to the agent. This means:
- Agents can sit behind NAT or strict firewalls with no inbound rules required.
- Log file monitoring (`log[]`, `logrt[]`) and Windows event log monitoring **only work in active mode** — they require the agent to stream data as events occur, not wait to be polled.
- At scale, the server handles incoming data streams rather than managing thousands of outbound polling connections, which reduces server-side scheduler load significantly.

**Recommendation:** prefer active checks for new deployments. The official built-in templates ship in two variants — for example, `Linux by Zabbix agent` (passive) and `Linux by Zabbix agent active` (active). Choose the active variant unless you have a specific reason not to.

**Gotcha:** if you configure only `ServerActive=` and omit `Server=`, passive checks will be refused. The agent logs `cannot connect: connection refused` is not the error you'll see — instead the server logs a timeout because nothing is listening for its connection attempt on 10050. The `Server=` directive is also an allowlist for passive connections; removing it is intentional for active-only deployments but will break any passive items you have configured.

### zabbix_agentd.conf

The agent configuration file lives at `/etc/zabbix/zabbix_agentd.conf` for the legacy C agent and `/etc/zabbix/zabbix_agent2.conf` for Agent 2. The syntax is identical for shared parameters; Agent 2 adds plugin-specific sections.

```ini
# /etc/zabbix/zabbix_agentd.conf

# PASSIVE: comma-separated list of server IPs allowed to poll this agent.
# Remove or leave empty to disable passive checks entirely.
Server=192.168.1.10,192.168.1.11

# ACTIVE: host:port of the server (or proxy) the agent sends data to.
# Multiple targets are comma-separated.
ServerActive=192.168.1.10:10051

# CRITICAL: must match the "Host name" in the Zabbix UI exactly.
# Case-sensitive. A mismatch causes the server to reject active check results silently.
Hostname=web-server-01

# Logging
LogFile=/var/log/zabbix/zabbix_agentd.log
LogFileSize=10          # MB; 0 = unlimited (dangerous in production)
DebugLevel=3            # 0=panic 1=crit 2=error 3=warn 4=debug 5=trace

# Key allowlist/denylist — defense-in-depth against unauthorized queries
# Order matters: rules are evaluated top-down, first match wins.
AllowKey=system.*
AllowKey=vfs.*
AllowKey=vm.*
AllowKey=net.*
AllowKey=proc.*
AllowKey=userparameter.*
DenyKey=*               # deny everything not matched above

# Include directory for UserParameter and other custom config fragments
Include=/etc/zabbix/zabbix_agentd.d/*.conf

# Maximum time (seconds) an agent check can run before timing out
Timeout=10

# Remote commands via Zabbix UI — disabled in most production environments
EnableRemoteCommands=0
```

**Agent 2 differences worth knowing:**

```ini
# /etc/zabbix/zabbix_agent2.conf (additions over classic agent)

# Agent 2 uses a single persistent connection for active checks
# instead of per-check connections
ControlSocket=/tmp/agent.sock

# Plugin-specific configuration sections
Plugins.SystemRun.LogRemoteCommands=0

# Agent 2 supports TLS natively with the same parameters as the server
TLSConnect=cert
TLSAccept=cert
TLSCAFile=/etc/zabbix/tls/ca.crt
TLSCertFile=/etc/zabbix/tls/agent.crt
TLSKeyFile=/etc/zabbix/tls/agent.key
```

**Gotcha:** `Hostname` in the config and the Host name in the Zabbix UI must match byte-for-byte. This is the single most common reason active agents silently fail to register. The server will log `received data from unregistered host` with the hostname the agent sent — check `/var/log/zabbix/zabbix_server.log` when debugging.

### Built-in Item Keys

Zabbix agents expose a large set of built-in keys covering OS-level metrics. Knowing the key format lets you construct and test items without guessing.

**Key format:** `key.namespace.metric[parameter1,parameter2,...]`

Parameters are positional. Omitting a parameter uses the default — `system.cpu.util[,idle]` leaves the first parameter (CPU number) as default (all CPUs) and requests the `idle` metric type.

| Key | Description | Returns |
|-----|-------------|---------|
| `system.cpu.load[all,avg1]` | Load average, 1-minute | `0.42` |
| `system.cpu.util[,idle]` | CPU idle percentage | `87.3` |
| `vm.memory.size[available]` | Available memory, bytes | `2147483648` |
| `vm.memory.size[pused]` | Memory used, percent | `43.2` |
| `vfs.fs.size[/,pused]` | Filesystem used, percent | `62.5` |
| `vfs.fs.discovery` | Discover mount points (LLD) | JSON array |
| `net.if.in[eth0,bytes]` | Network bytes received | `1234567890` |
| `net.if.discovery` | Discover interfaces (LLD) | JSON array |
| `proc.num[nginx]` | Count of matching processes | `4` |
| `proc.mem[nginx,,vsize]` | Memory used by process | `524288000` |
| `log[/var/log/app.log,ERROR,,100]` | Active log monitoring | Matching lines |
| `system.uname` | Kernel uname string | `Linux host 5.15...` |
| `agent.ping` | Agent availability | `1` |
| `agent.version` | Agent version string | `6.4.0` |
| `system.uptime` | Uptime in seconds | `864000` |

**Testing keys from the command line:**

```bash
# Test a passive key from the server or any host with zabbix_get installed
zabbix_get -s 192.168.1.20 -p 10050 -k "vfs.fs.size[/,pused]"

# Test with a timeout (useful for slow keys)
zabbix_get -s 192.168.1.20 -p 10050 -k "proc.num[nginx]" --timeout 10

# Test a key locally on the agent host (bypasses network entirely)
zabbix_agent2 -t "system.cpu.load[all,avg1]"
zabbix_agentd -t "vm.memory.size[available]"
```

**Gotcha:** `zabbix_get` only works for passive checks. If you've configured an active-only agent, `zabbix_get` will either refuse the connection (if `Server=` is absent) or return a value (if `Server=` is set as the allowlist, even with active checks). The `-t` flag on the agent binary tests the key locally without any network involvement and works regardless of check mode.

### UserParameter — Custom Item Keys

`UserParameter` maps a custom key name to a shell command. The agent executes the command when the key is requested (passive) or on schedule (active), and returns the command's stdout as the item value.

**Format:**
```
UserParameter=<key>[*],<command using $1 $2 ...>
```

`[*]` indicates the key accepts parameters. `$1`, `$2`, and so on are the arguments passed in the key call. If a key takes no parameters, omit the brackets entirely.

```ini
# /etc/zabbix/zabbix_agentd.d/custom.conf

# Count lines in any file — usage: custom.file.lines[/var/log/app.log]
UserParameter=custom.file.lines[*],wc -l < "$1" 2>/dev/null || echo 0

# Check if a systemd service is active — returns 1 (active) or 0 (inactive)
UserParameter=custom.service.active[*],systemctl is-active --quiet "$1" && echo 1 || echo 0

# Check if a TCP port is in LISTEN state — usage: custom.port.listening[8080]
UserParameter=custom.port.listening[*],ss -tln | grep -c ":$1 " || echo 0

# Poll a local Prometheus-format metrics endpoint for a specific metric value
UserParameter=app.queue.depth,curl -sf http://localhost:8080/metrics | awk '/^queue_depth / {print $2}'

# PostgreSQL active connections (runs as zabbix user — needs .pgpass or peer auth)
UserParameter=pg.connections.active,psql -U postgres -t -c \
  "SELECT count(*) FROM pg_stat_activity WHERE state='active';" 2>/dev/null | tr -d ' \n'

# Return JSON for custom LLD (see LLD section)
UserParameter=custom.app.discovery,/usr/local/bin/discover-app-instances.sh
```

**Security considerations:**

- UserParameter commands run as the `zabbix` OS user.
- The `zabbix` user should have minimal privileges. Use `sudo` only for specific commands with `NOPASSWD` entries scoped as tightly as possible.
- Avoid putting user-supplied data directly into shell commands without quoting — `"$1"` not `$1`.
- Use `UnsafeUserParameters=1` only if you need to pass characters like `\`, `'`, `"` as parameters; it's off by default for good reason.

**After adding a UserParameter, restart the agent:**
```bash
systemctl restart zabbix-agent2

# Verify the key works locally before testing from the server
zabbix_agent2 -t "custom.service.active[nginx]"

# Test from server (passive mode only)
zabbix_get -s <agent-ip> -p 10050 -k "custom.service.active[nginx]"
```

**Gotcha:** if the command returns an empty string or exits non-zero, Zabbix marks the item as unsupported and stops polling it until manually re-enabled or the next maintenance window. Always ensure your command outputs something — even `0` or `N/A` — in error conditions.

### Templates — Structure and Purpose

A Zabbix template is a named collection of monitoring objects that can be linked to hosts. Every object inside the template is inherited by every linked host. Updating the template propagates changes to all linked hosts immediately.

**Objects a template can contain:**

| Object | Purpose |
|--------|---------|
| **Items** | Metric collection definitions (key, interval, storage type) |
| **Triggers** | Alert conditions evaluated against item history |
| **Graphs** | Predefined metric visualizations |
| **Dashboards** | Host-scoped dashboard layouts |
| **Discovery rules** | LLD rules with item/trigger/graph prototypes |
| **Web scenarios** | Multi-step HTTP transaction monitoring |
| **Macros** | Template-scoped variables (e.g., `{$CPU.UTIL.CRIT}`) |

**Template macros** decouple thresholds from logic. A trigger expression like:

```
last(/Template Linux/system.cpu.util[,idle]) < {$CPU.IDLE.MIN}
```

…uses the macro `{$CPU.IDLE.MIN}` which defaults to `20` in the template but can be overridden at the host level. This means one template covers both a database server (where 10% idle CPU is a crisis) and a build server (where 5% idle is normal) without forking the template.

**Template inheritance (nesting):**

Templates can link other templates. This is the correct way to compose monitoring profiles:

```
Template: Production Web Server
  └── Template: Linux OS Base
  └── Template: Linux Network
  └── Template: App Nginx
  └── Template: TLS Certificate Expiry
```

When `Template: App Nginx` is updated, all hosts linked to `Template: Production Web Server` inherit the change. The nesting depth is not formally limited, but deeply nested chains become hard to audit.

**Template export/import for GitOps:**

```bash
# Export a template by ID to YAML via the Zabbix API
ZBXURL="http://zabbix-server/api_jsonrpc.php"
AUTH_TOKEN="your-api-token"

curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "configuration.export",
    "params": {
      "format": "yaml",
      "options": { "templates": ["10084"] }
    },
    "auth": "'"$AUTH_TOKEN"'",
    "id": 1
  }' | jq -r .result > templates/linux-base.yaml

# Import a template from YAML
curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "configuration.import",
    "params": {
      "format": "yaml",
      "rules": {
        "templates": {"createMissing": true, "updateExisting": true},
        "items": {"createMissing": true, "updateExisting": true, "deleteMissing": false},
        "triggers": {"createMissing": true, "updateExisting": true, "deleteMissing": false}
      },
      "source": "'"$(cat templates/linux-base.yaml)"'"
    },
    "auth
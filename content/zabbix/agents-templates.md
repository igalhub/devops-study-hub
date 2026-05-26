---
title: Agents & Templates
module: zabbix
duration_min: 20
difficulty: intermediate
tags: [zabbix, agent, templates, lld, userparameter, discovery]
exercises: 3
---

## Overview
The Zabbix Agent is the primary collection mechanism for host-level metrics. It runs as a daemon on monitored systems and exposes metrics through a simple key-value protocol. Templates are Zabbix's answer to configuration reuse — they bundle items, triggers, graphs, and discovery rules so you can apply the same monitoring profile to hundreds of hosts by linking a single template. Low-Level Discovery (LLD) takes templates further by automatically creating items for dynamically appearing entities like disks, network interfaces, or running services. Mastering these three topics is essential for running Zabbix at scale without manually configuring every host.

## Concepts

### Active vs Passive Agents
This is one of the most important Zabbix concepts for both operations and interviews.

| Mode | Who initiates | Direction | Port |
|------|--------------|-----------|------|
| Passive | Zabbix Server polls the agent | Server → Agent | 10050 (agent listens) |
| Active | Agent sends data to server | Agent → Server | 10051 (server listens) |

**Passive mode:**
- The server connects to the agent on port 10050 and requests a specific metric.
- Simpler to reason about — the server controls when checks run.
- Requires the server to be able to reach the agent directly. Breaks in NAT or firewall environments where the agent is behind a restrictive egress-only firewall.

**Active mode:**
- The agent establishes a persistent or periodic connection to the server/proxy.
- The agent fetches its active check list from the server on startup and after a configurable interval.
- Works in environments where only outbound connections from the agent are allowed.
- Supports log file monitoring and event log monitoring (Windows) — these require active mode because the agent pushes data as events occur.
- Higher scalability: the server receives pushed data instead of polling thousands of agents simultaneously.

**Recommendation:** prefer active checks for new deployments, especially at scale. Many Zabbix templates provide both active and passive variants (e.g., `Linux by Zabbix agent` vs `Linux by Zabbix agent active`).

### zabbix_agentd.conf
The agent configuration file is `/etc/zabbix/zabbix_agentd.conf` (or `zabbix_agent2.conf` for Agent 2).

```ini
# /etc/zabbix/zabbix_agentd.conf

# For PASSIVE checks — the server IP(s) allowed to poll this agent
Server=192.168.1.10,192.168.1.11

# For ACTIVE checks — where the agent sends data
ServerActive=192.168.1.10:10051

# Must match the host name defined in Zabbix UI exactly
Hostname=web-server-01

# Log settings
LogFile=/var/log/zabbix/zabbix_agentd.log
LogFileSize=10

# Security — limit what can be queried
AllowKey=system.*
AllowKey=vfs.*
AllowKey=vm.*
AllowKey=net.*
AllowKey=proc.*
AllowKey=userparameter.*
DenyKey=*

# Includes for user-defined parameters
Include=/etc/zabbix/zabbix_agentd.d/*.conf

# Timeouts
Timeout=10

# Allow remote commands (not recommended in production without careful audit)
EnableRemoteCommands=0
```

**Zabbix Agent 2** (`zabbix_agent2`) is the current generation — written in Go, supports plugins, and is preferred for new deployments. Configuration syntax is the same with additions for plugin-specific sections.

### Built-in Item Keys
Zabbix agents expose hundreds of built-in keys. Understanding the key format is important for writing templates and debugging.

**Key format:** `key[parameter1,parameter2]`

| Key | Description | Example |
|-----|-------------|---------|
| `system.cpu.load[all,avg1]` | CPU load average (1 min) | Returns: 0.42 |
| `system.cpu.util[,idle]` | CPU idle % | Returns: 87.3 |
| `vm.memory.size[available]` | Available memory in bytes | Returns: 2147483648 |
| `vfs.fs.size[/,pused]` | Filesystem usage % | Returns: 62.5 |
| `vfs.fs.discovery` | Discover mounted filesystems (LLD) | Returns: JSON array |
| `net.if.in[eth0,bytes]` | Network bytes received | Returns: 1234567890 |
| `net.if.discovery` | Discover network interfaces (LLD) | Returns: JSON array |
| `proc.num[nginx]` | Count of running nginx processes | Returns: 4 |
| `log[/var/log/app.log,ERROR]` | Active log monitoring for pattern | Returns: matching lines |
| `system.uname` | Kernel uname string | Returns: Linux host 5.15... |
| `agent.ping` | Agent availability check | Returns: 1 |

**Test any key from the server:**
```bash
zabbix_get -s 192.168.1.20 -p 10050 -k "vfs.fs.size[/,pused]"
```

### UserParameter — Custom Item Keys
`UserParameter` lets you define custom keys backed by shell commands. This is how Zabbix monitors anything outside its built-in catalog.

**Format:**
```
UserParameter=key[*],command $1 $2
```

`[*]` accepts parameters. `$1`, `$2`... are positional arguments passed from the key.

**Examples:**

```ini
# /etc/zabbix/zabbix_agentd.d/custom.conf

# Count lines in a file
UserParameter=custom.file.lines[*],wc -l < $1

# Check if a systemd service is active (returns 1 or 0)
UserParameter=custom.service.active[*],systemctl is-active --quiet $1 && echo 1 || echo 0

# Application-specific metric — query a local HTTP endpoint
UserParameter=app.queue.depth,curl -sf http://localhost:8080/metrics/queue_depth

# PostgreSQL — number of active connections
UserParameter=pg.connections,psql -U postgres -t -c "SELECT count(*) FROM pg_stat_activity WHERE state='active';" | tr -d ' '
```

**Security note:** UserParameter commands run as the `zabbix` user. Avoid `sudo` unless unavoidable; use file permissions and dedicated scripts with minimal privileges.

After adding a `UserParameter`, restart the agent:
```bash
systemctl restart zabbix-agent2
# Test from server:
zabbix_get -s <agent-host> -p 10050 -k "custom.service.active[nginx]"
```

### Templates — Structure and Purpose
A Zabbix template is a container for:
- **Items** — metric definitions (what to collect and how)
- **Triggers** — alert conditions based on item values
- **Graphs** — predefined visualizations
- **Dashboards** — host-level dashboard presets
- **Discovery rules** — LLD definitions
- **Web scenarios** — HTTP transaction monitoring steps

Templates are linked to hosts. When a template is updated, all linked hosts inherit the change automatically. This is Zabbix's primary mechanism for managing monitoring at scale.

**Template inheritance:** templates can link other templates. A "Linux server" template might include "Linux OS" + "Linux network" + "SMART disk health" sub-templates.

### Importing Community Templates
Zabbix hosts a template library at `https://www.zabbix.com/integrations`. Templates are distributed as XML or YAML files.

**Import process:**
```
Configuration → Templates → Import
```
Upload the `.yaml` or `.xml` file. Resolve any missing macros (shown as warnings during import).

**Common community templates:**
- `Template App Nginx by Zabbix agent` — built-in since Zabbix 5.4
- `Template App PostgreSQL by Zabbix agent 2` — built-in
- `Template Net Cisco IOS by SNMP` — network device monitoring
- `Template App Docker by Zabbix agent 2` — Docker engine metrics

**Via API (for automation):**
```bash
# Export a template to YAML
curl -s -X POST http://zabbix-server/api_jsonrpc.php \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "configuration.export",
    "params": {
      "format": "yaml",
      "options": { "templates": ["10001"] }
    },
    "auth": "<auth-token>",
    "id": 1
  }' | jq -r .result > template-export.yaml
```

### Low-Level Discovery (LLD)
LLD automatically creates items, triggers, and graphs for entities that are not known at configuration time — filesystem mount points, network interfaces, running services, Docker containers, etc.

**How it works:**
1. A **Discovery rule** runs a key (e.g., `vfs.fs.discovery`) that returns a JSON array of discovered objects.
2. Each object in the JSON has named fields called **LLD macros** (e.g., `{#FSNAME}`, `{#FSTYPE}`).
3. **Item prototypes** use these macros in their key and name. When discovery runs, Zabbix instantiates one real item per discovered object.

**Example — filesystem discovery:**

Discovery rule key: `vfs.fs.discovery`
Returned JSON (from the agent):
```json
[
  { "{#FSNAME}": "/",      "{#FSTYPE}": "ext4" },
  { "{#FSNAME}": "/data",  "{#FSTYPE}": "xfs" },
  { "{#FSNAME}": "/boot",  "{#FSTYPE}": "vfat" }
]
```

Item prototype:
```
Key:  vfs.fs.size[{#FSNAME},pused]
Name: Filesystem {#FSNAME}: space used %
```

Zabbix instantiates three items:
- `vfs.fs.size[/,pused]`
- `vfs.fs.size[/data,pused]`
- `vfs.fs.size[/boot,pused]`

Trigger prototype:
```
Expression: last(/host/vfs.fs.size[{#FSNAME},pused]) > 90
Name: Filesystem {#FSNAME} is more than 90% full
```

Three triggers are created automatically. When `/data` fills up, only that trigger fires.

**Filter LLD results** to exclude unwanted entries:
```
Filter: {#FSTYPE} NOT MATCHES_REGEX tmpfs|devtmpfs|squashfs
```

**Custom LLD with UserParameter:**
```ini
UserParameter=custom.app.discovery,/usr/local/bin/discover-services.sh
```
The script must output a valid JSON array with `{#MACRO}` keys.

## Exercises

1. Configure Zabbix Agent 2 on a host in **active mode** only (remove `Server=` and set only `ServerActive=`). Create a `UserParameter` that checks whether a specific port is listening using `ss -tln | grep -c :<port>`. Test the key with `zabbix_get` from another host (this should fail for active-only — understand why, and what to use instead for testing active items).
2. Import the official `Template App Nginx by Zabbix agent 2` template, link it to a host running Nginx, and confirm at least three items are collecting data. Identify one trigger in the template and explain the threshold logic in the trigger expression.
3. Write a custom LLD discovery script that returns a JSON array of all running systemd services in `active` state. Define a discovery rule using this script, create an item prototype for `custom.service.active[{#SERVICE}]`, and verify Zabbix auto-creates items for each discovered service.

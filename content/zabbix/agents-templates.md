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

**Gotcha:** if you configure only `ServerActive=` and omit `Server=`, passive checks will be refused. The `Server=` directive is also an allowlist for passive connections; removing it is intentional for active-only deployments but will break any passive items you have configured. When debugging, check `/var/log/zabbix/zabbix_server.log` for `received data from unregistered host` — this almost always means a `Hostname` mismatch, not a network problem.

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
# instead of per-check connections — dramatically reduces connection overhead
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

**Classic agent vs Agent 2 — when to choose which:**

| Factor | Classic Agent (C) | Agent 2 (Go) |
|--------|-------------------|--------------|
| Resource footprint | ~5 MB RAM | ~15–30 MB RAM |
| Plugin extensibility | UserParameter only | Go plugin API + UserParameter |
| Persistent connections | No (per-check) | Yes (single multiplexed) |
| Built-in integrations | Basic OS checks | Docker, PostgreSQL, MySQL, Redis, etc. |
| Log monitoring | Active mode only | Active mode only |
| Recommended for | Legacy/minimal systems | All new deployments |

**Gotcha:** `Hostname` in the config and the Host name in the Zabbix UI must match byte-for-byte, including case and whitespace. This is the single most common reason active agents silently fail to register. The server will log `received data from unregistered host` with the hostname the agent sent — always start debugging there.

### Built-in Item Keys

Zabbix agents expose a large set of built-in keys covering OS-level metrics. Knowing the key format lets you construct and test items without guessing.

**Key format:** `namespace.category.metric[parameter1,parameter2,...]`

Parameters are positional. Omitting a parameter uses the default — `system.cpu.util[,idle]` leaves the first parameter (CPU number) as default (all CPUs) and requests the `idle` metric type.

| Key | Description | Example return |
|-----|-------------|----------------|
| `system.cpu.load[all,avg1]` | Load average, 1-minute | `0.42` |
| `system.cpu.util[,idle]` | CPU idle percentage | `87.3` |
| `vm.memory.size[available]` | Available memory, bytes | `2147483648` |
| `vm.memory.size[pused]` | Memory used, percent | `43.2` |
| `vfs.fs.size[/,pused]` | Filesystem used, percent | `62.5` |
| `vfs.fs.discovery` | Discover mount points (LLD) | JSON array |
| `net.if.in[eth0,bytes]` | Network bytes received | `1234567890` |
| `net.if.discovery` | Discover interfaces (LLD) | JSON array |
| `proc.num[nginx]` | Count of matching processes | `4` |
| `proc.mem[nginx,,vsize]` | Virtual memory used by process | `524288000` |
| `log[/var/log/app.log,ERROR,,100]` | Active log monitoring | Matching lines |
| `agent.ping` | Agent availability check | `1` |
| `agent.version` | Agent version string | `6.4.0` |
| `system.uptime` | Uptime in seconds | `864000` |

**Testing keys from the command line:**

```bash
# Test a passive key from the server or any host with zabbix_get installed
zabbix_get -s 192.168.1.20 -p 10050 -k "vfs.fs.size[/,pused]"

# Test with an explicit timeout (useful for slow or hanging keys)
zabbix_get -s 192.168.1.20 -p 10050 -k "proc.num[nginx]" --timeout 10

# Test a key locally on the agent host — bypasses network entirely, works for both modes
zabbix_agent2 -t "system.cpu.load[all,avg1]"
zabbix_agentd -t "vm.memory.size[available]"
```

**Gotcha:** `zabbix_get` only tests passive checks. If you've configured an active-only agent (no `Server=` directive), `zabbix_get` will time out because nothing is listening on port 10050. Use the `-t` flag on the agent binary itself for local testing — it works regardless of active/passive configuration and is the faster debugging path.

### UserParameter — Custom Item Keys

`UserParameter` maps a custom key name to a shell command. The agent executes the command when the key is requested (passive) or on schedule (active), and returns the command's stdout as the item value.

**Format:**
```
UserParameter=<key>[*],<command>
```

`[*]` indicates the key accepts parameters. `$1`, `$2`, and so on are the positional arguments passed in the key call. If a key takes no parameters, omit the brackets entirely.

```ini
# /etc/zabbix/zabbix_agentd.d/custom.conf

# Count lines in any file — usage: custom.file.lines[/var/log/app.log]
UserParameter=custom.file.lines[*],wc -l < "$1" 2>/dev/null || echo 0

# Check if a systemd service is active — returns 1 (active) or 0 (inactive)
UserParameter=custom.service.active[*],systemctl is-active --quiet "$1" && echo 1 || echo 0

# Check if a TCP port is in LISTEN state — usage: custom.port.listening[8080]
UserParameter=custom.port.listening[*],ss -tln | grep -c ":$1 " || echo 0

# Poll a local Prometheus-format metrics endpoint for a specific metric value
# Requires curl; parses only the unquoted gauge/counter line
UserParameter=app.queue.depth,curl -sf http://localhost:8080/metrics | awk '/^queue_depth / {print $2}'

# PostgreSQL active connections (runs as zabbix user — needs .pgpass or peer auth)
UserParameter=pg.connections.active,psql -U postgres -t -c \
  "SELECT count(*) FROM pg_stat_activity WHERE state='active';" 2>/dev/null | tr -d ' \n'

# Return JSON for use with custom LLD (see Low-Level Discovery section)
UserParameter=custom.app.discovery,/usr/local/bin/discover-app-instances.sh
```

**Security considerations:**

- UserParameter commands run as the `zabbix` OS user.
- The `zabbix` user should have minimal privileges. Use `sudo` only for specific commands with tightly scoped `NOPASSWD` entries in `/etc/sudoers.d/`.
- Always quote `"$1"` not `$1` to prevent word splitting and path injection.
- `UnsafeUserParameters=1` permits backslashes, quotes, and shell metacharacters in parameters — only enable it if unavoidable, and never on internet-facing agents.

**After adding or modifying a UserParameter, restart the agent:**

```bash
systemctl restart zabbix-agent2

# Verify the key works locally before testing from the server
zabbix_agent2 -t "custom.service.active[nginx]"
# Expected: custom.service.active[nginx]          [s|1]

# Test from the server (passive mode only)
zabbix_get -s <agent-ip> -p 10050 -k "custom.service.active[nginx]"
```

**Gotcha:** if a UserParameter command returns an empty string or exits non-zero without producing output, Zabbix marks the item as **unsupported** and stops polling it entirely. It will not retry until you manually re-enable it or the `UnsupportedItemCheckFrequency` interval elapses (default: 10 minutes). Always ensure your command produces output in all exit conditions — even `echo 0` on failure is better than silence.

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

When `Template: App Nginx` is updated, all hosts linked to `Template: Production Web Server` inherit the change automatically. Avoid deeply nested chains (more than 3–4 levels) — they become difficult to audit and the inheritance path becomes non-obvious when debugging unexpected trigger behavior.

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

# Import a template from YAML — safe to run repeatedly (idempotent with these rules)
curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "configuration.import",
    "params": {
      "format": "yaml",
      "rules": {
        "templates":  {"createMissing": true, "updateExisting": true},
        "items":      {"createMissing": true, "updateExisting": true, "deleteMissing": false},
        "triggers":   {"createMissing": true, "updateExisting": true, "deleteMissing": false},
        "graphs":     {"createMissing": true, "updateExisting": true, "deleteMissing": false},
        "discoveryRules": {"createMissing": true, "updateExisting": true, "deleteMissing": false}
      },
      "source": "'"$(cat templates/linux-base.yaml | jq -Rs .)"'"
    },
    "auth": "'"$AUTH_TOKEN"'",
    "id": 2
  }'
```

**Gotcha:** `deleteMissing: true` on items or triggers will delete any object in the running configuration that isn't present in your YAML file. This is useful for keeping templates clean but dangerous if you're importing a partial export — you can silently delete production monitoring. Leave it `false` until you're managing the full template lifecycle from code.

### Low-Level Discovery (LLD)

LLD solves a specific problem: you can't write a template item for every filesystem, network interface, CPU core, Docker container, or JVM pool at template-authoring time — you don't know how many there will be. LLD discovers them at runtime and creates items, triggers, and graphs automatically.

**How LLD works:**

1. A **discovery rule** runs on a schedule and returns a JSON array of discovered objects.
2. Each object in the array contains **LLD macros** — key-value pairs like `{#FSNAME}` or `{#IFNAME}`.
3. **Prototypes** (item prototypes, trigger prototypes, graph prototypes) are templates that use those macros. For each discovered object, Zabbix instantiates one concrete item/trigger/graph by substituting the macro values.

**Discovery rule JSON format:**

```json
{
  "data": [
    { "{#FSNAME}": "/",     "{#FSTYPE}": "ext4" },
    { "{#FSNAME}": "/boot", "{#FSTYPE}": "ext4" },
    { "{#FSNAME}": "/data", "{#FSTYPE}": "xfs"  }
  ]
}
```

The built-in key `vfs.fs.discovery` returns exactly this format for all mounted filesystems. An item prototype using this discovery rule might be:

```
Key:  vfs.fs.size[{#FSNAME},pused]
Name: Filesystem {#FSNAME}: space used (%)
```

For a host with three filesystems, Zabbix creates three items: `vfs.fs.size[/,pused]`, `vfs.fs.size[/boot,pused]`, and `vfs.fs.size[/data,pused]`.

**Custom LLD with a UserParameter:**

```bash
#!/usr/bin/env bash
# /usr/local/bin/discover-app-instances.sh
# Discovers running Java app instances by scanning for PID files

echo '{"data":['
first=1
for pidfile in /var/run/myapp/*.pid; do
  [[ -f "$pidfile" ]] || continue
  instance=$(basename "$pidfile" .pid)
  port=$(grep -m1 'http.port' "/etc/myapp/${instance}.conf" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  [[ "$first" != "1" ]] && echo ","
  printf '  {"{#INSTANCE}": "%s", "{#PORT}": "%s"}' "$instance" "${port:-8080}"
  first=0
done
echo
echo ']}'
```

With this discovery script registered as a UserParameter and a discovery rule pointing at `custom.app.discovery`, Zabbix will create item prototypes like:

- `proc.num[myapp-{#INSTANCE}]` — process count per instance
- `net.tcp.service[http,,{#PORT}]` — HTTP port availability per instance
- A trigger prototype: "Instance {#INSTANCE} is down" firing when `proc.num` = 0

**LLD filter — avoid monitoring noise:**

Discovery rules accept filters to exclude unwanted objects. In the Zabbix UI (or YAML template), filters use regex against LLD macro values:

```yaml
# In exported template YAML — filter out tmpfs and devtmpfs filesystems
filter:
  evaltype: AND
  conditions:
    - macro: '{#FSTYPE}'
      value: 'tmpfs|devtmpfs|sysfs|proc'
      operator: NOT_MATCHES_REGEX
      formulaid: A
```

**Gotcha:** discovered items, triggers, and graphs are **owned by the discovery rule**. If a discovered object (e.g., a disk) disappears and the discovery rule runs again, Zabbix doesn't delete the generated items immediately — it marks them with a "lost resource" state and waits for the **Keep lost resources period** (default: 30 days) before deletion. Tune this value in the discovery rule to match your infrastructure's churn rate. For ephemeral containers, set it to hours, not days.

---

## Examples

### Example 1: Deploy and Verify an Active Agent on a New Linux Host

**Scenario:** you're onboarding a new Ubuntu application server. You want active checks, log monitoring enabled, and the host auto-registered.

```bash
# 1. Install Agent 2 on the target host
wget https://repo.zabbix.com/zabbix/6.4/ubuntu/pool/main/z/zabbix-release/zabbix-release_6.4-1+ubuntu22.04_all.deb
dpkg -i zabbix-release_6.4-1+ubuntu22.04_all.deb
apt update && apt install -y zabbix-agent2

# 2. Configure the agent
cat > /etc/zabbix/zabbix_agent2.conf << 'EOF'
# Active-only: no Server= directive means no passive checks accepted
ServerActive=192.168.1.10:10051

# Must match the Host name registered in Zabbix UI exactly
Hostname=app-server-prod-01

LogFile=/var/log/zabbix/zabbix_agent2.log
LogFileSize=20
DebugLevel=3
Timeout=10
EnableRemoteCommands=0

# Include drop-in configs for UserParameters
Include=/etc/zabbix/zabbix_agent2.d/*.conf
EOF

# 3. Enable and start
systemctl enable --now zabbix-agent2

# 4. Verify locally — agent should be able to execute keys without a server
zabbix_agent2 -t "agent.ping"
# Expected: agent.ping                            [s|1]

zabbix_agent2 -t "system.cpu.load[all,avg1]"
# Expected: system.cpu.load[all,avg1]             [u|0.18]

# 5. Verify the agent is connecting to the server — watch for active check list fetch
tail -f /var/log/zabbix/zabbix_agent2.log | grep -E "active check|getting"
# Expected: zabbix_agent2[...]: getting list of active checks
# Expected: zabbix_agent2[...]: in list of active checks
```

On the Zabbix server, go to **Monitoring → Hosts**, find `app-server-prod-01`, and confirm the ZBX icon turns green within 1–2 minutes.

---

### Example 2: Add a Custom UserParameter and Create an Item in the UI

**Scenario:** your application exposes a health endpoint at `http://localhost:9090/health` returning `ok` or `degraded`. You want to alert when it returns anything other than `ok`.

```bash
# 1. Create the UserParameter config file on the agent host
cat > /etc/zabbix/zabbix_agent2.d/app-health.conf << 'EOF'
# Returns 1 if healthy, 0 if degraded or unreachable
UserParameter=app.health.status,\
  result=$(curl -sf --max-time 5 http://localhost:9090/health 2>/dev/null); \
  [ "$result" = "ok" ] && echo 1 || echo 0
EOF

# 2. Restart the agent to load the new parameter
systemctl restart zabbix-agent2

# 3. Test locally
zabbix_agent2 -t "app.health.status"
# Expected: app.health.status                     [t|1]

# 4. Test from the Zabbix server (if passive is also configured)
zabbix_get -s 192.168.1.50 -p 10050 -k "app.health.status"
```

In the Zabbix UI, create a new item on the host:

```
Name:        Application health status
Type:        Zabbix agent (active)
Key:         app.health.status
Type of info: Numeric (unsigned)
Update interval: 60s
History:     7d
```

Create a trigger:

```
Name:        Application health degraded on {HOST.NAME}
Expression:  last(/app-server-prod-01/app.health.status)=0
Severity:    High
```

**Verify:** stop the application and wait up to 60 seconds — the trigger should fire. Restart the application — the trigger should resolve.

---

### Example 3: Export a Template to Git and Re-import It

**Scenario:** you want to version-control the `Linux by Zabbix agent active` template and make a threshold change via code.

```bash
#!/usr/bin/env bash
# export-template.sh — export a template by name, store to git repo

ZBXURL="http://192.168.1.10/api_jsonrpc.php"
TEMPLATE_NAME="Linux by Zabbix agent active"
OUTPUT_FILE="templates/linux-agent-active.yaml"

# Authenticate and get a token
TOKEN=$(curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","method":"user.login",
    "params":{"user":"Admin","password":"zabbix"},
    "id":1
  }' | jq -r .result)

# Resolve the template name to its internal ID
TMPL_ID=$(curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","method":"template.get",
    "params":{"output":["templateid"],"filter":{"host":["'"$TEMPLATE_NAME"'"]}},
    "auth":"'"$TOKEN"'","id":2
  }' | jq -r '.result[0].templateid')

echo "Exporting template ID: $TMPL_ID"

# Export to YAML
curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","method":"configuration.export",
    "params":{"format":"yaml","options":{"templates":["'"$TMPL_ID"'"]}},
    "auth":"'"$TOKEN"'","id":3
  }' | jq -r .result > "$OUTPUT_FILE"

echo "Exported to $OUTPUT_FILE"
git add "$OUTPUT_FILE"
git commit -m "chore: export $TEMPLATE_NAME from $(hostname)"
```

```bash
#!/usr/bin/env bash
# import-template.sh — import (or update) a template from YAML

ZBXURL="http://192.168.1.10/api_jsonrpc.php"
SOURCE_FILE="templates/linux-agent-active.yaml"

TOKEN=$(curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"user.login",
       "params":{"user":"Admin","password":"zabbix"},"id":1}' \
  | jq -r .result)

# jq -Rs . converts the file to a JSON-safe string (escapes newlines and quotes)
SOURCE=$(jq -Rs . < "$SOURCE_FILE")

curl -s -X POST "$ZBXURL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","method":"configuration.import",
    "params":{
      "format":"yaml",
      "rules":{
        "templates":      {"createMissing":true,"updateExisting":true},
        "items":          {"createMissing":true,"updateExisting":true,"deleteMissing":false},
        "triggers":       {"createMissing":true,"updateExisting":true,"deleteMissing":false},
        "graphs":         {"createMissing":true,"updateExisting":true,"deleteMissing":false},
        "discoveryRules": {"createMissing":true,"updateExisting":true,"deleteMissing":false},
        "templateLinkage":{"createMissing":true}
      },
      "source":'"$SOURCE"'
    },
    "auth":"'"$TOKEN"'","id":2
  }' | jq .
# A successful import returns: {"jsonrpc":"2.0","result":true,"id":2}
```

**Verify:** in the Zabbix UI, navigate to **Configuration → Templates**, find `Linux by Zabbix agent active`, and confirm the `Updated` timestamp changed.

---

### Example 4: Custom LLD for Multi-Instance Service Discovery

**Scenario:** a host runs multiple Nginx virtual hosts, each with a separate access log. You want Zabbix to automatically monitor all of them without updating the template when new vhosts are added.

```bash
# /usr/local/bin/discover-nginx-vhosts.sh
#!/usr/bin/env bash
# Discovers Nginx vhosts by scanning /etc/nginx/sites-enabled/
# Emits LLD JSON with {#VHOST} and {#LOGFILE} macros

vhosts=()
for conf in /etc/nginx/sites-enabled/*; do
  [[ -f "$conf" ]] || continue
  # Extract server_name and access_log from each config
  vhost=$(grep -m1 'server_name' "$conf" | awk '{print $2}' | tr -d ';')
  logfile=$(grep -m1 'access_log' "$conf" | awk '{print $2}' | tr -d ';')
  [[ -n "$vhost" && -n "$logfile" ]] && vhosts+=("{\"{\"{#VHOST}\"}\":\"$vhost\",\"{#LOGFILE}\":\"$logfile\"}")
done

# Output valid LLD JSON
echo "{\"data\":["
printf '%s\n' "${vhosts[@]}" | paste -sd','
echo "]}"
```

```ini
# /etc/zabbix/zabbix_agent2.d/nginx-discovery.conf
UserParameter=nginx.vhost.discovery,/usr/local/bin/discover-nginx-vhosts.sh
```

In the Zabbix UI, create a discovery rule on the host (or template):

```
Name:            Nginx vhost discovery
Type:            Zabbix agent (active)
Key:             nginx.vhost.discovery
Update interval: 1h
Keep lost resources period: 3d
```

Add item prototypes under this rule:

```
# Item prototype 1 — error rate
Name:  Nginx {#VHOST}: HTTP 5xx errors per minute
Key:   log[{#LOGFILE}," 5[0-9][0-9] ",,,skip]
Type:  Zabbix agent (active)

# Item prototype 2 — log file size as a proxy for activity
Name:  Nginx {#VHOST}: access log size
Key:   vfs.file.size[{#LOGFILE}]
Type:  Zabbix agent (active)
```

**Verify:** after the discovery interval runs, go to **Monitoring → Latest data**, filter by the host, and confirm separate items for each vhost are being collected.

---

## Exercises

### Exercise 1: Debug a Silent Active Agent

**Goal:** experience and resolve the most common active agent failure mode.

1. On a lab host with `zabbix-agent2` installed, set `Hostname=WRONG-NAME` in `/etc/zabbix/zabbix_agent2.conf` and `ServerActive=<your-server-ip>:10051`. Restart the agent.
2. On the Zabbix server, tail `/var/log/zabbix/zabbix_server.log` and identify the error message that appears when the agent tries to register.
3. Fix the hostname to match the host name configured in the Zabbix UI exactly. Restart the agent.
4. Confirm the fix by observing the server log again, then verify data is flowing in **Monitoring → Latest data**.

**What to understand:** why does Zabbix reject active data by hostname rather than by IP? What are the security and operational implications of this design?

---

### Exercise 2: Write and Test a Multi-Parameter UserParameter

**Goal:** write a UserParameter that takes two arguments and returns a meaningful value, then test it end-to-end.

1. Write a UserParameter `custom.process.cpu[*]` that accepts a process name as `$1` and returns the CPU usage percentage of that process (hint: use `ps` or `top -bn1`). Add it to `/etc/zabbix/zabbix_agent2.d/custom.conf`.
2. Restart the agent and test locally: `zabbix_agent2 -t "custom.process.cpu[nginx]"`. Confirm you get a numeric value.
3. If your agent is configured with `Server=` for passive checks, test from the server: `zabbix_get -s <agent-ip> -k "custom.process.cpu[nginx]"`.
4. Deliberately make the command return an empty string (e.g., query a non-existent process name). Observe in the Zabbix UI that the item enters **unsupported** state. Re-enable it manually from **Configuration → Hosts → Items**.

**What to understand:** what happens to an item's polling schedule after it becomes unsupported? How does this affect alerting coverage?

---

### Exercise 3: Build a Template with a Macro-Driven Trigger

**Goal:** create a reusable template where the alert threshold is configurable per host without modifying the template.

1. Create a new template called `Custom: Disk Usage` with a single item using key `vfs.fs.size[/,pused]`, type `Zabbix agent (active)`, update interval 5 minutes.
2. Add a template-level macro `{$DISK.PUSED.MAX}` with a default value of `80`.
3. Add a trigger with the expression: `last(/Custom: Disk Usage/vfs.fs.size[/,pused]) > {$DISK.PUSED.MAX}` and severity `Warning`.
4. Link the template to two lab hosts. On one host, override the macro value to `90` at the host level.
5. Verify the override is in effect: fill disk space on the host with the overridden macro to 85% (use `fallocate -l 1G /tmp/testfile`) and confirm the trigger fires on the default host but not on the overridden one.

**What to understand:** at what level does Zabbix resolve macros — template, host, or global? What is the precedence order when the same macro is defined at multiple levels?

---

### Exercise 4: Write a Custom LLD Discovery Script

**Goal:** implement end-to-end custom LLD for a real use case.

1. Write a shell script that discovers all TCP ports in `LISTEN` state on `localhost` (use `ss -tlnp`). For each port, emit an LLD JSON object with `{#PORT}` and `{#PROCESS}` macros. Save it to `/usr/local/bin/discover-listening-ports.sh` and make it executable.
2. Register it as `UserParameter=custom.ports.discovery,/usr/local/bin/discover-listening-ports.sh` and restart the agent. Validate locally: `zabbix_agent2 -t "custom.ports.discovery"` — confirm valid JSON output.
3. In the Zabbix UI, create a discovery rule using this key. Add an item prototype `net.tcp.service[tcp,,{#PORT}]` named `Port {#PORT} ({#PROCESS}): availability`.
4. Add a trigger prototype: "Port {#PORT} on {HOST.NAME} is unreachable" when `last(/…/net.tcp.service[tcp,,{#PORT}])=0`.
5. Wait for the discovery interval, then stop one of the discovered services (e.g., `systemctl stop ssh`). Confirm the trigger fires within one check interval and resolves when the service is restarted.

**What to understand:** what is the **Keep lost resources period** on a discovery rule, and what happens to the generated items and triggers when the discovery rule stops returning a previously known port?
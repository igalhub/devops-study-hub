---
title: Architecture & Installation
module: zabbix
duration_min: 20
difficulty: beginner
tags: [zabbix, architecture, installation, server, agent, database]
exercises: 3
---

## Overview

Zabbix is an enterprise-grade open-source monitoring platform that has been a staple of traditional infrastructure monitoring for over two decades. It monitors servers, network devices, applications, and cloud resources using both agent-based and agentless methods. Unlike newer cloud-native tools that emerged from the Kubernetes ecosystem, Zabbix is built for breadth — it handles SNMP for network switches, IPMI for bare-metal servers, and JMX for Java applications alongside standard Linux metrics. DevOps engineers encounter Zabbix heavily in on-premises and hybrid environments, and understanding its architecture is essential for both operating it and integrating it with modern tooling like Grafana or alerting pipelines built on PagerDuty and Opsgenie.

The design philosophy behind Zabbix is centralized control with distributed collection. One server owns all configuration, trigger evaluation, and alerting logic. Proxies push that collection perimeter outward — into remote datacenters, DMZs, or cloud VPCs — without creating independent control planes. This keeps operational complexity low while scaling geographically. The tradeoff is that the server and its database become a shared bottleneck; database tuning and cache configuration are therefore first-class operational concerns, not afterthoughts.

In the broader DevOps toolchain, Zabbix occupies the infrastructure observability layer. It excels at classic availability monitoring — "is this host up, is this service responding, is this disk filling?" — and at high-frequency metric collection from heterogeneous device types that a pure Prometheus stack would struggle to cover without extensive exporter management. In modern shops, Zabbix often coexists with Prometheus: Zabbix owns legacy infrastructure and network gear; Prometheus owns containerized workloads. Grafana sits above both, unifying dashboards via the Zabbix datasource plugin.

---

## Concepts

### Component Overview

Zabbix is a distributed system. Every component has a single, non-overlapping responsibility and communicates over well-defined protocols on fixed ports.

```
┌─────────────────────────────────────────────────────────┐
│                      ZABBIX SERVER                       │
│   Pollers │ Trappers │ Alerters │ Escalators │ DB Syncers│
└───────────────────────┬─────────────────────────────────┘
                        │ TCP 10051
            ┌───────────┴────────────┐
            │                        │
     ┌──────▼──────┐         ┌───────▼──────┐
     │ ZABBIX AGENT│         │ ZABBIX PROXY │
     │  (direct)   │         │ (remote site)│
     └─────────────┘         └──────┬───────┘
                                    │ TCP 10050/10051
                             ┌──────▼───────┐
                             │ ZABBIX AGENT │
                             │  (proxied)   │
                             └──────────────┘

     ┌─────────────────┐     ┌──────────────────┐
     │    DATABASE      │     │   WEB FRONTEND   │
     │ MySQL / PgSQL /  │     │  Nginx + PHP-FPM │
     │ TimescaleDB      │     │  + Zabbix API    │
     └─────────────────┘     └──────────────────┘
```

| Component | Role | Default Port |
|-----------|------|-------------|
| **Zabbix Server** | Central process — collects data, evaluates triggers, sends alerts, writes to DB | 10051 |
| **Zabbix Agent / Agent2** | Lightweight daemon on monitored hosts — collects local metrics, runs checks | 10050 |
| **Zabbix Proxy** | Collects data on behalf of server — buffers locally, forwards in bulk | 10051 |
| **Database** | Stores all configuration, collected history, events, acknowledgements | 3306 / 5432 |
| **Web Frontend** | PHP app — management UI and REST/JSON-RPC API | 80 / 443 |
| **Java Gateway** | Bridge process for JMX checks — server talks to it, it talks to JVM | 10052 |

**Architectural invariant:** the Zabbix Server is the only component that evaluates trigger expressions and fires alerts. Proxies collect and forward raw data — they never decide whether something is a problem. This means alerting always survives proxy failures gracefully: the proxy's buffered data arrives when connectivity is restored, triggers evaluate on arrival.

**Agent vs Agent2:** Agent2 is the modern replacement, written in Go. It supports concurrent active checks, plugin architecture, and significantly lower memory footprint. Unless you have a specific reason to use the legacy C agent, always install `zabbix-agent2`.

---

### Supported Databases

The database is the most consequential architectural decision in any Zabbix deployment. All collected data, all configuration, and all event history live there. Poor database choice or configuration is the primary cause of Zabbix performance degradation at scale.

| Database | Notes | Recommended For |
|----------|-------|-----------------|
| **MySQL / MariaDB** | Most common in existing deployments; requires InnoDB engine; good tooling | Existing MySQL shops; up to ~3,000 NVPS |
| **PostgreSQL** | Better concurrency model; superior JSON support for API-heavy use; no engine gotcha | New deployments; medium-to-large scale |
| **TimescaleDB** | PostgreSQL extension; stores history in hypertables with automatic time-based partitioning and native compression | High-throughput environments; >5,000 NVPS |
| **Oracle** | Supported; avoid unless enterprise licensing mandates it | Enterprise-only constraint |

**NVPS** (New Values Per Second) is the standard Zabbix throughput metric. A 1,000-host deployment collecting 60 items per host every 60 seconds produces ~1,000 NVPS. TimescaleDB compression can reduce history table storage by 90%+ and keeps `INSERT` performance flat over years of data accumulation.

**The history table problem:** Without TimescaleDB, the `history`, `history_uint`, `history_str`, and `trends` tables grow without bound. A two-year-old MySQL deployment with no partitioning will have hundreds-of-millions-row tables where even housekeeping `DELETE` statements cause lock contention. Plan for TimescaleDB or manual partitioning from day one.

```sql
-- Check history table row counts to assess DB health
SELECT table_name, table_rows
FROM information_schema.tables
WHERE table_schema = 'zabbix'
  AND table_name IN ('history','history_uint','history_str','trends','trends_uint')
ORDER BY table_rows DESC;
```

---

### Agent vs Agentless Monitoring

Zabbix supports both collection modes, and most real deployments use both simultaneously. The choice is determined by what you're monitoring, not a single global setting.

**Agent-based monitoring:**
- Zabbix Agent daemon runs on the target host.
- Supports **active** checks (agent initiates connection to server/proxy) and **passive** checks (server polls the agent).
- Grants access to local metrics not visible remotely: per-process CPU, open file descriptors, log file tailing, custom scripts.
- Preferred for Linux/Windows servers you control.

**Active vs Passive checks — a critical distinction:**

| Mode | Who initiates | Firewall implication | Best for |
|------|---------------|---------------------|---------|
| **Passive** | Server polls agent on TCP 10050 | Server must reach agent | Low-latency polling; server-side control |
| **Active** | Agent connects to server on TCP 10051 | Agent needs outbound only | NAT environments; agents behind firewalls |

**Agentless check types:**

| Check Type | Protocol | Typical Use Case |
|------------|----------|-----------------|
| ICMP ping | ICMP | Basic availability; latency measurement |
| SNMP v1/v2c/v3 | UDP 161 | Network switches, routers, UPS, printers |
| IPMI | IPMI/LAN | Bare-metal hardware sensors (temperature, fan, PSU) |
| JMX | JMX/RMI via Java Gateway | Java app metrics (heap, GC, thread pools) |
| HTTP agent | HTTP/HTTPS | Web endpoint checks; REST API polling; JSON path extraction |
| SSH / Telnet | SSH / TCP 23 | Run commands on hosts without an agent |
| External check | Shell script on server | Arbitrary custom logic executed by the server process |
| Database monitor | ODBC | Direct SQL queries against application databases |

**When agentless is not enough:** SNMP can tell you interface traffic and port status on a switch, but it cannot tell you which process is consuming CPU on a Linux host. Agent-based monitoring provides kernel-level visibility that no remote protocol can replicate. Use agentless for infrastructure you cannot install software on; use agents for everything else.

---

### Installation: Server, Database, and Frontend

Zabbix provides its own package repositories for all major distributions. Always use the official Zabbix repo rather than distribution-bundled packages — distro packages lag several major versions behind and lack up-to-date templates.

```bash
# --- Step 1: Add the official Zabbix 7.0 LTS repository (Ubuntu 22.04) ---
wget https://repo.zabbix.com/zabbix/7.0/ubuntu/pool/main/z/zabbix-release/zabbix-release_7.0-1+ubuntu22.04_all.deb
dpkg -i zabbix-release_7.0-1+ubuntu22.04_all.deb
apt update

# --- Step 2: Install server, frontend, and agent2 ---
apt install -y \
  zabbix-server-mysql \    # or zabbix-server-pgsql for PostgreSQL
  zabbix-frontend-php \
  zabbix-nginx-conf \
  zabbix-sql-scripts \
  zabbix-agent2

# --- Step 3: Create the database (MySQL example) ---
mysql -uroot -p <<'EOF'
CREATE DATABASE zabbix CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'zabbix'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON zabbix.* TO 'zabbix'@'localhost';
SET GLOBAL log_bin_trust_function_creators = 1;  -- Required for schema import
FLUSH PRIVILEGES;
EOF

# --- Step 4: Import the schema (takes 1-3 minutes; no output = normal) ---
zcat /usr/share/zabbix-sql-scripts/mysql/server.sql.gz \
  | mysql -uzabbix -p zabbix

# Disable the trust flag once import is complete
mysql -uroot -p -e "SET GLOBAL log_bin_trust_function_creators = 0;"

# --- Step 5: Set the DB password in server config ---
sed -i 's/# DBPassword=/DBPassword=StrongPassword123!/' \
  /etc/zabbix/zabbix_server.conf

# --- Step 6: Enable and start services ---
systemctl enable --now zabbix-server zabbix-agent2 nginx php8.1-fpm
systemctl status zabbix-server   # should show: active (running)
```

```bash
# Verify the server started successfully — look for "server #0 started"
grep -i "started\|error\|cannot" /var/log/zabbix/zabbix_server.log | tail -20
```

**The `log_bin_trust_function_creators` gotcha:** MySQL with binary logging enabled rejects the stored procedure creation in the Zabbix schema unless this flag is set. It must be set before the import and can be disabled immediately after. Forgetting this step produces a cryptic `ERROR 1418` and a partially imported schema.

---

### Zabbix Server Configuration

The server is configured via `/etc/zabbix/zabbix_server.conf`. Most parameters have sane defaults for small deployments, but several must be tuned before going to production.

```ini
# /etc/zabbix/zabbix_server.conf

# --- Logging ---
LogFile=/var/log/zabbix/zabbix_server.log
LogFileSize=100          # Rotate at 100MB; 0 = never rotate (risky)
DebugLevel=3             # 3=warning, 4=debug; never run 4 in production

# --- Database ---
DBHost=localhost
DBName=zabbix
DBUser=zabbix
DBPassword=secret        # Use DBPasswordFile= for secrets management

# --- Internal process threads (tune for your host count) ---
StartPollers=10          # Passive agent check workers
StartTrappers=5          # Active agent / trapper item receivers
StartPingers=3           # ICMP pinger threads (1 ping per thread)
StartDiscoverers=2       # Network auto-discovery threads
StartHTTPPollers=5       # HTTP agent check threads
StartDBSyncers=4         # DB write workers; increase for high NVPS
StartPreprocessors=3     # Value preprocessing pipeline workers

# --- Memory caches ---
CacheSize=64M            # Config cache; increase if "cannot allocate memory"
                         # appears in logs or you monitor >2,000 hosts
HistoryCacheSize=32M     # Write buffer before DB flush; increase for high NVPS
ValueCacheSize=16M       # Cache for history functions in trigger expressions
TrendCacheSize=8M        # Trend aggregation buffer

# --- Timeouts and reliability ---
ListenPort=10051
Timeout=4                # Per-check timeout in seconds; max 30
LogSlowQueries=3000      # Log DB queries slower than 3s (milliseconds)
HousekeepingFrequency=1  # Hours between history cleanup runs
MaxHousekeeperDelete=5000 # Rows deleted per housekeeping cycle
```

**CacheSize gotcha:** if `CacheSize` is too small, the server logs `cannot allocate memory in configuration cache` and stops accepting new data. This is a hard failure. Start at 64M for mid-size deployments and monitor the `zabbix[rcache,buffer,pused]` internal metric — alert if it exceeds 80%.

**Thread count and DB connections:** more threads consume more DB connections. Each poller thread holds one connection. `max_connections` on MySQL/PostgreSQL must be set to at least `(StartPollers + StartTrappers + StartPingers + StartDiscoverers + StartHTTPPollers + StartDBSyncers) × 2 + 50` with headroom. Running out of DB connections produces silent data loss, not a visible crash.

```bash
# Verify internal metrics via zabbix_server -R
zabbix_server -R diaginfo    # Dumps cache utilization, queue depth, process counts
```

---

### Web Frontend and PHP Configuration

The web frontend is a PHP application that communicates with the database directly and with the server indirectly via the API. It must be served by Nginx or Apache with PHP-FPM.

```nginx
# /etc/nginx/conf.d/zabbix.conf
server {
    listen 80;
    server_name zabbix.example.com;
    root /usr/share/zabbix;
    index index.php;

    # Deny access to sensitive files
    location ~ ^/(conf|include|locale)/ {
        deny all;
        return 404;
    }

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.1-fpm.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300;  # Match max_execution_time
    }
}
```

```ini
# /etc/php/8.1/fpm/conf.d/99-zabbix.ini
post_max_size = 16M
upload_max_filesize = 2M
max_execution_time = 300   # Long imports/exports need this
max_input_time = 300
memory_limit = 128M
date.timezone = UTC        # MUST match Zabbix server timezone; mismatches
                           # cause event timestamps to be wrong in the UI
```

**Timezone mismatches are a silent failure.** If PHP's `date.timezone`, the server OS timezone, and the Zabbix frontend setting differ, event times and graphs will be offset by the difference. Always set everything to UTC and convert in Grafana or user profile settings.

After restarting Nginx and PHP-FPM, navigate to `http://<server-ip>/` to complete the installation wizard. The wizard validates all PHP prerequisites, database connectivity, and server connectivity before writing the final config to `/etc/zabbix/web/zabbix.conf.php`.

---

### Zabbix Proxy Architecture

Proxies are optional but important for any multi-site or large deployment. A proxy collects data from a set of hosts, buffers it locally in its own SQLite/MySQL/PostgreSQL database, and forwards it to the server in bulk. The server sees proxy-collected data exactly the same as directly-collected data.

```
Remote datacenter (Berlin)          Central (Frankfurt)
┌─────────────────────────┐         ┌──────────────────┐
│  Hosts: web01, db01      │         │   Zabbix Server  │
│    │          │          │  WAN    │                  │
│  Agent      Agent        │◄───────►│                  │
│    └────┬───┘            │         └──────────────────┘
│      Proxy               │
│    (local DB buffer)     │
└─────────────────────────┘
```

| Proxy Mode | Server-proxy connectivity | Use case |
|------------|--------------------------|---------|
| **Active** | Proxy connects to server | Proxy is behind NAT/firewall |
| **Passive** | Server connects to proxy | Proxy is reachable from server |

```ini
# /etc/zabbix/zabbix_proxy.conf (active proxy example)
Server=zabbix.example.com     # Server address
Hostname=proxy-berlin-01       # Must match name registered in Zabbix UI
ProxyMode=0                    # 0=active, 1=passive
DBName=/var/lib/zabbix/proxy.db  # SQLite for small deployments
ConfigFrequency=300            # Fetch config from server every 5 min
DataSenderFrequency=5          # Forward collected data every 5 seconds
```

**Proxy buffering:** if WAN connectivity drops for 4 hours, the proxy continues collecting. When connectivity restores, it uploads 4 hours of buffered data. The server processes it, and gaps in graphs are filled in. This is fundamentally different from a direct-agent deployment where WAN loss means data loss.

**Sizing the proxy local database:** the proxy database only needs to store data for the duration of your longest anticipated WAN outage plus a safety margin. For a 24-hour outage tolerance with 500 hosts at 1,000 NVPS, budget approximately 5-10 GB with SQLite or use PostgreSQL for >200 proxied hosts.

---

### Adding the First Host

After the UI setup wizard completes, the first operational task is adding a monitored host. The host name in Zabbix and the `Hostname` in the agent config must match exactly — this is the most common first-time configuration mistake.

**On the agent host:**
```bash
# Install Agent2 on the monitored host
wget https://repo.zabbix.com/zabbix/7.0/ubuntu/pool/main/z/zabbix-release/zabbix-release_7.0-1+ubuntu22.04_all.deb
dpkg -i zabbix-release_7.0-1+ubuntu22.04_all.deb
apt update && apt install -y zabbix-agent2

# Configure it
cat > /etc/zabbix/zabbix_agent2.conf <<'EOF'
Server=192.168.1.10          # Zabbix server IP (passive checks: who can poll me)
ServerActive=192.168.1.10    # Zabbix server IP (active checks: where I send data)
Hostname=web01.prod          # MUST match what you enter in the Zabbix UI
LogFile=/var/log/zabbix/zabbix_agent2.log
EOF

systemctl enable --now zabbix-agent2

# Test the agent is reachable from the server side
# Run this FROM the Zabbix server:
zabbix_get -s 192.168.1.50 -p 10050 -k agent.ping
# Expected output: 1
```

**In the Zabbix UI:**
1. **Configuration → Hosts → Create host**
2. **Host name:** `web01.prod` (exact match with agent config `Hostname=`)
3. **Groups:** `Linux servers`
4. **Interfaces → Add:** Type=Agent, IP=`<host IP>`, Port=`10050`
5. **Templates tab → Link:** `Linux by Zabbix agent` (built-in template; 100+ items)
6. Click **Add**

After 1-2 minutes, the host's availability indicator in the host list should turn green. A gray indicator means the server has not yet polled it. A red indicator means a connection or authentication error — check that `Server=` in the agent config points to the Zabbix server's IP, not the agent's own IP.

```bash
# Troubleshoot agent connectivity from the server
zabbix_get -s <agent_ip> -p 10050 -k system.uname
# Should return the host's uname string

# Check agent logs on the monitored host
tail -f /var/log/zabbix/zabbix_agent2.log
# Look for: "cannot connect to [server_ip]:10051" = firewall or wrong ServerActive
# Look for: "active check configuration update from [server_ip]:10051 failed" = hostname mismatch
```

---

### Key Internal Metrics to Monitor

Zabbix exposes its own operational health via the `zabbix[]` internal item key. These are available without installing any additional exporters — add them to your Zabbix server's self-monitoring host.

| Item Key | What it measures | Alert threshold |
|----------|-----------------|-----------------|
| `zabbix[rcache,buffer,pused]` | Config cache % used | >80% |
| `zabbix[wcache,history,pused]` | History write cache % used | >75% |
| `zabbix[vcache,buffer,pused]` | Value cache % used | >80% |
| `zabbix[queue]` | Items waiting to be collected (delayed) | >100 sustained |
| `zabbix[process,poller,avg,busy]` | % time pollers are busy | >75% |
| `zabbix[db,history,count]` | History table row count | Site-specific baseline |
| `zabbix[proxy,proxy-name,lastaccess]` | Seconds since proxy checked in | >120 |

**The queue metric is the single most useful operational signal.** A growing `zabbix[queue]` means the server cannot keep up with its configured check intervals. Root causes in order of frequency: DB too slow, not enough poller threads, network latency on passive checks, `CacheSize` too small. Investigate in that order.

---

## Examples

### Example 1: Full Single-Node Installation on Ubuntu 22.04 with MySQL

This scenario installs a complete Zabbix 7.0 stack — server, database, frontend, and agent — on a single Ubuntu 22.04 host. Suitable for lab environments and small deployments up to ~500 hosts.

```bash
#!/bin/bash
# zabbix-install.sh — Zabbix 7.0 single-node installer
# Tested on: Ubuntu 22.04 LTS
# Run as root

set -euo pipefail

ZABBIX_DB_PASS="ZabbixDB$(openssl rand -hex 8)"
echo "Generated DB password: ${ZABBIX_DB_PASS}"
echo "${ZABBIX_DB_PASS}" > /root/.zabbix_db_pass
chmod 600 /root/.zabbix_db_pass

# 1. Add Zabbix 7.0 repo
wget -q https://repo.zabbix.com/zabbix/7.0/ubuntu/pool/main/z/zabbix-release/zabbix-release_7.0-1+ubuntu22.04_all.deb
dpkg -i zabbix-release_7.0-1+ubuntu22.04_all.deb
apt-get update -q

# 2. Install packages
apt-get install -y \
  mysql-server \
  zabbix-server-mysql \
  zabbix-frontend-php \
  zabbix-nginx-conf \
  zabbix-sql-scripts \
  zabbix-agent2

# 3. Harden MySQL and create Zabbix database
mysql -uroot <<EOF
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'RootPass123!';
CREATE DATABASE zabbix CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'zabbix'@'localhost' IDENTIFIED BY '${ZABBIX_DB_PASS}';
GRANT ALL PRIVILEGES ON zabbix.* TO 'zabbix'@'localhost';
SET GLOBAL log_bin_trust_function_creators = 1;
FLUSH PRIVILEGES;
EOF

# 4. Import schema
zcat /usr/share/zabbix-sql-scripts/mysql/server.sql.gz \
  | mysql -uzabbix -p"${ZABBIX_DB_PASS}" zabbix

mysql -uroot -pRootPass123! -e "SET GLOBAL log_bin_trust_function_creators = 0;"

# 5. Configure server
sed -i "s/# DBPassword=/DBPassword=${ZABBIX_DB_PASS}/" /etc/zabbix/zabbix_server.conf

# 6. Configure Nginx to listen on port 80
sed -i 's/#        listen          8080;/        listen          80;/' \
  /etc/nginx/conf.d/zabbix.conf
sed -i 's/#        server_name     example.com;/        server_name     _;/' \
  /etc/nginx/conf.d/zabbix.conf

# 7. Set PHP timezone
echo "date.timezone = UTC" >> /etc/php/8.1/fpm/conf.d/99-zabbix.ini

# 8. Start services
systemctl enable --now zabbix-server zabbix-agent2 nginx php8.1-fpm mysql

# 9. Verify
sleep 5
systemctl is-active zabbix-server && echo "✓ Zabbix server running"
grep "server #0 started" /var/log/zabbix/zabbix_server.log && echo "✓ Server initialized"
echo "Frontend: http://$(hostname -I | awk '{print $1}')/"
echo "Default credentials: Admin / zabbix  (change immediately)"
```

**Verification:**
```bash
# Check server is collecting data
zabbix_get -s 127.0.0.1 -p 10050 -k system.uptime
# Returns: uptime in seconds — confirms local agent is responding

# Check DB write pipeline
grep "synced" /var/log/zabbix/zabbix_server.log | tail -5
# Returns lines like: "synced 42 items in 0.034 sec, 100% done"
```

---

### Example 2: Installing and Registering an Agent2 on a Remote Host

This scenario installs Agent2 on a monitored host and registers it in Zabbix using the API — the automation-friendly approach used in Ansible playbooks and Terraform provisioners.

```bash
# On the monitored host (web02.prod, IP: 192.168.1.51)
# Assumes Zabbix repo already added

apt-get install -y zabbix-agent2

cat > /etc/zabbix/zabbix_agent2.conf <<'EOF'
Server=192.168.1.10
ServerActive=192.168.1.10
Hostname=web02.prod
LogFile=/var/log/zabbix/zabbix_agent2.log
LogFileSize=10
Timeout=3
# Allow the server to remotely execute agent commands (optional)
EnableRemoteCommands=0
EOF

systemctl enable --now zabbix-agent2
```

```bash
# On the Zabbix server: register the host via the JSON-RPC API
# This is how automation tools (Ansible, Terraform, CI pipelines) add hosts

ZABBIX_URL="http://localhost/api_jsonrpc.php"

# Step 1: Authenticate and get a session token
TOKEN=$(curl -s -X POST "${ZABBIX_URL}" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "user.login",
    "params": {"username": "Admin", "password": "zabbix"},
    "id": 1
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")

echo "Token: ${TOKEN}"

# Step 2: Get the host group ID for "Linux servers"
GROUP_ID=$(curl -s -X POST "${ZABBIX_URL}" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"hostgroup.get\",
    \"params\": {\"filter\": {\"name\": [\"Linux servers\"]}},
    \"auth\": \"${TOKEN}\",
    \"id\": 2
  }" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['groupid'])")

# Step 3: Get the template ID for the Linux template
TMPL_ID=$(curl -s -X POST "${ZABBIX_URL}" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"template.get\",
    \"params\": {\"filter\": {\"name\": [\"Linux by Zabbix agent\"]}},
    \"auth\": \"${TOKEN}\",
    \"id\": 3
  }" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['templateid'])")

# Step 4: Create the host
curl -s -X POST "${ZABBIX_URL}" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"host.create\",
    \"params\": {
      \"host\": \"web02.prod\",
      \"interfaces\": [{
        \"type\": 1,
        \"main\": 1,
        \"useip\": 1,
        \"ip\": \"192.168.1.51\",
        \"dns\": \"\",
        \"port\": \"10050\"
      }],
      \"groups\": [{\"groupid\": \"${GROUP_ID}\"}],
      \"templates\": [{\"templateid\": \"${TMPL_ID}\"}]
    },
    \"auth\": \"${TOKEN}\",
    \"id\": 4
  }" | python3 -m json.tool
# Success response contains: {"result": {"hostids": ["12345"]}}
```

---

### Example 3: Deploying a Zabbix Proxy for a Remote Site

This scenario sets up an active proxy for a remote datacenter. The proxy monitors 50 hosts in the remote site and forwards data to the central server over a WAN link.

```bash
# On the proxy host (proxy-berlin-01, IP: 10.20.1.5)

apt-get install -y zabbix-proxy-sqlite3 zabbix-agent2
# Use zabbix-proxy-mysql for >200 monitored hosts per proxy

mkdir -p /var/lib/zabbix
chown zabbix:zabbix /var/lib/zabbix

cat > /etc/zabbix/zabbix_proxy.conf <<'EOF'
ProxyMode=0                                    # 0=active: proxy initiates to server
Server=zabbix.example.com                      # Central server FQDN or IP
Hostname=proxy-berlin-01                       # Must match UI registration exactly
LogFile=/var/log/zabbix/zabbix_proxy.log
LogFileSize=100
DebugLevel=3
DBName=/var/lib/zabbix/proxy.db                # SQLite local buffer
ConfigFrequency=300                            # Pull config from server every 5 min
DataSenderFrequency=5                          # Push data every 5 sec
StartPollers=5
StartPingers=2
StartHTTPPollers=3
Timeout=4
EOF

# Import the proxy schema into SQLite
zcat /usr/share/zabbix-sql-scripts/sqlite3/proxy.sql.gz | sqlite3 /var/lib/zabbix/proxy.db
chown zabbix:zabbix /var/lib/zabbix/proxy.db

systemctl enable --now zabbix-proxy
```

```
In the Zabbix UI (on the central server):
1. Administration → Proxies → Create proxy
2. Proxy name: proxy-berlin-01   (exact match with Hostname= in config)
3. Proxy mode: Active
4. Click Add

To assign hosts to the proxy:
5. Configuration → Hosts → select your Berlin hosts
6. Mass update → Monitored by proxy → proxy-berlin-01
```

```bash
# Verify the proxy is checking in (run on the central server)
# Active proxy last access should update every few seconds
watch -n5 "zabbix_server -R config_cache_reload 2>&1; \
  mysql -uzabbix -psecret zabbix -e \
  \"SELECT host, lastaccess, FROM_UNIXTIME(lastaccess) FROM hosts WHERE status=5;\""
# status=5 means proxy host; lastaccess should be within last 30 seconds
```

---

## Exercises

### Exercise 1: Trace Data Flow from Agent to Database

**Goal:** Understand the end-to-end path a single metric takes through the Zabbix stack.

1. On a host running `zabbix-agent2`, use `zabbix_get` from the server to manually retrieve the value of `vm.memory.size[available]`:
   ```bash
   zabbix_get -s <agent_ip> -p 10050 -k "vm.memory.size[available]"
   ```
2. Enable debug logging temporarily on the server (`DebugLevel=4`, restart, wait 60 seconds, set back to `3`).
3. Search the server log for that item key and trace the lines showing: poll initiated → value received → value preprocessed → DB sync.
4. In the Zabbix UI, navigate to **Monitoring → Latest data**, filter by the host, and find the `Available memory` item. Confirm the value matches what `zabbix_get` returned.
5. Run the SQL query from the Concepts section to check history table row counts. Note the baseline for later comparison.

**What to answer:** At which step does the server evaluate whether a trigger fires? What would happen to that trigger if the DB sync thread was backlogged?

---

### Exercise 2: Reproduce and Fix a CacheSize Failure

**Goal:** Understand the impact of undersized configuration cache and how to detect it.

1. In `/etc/zabbix/zabbix_server.conf`, temporarily set `CacheSize=1M`. Restart the server.
2. Monitor the log: `tail -f /var/log/zabbix/zabbix_server.log`
3. If you have enough hosts configured, you should see `cannot allocate memory in configuration cache`. If not, reduce `CacheSize` further until you do.
4. Add the internal item `zabbix[rcache,buffer,pused]` to your Zabbix server self-monitoring host:
   - Item key: `zabbix[rcache,buffer,pused]`
   - Type: Zabbix internal
   - Update interval: 60s
5. Create a trigger: `last(/Zabbix server/zabbix[rcache,buffer,pused]) > 80`
6. Restore `CacheSize=64M`, restart, and confirm the trigger recovers.

**What to answer:** What is the observable symptom when CacheSize is exhausted? How does this differ from a DB connectivity failure?

---

### Exercise 3: Configure and Validate Active vs Passive Checks

**Goal:** Understand the firewall and connectivity implications of both check modes.

1. On a monitored host, configure `zabbix_agent2.conf` with only `Server=` set (no `ServerActive=`). Restart the agent.
2. In the Zabbix UI, create two items on that host:
   - Item A: type=**Zabbix agent (passive)**, key=`system.hostname`
   - Item B: type=**Zabbix agent (active)**, key=`system.hostname`
3. Check **Monitoring → Latest data** after 2 minutes. Item A should have data; Item B should show no recent data or a `ZBX_NOTSUPPORTED` error.
4. Now add `ServerActive=<zabbix_server_ip>` to the agent config. Restart the agent. Confirm both items collect data.
5. Use `iptables` to block inbound TCP port 10050 on the monitored host:
   ```bash
   iptables -I INPUT -p tcp --dport 10050 -j DROP
   ```
6. Observe in the UI: passive check (Item A) turns red/unavailable; active check (Item B) continues working.
7. Remove the rule: `iptables -D INPUT -p tcp --dport 10050 -j DROP`

**What to answer:** In a cloud environment where monitored instances are in private subnets and cannot be reached directly by the Zabbix server, which check mode should you use, and what network rule does the monitored host need?

---

### Exercise 4: Benchmark NVPS and Identify the Bottleneck

**Goal:** Understand how to measure Zabbix throughput and identify performance limits.

1. Add the following internal items to your Zabbix server self-monitoring host (all type=Zabbix internal, 60s interval):
   - `zabbix[wcache,history,pused]` — write cache utilization
   - `zabbix[queue]` — items in collection queue
   - `zabbix[process,poller,avg,busy]` — poller thread utilization
2. Create a dashboard with graphs for all three metrics over a 1-hour window.
3. Simulate load by creating 50 items with 10-second collection intervals on 10 hosts (use `system.cpu.load[all,avg1]` with random time offsets if needed). This should push NVPS meaningfully.
4. After 15 minutes, examine your dashboard:
   - If `wcache,history,pused` is climbing: increase `HistoryCacheSize` or `StartDBSyncers`.
   - If `queue` is growing: increase `StartPollers` or reduce check intervals.
   - If `poller,avg,busy` exceeds 75%: increase `StartPollers`.
5. Make one configuration change, restart the server, and observe whether the metric stabilizes.

**What to answer:** If all three metrics are healthy but users report the UI feels slow, which component is most likely the bottleneck, and what would you check first?

---

### Quick Checks

6. Identify the default Zabbix agent listening port. Run: `python3 -c "ports={'agent': 10050, 'server': 10051}; print(ports['agent'])"`

```expected_output
10050
```

hint: Think about how Python dictionaries can store port mappings and how you can access a specific value by its key.
hint: Use python3 -c to run an inline script that defines a dictionary with named port entries and prints the value associated with the 'agent' key.

7. Count Zabbix architecture components. Run: `printf 'server\nproxy\nagent\nfrontend\ndatabase\n' | wc -l`

```expected_output
5
```

hint: Think about how you can combine a command that generates a list of items with a command that counts lines.
hint: Use printf to print each component on its own line with \n separators, then pipe the output to wc -l to count the total number of lines.

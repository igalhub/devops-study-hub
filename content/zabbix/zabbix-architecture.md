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
StartPreprocessors=3     # Value preprocessing pipeline workers (Agent2)

# --- Memory caches ---
CacheSize=64M            # Config cache; increase if: "cannot allocate memory"
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

**Thread count guidance:** more threads consume more DB connections. Each poller thread holds one connection. `max_connections` on MySQL/PostgreSQL must be set to at least `(StartPollers + StartTrappers + StartPingers + StartDiscoverers + StartHTTPPollers + StartDBSyncers) × 2 + 50` with headroom.

---

### Web Frontend and PHP Configuration

The web frontend is a PHP application that communicates with the database directly and with the server indirectly (via the API). It must be served by Nginx or Apache with PHP-FPM.

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

---

### Adding the First Host

After the UI setup wizard completes, the first operational task is adding a monitored host. The host name in Zabbix and the `Hostname` in the agent config must match exactly — this is the most common first-time configuration mistake.

**On the agent host:**
```bash
# /etc/zabbix/zabbix_agent2.conf
Server=192.168.1.10          # Zabbix server IP (passive checks: who can poll me)
ServerActive=192.168.1.10    # Zabbix server IP (active checks: where I send data)
Hostname=web01.prod          # MUST match what you enter in the Zabbix UI
```

**In the Zabbix UI:**
1. **Configuration → Hosts → Create host**
2. **Host name:** `web01.prod` (exact match with agent config)
3. **Groups:** `Linux servers`
4. **Interfaces → Add:** Type=Agent, IP=`<host IP>`, Port=`10050`
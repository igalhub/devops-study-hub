---
title: Architecture & Installation
module: zabbix
duration_min: 20
difficulty: beginner
tags: [zabbix, architecture, installation, server, agent, database]
exercises: 3
---

## Overview
Zabbix is an enterprise-grade open-source monitoring platform that has been a staple of traditional infrastructure monitoring for over two decades. It monitors servers, network devices, applications, and cloud resources using both agent-based and agentless methods. Unlike newer cloud-native tools that emerged from the Kubernetes ecosystem, Zabbix is built for breadth — it handles SNMP for network switches, IPMI for bare-metal servers, and JMX for Java applications alongside standard Linux metrics. DevOps engineers encounter Zabbix in on-premises and hybrid environments, and understanding its architecture is essential for both operating it and integrating it with modern tooling like Grafana.

## Concepts

### Component Overview
Zabbix is a distributed system. Each component has a specific role and communicates over well-defined protocols.

```
┌─────────────────────────────────────────────────┐
│                  ZABBIX SERVER                   │
│  Pollers │ Trappers │ Alerters │ DB Syncer       │
└───────────────────┬─────────────────────────────┘
                    │ TCP 10051
          ┌─────────┴──────────┐
          │                    │
   ┌──────▼──────┐     ┌───────▼──────┐
   │ ZABBIX AGENT│     │ ZABBIX PROXY │
   │ (direct)    │     │ (remote site)│
   └─────────────┘     └──────┬───────┘
                              │ TCP 10050/10051
                       ┌──────▼───────┐
                       │ ZABBIX AGENT │
                       │ (proxied)    │
                       └──────────────┘

   ┌───────────────┐     ┌─────────────┐
   │   DATABASE    │     │ WEB FRONTEND│
   │ MySQL/PgSQL   │     │ Nginx+PHP   │
   └───────────────┘     └─────────────┘
```

| Component | Role |
|-----------|------|
| Zabbix Server | Central process — collects data, evaluates triggers, sends alerts |
| Zabbix Agent | Lightweight daemon on monitored hosts — collects and reports local metrics |
| Zabbix Proxy | Collects data on behalf of the server — reduces server load, enables monitoring across network boundaries |
| Database | Stores configuration, collected data, history, events (MySQL, PostgreSQL, Oracle, TimescaleDB) |
| Web Frontend | PHP application served by Nginx/Apache — provides the management UI and API |

### Supported Databases
The database is the most critical scaling decision in a Zabbix deployment.

| Database | Notes |
|----------|-------|
| MySQL / MariaDB | Most common in existing deployments; requires InnoDB |
| PostgreSQL | Preferred for new deployments; better performance at scale |
| TimescaleDB | PostgreSQL extension; dramatically better performance for history data via hypertables; recommended for high-throughput environments |
| Oracle | Supported but rarely used outside enterprise licensing constraints |

For DevOps interviews: know that TimescaleDB compression and automatic data partitioning solve Zabbix's historical performance problem. Without it, history and trends tables grow unbounded and slow down the entire system.

### Agent vs Agentless Monitoring
Zabbix supports both modes.

**Agent-based monitoring:**
- Zabbix Agent daemon runs on the target host.
- Supports active and passive check modes (covered in the Agents lesson).
- Access to local metrics not available remotely: disk I/O, process lists, log file monitoring.
- More secure — the agent controls what data is exposed.

**Agentless monitoring — built-in check types:**

| Check Type | Protocol | Use Case |
|------------|----------|---------|
| ICMP ping | ICMP | Basic host availability |
| SNMP | UDP 161 | Network devices (switches, routers, printers) |
| IPMI | IPMI/LAN | Bare-metal server hardware sensors |
| JMX | JMX/RMI | Java application metrics via Zabbix Java Gateway |
| HTTP agent | HTTP/HTTPS | Web endpoint checks, REST API polling |
| SSH / Telnet | SSH/TCP | Run remote commands without an agent |
| External check | Script on server | Custom scripts run by the Zabbix server |

### Zabbix Server Configuration
The server is configured via `/etc/zabbix/zabbix_server.conf`. Critical parameters:

```ini
# /etc/zabbix/zabbix_server.conf

LogFile=/var/log/zabbix/zabbix_server.log
LogFileSize=100          # MB, rotates at this size

DBHost=localhost
DBName=zabbix
DBUser=zabbix
DBPassword=secret

# Tune these for your scale
StartPollers=5           # Threads for passive agent checks
StartTrappers=5          # Threads for active agent / trapper data
StartPingers=1           # ICMP ping threads
StartDiscoverers=1       # Network discovery threads
StartHTTPPollers=1       # HTTP agent check threads
StartDBSyncers=4         # Database writer threads

CacheSize=32M            # Configuration cache — increase for many hosts
HistoryCacheSize=16M     # In-memory write buffer for history
ValueCacheSize=8M        # Cache for calculated/aggregate items

ListenPort=10051
Timeout=4                # Default check timeout in seconds
LogSlowQueries=3000      # Log DB queries slower than 3s (ms)
```

**Start and enable:**
```bash
systemctl enable --now zabbix-server zabbix-agent2 nginx php8.1-fpm
```

### Web UI Setup
The web frontend is a PHP application. After package installation, initial setup is done via the browser wizard at `http://<server>/zabbix`.

**Nginx configuration snippet:**
```nginx
server {
    listen 80;
    server_name zabbix.example.com;
    root /usr/share/zabbix;

    index index.php;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.1-fpm.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

**PHP settings required by Zabbix** (`/etc/php/8.1/fpm/conf.d/99-zabbix.ini`):
```ini
post_max_size = 16M
upload_max_filesize = 2M
max_execution_time = 300
max_input_time = 300
memory_limit = 128M
date.timezone = UTC
```

### Adding the First Host
After UI setup, add a host to monitor:

1. **Configuration → Hosts → Create host**
2. Set:
   - **Host name** — must match the `Hostname` in `zabbix_agentd.conf`
   - **Groups** — logical grouping (e.g., "Linux servers")
   - **Interfaces** — Agent, IP: `<host IP>`, Port: `10050`
3. **Templates tab** — link `Linux by Zabbix agent` (built-in template)
4. Click **Add**

Zabbix will begin polling the agent and data will appear under **Monitoring → Latest data** within one polling cycle (default 1 minute).

**Verify agent connectivity from the server:**
```bash
zabbix_get -s <agent-host> -p 10050 -k system.uname
# Returns: Linux hostname 5.15.0-91-generic ...
```

## Examples

**Full Zabbix installation on Ubuntu 22.04:**
```bash
# Add Zabbix repository
wget https://repo.zabbix.com/zabbix/6.4/ubuntu/pool/main/z/zabbix-release/zabbix-release_6.4-1+ubuntu22.04_all.deb
dpkg -i zabbix-release_6.4-1+ubuntu22.04_all.deb
apt update

# Install components
apt install -y zabbix-server-mysql zabbix-frontend-php zabbix-nginx-conf \
               zabbix-sql-scripts zabbix-agent2

# Create database
mysql -uroot -e "
  CREATE DATABASE zabbix CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
  CREATE USER 'zabbix'@'localhost' IDENTIFIED BY 'secret';
  GRANT ALL ON zabbix.* TO 'zabbix'@'localhost';
  SET GLOBAL log_bin_trust_function_creators = 1;
"

# Import schema
zcat /usr/share/zabbix-sql-scripts/mysql/server.sql.gz | mysql -uzabbix -psecret zabbix

# Configure server DB password
sed -i 's/# DBPassword=/DBPassword=secret/' /etc/zabbix/zabbix_server.conf

# Start services
systemctl enable --now zabbix-server zabbix-agent2 nginx php8.1-fpm
```

## Exercises

1. Install Zabbix Server 6.4 on a VM or container with a MySQL backend. Complete the web UI setup wizard, log in as Admin (default password: `zabbix`), and change the admin password immediately. Document each step you took to harden the default configuration.
2. Add a second Linux host by installing `zabbix-agent2` on it, configuring `zabbix_agentd.conf` with the server IP and correct hostname, and linking the `Linux by Zabbix agent` template. Verify data appears under **Monitoring → Latest data** for that host.
3. Use `zabbix_get` from the server to query three different item keys on the agent host: `system.cpu.load[all,avg1]`, `vm.memory.size[available]`, and `vfs.fs.size[/,free]`. Record the returned values and match them against what Zabbix displays in the Latest data view.

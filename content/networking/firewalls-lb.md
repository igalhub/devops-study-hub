---
title: Firewalls & Load Balancers
module: networking
duration_min: 20
difficulty: intermediate
tags: [networking, firewall, iptables, ufw, security-groups, load-balancer, nginx]
exercises: 4
---

## Overview

Firewalls and load balancers are the gatekeepers of every production system. A firewall enforces access policy — it decides which packets are allowed to reach a service and which are dropped before they arrive. A load balancer distributes accepted traffic across multiple backend instances, enabling horizontal scaling and fault tolerance. In practice, these two components are almost always deployed together: the firewall controls who can reach the load balancer, and the load balancer decides which backend handles the request.

For a DevOps engineer, understanding both is non-negotiable. Misconfigured firewalls are one of the most common causes of "it works on my machine" connectivity failures in staging and production environments. Misconfigured load balancers cause silent data-loss bugs, uneven traffic distribution, and failed health checks that route traffic to dead instances. You need to be able to read a ruleset, write a new one, and diagnose failures at each layer — on bare metal, in VMs, and in cloud infrastructure.

Both technologies exist at multiple layers of the stack simultaneously. On a single Linux host you might have `iptables` rules enforced by the kernel, a cloud security group applied at the hypervisor level before packets even reach your OS, and an application-layer load balancer in front of everything. These layers interact. Understanding their boundaries — and how they can contradict each other — is what separates engineers who can diagnose production incidents from those who guess and restart services.

---

## Concepts

### How Firewall Rule Evaluation Works

A firewall is an ordered list of rules. Each rule has a **match condition** (which packets it applies to) and a **target** (what to do with matching packets: ACCEPT, DROP, REJECT, LOG, etc.). Rules are evaluated top to bottom; the first rule that matches terminates evaluation for that packet.

This ordering has critical implications:

- A broad ACCEPT rule placed before a specific DROP rule will make the DROP unreachable.
- A broad DROP at the top of a chain will block everything, including your own SSH session.
- Rules that are never matched add latency (small, but measurable at high packet rates).

| Target | Behavior | Visible to sender? |
|--------|----------|--------------------|
| `ACCEPT` | Let the packet through | Yes — connection proceeds |
| `DROP` | Silently discard | No — sender times out |
| `REJECT` | Discard and send ICMP error | Yes — sender gets immediate error |
| `LOG` | Log and continue evaluation | N/A — non-terminating |

**DROP vs REJECT:** Use `DROP` for external-facing rules — giving no response makes port scanning slower and less informative for attackers. Use `REJECT` internally (between services) so that legitimate clients fail fast rather than hanging until timeout.

**Connection state matters:** Modern firewalls are stateful. A packet that is part of an already-established TCP session (`ESTABLISHED`) or is related to one (`RELATED`, e.g., ICMP error responses) does not need its own ACCEPT rule. Always add a stateful ACCEPT rule near the top of your INPUT chain — failing to do this is the most common way engineers accidentally lock themselves out when setting a default DROP policy.

---

### iptables (Linux Kernel Firewall)

`iptables` is the traditional userspace interface to the Linux kernel's `netfilter` packet-filtering framework. On Ubuntu 20.04+ and RHEL 9+, the actual backend is `nftables` — `iptables` commands are translated via a compatibility shim (`iptables-nft`). The syntax and behavior below remain the same; the shim is transparent.

Rules are organized into **chains** within **tables**:

| Table | Purpose | Chains |
|-------|---------|--------|
| `filter` | Accept/drop/reject (default) | INPUT, OUTPUT, FORWARD |
| `nat` | Address translation | PREROUTING, POSTROUTING, OUTPUT |
| `mangle` | Packet header modification | All five chains |
| `raw` | Skip connection tracking | PREROUTING, OUTPUT |

For most firewall work, you only touch the `filter` table.

```bash
# Show current rules with line numbers, packet/byte counts, no DNS lookup
iptables -L -v -n --line-numbers

# Show only the INPUT chain
iptables -L INPUT -v -n --line-numbers

# Set default policies for OUTPUT and FORWARD first — safe operations
iptables -P OUTPUT ACCEPT
iptables -P FORWARD DROP

# --- Build INPUT rules in order BEFORE setting default DROP ---

# 1. Allow loopback (required for many local services)
iptables -A INPUT -i lo -j ACCEPT

# 2. Allow established/related connections — critical: do this before DROP policy
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 3. Allow new SSH connections
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# 4. Allow HTTP and HTTPS
iptables -A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT

# 5. Allow PostgreSQL only from a specific application server IP
iptables -A INPUT -p tcp --dport 5432 -s 10.0.0.50 -j ACCEPT

# 6. Set default DROP only after all ACCEPT rules are in place
iptables -P INPUT DROP

# --- Rule management ---

# Insert a rule at position 3 (pushes existing rule 3 down)
iptables -I INPUT 3 -p tcp --dport 8080 -j ACCEPT

# Delete a rule by line number (use -L --line-numbers to find it first)
iptables -D INPUT 3

# Flush all rules in a chain (dangerous — removes all rules immediately)
iptables -F INPUT

# Save rules to survive reboot (Debian/Ubuntu)
iptables-save > /etc/iptables/rules.v4

# Save rules (RHEL/CentOS with iptables-services package)
service iptables save

# Restore saved rules
iptables-restore < /etc/iptables/rules.v4
```

**Gotcha — the lockout trap:** If you run `iptables -P INPUT DROP` before adding the ESTABLISHED/RELATED and SSH ACCEPT rules, your existing SSH session will continue (the kernel keeps existing connections) but you will not be able to reconnect after disconnecting. Always add ACCEPT rules first, then set the default DROP policy.

**Gotcha — rules don't persist by default:** `iptables` rules live in kernel memory. A reboot wipes them. On Debian/Ubuntu, install `iptables-persistent` (`apt install iptables-persistent`) and save rules via `netfilter-persistent save`. On RHEL, use `firewalld` or the `iptables` service with the `iptables-services` package.

**Gotcha — rule ordering with `-A` vs `-I`:** `-A` appends to the end of a chain. If your chain ends in a DROP policy and you append an ACCEPT, it may never be reached because an earlier DROP rule already matched. Use `-I` with a position number to insert rules at the correct point.

---

### ufw — Uncomplicated Firewall

`ufw` wraps `iptables` with a simpler interface designed for servers. It's the standard on Ubuntu. Internally it still generates `iptables` rules, so you can mix `iptables -L` inspection with `ufw` management.

```bash
# Initial setup — set defaults before enabling
ufw default deny incoming      # default DROP on INPUT
ufw default allow outgoing     # default ACCEPT on OUTPUT

# Enable (applies rules, persists across reboots automatically)
ufw enable

# Status — always check this after changes
ufw status verbose
ufw status numbered             # shows line numbers for deletion

# Allow rules
ufw allow 22/tcp                                       # SSH
ufw allow 80/tcp                                       # HTTP
ufw allow 443/tcp                                      # HTTPS
ufw allow from 10.0.0.50 to any port 5432 proto tcp   # DB from one host
ufw allow from 10.0.0.0/8 to any port 9090            # monitoring from internal net

# Deny rules (explicit deny — useful for documentation even with deny-incoming default)
ufw deny 3306                   # block MySQL from everywhere

# Allow by application profile (reads /etc/ufw/applications.d/)
ufw allow OpenSSH
ufw allow 'Nginx Full'          # opens both 80 and 443
ufw app list                    # see available profiles

# Delete rules
ufw delete allow 80/tcp         # by rule specification
ufw delete 3                    # by number from 'ufw status numbered'

# Reset everything (disables ufw, flushes all rules — use with caution)
ufw reset
```

**When to use ufw vs iptables directly:** Use `ufw` for simple server hardening where you need a small set of static rules. Use `iptables` directly (or `nftables`) when you need fine-grained control — custom chains, packet marking, NAT rules, or integration with tooling like Docker.

**Docker and ufw gotcha:** Docker bypasses `ufw` by writing rules directly to `iptables`. If you `ufw deny 8080` but run a container with `-p 8080:8080`, the port will still be publicly accessible. The fix is to either configure Docker to not manipulate iptables (`"iptables": false` in `/etc/docker/daemon.json`) or bind containers to localhost (`-p 127.0.0.1:8080:8080`) and let a reverse proxy handle external access.

---

### Cloud Security Groups

Cloud security groups are stateful firewalls applied at the hypervisor/NIC level — before packets reach your instance's OS. This means they work regardless of what's running inside the VM, and they cannot be bypassed from within the OS.

| Feature | iptables (host) | AWS Security Group |
|---------|----------------|-------------------|
| Applied at | OS kernel | Hypervisor/NIC |
| Statefulness | Requires conntrack module | Always stateful |
| Rule ordering | Matters (first match wins) | All rules evaluated; most permissive wins |
| References other groups | No | Yes — attach SG as a source |
| Logging | Via LOG target | Via VPC Flow Logs |
| Persistence | Requires explicit save | Always persisted |

**All rules evaluated — no ordering:** Unlike iptables, AWS security groups evaluate all inbound rules and take the most permissive result. There is no "first match wins." This means you cannot block a specific IP if another rule allows all traffic on that port — the ALLOW wins. To block specific IPs in AWS, use a Network ACL (NACL), which does support ordered deny rules.

**Security group referencing:** Instead of specifying IP CIDR ranges, you can reference another security group as the source. Any instance assigned that group is automatically allowed. This is the correct pattern for internal service communication in AWS — it scales automatically as instances are added or removed without touching firewall rules.

```
# Example: 3-tier application security group structure

# Web tier SG (sg-web)
Inbound:
  TCP  80    0.0.0.0/0, ::/0   ← HTTP from internet
  TCP  443   0.0.0.0/0, ::/0   ← HTTPS from internet

# App tier SG (sg-app)
Inbound:
  TCP  8080  sg-web              ← only from web tier (SG reference, not IPs)

# DB tier SG (sg-db)
Inbound:
  TCP  5432  sg-app              ← only from app tier

# All SGs — Outbound:
  All traffic  0.0.0.0/0        ← AWS default; restrict if compliance requires it
```

**GCP firewall rules** work similarly but are applied at the VPC network level, not per-instance. Rules use **target tags** or **service accounts** as selectors, and priority (0–65535, lower = higher priority) determines evaluation order when multiple rules match. GCP supports explicit DENY rules, unlike AWS security groups.

**NACLs vs Security Groups (AWS):** Security groups are stateful — if you allow inbound port 80, the response traffic is automatically allowed outbound. NACLs are stateless — you must explicitly allow both inbound and outbound for each port. NACLs apply to entire subnets; security groups apply per-instance. Use NACLs for subnet-level blast radius control (blocking a compromised subnet), and security groups for fine-grained instance-level policy.

---

### Load Balancer Types and Layer Differences

| Type | OSI Layer | What it inspects | Typical use |
|------|-----------|-----------------|-------------|
| L4 (Transport) | 4 — TCP/UDP | IP, port, protocol | Any TCP/UDP protocol, ultra-low latency |
| L7 (Application) | 7 — HTTP | URL, headers, cookies, body | HTTP/HTTPS routing, SSL termination |

**L4 load balancers** forward raw TCP/UDP connections. They are fast because they do minimal inspection. They cannot distinguish between `/api` and `/static` in the same connection — they only see port and protocol. Use L4 when you need to load-balance non-HTTP protocols (gRPC over raw TCP, MQTT, database protocols, game servers) or when latency is the primary constraint.

**L7 load balancers** parse the HTTP request before routing. This enables:

- **Path-based routing:** `/api/*` → backend cluster A, `/images/*` → CDN or object storage
- **Host-based routing:** `api.example.com` → API fleet, `app.example.com` → frontend fleet
- **SSL/TLS termination:** handle certificates centrally; backends receive plain HTTP
- **Header manipulation:** inject `X-Real-IP`, `X-Forwarded-For`, custom auth headers
- **Active health checks:** send HTTP requests to `/health` and remove failing backends
- **Session affinity (sticky sessions):** route the same client to the same backend using cookies

**The TLS termination trade-off:** Terminating TLS at the load balancer means traffic between the LB and backends is unencrypted (typically acceptable within a private VPC network). If compliance requires end-to-end encryption, use TLS passthrough (L4) or re-encrypt at the backend (TLS bridging). Certificate management is significantly more complex in both cases and is usually avoided unless there's a hard compliance requirement.

**Load balancing algorithms comparison:**

| Algorithm | How it works | Best for |
|-----------|-------------|----------|
| Round Robin | Requests distributed sequentially | Stateless services with uniform request cost |
| Weighted Round Robin | Sequential but with proportional bias | Mixed instance sizes (e.g., 2 large + 4 small) |
| Least Connections | Next request goes to backend with fewest active connections | Variable request duration (long-lived sessions) |
| IP Hash | Hash of client IP determines backend | Sticky sessions without cookies |
| Random | Random backend selection | Simple, low-coordination environments |

**Least connections vs round robin:** Round robin breaks down when requests have highly variable durations — one slow backend accumulates connections while others sit idle. Least connections routes around this naturally. Prefer it for API services where some endpoints are significantly slower than others.

---

### nginx as a Load Balancer

nginx is both a web server and a capable L7 load balancer. It's widely used in environments where a dedicated LB (like HAProxy or an AWS ALB) isn't available or is overkill.

```nginx
# /etc/nginx/conf.d/api-lb.conf

upstream api_backends {
    # Default algorithm: round-robin
    server 10.0.0.10:8080;
    server 10.0.0.11:8080;
    server 10.0.0.12:8080;

    # Weight — 10.0.0.10 gets 50% of traffic, others get 25% each
    # server 10.0.0.10:8080 weight=2;
    # server 10.0.0.11:8080 weight=1;
    # server 10.0.0.12:8080 weight=1;

    # Least connections — better than round-robin for variable request durations
    # least_conn;

    # IP hash — sticky sessions based on client IP (same client → same backend)
    # ip_hash;

    # Mark a server as backup — only used if all primary servers are down
    # server 10.0.0.13:8080 backup;

    # Take a server out of rotation without removing the config
    # server 10.0.0.12:8080 down;

    # Connection keepalive pool to backends (reduces TCP handshake overhead)
    # Requires proxy_http_version 1.1 and clearing Connection header in location block
    keepalive 32;
}

server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;   # Force HTTPS
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/ssl/certs/api.example.com.crt;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Health check endpoint — respond directly, don't proxy to backends
    location /lb-health {
        access_log off;
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }

    location /api/ {
        proxy_pass http://api_backends;     # no trailing slash — preserves /api/ prefix

        # Pass real client info to backends
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts — tune based on actual backend performance budgets
        proxy_connect_timeout  5s;    # time to establish connection to backend
        proxy_send_timeout    10s;    # time to send request to backend
        proxy_read_timeout    30s;    # time to wait for backend response

        # Enable keepalive to upstream (requires keepalive directive in upstream block)
        proxy_http_version 1.1;
        proxy_set_header Connection "";   # clear Connection header to allow keepalive
    }

    location /static/ {
        # Route static assets to object storage, bypassing app backends entirely
        proxy_pass https://my-bucket.s3.amazonaws.com/static/;
    }
}
```

**Gotcha — trailing slash in `proxy_pass`:** `proxy_pass http://api_backends` (no trailing slash) passes the full URI including `/api/` to the backend. `proxy_pass http://api_backends/` strips `/api/` and only sends the remainder. This is a frequent source of 404s that are hard to trace — always verify which behavior your backend expects.

**Passive vs active health checks:** By default, nginx uses passive health checks — it marks a backend as down only after it fails a real request. The `max_fails` and `fail_timeout` parameters control this behavior. Active health checks (polling `/health` periodically) require the `nginx_upstream_check_module` or nginx Plus. For production, active checks are strongly preferred because they detect failures before real user traffic is impacted.

```nginx
upstream api_backends {
    server 10.0.0.10:8080 max_fails=3 fail_timeout=30s;
    server 10.0.0.11:8080 max_fails=3 fail_timeout=30s;
    # After 3 failures within 30s, backend is removed for 30s
}
```

---

### Health Checks and Backend Failure Handling

Health checks are how a load balancer detects that a backend is unavailable and stops routing traffic to it. Without them, the LB continues sending requests to dead instances, causing user-visible errors.

| Check type | How it works | Failure detection speed | Cost |
|------------|-------------|------------------------|------|
| Passive | Observes real request failures | Slow — requires real user failures | Zero overhead |
| Active (TCP) | Opens TCP connection to backend port | Fast — detects port-level failures | Low |
| Active (HTTP) | Sends HTTP request, checks status code | Fast — detects application-level failures | Low-medium |
| Active (deep) | HTTP request that exercises a DB/cache dependency | Accurate — detects dependency failures | Medium-high |

**Designing a `/health` endpoint:** A good health endpoint returns 200 only when the instance is ready to serve traffic. A minimal endpoint that always returns 200 defeats the purpose. A useful endpoint checks:
- Can the application connect to its database?
- Are required config files present?
- Is memory below a threshold?

However, **don't make health checks too strict** — if your `/health` endpoint checks every dependency and your shared Redis cluster has a blip, you'll drain all backends simultaneously and cause a full outage. The common pattern is a two-tier approach: a liveness check (is the process alive?) and a readiness check (is it ready to serve traffic?). Kubernetes formalizes this distinction with `livenessProbe` and `readinessProbe`.

```yaml
# Kubernetes deployment with separate liveness and readiness probes
containers:
  - name: api
    image: myapp:latest
    livenessProbe:
      httpGet:
        path: /healthz/live      # is the process alive? failure = restart container
        port: 8080
      initialDelaySeconds: 10
      periodSeconds: 10
      failureThreshold: 3
    readinessProbe:
      httpGet:
        path: /healthz/ready     # is it ready for traffic? failure = remove from LB
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 5
      failureThreshold: 2
```

**Connection draining:** When a backend is removed from rotation (scale-in, deployment, health failure), in-flight requests should be allowed to complete rather than being abruptly terminated. AWS ALB calls this "deregistration delay" (default 300s). nginx has no built-in draining for dynamic upstream changes, but you can achieve it by marking a backend `down` and waiting before removing it.

---

## Examples

### Example 1: Hardening a New Ubuntu Server with ufw

Scenario: You've just provisioned a new Ubuntu 22.04 server. It has a public IP. Your goal is to allow SSH from your office IP only, allow web traffic from everywhere, and drop everything else.

```bash
# Step 1: Verify ufw is installed (it is by default on Ubuntu)
ufw version

# Step 2: Set default policies BEFORE enabling
ufw default deny incoming
ufw default allow outgoing

# Step 3: Add rules BEFORE enabling — you're not protected yet, but also not locked out
# Allow SSH only from your office IP (replace with your actual IP)
ufw allow from 203.0.113.10 to any port 22 proto tcp

# Allow web traffic from anywhere
ufw allow 80/tcp
ufw allow 443/tcp

# Allow ICMP (ping) for diagnostics — ufw doesn't expose this via 'allow' commands
# Edit /etc/ufw/before.rules and ensure the ICMP rules in the INPUT section are present
# (they are by default on Ubuntu — verify before removing)

# Step 4: Enable ufw
ufw enable
# You will see: "Command may disrupt existing ssh connections. Proceed with operation (y|n)?"
# Answer y — your SSH rule is already in place

# Step 5: Verify the ruleset
ufw status verbose
# Expected output:
# Status: active
# Default: deny (incoming), allow (outgoing), disabled (routed)
# New profiles: skip
#
# To                         Action      From
# --                         ------      ----
# 22/tcp                     ALLOW IN    203.0.113.10
# 80/tcp                     ALLOW IN    Anywhere
# 443/tcp                    ALLOW IN    Anywhere

# Step 6: Test from a different IP that should be blocked
# From a machine that is NOT 203.0.113.10:
ssh root@<server-ip>
# Expected: Connection timed out (DROP, not REJECT — no response)

# From 203.0.113.10:
ssh root@<server-ip>
# Expected: normal SSH prompt
```

---

### Example 2: Setting Up iptables Rules and Persisting Them

Scenario: A Debian production server running a REST API on port 8080. You need to lock it down, allow monitoring from an internal subnet, and ensure rules survive reboot.

```bash
# Step 1: Install persistence package
apt install -y iptables-persistent

# Step 2: Flush existing rules to start clean (verify nothing important is in place first)
iptables -F
iptables -X   # delete user-defined chains
iptables -Z   # zero counters

# Step 3: Set permissive defaults temporarily while building rules
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -P FORWARD DROP

# Step 4: Build the INPUT chain
# Loopback
iptables -A INPUT -i lo -j ACCEPT

# Stateful — allow established/related connections
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# SSH — allow from anywhere (or restrict to bastion IP in production)
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# API port — allow from anywhere (public-facing)
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT

# Prometheus node_exporter — allow only from monitoring subnet
iptables -A INPUT -p tcp --dport 9100 -s 10.0.10.0/24 -j ACCEPT

# ICMP ping — allow for diagnostics
iptables -A INPUT -p icmp --icmp-type echo-request -j ACCEPT

# Step 5: Now set default DROP
iptables -P INPUT DROP

# Step 6: Verify rules look correct before saving
iptables -L -v -n --line-numbers
# Check: ESTABLISHED/RELATED appears before DROP policy
# Check: SSH rule is present
# Check: node_exporter only from 10.0.10.0/24

# Step 7: Persist rules
netfilter-persistent save
# Writes to /etc/iptables/rules.v4 and /etc/iptables/rules.v6

# Step 8: Simulate reboot and verify
netfilter-persistent reload
iptables -L -v -n --line-numbers
# Rules should be identical to before

# Step 9: Test that node_exporter is not accessible from outside the monitoring subnet
# From a host NOT in 10.0.10.0/24:
curl --connect-timeout 5 http://<server-ip>:9100/metrics
# Expected: curl: (28) Connection timed out — DROP in effect

# From monitoring host in 10.0.10.0/24:
curl http://<server-ip>:9100/metrics
# Expected: Prometheus metrics output
```

---

### Example 3: nginx Load Balancer with Health Check and Path-Based Routing

Scenario: You have two backend API servers (`10.0.0.10:8080`, `10.0.0.11:8080`) and a separate static content server (`10.0.0.20:80`). You want nginx to route `/api/` to the API backends and `/static/` to the content server, with health checks.

```bash
# Step 1: Install nginx on the load balancer host
apt install -y nginx

# Step 2: Create the load balancer config
cat > /etc/nginx/conf.d/app-lb.conf << 'EOF'
upstream api_backends {
    least_conn;   # better than round-robin for variable API response times

    server 10.0.0.10:8080 max_fails=3 fail_timeout=15s;
    server 10.0.0.11:8080 max_fails=3 fail_timeout=15s;

    keepalive 16;   # maintain up to 16 idle keepalive connections per worker
}

upstream static_backend {
    server 10.0.0.20:80;
}

server {
    listen 80;
    server_name app.example.com;

    # Access log with upstream response time for performance monitoring
    log_format upstream_timing '$remote_addr - $upstream_addr [$time_local] '
                                '"$request" $status $body_bytes_sent '
                                'rt=$request_time uct=$upstream_connect_time '
                                'uht=$upstream_header_time urt=$upstream_response_time';
    access_log /var/log/nginx/app-lb.access.log upstream_timing;

    # LB health check — cloud load balancers and uptime monitors hit this
    location /lb-health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }

    # API traffic
    location /api/ {
        proxy_pass http://api_backends;   # no trailing slash — /api/users → /api/users

        proxy_http_version 1.1;
        proxy_set_header Connection "";   # required for keepalive to upstream

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout  3s;
        proxy_read_timeout    20s;

        # Return 502 immediately if all upstreams are down rather than queuing
        proxy_next_upstream error timeout http_502 http_503;
        proxy_next_upstream_tries 2;
    }

    # Static content
    location /static/ {
        proxy_pass http://static_backend/;   # trailing slash strips /static/ prefix

        proxy_cache_valid 200 1h;
        add_header X-Cache-Status $upstream_cache_status;
    }

    # Catch-all — return 404 for anything not explicitly routed
    location / {
        return 404;
    }
}
EOF

# Step 3: Test the nginx config syntax
nginx -t
# Expected: nginx: configuration file /etc/nginx/nginx.conf syntax is ok
#           nginx: configuration file /etc/nginx/nginx.conf test is successful

# Step 4: Reload nginx (no downtime — in-flight requests complete on old workers)
systemctl reload nginx

# Step 5: Verify load balancing is working
# Send 6 requests and watch which backend responds (add a response header on backends)
for i in {1..6}; do
    curl -s -o /dev/null -w "Backend: %{http_code} - %{url_effective}\n" \
         http://app.example.com/api/users
done

# Step 6: Simulate a backend failure — bring down 10.0.0.10
# On 10.0.0.10:
systemctl stop myapi

# Back on the LB host — watch error log for failure detection
tail -f /var/log/nginx/error.log
# After 3 failures within 15s, nginx marks 10.0.0.10 as down
# All subsequent requests should go to 10.0.0.11

# Step 7: Verify the static routing strips the /static/ prefix correctly
curl -v http://app.example.com/static/logo.png
# Request should reach static_backend as GET /logo.png (not /static/logo.png)
```

---

### Example 4: Diagnosing a Connectivity Failure Across Firewall Layers

Scenario: A developer reports that their new microservice can't reach the PostgreSQL database at `10.0.1.5:5432`. The service runs on `10.0.1.10`. You need to systematically diagnose which firewall layer is dropping the connection.

```bash
# ---- On the application host (10.0.1.10) ----

# Step 1: Verify the target is reachable at the network layer (ICMP)
ping -c 3 10.0.1.5
# If this fails: routing problem or ICMP is blocked — check VPC routing tables

# Step 2: Test TCP connectivity to the specific port
# nc (netcat) is the right tool — curl won't work for PostgreSQL
nc -zv 10.0.1.5 5432
# Connection to 10.0.1.5 5432 port [tcp/postgresql] succeeded!
# If this hangs: firewall is DROPping (no response)
# If this fails immediately: firewall is REJECTing

# Step 3: Check if the local OS firewall is interfering outbound
iptables -L OUTPUT -v -n
# Look for any rules that could match outbound TCP to 10.0.1.5:5432

# Step 4: Use traceroute to see where packets stop
traceroute -T -p 5432 10.0.1.5
# -T uses TCP SYN packets (more likely to match real firewall behavior than ICMP)

# ---- On the database host (10.0.1.5) ----

# Step 5: Check if PostgreSQL is actually listening
ss -tlnp | grep 5432
# Expected: LISTEN  0  128  0.0.0.0:5432  0.0.0.0:*  users:(("postgres",...))
# If not listening: PostgreSQL isn't running or is bound to a different interface

# Step 6: Check the INPUT chain for rules allowing/blocking port 5432
iptables -L INPUT -v -n --line-numbers | grep -E "5432|ACCEPT|DROP"

# Step 7: Temporarily test by adding a permissive rule (REMOVE after testing)
iptables -I INPUT 1 -p tcp --dport 5432 -s 10.0.1.10 -j ACCEPT -m comment --comment "DEBUG TEMP"
# Re-test from 10.0.1.10: nc -zv 10.0.1.5 5432
# If this fixes it: the original ruleset is missing this ACCEPT rule
# Remove the temp rule after confirming:
iptables -D INPUT 1

# ---- Cloud layer check ----

# Step 8: If the above is clear, check cloud security groups
# AWS CLI — check the security group attached to the DB instance
aws ec2 describe-security-groups \
    --group-ids sg-0123456789abcdef0 \
    --query 'SecurityGroups[0].IpPermissions'
# Look for an inbound rule: TCP 5432 from sg-app or 10.0.1.0/24

# If the SG is missing the rule, add it:
aws ec2 authorize-security-group-ingress \
    --group-id sg-0123456789abcdef0 \
    --protocol tcp \
    --port 5432 \
    --source-group sg-0987654321fedcba0   # the app tier's security group ID

# Step 9: Final verification from application host
nc -zv 10.0.1.5 5432
# Should now succeed at every layer
```

---

## Exercises

### Exercise 1: Build and Test an iptables Ruleset

Set up a Linux VM (Vagrant, VirtualBox, or any cloud instance) with at least two network interfaces or test using two terminals on the same machine.

1. Flush all existing iptables rules and start from a clean state.
2. Build a ruleset that allows: SSH (port 22), HTTP (port 80), and ICMP. Block everything else on INPUT with a default DROP policy.
3. Add a rule that allows traffic to port 8080 **only** from the loopback interface (`127.0.0.1`).
4. Verify your rules with `iptables -L -v -n --line-numbers` and confirm the rule order is correct.
5. Test that port 9090 is unreachable from an external address but that SSH and HTTP work.
6. Save the rules using `iptables-save` and simulate a reload by flushing all rules and restoring from the saved file. Confirm the rules are identical after restore.

**Challenge:** Add a rule that rate-limits new SSH connections to 3 per minute per source IP using the `hashlimit` module. Research the `hashlimit` module syntax — it is not covered in this lesson but is commonly used in production to prevent brute-force attacks.

---

### Exercise 2: nginx Load Balancer with Weighted Backends and Failure Simulation

Use three terminals or three Docker containers as backends.

1. Start three simple HTTP servers on ports 8081, 8082, and 8083 that return different responses so you can identify which backend is serving (use `python3 -m http.server` with different `index.html` files, or simple `nc` listeners).
2. Write an nginx `upstream` block that distributes traffic with weights: 8081 gets 50% of requests, 8082 gets 30%, 8083 gets 20%.
3. Configure passive health checks so that after 2 failures within 10 seconds, a backend is removed for 20 seconds.
4. Send 20 requests using a loop and verify the distribution roughly matches the weights.
5. Stop the process on port 8081 and send another 20 requests. Confirm that after the initial failures, traffic is redistributed to the remaining backends.
6. Restart port 8081. Verify nginx resumes sending traffic to it after the `fail_timeout` expires.

**Explain in writing:** Why does round-robin work less well than weighted round-robin here? When would `least_conn` be a better choice than weighted round-robin?

---

### Exercise 3: Debug a Deliberately Misconfigured Firewall

This exercise requires two machines on the same network (or two Docker containers with a shared network).

**Setup (run these on machine B):**

```bash
# Machine B: Start a web server on port 80
python3 -m http.server 80 &

# Add a misconfigured iptables rule:
iptables -A INPUT -p tcp --dport 80 -j DROP
iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT
# NOTE: The ESTABLISHED/RELATED rule is intentionally missing
iptables -P INPUT DROP
```

From machine A, attempt to connect to machine B on port 80. You should observe a timeout.

Your tasks:
1. From machine A, determine whether the port is being DROPped or REJECTed without logging into machine B. Explain how you determined this.
2. Log into machine B via SSH (this still works — your existing session is ESTABLISHED). Identify the specific rule causing the problem using `iptables -L`.
3. Fix the firewall so that: port 80 is accessible from machine A, SSH remains accessible, and the missing stateful rule is added in the correct position.
4. Verify the fix without flushing all rules — use `-I` to insert at the correct position and `-D` to remove the blocking rule.

**Explain:** What would happen to your SSH session if you had added `iptables -P INPUT DROP` without the ESTABLISHED/RELATED rule in place and then disconnected? Why?

---

### Exercise 4: AWS Security Group Design for a Two-Tier App

This exercise is design and CLI-based. You need AWS CLI access and an AWS account (free tier is sufficient).

**Scenario:** You are deploying a web application with a frontend (port 443, public) and a backend API (port 8080, internal only). Both tiers run on EC2 instances.

1. Using the AWS CLI, create two security groups: `sg-frontend` and `sg-backend` in the same VPC.
2. Configure `sg-frontend` to allow inbound TCP 443 from `0.0.0.0/0` and inbound TCP 22 from your IP only.
3. Configure `sg-backend` to allow inbound TCP 8080 **only from `sg-frontend`** using a security group reference (not a CIDR range).
4. Launch two t2.micro instances: one with `sg-frontend`, one with `sg-backend`. Run `python3 -m http.server 8080` on the backend instance.
5. From the frontend instance, verify you can reach port 8080 on the backend instance. From your laptop, verify you **cannot** reach port 8080 on the backend instance directly.
6. Add a rule to `sg-backend` that accidentally allows all inbound traffic (`0.0.0.0/0` on all ports). Verify that port 8080 is now accessible from your laptop.
7. Remove the overly permissive rule. Verify access is restricted again.

**Explain:** Why did step 6 work even though the original rules were still present? What AWS mechanism would you use if you needed a rule to explicitly DENY a specific IP even if another rule allows it?
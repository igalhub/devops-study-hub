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
|--------|----------|-------------------|
| `ACCEPT` | Let the packet through | Yes — connection proceeds |
| `DROP` | Silently discard | No — sender times out |
| `REJECT` | Discard and send ICMP error | Yes — sender gets "connection refused" immediately |
| `LOG` | Log and continue evaluation | N/A — non-terminating |

**DROP vs REJECT:** Use `DROP` for external-facing rules — giving no response makes port scanning slower and less informative for attackers. Use `REJECT` internally (between services) so that legitimate clients fail fast rather than hanging until timeout.

**Connection state matters:** Modern firewalls are stateful. A packet that is part of an already-established TCP session (`ESTABLISHED`) or is related to one (`RELATED`, e.g., ICMP error responses) does not need its own ACCEPT rule. Always add a stateful ACCEPT rule near the top of your INPUT chain — failing to do this is the most common way engineers accidentally lock themselves out when setting a default DROP policy.

---

### iptables (Linux Kernel Firewall)

iptables is the traditional userspace interface to the Linux kernel's `netfilter` packet-filtering framework. On Ubuntu 20.04+ and RHEL 9+, the actual backend is `nftables` — `iptables` commands are translated via a compatibility shim (`iptables-nft`). The syntax and behavior below remain the same; the shim is transparent.

It organizes rules into **chains** within **tables**:

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

# Set default policies (order matters — set DROP last or you'll lock yourself out)
iptables -P OUTPUT ACCEPT
iptables -P FORWARD DROP

# --- Build INPUT rules in order ---

# 1. Allow loopback (required for many local services)
iptables -A INPUT -i lo -j ACCEPT

# 2. Allow established/related connections — do this before DROP policy
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 3. Allow new SSH connections
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# 4. Allow HTTP and HTTPS
iptables -A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT

# 5. Allow PostgreSQL only from a specific application server IP
iptables -A INPUT -p tcp --dport 5432 -s 10.0.0.50 -j ACCEPT

# 6. Now set default DROP (all unmatched packets are dropped)
iptables -P INPUT DROP

# --- Rule management ---

# Insert a rule at a specific position (position 3)
iptables -I INPUT 3 -p tcp --dport 8080 -j ACCEPT

# Delete a rule by line number
iptables -D INPUT 3

# Flush all rules in a chain (dangerous — removes all rules)
iptables -F INPUT

# Save rules to survive reboot
iptables-save > /etc/iptables/rules.v4        # Debian/Ubuntu
service iptables save                          # RHEL/CentOS

# Restore saved rules
iptables-restore < /etc/iptables/rules.v4
```

**Gotcha — the lockout trap:** If you run `iptables -P INPUT DROP` before adding the ESTABLISHED/RELATED and SSH ACCEPT rules, your existing SSH session will continue (the kernel allows existing connections) but you will not be able to reconnect if you disconnect. Always add ACCEPT rules first, then set the default policy to DROP.

**Gotcha — rules don't persist by default:** `iptables` rules live in kernel memory. A reboot wipes them. On Debian/Ubuntu, install `iptables-persistent` (`apt install iptables-persistent`) and save rules via `netfilter-persistent save`. On RHEL, use `firewalld` or the `iptables` service.

---

### ufw — Uncomplicated Firewall

`ufw` wraps `iptables` with a simpler interface designed for servers. It's the standard on Ubuntu. Internally it still generates `iptables` rules, so you can mix `iptables -L` inspection with `ufw` management.

```bash
# Initial setup
ufw default deny incoming      # default DROP on INPUT
ufw default allow outgoing     # default ACCEPT on OUTPUT

# Enable (applies rules, persists across reboots automatically)
ufw enable

# Status — always check this after changes
ufw status verbose
ufw status numbered             # shows line numbers for deletion

# Allow rules
ufw allow 22/tcp                                    # SSH
ufw allow 80/tcp                                    # HTTP
ufw allow 443/tcp                                   # HTTPS
ufw allow from 10.0.0.50 to any port 5432 proto tcp  # DB from one host
ufw allow from 10.0.0.0/8 to any port 9090          # monitoring from internal net

# Deny rules (explicit deny before catch-all)
ufw deny 3306                   # block MySQL from everywhere

# Allow by application profile (reads /etc/ufw/applications.d/)
ufw allow OpenSSH
ufw allow 'Nginx Full'          # opens both 80 and 443
ufw app list                    # see available profiles

# Delete rules
ufw delete allow 80/tcp         # by rule specification
ufw delete 3                    # by number from 'ufw status numbered'

# Reset everything (disables ufw, flushes all rules)
ufw reset
```

**When to use ufw vs iptables directly:** Use `ufw` for simple server hardening where you need a small set of static rules. Use `iptables` directly (or `nftables`) when you need fine-grained control — custom chains, packet marking, NAT rules, or integration with tooling like Docker (which manages its own iptables chains and does not respect `ufw` rules by default).

**Docker and ufw gotcha:** Docker bypasses `ufw` by writing rules directly to `iptables`. If you `ufw deny 8080` but run a container with `-p 8080:8080`, the port will still be publicly accessible. The fix is to configure Docker to not manipulate iptables (`"iptables": false` in `/etc/docker/daemon.json`) or to bind containers to localhost (`-p 127.0.0.1:8080:8080`) and let a reverse proxy handle external access.

---

### Cloud Security Groups

Cloud security groups are stateful firewalls applied at the hypervisor/NIC level — before packets reach your instance's OS. This means they work regardless of what's running inside the VM, and bypassing them from inside the OS is not possible.

| Feature | iptables (host) | AWS Security Group |
|---------|----------------|-------------------|
| Applied at | OS kernel | Hypervisor/NIC |
| Statefulness | Requires conntrack module | Always stateful |
| Rule ordering | Matters (first match wins) | All rules evaluated; most permissive wins |
| References other groups | No | Yes — attach SG as a source |
| Logging | Via LOG target | Via VPC Flow Logs |
| Persistence | Requires explicit save | Always persisted |

**All rules evaluated (no ordering):** Unlike iptables, AWS security groups evaluate all inbound rules and take the most permissive result. There is no "first match wins." This means you cannot write a rule to block a specific IP if another rule allows all traffic on that port — the ALLOW wins.

**Security group referencing:** Instead of specifying IP ranges, you can reference another security group as the source. Any instance in that group is allowed. This is the correct pattern for internal service communication in AWS — it scales automatically as instances are added or removed from the group.

```
# Example: 3-tier application security group structure

# Web tier SG (sg-web)
Inbound:
  TCP  80    0.0.0.0/0, ::/0   ← HTTP from internet
  TCP  443   0.0.0.0/0, ::/0   ← HTTPS from internet

# App tier SG (sg-app)
Inbound:
  TCP  8080  sg-web              ← only from web tier (references SG, not IPs)

# DB tier SG (sg-db)
Inbound:
  TCP  5432  sg-app              ← only from app tier

# All SGs — Outbound:
  All traffic  0.0.0.0/0        ← AWS default; restrict if compliance requires it
```

**GCP firewall rules** work similarly but are applied at the VPC network level, not per-instance. Rules use **target tags** or **service accounts** as selectors, and priority (0–65535, lower = higher priority) determines evaluation order when multiple rules match.

---

### Load Balancer Types and Layer Differences

| Type | OSI Layer | What it inspects | Typical use |
|------|-----------|-----------------|-------------|
| L4 (Network/Transport) | 4 — TCP/UDP | IP, port, protocol | Any TCP/UDP protocol, ultra-low latency |
| L7 (Application) | 7 — HTTP | URL, headers, cookies, body | HTTP/HTTPS routing, SSL termination |

**L4 load balancers** forward raw TCP/UDP connections. They are fast because they do minimal inspection. They cannot distinguish between `/api` and `/static` in the same connection — they only see the port. Use L4 when you need to load-balance non-HTTP protocols (gRPC over TCP, MQTT, game servers) or when latency is paramount.

**L7 load balancers** parse the HTTP request before routing. This enables:

- **Path-based routing:** `/api/*` → backend cluster A, `/images/*` → CDN or object storage
- **Host-based routing:** `api.example.com` → API fleet, `app.example.com` → frontend fleet
- **SSL/TLS termination:** handle certificates centrally; backends receive plain HTTP
- **Header manipulation:** inject `X-Real-IP`, `X-Forwarded-For`, custom auth headers
- **Active health checks:** send HTTP requests to `/health` and remove failing backends
- **Session affinity (sticky sessions):** route the same client to the same backend using cookies

**The TLS termination trade-off:** Terminating TLS at the load balancer means traffic between the LB and backends is unencrypted (typically acceptable within a VPC/private network). If compliance requires end-to-end encryption, use TLS passthrough (L4) or re-encrypt at the backend (TLS bridging). The certificate management is significantly more complex in both cases.

---

### nginx as a Load Balancer

nginx is both a web server and a capable L7 load balancer. It's widely used for this purpose in environments where a dedicated LB (like HAProxy or an AWS ALB) isn't available or is overkill.

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
        proxy_pass http://api_backends;     # trailing slash matters — see gotcha below

        # Pass real client info to backends
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout  5s;    # time to establish connection to backend
        proxy_send_timeout    10s;    # time to send request to backend
        proxy_read_timeout    30s;    # time to wait for backend response

        # Enable keepalive to upstream (requires keepalive in upstream block)
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    location /static/ {
        # Route static assets directly to object storage, bypassing backends
        proxy_pass https://my-bucket.s3.amazonaws
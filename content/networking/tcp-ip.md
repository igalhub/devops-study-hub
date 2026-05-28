---
title: TCP/IP Fundamentals
module: networking
duration_min: 20
difficulty: beginner
tags: [networking, tcp, ip, udp, osi, protocols, ports]
exercises: 4
---

## Overview

Everything in DevOps runs on TCP/IP. When a service is unreachable, a port is blocked, or a connection times out, you need to understand what's happening at the network layer to diagnose it quickly — before you start restarting containers or blaming the application. TCP/IP is the foundation on which every service mesh, load balancer, container network, and cloud VPC is built, so fluency here pays off across your entire career.

The TCP/IP model emerged from ARPANET research in the 1970s with a core design principle: packet-switched, best-effort delivery at the network layer, with reliability pushed up to the transport layer. This layering means each concern is isolated — IP doesn't care about ordering, TCP doesn't care about routing, HTTP doesn't care about whether the underlying transport is wired or wireless. That separation is what makes the stack composable and diagnosable.

In the DevOps toolchain, TCP/IP knowledge surfaces constantly: Kubernetes network policies filter by port and IP block, Docker bridge networks assign RFC 1918 addresses, Prometheus scrapes targets over HTTP, health checks use TCP probes, and Ansible connects over SSH. When any of those break, your debugging starts at the network layer and works upward. This lesson gives you the mental model and the commands to do that efficiently.

---

## Concepts

### The OSI Model (Practical View)

The full 7-layer OSI model is useful as a mental map for isolating where a problem lives. In practice, you'll spend most of your time at layers 3, 4, and 7.

| Layer | Name | Protocol examples | What breaks here |
|-------|------|-------------------|------------------|
| 7 | Application | HTTP, SSH, DNS, SMTP, TLS | App config, TLS cert mismatch, wrong URL, auth failure |
| 6 | Presentation | TLS/SSL encoding | Certificate errors, cipher mismatch |
| 5 | Session | (mostly handled by app) | Session timeout, keep-alive config |
| 4 | Transport | TCP, UDP | Port blocked, connection refused, timeout, packet loss |
| 3 | Network | IP, ICMP | Wrong route, firewall drop, wrong subnet, TTL exceeded |
| 2 | Data Link | Ethernet, ARP | Wrong MAC, ARP failure, VLAN mismatch |
| 1 | Physical | Cables, NIC | Interface down, cable unplugged |

**Debug top-down:** start at layer 7 (does the app respond?) and work down until something fails. If HTTP is broken but `nc` to port 80 succeeds, the problem is in the application, not the network. If `nc` fails but `ping` succeeds, the problem is at layer 4 (port/firewall). If `ping` fails, move to layer 3 (routing). This systematic approach prevents wasted time in the wrong layer.

The TCP/IP model collapses OSI layers 5–7 into "Application" and layers 1–2 into "Link," but the OSI vocabulary is still what people use when talking about firewalls ("layer 4 rules") and load balancers ("layer 7 routing").

---

### IP Addresses and Subnets

Every host on a network has an IP address — a 32-bit number written as four decimal octets: `192.168.1.100`. A subnet mask (or CIDR prefix) defines which bits identify the network vs. the host.

```
192.168.1.100/24
              ↑
              24 bits = network, 8 bits = host
              → network:       192.168.1.0
              → valid hosts:   192.168.1.1 – 192.168.1.254
              → broadcast:     192.168.1.255
              → total hosts:   254
```

A `/25` gives you 126 hosts per subnet; `/16` gives 65,534. Each time you increase the prefix by 1, you halve the host count. This matters when planning VPC subnets in AWS or GCP — choose a CIDR that leaves room to grow.

**Private ranges (RFC 1918)** — routable only within private networks, not on the public internet:

| Range | CIDR | Typical use |
|-------|------|-------------|
| `10.0.0.0` – `10.255.255.255` | `10.0.0.0/8` | Cloud VPCs, corporate LANs |
| `172.16.0.0` – `172.31.255.255` | `172.16.0.0/12` | Docker default bridge network |
| `192.168.0.0` – `192.168.255.255` | `192.168.0.0/16` | Home routers, small office |

**Special addresses:**
- `127.0.0.1` — loopback (the host talking to itself); entire `127.0.0.0/8` is loopback
- `0.0.0.0` — "all interfaces" when used as a bind address; "default route" in routing tables
- `169.254.x.x` — link-local (APIPA); a host assigned this has no DHCP — usually a problem
- `100.64.0.0/10` — shared address space; AWS instance metadata endpoint lives at `169.254.169.254`

```bash
# Show all IP addresses and interfaces
ip addr show

# Show a specific interface
ip addr show eth0

# Show only IPv4 addresses
ip -4 addr show

# Show IPv6
ip -6 addr show
```

**`169.254.x.x` warning:** if `ip addr show` reveals a `169.254` address on your primary interface, DHCP failed. The host may still be partially functional but routing to anything outside the local link will be broken. This is common in misconfigured VMs and containers that lose their DHCP lease on restart.

**CIDR overlap in Kubernetes:** when provisioning clusters, your node CIDR, pod CIDR, and service CIDR must not overlap each other or your VPC subnet. A common mistake is letting Kubernetes default pod CIDR (`10.244.0.0/16`) collide with the corporate VPN range, breaking all pod-to-pod traffic when the VPN is connected.

---

### TCP vs UDP

| Property | TCP | UDP |
|----------|-----|-----|
| Connection setup | 3-way handshake | None |
| Reliable delivery | Yes (retransmits lost segments) | No (fire and forget) |
| Ordered delivery | Yes | No |
| Flow control | Yes (window sizing) | No |
| Congestion control | Yes | No |
| Header overhead | ~20 bytes + handshake RTT | ~8 bytes |
| Latency | Higher (handshake + ACKs) | Lower |
| Use cases | HTTP/S, SSH, databases, email | DNS, NTP, DHCP, video streaming, game state |

**TCP 3-way handshake** — every TCP connection starts here:

```
Client                    Server
  │                          │
  │──── SYN ────────────────>│  Client picks initial sequence number (ISN)
  │                          │
  │<─── SYN-ACK ─────────────│  Server picks its own ISN, acks client's ISN+1
  │                          │
  │──── ACK ────────────────>│  Client acks server's ISN+1
  │                          │
  │═══════ DATA FLOWS ═══════│
```

The handshake takes one full round-trip before any data flows. At 100ms RTT to a distant server, your first byte of data costs at least 100ms just for the handshake. TLS adds another 1–2 round trips on top. This is why connection pooling exists in every database driver and HTTP client — amortizing that setup cost across many requests.

**TCP connection states you'll encounter:**

| State | Meaning | Action if stuck |
|-------|---------|-----------------|
| `LISTEN` | Socket accepting connections | Normal for server processes |
| `ESTABLISHED` | Active connection, data flowing | Normal |
| `TIME_WAIT` | Connection closed, draining stale packets | Normal; lasts ~60s (2×MSL) |
| `CLOSE_WAIT` | Remote side closed, local app hasn't called `close()` | Possible app bug — connection leak |
| `SYN_SENT` | Client sent SYN, waiting for SYN-ACK | Firewall drop or server down |
| `SYN_RECV` | Server got SYN, sent SYN-ACK, waiting for ACK | SYN flood or very high latency |
| `FIN_WAIT_2` | Local sent FIN, waiting for remote FIN | Remote app not closing cleanly |

**`TIME_WAIT` gotcha:** a server handling high connection volume can accumulate thousands of `TIME_WAIT` sockets. This is normal and expected — do not "fix" it by disabling `TIME_WAIT`. Doing so can cause data corruption from stale packets arriving on a reused port number. If you're running out of ephemeral ports, tune `net.ipv4.ip_local_port_range` to expand the pool and enable `net.ipv4.tcp_tw_reuse` (not `tcp_tw_recycle`, which was removed in kernel 4.12 and was broken in NAT environments).

**`CLOSE_WAIT` gotcha:** large numbers of `CLOSE_WAIT` sockets almost always indicate a bug in the application — it received a FIN from the peer but never called `close()` on the socket. This leaks file descriptors and eventually produces "too many open files" errors that crash the process. Check your connection pool shutdown logic.

```bash
# Count sockets by state — quick health check
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn

# Find processes with CLOSE_WAIT connections
ss -tanp | grep CLOSE_WAIT

# Watch socket counts in real time
watch -n 1 'ss -tan | awk "NR>1 {print \$1}" | sort | uniq -c'
```

---

### Ports

Ports are 16-bit numbers (0–65535) that allow multiple applications to share a single IP address. The kernel routes incoming packets to the correct process based on the `{protocol, local IP, local port, remote IP, remote port}` 5-tuple — each unique 5-tuple is a distinct connection.

**Port ranges:**

| Range | Name | Notes |
|-------|------|-------|
| 0–1023 | Well-known / privileged | Requires root or `CAP_NET_BIND_SERVICE` to bind |
| 1024–49151 | Registered | IANA-assigned; unprivileged processes may bind |
| 49152–65535 | Ephemeral / dynamic | OS-assigned for outbound client connections |

**Common service ports:**

| Port | Protocol | Service |
|------|----------|---------|
| 22 | TCP | SSH |
| 25 | TCP | SMTP |
| 53 | TCP+UDP | DNS |
| 80 | TCP | HTTP |
| 443 | TCP | HTTPS |
| 2379–2380 | TCP | etcd (Kubernetes) |
| 3306 | TCP | MySQL / MariaDB |
| 5432 | TCP | PostgreSQL |
| 6379 | TCP | Redis |
| 8080 | TCP | Alt-HTTP, common for dev servers |
| 9090 | TCP | Prometheus |
| 9100 | TCP | Prometheus node_exporter |
| 10250 | TCP | Kubernetes kubelet API |

```bash
# Show all listening TCP sockets with process info (preferred modern tool)
ss -tlnp

# Show TCP + UDP listeners
ss -tulnp

# IPv4 only
ss -tlnp4

# Show all established TCP connections
ss -tanp | grep ESTABLISHED

# Find what process is using a specific port
ss -tlnp | grep :443
lsof -i :443          # alternative; works on macOS too

# Check the ephemeral port range on this system
cat /proc/sys/net/ipv4/ip_local_port_range
# typical: 32768   60999  →  ~28000 available client ports

# Test whether a port is open without installing extra tools
# (bash /dev/tcp is available on most Linux systems)
timeout 3 bash -c 'cat < /dev/null > /dev/tcp/10.0.0.1/5432' \
  && echo "Port open" || echo "Port closed or filtered"
```

**Binding to `0.0.0.0` vs `127.0.0.1`:** when a service binds to `0.0.0.0`, it listens on all interfaces and is reachable from the network. When it binds to `127.0.0.1`, it only accepts local connections. Databases and caches that are only accessed by local application code should bind to loopback. Accidentally exposing them on `0.0.0.0` is one of the most common cloud security misconfigurations — it's how publicly accessible Redis and Elasticsearch instances end up getting wiped by ransomware bots.

```bash
# Good: Redis bound to loopback only
# LISTEN  0  128  127.0.0.1:6379  0.0.0.0:*

# Bad: Redis exposed on all interfaces
# LISTEN  0  128  0.0.0.0:6379   0.0.0.0:*

# Verify your Redis bind configuration
grep ^bind /etc/redis/redis.conf
# Should read: bind 127.0.0.1
```

---

### ICMP — The Diagnostic Protocol

ICMP (Internet Control Message Protocol) operates at layer 3 and carries control messages: reachability probes (ping), "destination unreachable," "TTL exceeded," and path MTU discovery. It has no ports — messages are identified by type and code numbers.

| ICMP Type | Code | Meaning |
|-----------|------|---------|
| 0 | 0 | Echo Reply (ping response) |
| 3 | 0 | Destination Network Unreachable |
| 3 | 1 | Destination Host Unreachable |
| 3 | 3 | Destination Port Unreachable |
| 3 | 4 | Fragmentation Needed, DF set (PMTUD) |
| 8 | 0 | Echo Request (ping) |
| 11 | 0 | TTL Exceeded in Transit (used by traceroute) |

```bash
# Test reachability — 4 packets, report packet loss and RTT
ping -c 4 8.8.8.8

# Fast timeout — useful in scripts (1 packet, 2-second wait)
ping -c 1 -W 2 10.0.0.1 && echo "UP" || echo "DOWN"

# Trace the path — shows each router hop and RTT
traceroute google.com
traceroute -n google.com       # skip DNS lookups per hop, faster output

# mtr = traceroute + continuous ping; best tool for diagnosing per-hop packet loss
mtr --report --report-cycles 10 google.com

# Test path MTU — find the largest packet that passes without fragmentation
# 1472 bytes payload + 28 bytes IP/ICMP header = 1500 bytes (standard Ethernet MTU)
ping -c 3 -M do -s 1472 8.8.8.8
# If you get "Frag needed" or the pings time out, the path MTU is smaller than 1500
# Try -s 1400, then -s 1350 to narrow it down
```

**ICMP filtering warning:** many firewalls and cloud security groups block ICMP by default. A failed `ping` does not mean the host is unreachable — the TCP port may still be open and serving traffic. Always follow a failed `ping` with a TCP-level check (`nc -zv`, `curl`, or the bash `/dev/tcp` trick). Conversely, `ping` succeeding does not mean the service is up — it only proves layer 3 connectivity.

**MTU and PMTUD black holes:** Path MTU Discovery works by sending packets with the "Don't Fragment" (DF) bit set. If a router needs to fragment the packet, it sends back ICMP type 3 code 4 instead. If a firewall drops that ICMP message, the sender never learns the correct MTU. TCP connections will appear to hang silently after the 3-way handshake — the handshake uses small packets, but bulk data transfer uses large ones that get silently dropped. This is one of the most common causes of mysterious stalls across VPNs and between cloud regions.

```bash
# Diagnose a PMTUD black hole: if large transfers hang but small ones work,
# capture traffic to confirm the DF bit and missing ICMP responses
tcpdump -i eth0 'icmp[icmptype] == icmp-unreach'
```

---

### Routing

When a packet leaves a host, the kernel looks up the destination IP in the routing table to decide: which interface to send it out, and which gateway (next-hop) to forward it to.

```bash
# Show the full routing table
ip route show

# Example output on a Kubernetes node:
# default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5
# 10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.5
# 10.244.0.0/16 via 10.0.0.1 dev eth0          ← pod CIDR routed through gateway
# 10.244.2.0/24 dev cni0 proto kernel scope link src 10.244.2.1  ← local pod subnet

# Which route would be used for a specific destination? (includes source IP selection)
ip route get 8.8.8.8
# Output: 8.8.8.8 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0

# Add a static route (non-persistent — survives until reboot or network restart)
ip route add 10.10.0.0/16 via 10.0.0.254 dev eth0

# Delete a route
ip route del 10.10.0.0/16

# Persist a static route (systemd-networkd)
# /etc/systemd/network/10-static.network
[Route]
Gateway=10.0.0.254
Destination=10.10.0.0/16

# Show the ARP table — IP → MAC mappings for hosts on the local segment
ip neigh show
```

**Default gateway:** the route `0.0.0.0/0` (shown as `default`) matches everything not covered by a more specific route. If this is missing or points to the wrong IP, the host can reach local machines but cannot route to any other network or the internet.

**Longest prefix match:** the kernel always uses the most specific matching route. `10.244.1.0/24` beats `10.244.0.0/16` beats `0.0.0.0/0` for a packet destined to `10.244.1.5`. Kubernetes relies on this to route traffic to individual pods: the CNI plugin injects `/32` or `/24` routes for pod IPs, which override the broader cluster CIDR route.

**Asymmetric routing warning:** in multi-homed hosts (two NICs, two gateways), return traffic may leave on a different interface than it arrived on. Linux's `rp_filter` setting will silently drop packets that fail a reverse-path check. This is a common source of mysterious one-way traffic failures in bonded or multi-homed setups.

---

### DNS Resolution

DNS translates hostnames to IP addresses. Before a TCP connection can be established, the hostname must be resolved — making DNS failures appear as network failures even when the network itself is healthy. Every DevOps engineer should be able to independently confirm whether a failure is DNS or network.

```bash
# Query DNS for an A record (IPv4 address)
dig +short api.example.com

# Full answer with TTL, authoritative flag, query time
dig api.example.com A

# Query a specific DNS server directly (bypass /etc/resolv.conf)
dig @8.8.8.8 api.example.com

# Reverse lookup (IP → PTR record)
dig -x 8.8.8.8

# Query for other record types
dig api.example.com CNAME
dig example.com MX
dig example.com NS
dig example.com TXT   # useful for SPF, DKIM, domain verification

# Trace the full delegation path from root servers
dig +trace api.example.com

# Check what DNS server this host is using
cat /etc/resolv.conf

# Quick lookup without dig (less detail but always available)
nslookup api.example.com
host api.example.com
```

**TTL and caching:** DNS records carry a TTL (time-to-live) in seconds. When you update a DNS record, resolvers cache the old answer until the TTL expires. During a migration or incident, this is critical — if TTL was 3600 (1 hour), you may need to wait up to an hour for all clients to see the new IP. Pre-lowering TTLs to 60s before a planned migration is standard practice.

**`/etc/resolv.conf` in containers:** Docker and Kubernetes inject `resolv.conf` into containers. In Kubernetes, pods use the cluster DNS (CoreDNS) by default, running at the `kube-dns` service IP. If pods can't resolve service names, CoreDNS is the first place to look — not the underlying host DNS.

```bash
# From inside a Kubernetes pod, confirm DNS config
cat /etc/resolv.conf
# Expected output:
# nameserver 10.96.0.10        ← cluster DNS IP
# search default.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# Test in-cluster DNS resolution from a pod
kubectl run -it --rm dns-test --image=busybox --restart=Never -- \
  nslookup kubernetes.default.svc.cluster.local

# Check CoreDNS logs for resolution failures
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
```

**`ndots:5` gotcha:** Kubernetes sets `options ndots:5` in pod `resolv.conf`. This means any hostname with fewer than 5 dots triggers a search through the `search` domains before trying the name as-is. A query for `api.external-service.com` (3 dots) will first try `api.external-service.com.default.svc.cluster.local`, fail, then try several more variants before reaching the actual external DNS. This adds latency — up to 5 failed DNS queries before the real one. Applications that make high volumes of external DNS lookups can work around this by using fully-qualified domain names (trailing dot: `api.external-service.com.`) or reducing `ndots` in a custom pod DNS config.

---

### Practical Diagnostic Workflow

When a service is unreachable, use this layered checklist to isolate the fault quickly without guessing:

```
1. DNS:      dig +short <hostname>           → does it resolve to an IP?
2. Layer 3:  ping -c 3 <IP>                 → does ICMP echo reach the host?
3. Layer 4:  nc -zv <IP> <port>             → does the TCP port accept connections?
             (or: timeout 3 bash -c 'cat < /dev/null > /dev/tcp/<IP>/<port>')
4. Layer 7:  curl -v http://<IP>:<port>/    → does the application respond?
5. Local:    ss -tlnp | grep <port>         → is the service listening on this host?
6. Routing:  ip route get <IP>              → does the kernel have a route to the target?
7. Firewall: iptables -L -n -v              → is a local rule dropping packets?
```

Each step narrows the blast radius. If step 1 fails, fix DNS — don't touch the app. If step 3 fails but step 2 succeeds, the problem is a firewall rule or the service isn't listening. If step 4 fails but step 3 succeeds, it's an application error. This prevents the common mistake of restarting services when the real problem is a missing DNS entry or a security group rule.

```bash
# Full one-liner diagnostic sweep (substitute your target)
TARGET=api.example.com PORT=443

echo "=== DNS ===" && dig +short $TARGET
echo "=== PING ===" && ping -c 2 -W 2 $(dig +short $TARGET | head -1)
echo "=== TCP ===" && nc -zv $(dig +short $TARGET | head -1) $PORT
echo "=== HTTP ===" && curl -o /dev/null -sw "HTTP %{http_code} in %{time_total}s\n" \
  https://$TARGET/health
```

---

## Examples

### Example 1: Diagnose a "Connection Refused" Error from an Application Container

**Scenario:** A web application container is throwing `Connection refused` when trying to reach a PostgreSQL database. Both containers are running on the same Docker host.

```bash
# Step 1: Confirm the database container is running and healthy
docker ps | grep postgres
# CONTAINER ID  IMAGE     STATUS         PORTS
# a3f2b1c4d5e6  postgres  Up 5 minutes   0.0.0.0:5432->5432/tcp   ← exposed on host

# Step 2: Find out what IP the database container is on
docker inspect postgres-container | \
  python3 -m json.tool | grep '"IPAddress"'
# "IPAddress": "172.17.0.3"

# Step 3: Verify PostgreSQL is actually listening inside the container
docker exec postgres-container ss -tlnp | grep 5432
# LISTEN  0  128  0.0.0.0:5432  0.0.0.0:*   users:(("postgres",pid=1,fd=4))
# ✓ listening on all interfaces inside the container

# Step 4: From the app container, test TCP reachability to the DB container
docker exec app-container bash -c \
  'timeout 3 bash -c "cat < /dev/null > /dev/tcp/172.17.0.3/5432" \
   && echo "Port reachable" || echo "Port blocked"'
# Port blocked  ← problem is at layer 3/4, not the app

# Step 5: Check routing from the app container
docker exec app-container ip route show
# default via 172.17.0.1 dev eth0
# 172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.4
# ✓ both containers are on 172.17.0.0/16 — routing looks correct

# Step 6: Check iptables rules on the Docker host for DROP rules
iptables -L DOCKER-USER -n -v
# The issue: a custom iptables rule was dropping inter-container traffic

# Fix: identify and remove the blocking rule (adjust rule number accordingly)
iptables -L DOCKER-USER -n -v --line-numbers
iptables -D DOCKER-USER 3   # delete rule number 3

# Verify the fix
docker exec app-container bash -c \
  'timeout 3 bash -c "cat < /dev/null > /dev/tcp/172.17.0.3/5432" \
   && echo "Port reachable" || echo "Still blocked"'
# Port reachable  ✓
```

---

### Example 2: Identify a Port Binding Misconfiguration in Production

**Scenario:** After deploying a new Redis instance, the application can't connect, but the Redis process is running.

```bash
# Step 1: Confirm Redis is running
systemctl status redis
# ● redis.service - Advanced key-value store
#    Active: active (running)

# Step 2: Check what address Redis is listening on
ss -tlnp | grep 6379
# LISTEN  0  128  127.0.0.1:6379  0.0.0.0:*  users:(("redis-server",pid=1842))
# ↑ only bound to loopback — unreachable from other hosts or containers

# Step 3: Check the bind configuration
grep "^bind" /etc/redis/redis.conf
# bind 127.0.0.1    ← this is the problem; app is on a different host/container

# Step 4: Update the bind address to the internal network interface
# WARNING: never bind Redis to 0.0.0.0 on a public network.
# Bind to the specific private interface IP instead.
PRIVATE_IP=$(ip -4 addr show eth0 | awk '/inet / {print $2}' | cut -d/ -f1)
echo "Private IP: $PRIVATE_IP"
# Private IP: 10.0.1.15

# Edit /etc/redis/redis.conf:
# Change:  bind 127.0.0.1
# To:      bind 127.0.0.1 10.0.1.15
sed -i "s/^bind 127.0.0.1$/bind 127.0.0.1 $PRIVATE_IP/" /etc/redis/redis.conf

# Step 5: Restart Redis and verify
systemctl restart redis
ss -tlnp | grep 6379
# LISTEN  0  128  127.0.0.1:6379  0.0.0.0:*
# LISTEN  0  128  10.0.1.15:6379  0.0.0.0:*   ← now also on private interface

# Step 6: Test connectivity from the application server
nc -zv 10.0.1.15 6379
# Connection to 10.0.1.15 6379 port [tcp/*] succeeded!

# Step 7: Also restrict access via firewall — only app servers should reach Redis
iptables -A INPUT -s 10.0.1.0/24 -p tcp --dport 6379 -j ACCEPT
iptables -A INPUT -p tcp --dport 6379 -j DROP
```

---

### Example 3: Trace a DNS Resolution Failure in a Kubernetes Pod

**Scenario:** A pod is failing to connect to an external API. The error message is `dial tcp: lookup api.payments.io: no such host`.

```bash
# Step 1: Exec into the failing pod
kubectl exec -it payment-service-7d9f4b6c8-xk2p9 -- /bin/sh

# Step 2: Check the DNS configuration inside the pod
cat /etc/resolv.conf
# nameserver 10.96.0.10
# search payments.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# Step 3: Try to resolve the external hostname
nslookup api.payments.io
# Server:   10.96.0.10
# Address:  10.96.0.10:53
# ** server can't find api.payments.io: NXDOMAIN
# ← CoreDNS is responding, but can't resolve — suggests CoreDNS can't reach upstream

# Step 4: Try querying an external DNS server directly
nslookup api.payments.io 8.8.8.8
# Server:   8.8.8.8
# Address:  8.8.8.8:53
# Name:    api.payments.io
# Address: 52.10.45.200
# ← external DNS works fine; problem is CoreDNS upstream forwarding

# Exit the pod
exit

# Step 5: Check CoreDNS config for upstream forwarders
kubectl get configmap coredns -n kube-system -o yaml
# Look at the 'forward' directive — it should forward to a reachable upstream
# forward . /etc/resolv.conf   ← uses node's resolv.conf; check the node

# Step 6: Check node-level DNS config
NODE=$(kubectl get pod payment-service-7d9f4b6c8-xk2p9 -o jsonpath='{.spec.nodeName}')
kubectl debug node/$NODE -it --image=busybox -- cat /etc/resolv.conf
# nameserver 169.254.169.253   ← AWS VPC DNS; if this is unreachable, CoreDNS fails

# Step 7: Check CoreDNS logs for upstream errors
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=30
# [ERROR] plugin/errors: 2 api.payments.io. A: read udp ...: i/o timeout
# ← CoreDNS is timing out reaching its upstream — check security group UDP/53 rules

# Fix: open outbound UDP/53 and TCP/53 from nodes to the VPC DNS resolver (169.254.169.253)
```

---

### Example 4: Investigate High TIME_WAIT Counts on a Load Balancer

**Scenario:** A reverse proxy (nginx) host is throwing "cannot assign requested address" errors under load. `ss` reveals tens of thousands of `TIME_WAIT` sockets.

```bash
# Step 1: Confirm the socket state distribution
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn
#  42108 TIME_WAIT
#   1204 ESTABLISHED
#     12 LISTEN

# Step 2: Check the ephemeral port range
cat /proc/sys/net/ipv4/ip_local_port_range
# 32768   60999
# That's only ~28000 ports — fewer than the TIME_WAIT count. We're exhausted.

# Step 3: Check current sysctl settings
sysctl net.ipv4.tcp_tw_reuse
# net.ipv4.tcp_tw_reuse = 0   ← not enabled

# Step 4: Expand the port range and enable tw_reuse (safe for outbound connections)
# These take effect immediately; also add to /etc/sysctl.d/99-tcp-tuning.conf to persist

sysctl -w net.ipv4.ip_local_port_range="1024 65535"   # ~64k ports
sysctl -w net.ipv4.tcp_tw_reuse=1                      # reuse TIME_WAIT sockets for new outbound conns
sysctl -w net.ipv4.tcp_fin_timeout=15                  # reduce FIN_WAIT_2 timeout from 60s default

# Persist across reboots
cat > /etc/sysctl.d/99-tcp-tuning.conf << 'EOF'
# Expand ephemeral port range
net.ipv4.ip_local_port_range = 1024 65535
# Reuse TIME_WAIT sockets for new outbound connections (safe; requires timestamps)
net.ipv4.tcp_tw_reuse = 1
# Reduce time to release FIN_WAIT_2 sockets
net.ipv4.tcp_fin_timeout = 15
EOF

sysctl -p /etc/sysctl.d/99-tcp-tuning.conf

# Step 5: Verify improvement
sleep 5
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn
# TIME_WAIT count should stop growing and begin declining

# Step 6: Long-term fix — enable HTTP keep-alive in nginx
# (reduces connection churn by reusing connections across multiple requests)
# In /etc/nginx/nginx.conf, upstream block:
# upstream backend {
#     server 10.0.1.10:8080;
#     keepalive 64;        # keep 64 idle connections to upstream open
# }
# In location block:
# proxy_http_version 1.1;
# proxy_set_header Connection "";
```

---

## Exercises

### Exercise 1: Map a Running Service End-to-End

On any Linux host with at least one running service (SSH is fine):

1. Use `ss -tlnp` to list all listening TCP sockets. Identify the port, bound address (`0.0.0.0` vs `127.0.0.1`), and the process name for each.
2. For each service bound to `0.0.0.0`, determine whether that exposure is intentional. Would any of these be a security concern in a production environment?
3. Use `ip route get <IP>` to determine which interface and gateway would be used to reach `8.8.8.8`. Then use `ip addr show` to find the source IP that would be used. Explain the output.
4. Use the bash `/dev/tcp` trick to test whether port 22 is reachable on `127.0.0.1` without using `nc` or `curl`.

**Goal:** understand the relationship between listening address, routing, and reachability — and develop comfort with `ss` and `ip` as your primary network inspection tools.

---

### Exercise 2: Trace a Full TCP Connection with tcpdump

On a Linux host where you have `tcpdump` available:

1. In one terminal, start a packet capture on the loopback interface for port 80:
   ```bash
   sudo tcpdump -i lo -n 'tcp port 80' -S
   ```
2. In a second terminal, use `curl http://127.0.0.1:80` (or any service running on localhost). If nothing is on port 80, start a quick Python server: `python3 -m http.server 80`.
3. Observe the captured packets. Identify: the SYN, SYN-ACK, and ACK packets (the 3-way handshake), data transfer packets, and the FIN sequence for connection teardown.
4. Note the sequence numbers. Confirm that the SYN-ACK's acknowledgment number equals the SYN's sequence number + 1.

**Goal:** see the TCP state machine in action in real packets, not just diagrams. Being able to read a `tcpdump` trace is an essential debugging skill.

---

### Exercise 3: Diagnose a DNS Failure Deliberately

This exercise requires either a Linux VM or a container you can modify.

1. Temporarily break DNS resolution by redirecting `/etc/resolv.conf` to point to a non-existent nameserver:
   ```bash
   # Save the original first!
   cp /etc/resolv.conf /etc/resolv.conf.bak
   echo "nameserver 192.0.2.1" | sudo tee /etc/resolv.conf   # 192.0.2.1 is TEST-NET, non-routable
   ```
2. Try `curl https://google.com`. Observe the error message. Note how long it takes to fail (DNS timeout).
3. Try `curl https://8.8.8.8`. Does this work? Why or why not?
4. Use `dig @8.8.8.8 google.com` — does this work? Why?
5. Use `dig google.com` — does this fail differently than `curl`? Why?
6. Restore your original `resolv.conf`:
   ```bash
   sudo cp /etc/resolv.conf.bak /etc/resolv.conf
   ```
7. Explain in your own words: what is the difference between a DNS failure and a network failure, and how can you tell them apart?

**Goal:** recognize DNS failures by their error messages and timing, and understand that DNS and network reachability are independently testable.

---

### Exercise 4: Subnet and Routing Analysis

No special tools required — use `ip` and a calculator or your own mental arithmetic.

1. Given the address `10.128.45.200/20`:
   - What is the network address?
   - What is the broadcast address?
   - How many usable host addresses are in this subnet?
   - Is `10.128.48.1` in the same subnet? Show your reasoning.

2. On your host, run `ip route show`. Find the default route and identify:
   - The gateway IP
   - The outbound interface
   - Run `ip route get 1.1.1.1` and confirm it selects the same gateway

3. Add a static route to a non-existent subnet (use a safe range that won't affect your existing traffic, e.g., `203.0.113.0/24` — this is TEST-NET-3, reserved for documentation):
   ```bash
   sudo ip route add 203.0.113.0/24 via <your-default-gateway>
   ```
   - Verify it appears in `ip route show`
   - Run `ip route get 203.0.113.1` and confirm the new route is selected
   - Delete the route with `ip route del 203.0.113.0/24`

4. Explain why `ip route get` is more useful than `ip route show` when debugging connectivity for a specific destination.

**Goal:** build fluency with CIDR arithmetic and routing lookups — skills that come up constantly when working with VPCs, Kubernetes pod networks, and VPN split tunneling.

---

### Quick Checks

1. Classify port 443 as well-known or ephemeral.

   ```bash
   echo 443 | awk '{print ($1 < 1024) ? "well-known" : "ephemeral"}'
   ```

   ```expected_output
   well-known
   ```

2. Extract the gateway IP from a mock `ip route` default route line.

   ```bash
   echo "default via 192.168.1.1 dev eth0 proto dhcp" | awk '/^default/{print $3}'
   ```

   ```expected_output
   192.168.1.1
   ```
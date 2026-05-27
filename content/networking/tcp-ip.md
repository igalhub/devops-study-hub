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
              → network: 192.168.1.0
              → valid hosts: 192.168.1.1 – 192.168.1.254
              → broadcast: 192.168.1.255
```

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
- `100.64.0.0/10` — shared address space used by cloud instance metadata (AWS: `169.254.169.254`)

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

**`169.254.x.x` warning:** if `ip addr show` reveals a `169.254` address, DHCP failed. The host may still be partially functional but routing will be broken. This is common in misconfigured VMs and containers.

---

### TCP vs UDP

| Property | TCP | UDP |
|----------|-----|-----|
| Connection setup | 3-way handshake | None |
| Reliable delivery | Yes (retransmits lost segments) | No (fire and forget) |
| Ordered delivery | Yes | No |
| Flow control | Yes (window sizing) | No |
| Congestion control | Yes | No |
| Overhead | ~20-byte header + handshake | ~8-byte header |
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

The handshake takes one full round-trip before any data flows. At 100ms RTT to a distant server, your first byte of data costs at least 100ms just for the handshake — relevant when diagnosing latency in distributed systems.

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

**`TIME_WAIT` gotcha:** a server handling high connection volume can accumulate thousands of `TIME_WAIT` sockets. This is normal and expected — do not "fix" it by disabling `TIME_WAIT`. Doing so can cause data corruption from stale packets on reused port numbers. If you're running out of ports, tune `net.ipv4.ip_local_port_range` and enable `net.ipv4.tcp_tw_reuse` (not `tcp_tw_recycle`, which is removed in kernel 4.12+ and was broken in NAT environments).

**`CLOSE_WAIT` gotcha:** large numbers of `CLOSE_WAIT` sockets almost always indicate a bug in the application — it received a FIN from the peer but never called `close()` on the socket. This leaks file descriptors and eventually causes "too many open files" errors.

```bash
# Count sockets by state
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn

# Find processes with CLOSE_WAIT connections
ss -tanp | grep CLOSE_WAIT
```

---

### Ports

Ports are 16-bit numbers (0–65535) multiplexing multiple applications on a single IP address. The kernel routes incoming packets to the right process based on the destination port.

**Port ranges:**

| Range | Name | Notes |
|-------|------|-------|
| 0–1023 | Well-known / privileged | Requires root (or `CAP_NET_BIND_SERVICE`) to bind |
| 1024–49151 | Registered | Assigned by IANA; apps may bind without root |
| 49152–65535 | Ephemeral / dynamic | Used by the OS for outbound connections (client-side ports) |

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
# Show all listening TCP sockets with process info
ss -tlnp

# Show TCP + UDP listeners
ss -tulnp

# IPv4 only
ss -tlnp4

# Show all established TCP connections
ss -tanp | grep ESTABLISHED

# Find what process is using a specific port
ss -tlnp | grep :443
lsof -i :443          # alternative using lsof

# Check ephemeral port range configured on this system
cat /proc/sys/net/ipv4/ip_local_port_range
# typical output: 32768   60999
```

**Binding to `0.0.0.0` vs `127.0.0.1`:** when a service binds to `0.0.0.0`, it listens on all interfaces — accessible from the network. When it binds to `127.0.0.1`, it only accepts local connections. A database that should only be accessed locally (Redis, PostgreSQL in dev) should bind to `127.0.0.1`. Accidentally exposing it on `0.0.0.0` is a common security misconfiguration.

```bash
# This output shows Redis correctly bound to loopback only:
# LISTEN  0  128  127.0.0.1:6379  0.0.0.0:*

# This is a problem — Redis exposed on all interfaces:
# LISTEN  0  128  0.0.0.0:6379   0.0.0.0:*
```

---

### ICMP — The Diagnostic Protocol

ICMP (Internet Control Message Protocol) operates at layer 3 and carries control messages: reachability probes (ping), "destination unreachable," "TTL exceeded," and path MTU discovery. It has no ports — it's identified by type and code numbers.

| ICMP Type | Meaning |
|-----------|---------|
| 0 | Echo Reply (ping response) |
| 3 | Destination Unreachable |
| 8 | Echo Request (ping) |
| 11 | Time Exceeded (TTL = 0, used by traceroute) |

```bash
# Test reachability — 4 packets, report packet loss and RTT
ping -c 4 8.8.8.8

# Fast timeout — useful in scripts (1 packet, 2s wait)
ping -c 1 -W 2 10.0.0.1 && echo "UP" || echo "DOWN"

# Trace the path — shows each router hop and RTT
traceroute google.com
traceroute -n google.com       # skip DNS, faster

# mtr = traceroute + ping, live view, best tool for diagnosing packet loss per hop
mtr --report --report-cycles 10 google.com

# Test MTU — find the largest packet that passes without fragmentation
ping -c 1 -M do -s 1472 8.8.8.8   # 1472 + 28 byte header = 1500 byte MTU
# if you get "Frag needed" or timeout, MTU is smaller
```

**ICMP filtering warning:** many firewalls and cloud security groups block ICMP by default. A failed `ping` does not mean the host is unreachable — the TCP port may still be open. Always follow a failed `ping` with a TCP-level check (`nc`, `curl`). Conversely, `ping` succeeding does not mean the service is up.

**MTU and PMTUD:** Path MTU Discovery uses ICMP type 3 code 4 ("fragmentation needed, DF set") to negotiate the largest packet size that fits across a path. If firewalls block this ICMP type, PMTUD fails silently — TCP connections will appear to hang after the handshake (the 3-way handshake uses small packets, but data transfer uses large ones). This is a common cause of mysterious connection stalls across VPNs.

---

### Routing

When a packet leaves a host, the kernel looks up the destination IP in the routing table to decide: which interface to send it out, and which gateway (next-hop router) to forward it to.

```bash
# Show the full routing table
ip route show

# Example output:
# default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50
# 192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.50
# 10.244.0.0/16 via 10.0.0.1 dev eth1      ← pod network route (Kubernetes example)

# Which route would be used for a specific destination?
ip route get 8.8.8.8
# Output: 8.8.8.8 via 192.168.1.1 dev eth0 src 192.168.1.50

# Add a static route (non-persistent)
ip route add 10.10.0.0/16 via 192.168.1.254 dev eth0

# Delete a route
ip route del 10.10.0.0/16

# Show ARP table (IP → MAC mappings on the local segment)
ip neigh show
```

**Default gateway:** the route `0.0.0.0/0` (or `default`) matches everything not matched by a more specific route. If this is missing or points to the wrong address, the host can talk to local machines but not the internet or other networks.

**Longest prefix match:** the kernel always uses the most specific route. `10.244.1.0/24` beats `10.244.0.0/16` beats `0.0.0.0/0` for a packet to `10.244.1.5`. This is how Kubernetes routes traffic to individual pods.

---

### DNS Resolution

DNS translates hostnames to IPs. Before a TCP connection can be made, the hostname must be resolved. DNS failures cause connection errors that look like network failures but aren't.

```bash
# Query DNS for a hostname (A record = IPv4)
dig +short api.example.com

# Get full answer with TTL
dig api.example.com A

# Query a specific DNS server
dig @8.8.8.8 api.example.com

# Reverse lookup (IP → hostname)
dig -x 8.8.8.8
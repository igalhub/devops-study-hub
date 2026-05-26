---
title: TCP/IP Fundamentals
module: networking
duration_min: 20
difficulty: beginner
tags: [networking, tcp, ip, udp, osi, protocols, ports]
exercises: 4
---

## Overview
Everything in DevOps runs on TCP/IP. When a service is unreachable, a port is blocked, or a connection times out, you need to understand what's happening at the network layer to diagnose it. This lesson covers the model, the protocols, and the tools to inspect them.

## Concepts

### The OSI Model (Practical View)
The full 7-layer model matters less in practice than understanding the three layers you'll actually troubleshoot:

| Layer | Protocol examples | What breaks here |
|---|---|---|
| 7 — Application | HTTP, SSH, DNS, SMTP | App config, TLS certs, wrong URL |
| 4 — Transport | TCP, UDP | Port blocked, connection refused, timeout |
| 3 — Network | IP, ICMP | Routing, firewall, wrong subnet |
| 2 — Data Link | Ethernet, ARP | Physical connectivity, MAC issues |

You work top-down when debugging: can the app connect? → Is the port open? → Can you reach the IP? → Is there a physical link?

### IP Addresses
Every host on a network has an IP address — a 32-bit number written as four octets: `192.168.1.100`.

**Private ranges (RFC 1918)** — not routable on the public internet:
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`

**Loopback:** `127.0.0.1` (or `::1` for IPv6) — the host talking to itself.

```bash
# See your IP addresses
ip addr show
ip addr show eth0      # specific interface

# Older command (still works)
ifconfig
```

### TCP vs UDP
| | TCP | UDP |
|---|---|---|
| Connection | Yes (3-way handshake) | No |
| Reliable delivery | Yes (retransmit lost packets) | No (best effort) |
| Order guaranteed | Yes | No |
| Overhead | Higher | Lower |
| Use cases | HTTP, SSH, databases | DNS, NTP, streaming, gaming |

**TCP 3-way handshake:**
```
Client → Server: SYN
Server → Client: SYN-ACK
Client → Server: ACK
(connection established — data can flow)
```

**TCP connection states you'll see:**
- `ESTABLISHED` — active connection
- `TIME_WAIT` — connection closed, waiting for stray packets (normal, ~60s)
- `CLOSE_WAIT` — remote side closed, local hasn't yet (possible app bug)
- `LISTEN` — socket waiting for incoming connections

### Ports
Ports are 16-bit numbers (0–65535) that identify which application receives a connection.

**Well-known ports (0–1023, requires root to bind):**
| Port | Protocol |
|---|---|
| 22 | SSH |
| 25 | SMTP |
| 53 | DNS |
| 80 | HTTP |
| 443 | HTTPS |
| 3306 | MySQL |
| 5432 | PostgreSQL |
| 6379 | Redis |
| 8080 | Common alt-HTTP |

```bash
# See what's listening
ss -tlnp         # TCP listening, numeric, with process
ss -tulnp        # TCP + UDP
ss -tlnp4        # IPv4 only
netstat -tlnp    # older equivalent

# See all connections
ss -tanp | grep ESTABLISHED
```

### ICMP — The Diagnostic Protocol
ICMP carries network-layer messages: ping responses, "destination unreachable", "TTL exceeded". Tools like `ping` and `traceroute` use ICMP.

```bash
# Test basic reachability
ping -c 4 8.8.8.8          # 4 packets to Google DNS
ping -c 1 -W 2 10.0.0.1   # 1 packet, 2s timeout

# Trace path (how packets travel to destination)
traceroute google.com
traceroute -n google.com   # no DNS lookup (faster)
mtr google.com             # interactive, live view
```

Note: some firewalls block ICMP. A failed ping doesn't mean the host is down — it might just have ICMP filtered.

### Routing
When a packet leaves your machine, the kernel consults the routing table to decide which interface and gateway to use:

```bash
# Show routing table
ip route show
# Output:
# default via 192.168.1.1 dev eth0   ← default gateway (everything not matched below)
# 192.168.1.0/24 dev eth0 proto kernel  ← local subnet (direct)
# 10.0.0.0/8 via 10.10.0.1 dev eth1  ← specific route via a gateway

# Test which route a destination uses
ip route get 8.8.8.8
```

### Common Troubleshooting Flow
```bash
# 1. Can I reach the IP?
ping -c 2 10.0.0.100

# 2. Is the port open?
nc -zv 10.0.0.100 5432       # -z: don't send data, -v: verbose
# or:
curl -s --connect-timeout 3 telnet://10.0.0.100:5432

# 3. What's listening on that port locally?
ss -tlnp | grep :5432

# 4. Is there a firewall blocking it?
# (depends on platform: iptables, ufw, AWS security groups, etc.)
iptables -L -n | grep 5432

# 5. Is DNS resolving correctly?
dig +short db.example.com
```

## Examples

### Check Which Services Are Exposed
```bash
#!/usr/bin/env bash
echo "Listening services:"
ss -tlnp | awk 'NR>1 {
    split($4, addr, ":")
    port = addr[length(addr)]
    split($6, proc, "\"")
    printf "Port %-6s  Process: %s\n", port, proc[2]
}'
```

### Port Connectivity Test Script
```bash
#!/usr/bin/env bash
# Usage: ./portcheck.sh host port [timeout]
HOST="$1"
PORT="$2"
TIMEOUT="${3:-5}"

if nc -z -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null; then
    echo "OPEN   $HOST:$PORT"
    exit 0
else
    echo "CLOSED $HOST:$PORT"
    exit 1
fi
```

## Exercises

1. Run `ss -tlnp` on your machine and list all listening services: port number, protocol, and process name. Identify any that surprise you.
2. Use `ip route show` to identify your default gateway and local subnet. Then `ping` the gateway and a public IP (`8.8.8.8`). Document the round-trip times.
3. Use `nc -zv` to check whether these ports are open on localhost: 22, 80, 443, 5432, 6379. Document which are open and why (or why not).
4. Write a bash script that takes a hostname and a space-separated list of ports as arguments and outputs a table: `PORT | STATUS | LATENCY`.

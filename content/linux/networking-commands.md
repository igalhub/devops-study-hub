---
title: Networking Commands
module: linux
duration_min: 15
difficulty: intermediate
tags: [ss, netstat, curl, ip, dig, ping, traceroute, tcpdump, networking]
exercises: 4
---

## Overview

Networking commands are your diagnostic toolkit on Linux servers — used to check connectivity, inspect open ports, trace traffic routes, query DNS, and test HTTP endpoints. In a DevOps role, you'll reach for these tools every time a deployment fails health checks, a microservice can't talk to another, or a customer reports that a service is down. Knowing which tool to use and in what order separates engineers who resolve incidents in five minutes from those who spend an hour guessing.

The Linux networking toolset evolved in two waves: the older `net-tools` package (`ifconfig`, `netstat`, `route`) which is deprecated but still installed on most systems, and the modern `iproute2` suite (`ip`, `ss`) which maps directly to the kernel's netlink interface and provides more accurate, richer output. You need to know both because you'll inherit servers running either generation, and interview questions reference both.

In the broader DevOps toolchain, these commands sit at the foundation layer. Kubernetes networking, service meshes, load balancer configuration, TLS termination, and CI/CD health checks all depend on the same underlying primitives: does the interface have an IP, is the port open, does DNS resolve, does the packet reach its destination. Every layer of abstraction above this still breaks down to these fundamentals when something goes wrong.

---

## Concepts

### The Diagnostic Hierarchy

Treat network troubleshooting as a layered process. Working from Layer 1 up prevents you from debugging DNS when the interface is down.

| Step | Question | Tool |
|------|----------|------|
| 1 | Is the interface up and does it have an IP? | `ip addr` |
| 2 | Can I reach my default gateway? | `ping <gateway>` |
| 3 | Can I reach the destination host? | `ping`, `traceroute` |
| 4 | Is the service listening on the right port and interface? | `ss -tlnp` |
| 5 | Is a firewall dropping the packets? | `curl`, `nmap`, firewall commands |
| 6 | Is DNS resolving to the right address? | `dig`, `nslookup` |
| 7 | What is actually on the wire? | `tcpdump` |

**Don't skip steps.** A misconfigured service listening on `127.0.0.1` instead of `0.0.0.0` (step 4) looks identical from the outside to a firewall block (step 5). Confirming step 4 first eliminates one hypothesis immediately.

---

### `ip` — Interface and Routing Management

`ip` is the modern replacement for `ifconfig`, `route`, and `arp`. It talks directly to the kernel via netlink sockets and gives you authoritative state rather than a cached view.

```bash
# Show all interfaces with IP addresses, MAC addresses, and link state
ip addr
ip addr show eth0          # scope to one interface

# Show the routing table — critical for multi-homed servers
ip route show
# Example output:
# default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.42 metric 100
# 10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.42

# Show only the default route — useful in scripts
ip route get 8.8.8.8       # which interface and gateway would be used for this destination

# Add a static route — gone on reboot unless persisted
ip route add 10.100.0.0/16 via 10.0.0.1 dev eth0
ip route del 10.100.0.0/16

# ARP/neighbor table: IP → MAC mappings
ip neigh show
# FAILED state = host doesn't exist or isn't responding at Layer 2

# Bring an interface up or down
ip link set eth0 up
ip link set eth0 down

# Assign an IP address to an interface (non-persistent)
ip addr add 192.168.50.10/24 dev eth1
ip addr del 192.168.50.10/24 dev eth1
```

**`ip route get` is underused.** `ip route get 8.8.8.8` tells you exactly which source IP and gateway the kernel would use to reach a destination — invaluable on multi-interface servers where routing asymmetry causes connection resets.

**Changes made with `ip` are non-persistent.** They survive until next reboot. To persist them, edit `/etc/netplan/*.yaml` (Ubuntu), `/etc/sysconfig/network-scripts/` (RHEL/CentOS 7), or use `nmcli` (NetworkManager-managed systems).

| Old command (`net-tools`) | Modern equivalent (`iproute2`) |
|---------------------------|-------------------------------|
| `ifconfig eth0` | `ip addr show eth0` |
| `ifconfig eth0 up` | `ip link set eth0 up` |
| `route -n` | `ip route show` |
| `arp -n` | `ip neigh show` |
| `ifconfig eth0 192.168.1.10` | `ip addr add 192.168.1.10/24 dev eth0` |

---

### `ss` — Socket Statistics

`ss` queries the kernel's socket tables directly. It is faster and more detailed than `netstat`, and it is what you should use on any modern system (kernel 2.6+).

```bash
# The most useful single command: listening TCP and UDP with process info
ss -tlunp
# -t  TCP
# -u  UDP
# -l  listening sockets only
# -n  numeric (skip reverse DNS and service name lookups — much faster)
# -p  show process name and PID (requires root for other users' processes)

# Sample output:
# Netid  State   Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
# tcp    LISTEN  0      128     0.0.0.0:22            0.0.0.0:*          users:(("sshd",pid=987,fd=3))
# tcp    LISTEN  0      511     127.0.0.1:5432        0.0.0.0:*          users:(("postgres",pid=1204,fd=7))

# All established TCP connections
ss -tn state established

# Filter by local port
ss -tlnp sport = :443

# Filter by destination address
ss -tn dst 10.0.1.50

# Show connection counts per state — spot SYN floods or FIN_WAIT accumulation
ss -s

# Watch socket stats live
watch -n1 'ss -s'
```

**Read the `Local Address` column carefully.** `0.0.0.0:8080` means the service accepts connections on all interfaces. `127.0.0.1:8080` means it only accepts local connections — external clients will get "connection refused" or a timeout depending on firewall rules. This is the single most common misconfiguration in service deployments.

| Local Address | Meaning | Accessible from |
|---------------|---------|----------------|
| `0.0.0.0:8080` | All IPv4 interfaces | Anywhere (subject to firewall) |
| `127.0.0.1:8080` | Loopback only | Same host only |
| `192.168.1.10:8080` | Specific interface | That interface's network |
| `:::8080` | All IPv6 interfaces | Anywhere via IPv6 |

**`Recv-Q` and `Send-Q` in LISTEN state** represent the number of connections that have completed the three-way handshake but haven't been `accept()`-ed by the application yet. A non-zero `Recv-Q` on a listening socket means your application is not consuming connections fast enough — a sign of an overloaded or deadlocked service.

---

### `netstat` — Legacy Socket Statistics

`netstat` comes from the `net-tools` package. It is deprecated but ships on almost every Linux distro you'll encounter. Know it for legacy systems and interview recognition.

```bash
# Equivalent to ss -tlunp
netstat -tlunp

# All connections (established, listening, all protocols)
netstat -an

# Show routing table (equivalent to ip route)
netstat -rn

# Show per-interface statistics: packets, errors, dropped
netstat -i

# Continuous output
netstat -c -tlun
```

| `ss` command | `netstat` equivalent | Notes |
|--------------|---------------------|-------|
| `ss -tlnp` | `netstat -tlnp` | Same output, `ss` is faster |
| `ss -s` | `netstat -s` | `netstat -s` is more verbose |
| `ss -i` | `netstat -i` | Interface stats |
| `ip route` | `netstat -rn` | Routing table |

**`netstat` may not be installed** on minimal container images or fresh cloud instances. If it's missing, install `net-tools` or just use `ss` — they show the same underlying data.

---

### `ping` — Reachability and Latency

`ping` sends ICMP Echo Request packets and measures round-trip time. It tests Layer 3 (IP) reachability but not application availability — a host can respond to ping and still have its web server down.

```bash
# Basic ping — runs until Ctrl+C
ping google.com

# Send exactly 4 packets and exit (good for scripts)
ping -c 4 google.com

# Faster pings — 0.5s interval (default is 1s)
ping -i 0.5 -c 10 192.168.1.1

# Flood ping — as fast as possible (requires root, use carefully on shared networks)
ping -f -c 1000 192.168.1.1

# Test MTU — expose fragmentation issues
# Ethernet MTU = 1500. IP header = 20 bytes, ICMP header = 8 bytes.
# Max payload to test full MTU: 1500 - 28 = 1472
ping -s 1472 -M do google.com
# -M do = don't fragment; failure here with smaller sizes succeeding = MTU mismatch

# Ping a specific source interface — useful on multi-homed hosts
ping -I eth1 8.8.8.8
```

**ICMP can be blocked.** Many cloud providers (AWS, GCP) and firewalls block ICMP by default. A `ping` timeout does not prove a host is down — use `curl` or `nc` to verify application-level reachability before concluding a host is unreachable.

**Interpreting ping output:**

| Output | Meaning |
|--------|---------|
| `time=2ms` consistent | Healthy, stable path |
| `time=` spiking intermittently | Packet loss or routing instability |
| `packet loss > 0%` | Investigate immediately in production |
| `Destination Host Unreachable` | No route to host, or ARP failure at Layer 2 |
| `Request timeout` | ICMP blocked by firewall, or host is truly down |
| `ping: unknown host` | DNS resolution failed — check `/etc/resolv.conf` |

---

### `traceroute` and `tracepath` — Path Analysis

`traceroute` reveals each router hop between you and a destination by sending packets with incrementally increasing TTL values. When TTL expires at a router, that router sends back an ICMP Time Exceeded message, revealing its IP.

```bash
# Standard traceroute (uses UDP by default on Linux)
traceroute google.com

# Use ICMP instead of UDP — gets through more firewalls
traceroute -I google.com

# Use TCP on port 80 — gets through almost any firewall that allows web traffic
traceroute -T -p 80 google.com

# Set maximum hops (default 30)
traceroute -m 15 google.com

# Don't resolve hostnames — faster output
traceroute -n google.com

# tracepath — no root required, auto-discovers MTU along path
tracepath google.com
```

**Reading traceroute output:**
```
 1  10.0.0.1 (10.0.0.1)         0.812 ms    ← your gateway
 2  100.64.0.1 (100.64.0.1)     2.104 ms    ← ISP edge
 3  * * *                                   ← hop blocked ICMP (not necessarily broken)
 4  142.250.82.174 (...)         8.332 ms    ← Google's network
```

`* * *` at a hop means that router doesn't respond to ICMP Time Exceeded. **This is normal and does not mean the path is broken** — if later hops respond, traffic is flowing through that silent hop fine.

**High latency that appears at a specific hop and persists to all subsequent hops** indicates a real problem at or near that hop. Latency that spikes at one hop but recovers at the next is just that router deprioritizing ICMP responses — not a real bottleneck. Only sustained latency increases that carry through to the destination matter.

---

### `curl` — HTTP Testing and Data Transfer

`curl` is the most important networking tool in DevOps. It's used in health checks, CI/CD pipelines, Kubernetes liveness probes, API testing, file downloads, and webhook debugging.

```bash
# GET request — basic
curl https://api.example.com/health

# Show only the HTTP status code — ideal for health check scripts
curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/health

# Full timing breakdown — essential for latency diagnosis
curl -s -o /dev/null -w \
  "DNS lookup:    %{time_namelookup}s\nTCP connect:   %{time_connect}s\nTLS handshake: %{time_appconnect}s\nFirst byte:    %{time_starttransfer}s\nTotal:         %{time_total}s\n" \
  https://api.example.com

# Include response headers in output — diagnose caching, redirects, CORS
curl -i https://api.example.com/health

# Show only response headers, no body
curl -sI https://api.example.com

# Verbose — shows TLS certificate chain, request/response headers, everything
curl -v https://api.example.com

# POST with a JSON body
curl -X POST https://api.example.com/events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"event": "deploy", "env": "production"}'

# POST JSON from a file
curl -X POST https://api.example.com/config \
  -H "Content-Type: application/json" \
  -d @config.json

# Follow HTTP redirects (301, 302)
curl -L https://example.com

# Download a file, preserving remote filename
curl -O https://releases.example.com/app-1.2.3.tar.gz

# Set connection timeout and max time — critical in CI/CD scripts
curl --connect-timeout 5 --max-time 30 https://api.example.com/health

# Skip TLS certificate verification — ONLY for debugging, never in production
curl -k https://self-signed-internal.example.com

# Connect to a specific IP but send the correct Host header — bypass DNS for testing
curl --resolve api.example.com:443:10.0.1.50 https://api.example.com/health

# Test a Unix domain socket — used for Docker daemon, Kubernetes CRI, etc.
curl --unix-socket /var/run/docker.sock http://localhost/version
```

**`-s` silences the progress meter but not errors.** Use `-sS` to silence progress but still show error messages — important in scripts so failures don't disappear silently.

**`--resolve` is one of curl's most powerful debugging flags.** It lets you bypass DNS and force a connection to a specific IP while still sending the correct SNI and Host header. This lets you test individual backend servers behind a load balancer without modifying `/etc/hosts`.

**The `-w` format string** is a powerful feature for structured output in scripts:

| Variable | Description |
|----------|-------------|
| `%{http_code}` | HTTP response status code |
| `%{time_total}` | Total transaction time in seconds |
| `%{time_connect}` | Time to complete TCP connect |
| `%{time_namelookup}` | Time for DNS resolution |
| `%{time_appconnect}` | Time until TLS handshake
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
| `%{time_appconnect}` | Time until TLS handshake complete |
| `%{size_download}` | Bytes received in response body |
| `%{speed_download}` | Download speed in bytes/sec |

---

### `dig` — DNS Interrogation

`dig` (Domain Information Groper) is the standard tool for querying DNS. It gives you full control over which record type to request, which server to ask, and shows exactly what the resolver returned — including TTLs, authoritative flags, and the full answer chain.

```bash
# Basic A record lookup
dig google.com

# Query a specific record type
dig google.com A       # IPv4 address
dig google.com AAAA    # IPv6 address
dig google.com MX      # Mail exchange records
dig google.com TXT     # Text records (SPF, DKIM, domain verification)
dig google.com NS      # Authoritative nameservers
dig google.com CNAME   # Canonical name (alias)
dig google.com SOA     # Start of Authority — serial, refresh, TTL defaults

# Query a specific DNS server directly — bypass system resolver
dig @8.8.8.8 google.com A          # Ask Google's public resolver
dig @1.1.1.1 google.com A          # Ask Cloudflare's resolver
dig @10.0.0.53 internal.corp.com A # Ask your internal DNS server

# Short output — just the answer, nothing else
dig +short google.com

# Trace the full delegation path from root to authoritative
dig +trace google.com

# Reverse DNS lookup (PTR record) — IP to hostname
dig -x 8.8.8.8

# Show the full answer including TTL — useful for cache debugging
dig +noall +answer google.com
# google.com.    299    IN    A    142.250.80.46
#               ^^^
#               TTL in seconds — how long this can be cached

# Check if a record exists without caring about the value
dig +short google.com A | grep -q . && echo "resolves" || echo "NXDOMAIN"
```

**Understanding dig output sections:**

| Section | What it contains |
|---------|-----------------|
| `QUESTION` | What you asked for |
| `ANSWER` | Direct records matching your query |
| `AUTHORITY` | Nameservers authoritative for this zone |
| `ADDITIONAL` | Extra records (often A records for NS hostnames) |
| `flags: qr aa rd ra` | `aa` = authoritative answer, `ra` = recursion available |

**`NXDOMAIN` vs `SERVFAIL` vs empty `ANSWER`:**
- `NXDOMAIN`: the domain does not exist at all in DNS.
- `SERVFAIL`: the nameserver had an error resolving — could be a broken delegation, DNSSEC failure, or unreachable upstream.
- Empty `ANSWER` with `NOERROR`: the domain exists but has no record of the type you requested — common when querying `A` for a CNAME-only entry or a domain with only AAAA records.

**`dig +trace` is invaluable for split-horizon and internal DNS debugging.** It shows you every delegation step from the root servers down, making it obvious where a misconfigured delegation or missing glue record is causing resolution to fail.

**TTL matters for incident response.** Before making a DNS change, check the current TTL with `dig +noall +answer`. If the TTL is 3600 (1 hour), traffic won't shift for up to an hour after you update the record. Lower the TTL hours before a planned migration, then raise it again afterward.

---

### `tcpdump` — Packet Capture

`tcpdump` captures raw packets off the wire. It's the tool of last resort when nothing else explains what's happening — you can see exactly what bytes are being exchanged, verify that packets are arriving, and observe protocol handshakes directly.

```bash
# Capture all traffic on eth0 — very noisy, use filters
tcpdump -i eth0

# Capture on any interface
tcpdump -i any

# Filter by host
tcpdump -i eth0 host 10.0.1.50

# Filter by port
tcpdump -i eth0 port 443

# Combine filters with and/or
tcpdump -i eth0 host 10.0.1.50 and port 80

# Don't resolve hostnames or port names — much faster, unambiguous output
tcpdump -n -i eth0 port 53

# Show packet contents as hex and ASCII (-X) or ASCII only (-A)
tcpdump -i eth0 -A port 80

# Capture to a file for later analysis in Wireshark
tcpdump -i eth0 -w /tmp/capture.pcap

# Read back a capture file
tcpdump -r /tmp/capture.pcap

# Limit capture to N packets then exit
tcpdump -i eth0 -c 100 port 8080

# Verbose output — show TTL, checksums, TCP flags
tcpdump -v -i eth0 port 443

# Capture DNS queries and responses
tcpdump -n -i eth0 port 53

# Capture only TCP SYN packets — see new connection attempts
tcpdump -i eth0 'tcp[tcpflags] & tcp-syn != 0'

# Capture traffic to a subnet
tcpdump -i eth0 net 10.0.1.0/24
```

**TCP flags in tcpdump output** tell you the state of the connection:

| Flag | Meaning | What to look for |
|------|---------|-----------------|
| `S` | SYN | New connection attempt |
| `S.` | SYN-ACK | Server accepted, handshake responding |
| `.` | ACK | Acknowledgment only |
| `P.` | PSH-ACK | Data being sent |
| `R` | RST | Connection forcibly reset — firewall or app rejection |
| `F.` | FIN-ACK | Graceful connection close |

**A SYN with no SYN-ACK** means the packet is not reaching the server, or the server is not listening. **A SYN followed immediately by RST** means the server received the SYN but actively refused it — the port is closed at the OS level (no process listening), or a firewall sent a reject rather than a drop.

**`tcpdump` requires root** (or `CAP_NET_RAW` capability). On production systems, capture for as short a time as possible and pipe to a file rather than displaying to terminal — the volume of output can itself cause problems. Rotate capture files with `-W` and `-C` for long-running captures:

```bash
# Rotate: keep 5 files of 10MB each (50MB total cap)
tcpdump -i eth0 -w /tmp/cap.pcap -C 10 -W 5 port 8080
```

---

### `nmap` — Port Scanning and Service Discovery

`nmap` goes beyond `ss` — it lets you probe ports from the perspective of an external host, test firewall rules, and identify what services are actually reachable from a given network position.

```bash
# Scan common ports on a host (top 1000 ports by frequency)
nmap 10.0.1.50

# Scan a specific port
nmap -p 8080 10.0.1.50

# Scan a range of ports
nmap -p 1-65535 10.0.1.50

# Fast scan — only top 100 ports
nmap -F 10.0.1.50

# Skip host discovery (assume host is up) — useful when ICMP is blocked
nmap -Pn 10.0.1.50

# Service version detection — identify what's actually running on open ports
nmap -sV 10.0.1.50

# Scan an entire subnet
nmap 10.0.1.0/24

# TCP connect scan — full three-way handshake (no root needed, more detectable)
nmap -sT 10.0.1.50

# UDP scan — important: many services use UDP (DNS 53, NTP 123, SNMP 161)
nmap -sU -p 53,123,161 10.0.1.50

# Output results to a file for comparison between deployments
nmap -oN scan_before.txt 10.0.1.50
nmap -oN scan_after.txt 10.0.1.50
diff scan_before.txt scan_after.txt
```

**Port states in nmap output:**

| State | Meaning |
|-------|---------|
| `open` | A process is listening; connection succeeded |
| `closed` | No process listening; RST received |
| `filtered` | No response; firewall is dropping packets |
| `open\|filtered` | Could not determine — typical for UDP |

**`filtered` vs `closed` distinguishes firewall drops from missing services.** If an expected port shows `filtered` after deployment, the application may have started but the firewall rule wasn't updated. If it shows `closed`, the application itself isn't listening.

**Use `nmap` to validate firewall rules from the correct network position.** Running `ss` on the server shows what the kernel has open; running `nmap` from a client shows what's actually reachable through the network path including all firewalls and security groups. They should agree — if they don't, something is blocking in transit.

---

## Examples

### Example 1: Diagnosing a Service That Fails External Health Checks

A Kubernetes readiness probe is failing for a new pod. The pod is running and the application log shows no errors.

```bash
# Step 1: Confirm the application is actually listening
# Run this inside the pod or on the node
ss -tlnp | grep 8080
# Expected: tcp LISTEN 0 128 0.0.0.0:8080   0.0.0.0:*  users:(("app",pid=1,fd=3))
# Problem case: tcp LISTEN 0 128 127.0.0.1:8080  0.0.0.0:*
# → app is bound to loopback only; Kubernetes probes come from the node IP, not loopback

# Step 2: Test from inside the pod (confirms app-level response)
curl -sS http://localhost:8080/health
# → 200 OK — app works on loopback

# Step 3: Test from the node's perspective (mimics what kubelet does for hostNetwork=false pods)
# Get the pod IP from: kubectl get pod mypod -o jsonpath='{.status.podIP}'
curl -sS http://10.244.1.23:8080/health
# → Connection refused — confirms the bind address is wrong

# Step 4: Verify using ss with the exact bind address
ss -tlnp sport = :8080
# Netid  State   Local Address:Port
# tcp    LISTEN  127.0.0.1:8080      ← root cause confirmed

# Fix: change application config to bind 0.0.0.0:8080 instead of localhost:8080
# Then verify after restart:
ss -tlnp | grep 8080
# tcp    LISTEN  0.0.0.0:8080        ← correct
curl -sS http://10.244.1.23:8080/health
# → {"status":"ok"}
```

---

### Example 2: Tracing a Slow API Response to Its Root Cause

Users report that `POST /api/orders` is slow. Response times vary between 200ms and 4000ms randomly.

```bash
# Step 1: Measure timing breakdown with curl — run 5 times to observe variance
for i in {1..5}; do
  curl -s -o /dev/null -w \
    "Run $i — DNS: %{time_namelookup}s  Connect: %{time_connect}s  TLS: %{time_appconnect}s  TTFB: %{time_starttransfer}s  Total: %{time_total}s\n" \
    -X POST https://api.example.com/api/orders \
    -H "Content-Type: application/json" \
    -d '{"item":"widget","qty":1}'
done

# Sample output:
# Run 1 — DNS: 0.004s  Connect: 0.021s  TLS: 0.089s  TTFB: 0.210s  Total: 0.215s
# Run 2 — DNS: 0.004s  Connect: 0.020s  TLS: 0.088s  TTFB: 3.987s  Total: 3.992s
# Run 3 — DNS: 0.004s  Connect: 0.022s  TLS: 0.091s  TTFB: 0.208s  Total: 0.212s

# DNS, Connect, and TLS are all stable — the spike is entirely in TTFB.
# This means the network path is fine; the application or its backend is slow intermittently.

# Step 2: Confirm TCP connection is reaching the server cleanly
# TTFB = time_starttransfer - time_appconnect
# When TTFB spikes but connect/TLS are stable → application-side issue (DB query, external call)

# Step 3: Check if the app server is exhausting connection pool during slow requests
# On the application server:
ss -tn state established dst 10.0.2.100   # 10.0.2.100 = your database
# Count how many connections are in use:
ss -tn state established dst 10.0.2.100 | wc -l
# If this hits your pool limit during slow requests, pool exhaustion is the cause

# Step 4: Watch connection states over time
watch -n1 'ss -s'
# Look for TIME_WAIT accumulation or CLOSE_WAIT stuck connections
# TIME_WAIT is normal but large counts indicate high connection churn
# CLOSE_WAIT staying high = application not closing connections (resource leak)
```

---

### Example 3: Verifying DNS Propagation After a Cutover

You've updated an A record for `api.example.com` from `203.0.113.10` (old) to `203.0.113.20` (new). You need to verify the change has propagated before decommissioning the old server.

```bash
# Step 1: Check the TTL on the record before the change
dig +noall +answer api.example.com A
# api.example.com.  3600  IN  A  203.0.113.10
#                   ^^^^
# 3600 seconds = 1 hour; resolvers can cache the old record for up to 1 hour

# Step 2: Query the authoritative nameserver directly — bypasses all caching
# First, find who is authoritative:
dig +short api.example.com NS
# ns1.exampledns.com.
# ns2.exampledns.com.

# Then query that server directly:
dig @ns1.exampledns.com api.example.com A +short
# 203.0.113.20   ← authoritative answer; change is live at the source

# Step 3: Check from multiple public resolvers to gauge propagation
for resolver in 8.8.8.8 1.1.1.1 9.9.9.9 208.67.222.222; do
  result=$(dig @$resolver +short api.example.com A)
  echo "Resolver $resolver: $result"
done
# Resolver 8.8.8.8:         203.0.113.20   ← updated
# Resolver 1.1.1.1:         203.0.113.20   ← updated
# Resolver 9.9.9.9:         203.0.113.10   ← still cached (old)
# Resolver 208.67.222.222:  203.0.113.20   ← updated

# Step 4: Confirm the new IP actually serves the application correctly
# Use --resolve to test the new IP before DNS fully propagates everywhere
curl --resolve api.example.com:443:203.0.113.20 \
  -s -o /dev/null -w "%{http_code}\n" \
  https://api.example.com/health
# 200 — new server is healthy and TLS cert is valid for the domain

# Step 5: Once TTL expires, verify from the system resolver
dig +short api.example.com A
# 203.0.113.20   ← system resolver now returns the new address
```

---

### Example 4: Capturing and Analyzing a Failing TLS Handshake

A service is getting intermittent TLS errors connecting to an upstream dependency. The errors are rare and hard to reproduce.

```bash
# Step 1: Set up a continuous capture to a rotating file
# Capture only traffic to the upstream host (10.0.3.80) on port 443
tcpdump -i eth0 -w /tmp/tls_capture.pcap \
  -C 10 -W 3 \        # rotate at 10MB, keep 3 files = 30MB max
  host 10.0.3.80 and port 443

# Step 2: While capture runs, trigger the failing operation repeatedly
# Use curl verbose mode to capture the TLS-level error message
for i in {1..50}; do
  curl -v --connect-timeout 5 https://upstream.internal:443/api/check 2>&1 | \
    grep -E "(SSL|TLS|handshake|error|Connected|certificate)" &
done
wait

# Sample failing output:
# * SSL_ERROR_SYSCALL
# * OpenSSL SSL_connect: Connection reset by peer

# Step 3: In the pcap, look for RST packets during the TLS handshake
tcpdump -r /tmp/tls_capture.pcap0 -n \
  'tcp[tcpflags] & tcp-rst != 0'
# 14:23:07.442891 IP 10.0.1.5.54312 > 10.0.3.80.443: Flags [R.]
# → RST is coming from 10.0.3.80 after the ClientHello
# This means the upstream server is actively rejecting the connection
# Possible causes: TLS version mismatch, cipher suite not supported, cert client auth required

# Step 4: Test specific TLS versions to isolate the mismatch
curl -v --tls-max 1.2 https://upstream.internal:443/api/check 2>&1 | grep "SSL connection"
# SSL connection using TLSv1.2 / ECDHE-RSA-AES256-GCM-SHA384 — works

curl -v --tls-max 1.3 https://upstream.internal:443/api/check 2>&1 | grep "SSL connection"
# SSL_ERROR_SYSCALL — fails

# Step 5: Confirm upstream only supports TLS 1.2
# Root cause: upstream service has TLS 1.3 disabled; our client is sometimes
# negotiating 1.3 first. Fix: pin TLS version in our client config or update upstream.
```

---

## Exercises

### Exercise 1: Map What's Listening on a Server

On any Linux machine (local VM, cloud instance, or container):

1. Use `ss` to list every TCP socket in LISTEN state with process names and numeric ports.
2. Identify which services are bound to `127.0.0.1` (loopback-only) vs `0.0.0.0` (all interfaces).
3. Find any service listening on a non-standard port (not 22, 80, or 443) and identify what process owns it.
4. Use `ss -s` to get a summary of all socket states. Explain what the `TIME_WAIT` count represents and whether the number you see is concerning.

**Deliverable:** For each listening process, write one sentence explaining whether the bind address is correct for that service's purpose.

---

### Exercise 2: Trace a DNS Resolution Chain

Pick any public hostname you use in your work (e.g., your company's API endpoint, a package registry, a cloud provider endpoint).

1. Look up its A record using your system's default resolver.
2. Find the authoritative nameservers for the domain.
3. Query the authoritative nameserver directly and compare the TTL to what your local resolver returned. Explain any difference.
4. Perform a `+trace` lookup and identify at least three delegation steps in the chain (root → TLD → authoritative).
5. Check whether the hostname has a CNAME in its chain. If it does, identify the full resolution path from alias to final IP.

**Gotcha to discover:** Run `dig +short example.com A` and `dig +short example.com CNAME`. Explain why one returns a result and the other doesn't, even though following a CNAME is part of the A record lookup process.

---

### Exercise 3: Benchmark an HTTP Endpoint Across Multiple Runs

Choose an HTTP/HTTPS endpoint you can make repeated requests to (a public API, `httpbin.org`, or a local service).

1. Write a one-liner using `curl` and a `for` loop that makes 10 requests and prints `time_namelookup`, `time_connect`, `time_appconnect`, and `time_starttransfer` for each.
2. Calculate the average TTFB (time to first byte) manually or with `awk`.
3. Make the same request but force resolution to a different IP using `--resolve`. Observe whether any timing fields change and explain why.
4. Add `--connect-timeout 2 --max-time 5` to your curl command. Trigger a timeout intentionally (use a host that doesn't respond, or a port that's firewalled) and capture curl's exit code. Write a conditional shell snippet that exits with a non-zero status and prints a clear error message when the health check fails.

**Goal:** produce a shell function `check_health <url>` that returns 0 on HTTP 200 within 5 seconds and 1 with an error message otherwise.

---

### Exercise 4: Capture and Interpret a TCP Handshake

This exercise requires `tcpdump` and root access (or a VM you control).

1. In one terminal, start a simple HTTP server: `python3 -m http.server 8888`
2. In a second terminal, start a packet capture filtering only port 8888: `sudo tcpdump -i lo -n port 8888 -v`
3. In a third terminal, make a request: `curl http://localhost:8888/`
4. Stop the capture (Ctrl+C) and locate the three-way handshake in the output. Identify the SYN, SYN-ACK, and ACK packets by their flags.
5. Now kill the HTTP server while the capture is still running. Make another `curl` request. Find the RST packet in the output and explain: what does it tell you about why the connection failed, and how does this differ from what you'd see if a firewall were dropping the packets instead?

**Extension:** repeat the capture but use `tcpdump -w /tmp/handshake.pcap`, then replay it with `tcpdump -r /tmp/handshake.pcap` and filter for only the SYN packets using a BPF expression.

---

### Quick Checks

1. Extract the CIDR prefix length from a network address.

   ```bash
   echo "10.0.0.0/16" | awk -F/ '{print $2}'
   ```

   ```expected_output
   16
   ```

hint: Think about how you can split a string in the shell using a delimiter to isolate a specific part of it.
hint: Use cut with the -d '/' flag and -f 2 to extract the portion of the network address that comes after the slash.

2. Count the number of octets in an IP address.

   ```bash
   echo "10.20.30.40" | tr '.' '\n' | wc -l | awk '{print $1}'
   ```

   ```expected_output
   4
   ```
hint: Think about how you can split a string by a specific delimiter and count the resulting parts.
hint: Use echo with the IP address and pipe it to awk, using -F'.' to set the dot as a field separator, then print NF to get the number of fields.

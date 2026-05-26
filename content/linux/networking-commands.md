---
title: Networking Commands
module: linux
duration_min: 15
difficulty: intermediate
tags: [ss, netstat, curl, ip, dig, ping, traceroute, tcpdump, networking]
exercises: 4
---

## Overview
Networking commands are your diagnostic toolkit on Linux servers — used to check connectivity, inspect open ports, trace traffic routes, query DNS, and test HTTP endpoints. These are daily tools in DevOps and come up constantly in troubleshooting interviews.

## Concepts

### The Diagnostic Hierarchy
When something's broken, check in this order:
1. **Is the interface up and has an IP?** → `ip addr`
2. **Can I reach the network?** → `ping`
3. **Can I reach the specific host?** → `ping`, `traceroute`
4. **Is the service listening on the right port?** → `ss`
5. **Is the firewall blocking it?** → `curl`, port-specific test
6. **Is DNS resolving correctly?** → `dig`, `nslookup`

### Key Tools Quick Reference
| Tool | Purpose |
|------|---------|
| `ip` | Interface/routing config (modern `ifconfig` replacement) |
| `ss` | Socket statistics — open ports, connections |
| `netstat` | Older socket stats (still found everywhere) |
| `ping` | Basic connectivity test |
| `traceroute` / `tracepath` | Trace packet hops to a destination |
| `curl` | Transfer data via HTTP/HTTPS — the Swiss Army knife |
| `dig` / `nslookup` | DNS lookups |
| `tcpdump` | Packet capture — see actual traffic |
| `nmap` | Port scanning (install separately) |

## Examples

### ip — Interface and Routing
```bash
# Show all interfaces and IP addresses
ip addr
ip addr show eth0          # specific interface

# Show routing table
ip route
ip route show

# Add/remove a static route (non-persistent)
ip route add 10.0.0.0/8 via 192.168.1.1
ip route del 10.0.0.0/8

# Show ARP cache (IP → MAC mapping)
ip neigh

# Bring interface up/down
ip link set eth0 up
ip link set eth0 down
```

### ss — Socket Statistics (replaces netstat)
```bash
# All listening ports (TCP + UDP)
ss -tlun
# -t = TCP, -u = UDP, -l = listening, -n = numeric (no hostname lookup)

# All established TCP connections
ss -tn state established

# Find what process is using a port (requires sudo)
ss -tlnp | grep :80
# output: LISTEN  0  128  0.0.0.0:80  ...  users:(("nginx",pid=1234,fd=6))

# All connections to/from a specific address
ss -tn dst 192.168.1.100

# Show socket summary
ss -s
```

### netstat — older but still common
```bash
# Same as ss -tlun
netstat -tlun

# With process names
netstat -tlunp

# All connections
netstat -an
```

### ping — Connectivity Check
```bash
# Basic ping
ping google.com

# Limit to 4 packets
ping -c 4 google.com

# Ping with interval (seconds between pings)
ping -i 0.5 -c 10 192.168.1.1

# Ping a specific size (tests MTU issues)
ping -s 1472 google.com
```

### traceroute — Path Tracing
```bash
# Show each hop between you and the destination
traceroute google.com

# Use ICMP instead of UDP (better through some firewalls)
traceroute -I google.com

# tracepath — similar, no root required
tracepath google.com
```

### curl — HTTP Testing and Data Transfer
curl is the most important networking tool in DevOps — used for health checks, API testing, downloading files, and debugging.

```bash
# Basic GET request
curl https://api.example.com/health

# Show response code only
curl -s -o /dev/null -w "%{http_code}" https://api.example.com/health

# POST with JSON body
curl -X POST https://api.example.com/data \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'

# Include response headers in output
curl -i https://api.example.com/health

# Follow redirects
curl -L https://example.com

# Save response to file
curl -o output.html https://example.com
curl -O https://example.com/file.tar.gz    # use remote filename

# Show timing breakdown (great for latency debugging)
curl -s -o /dev/null -w "DNS: %{time_namelookup}s  Connect: %{time_connect}s  Total: %{time_total}s\n" https://example.com

# With authentication
curl -u user:password https://api.example.com
curl -H "Authorization: Bearer $TOKEN" https://api.example.com

# Skip TLS verification (testing only — never in production scripts)
curl -k https://self-signed.example.com

# Verbose output — shows TLS handshake, headers, everything
curl -v https://api.example.com
```

### dig — DNS Lookups
```bash
# Look up A record (IPv4 address)
dig google.com

# Short output — just the answer
dig +short google.com

# Look up specific record types
dig google.com MX         # mail exchangers
dig google.com AAAA       # IPv6 addresses
dig google.com TXT        # TXT records (SPF, domain verification, etc.)
dig google.com NS         # nameservers
dig google.com CNAME      # canonical name

# Query a specific DNS server
dig @8.8.8.8 google.com
dig @1.1.1.1 google.com

# Reverse lookup (IP → hostname)
dig -x 8.8.8.8

# Trace DNS resolution from root servers
dig +trace google.com
```

### tcpdump — Packet Capture (requires root)
```bash
# Capture all traffic on eth0
tcpdump -i eth0

# Capture only HTTP traffic (port 80)
tcpdump -i eth0 port 80

# Capture traffic to/from a specific host
tcpdump -i eth0 host 192.168.1.100

# Save capture to file for analysis in Wireshark
tcpdump -i eth0 -w capture.pcap

# Read saved capture
tcpdump -r capture.pcap

# Show packet contents in ASCII
tcpdump -i eth0 -A port 80

# Combine filters
tcpdump -i eth0 "host 192.168.1.100 and port 443"
```

### Practical Troubleshooting Pattern
```bash
# "Port 8080 should be open but curl times out from outside"

# Step 1: Is something listening on 8080?
ss -tlnp | grep 8080

# Step 2: Is it bound to 0.0.0.0 (all interfaces) or 127.0.0.1 (loopback only)?
# 127.0.0.1:8080 = only accessible locally — that's the bug

# Step 3: Is the firewall blocking it?
# On Ubuntu: ufw status
# On RHEL:   firewall-cmd --list-all

# Step 4: Test locally vs externally
curl http://localhost:8080/health     # from the server itself
curl http://PUBLIC_IP:8080/health     # from outside
```

## Exercises

1. Find all processes listening on TCP ports on your machine. For each one, identify the port number, the process name, and its PID.
2. Use `curl` to make a GET request to `http://localhost:8000/health` and display: the HTTP status code, the total time taken, and the response body — all in one command.
3. Use `dig` to find the A record, MX record, and TXT records for a domain of your choice (e.g., `github.com`). What does the TXT record contain?
4. A service should be running on port 3000 but you can't connect to it. Write the sequence of commands you'd run to diagnose whether the problem is (a) the service not running, (b) bound to wrong interface, or (c) firewall.

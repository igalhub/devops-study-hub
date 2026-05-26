---
title: DNS
module: networking
duration_min: 15
difficulty: beginner
tags: [networking, dns, dig, nslookup, records, resolution]
exercises: 4
---

## Overview
DNS translates names (`api.example.com`) to IP addresses. It's involved in every network connection your services make — and when it breaks, everything breaks in mysterious ways. Understanding the resolution chain and record types lets you diagnose DNS-related outages quickly and configure DNS correctly for your services.

## Concepts

### DNS Resolution Chain
When you look up `api.example.com`:

```
Your app
  → /etc/nsswitch.conf determines lookup order (files, dns, ...)
  → /etc/hosts (checked first for local overrides)
  → Resolver (127.0.0.53 on systemd-resolved, or /etc/resolv.conf nameserver)
    → Recursive resolver (your ISP's or 8.8.8.8 or 1.1.1.1)
      → Root nameservers (know who manages .com)
      → .com TLD nameservers (know who manages example.com)
      → Authoritative nameservers for example.com (give the final answer)
```

Results are cached at each step according to TTL (Time To Live).

### Key Config Files
```bash
# Nameserver(s) to query
cat /etc/resolv.conf
# nameserver 8.8.8.8
# nameserver 8.8.4.4
# search example.com   ← appended to short names (e.g. "db" → "db.example.com")

# Local overrides (checked before DNS)
cat /etc/hosts
# 127.0.0.1  localhost
# 10.0.0.100  db.internal mydb
```

### DNS Record Types
| Type | Purpose | Example |
|---|---|---|
| A | IPv4 address | `api.example.com → 1.2.3.4` |
| AAAA | IPv6 address | `api.example.com → 2001:db8::1` |
| CNAME | Alias to another name | `www.example.com → example.com` |
| MX | Mail exchanger | `example.com → mail.example.com (priority 10)` |
| TXT | Arbitrary text (SPF, DKIM, verification) | `"v=spf1 include:sendgrid.net ~all"` |
| NS | Nameservers for this zone | `example.com → ns1.dnsprovider.com` |
| PTR | Reverse DNS (IP → name) | `1.2.3.4 → api.example.com` |
| SRV | Service discovery (port + hostname) | `_http._tcp.example.com → host:port` |
| SOA | Zone authority and serial | (used by nameservers) |

### dig — The DNS Debugging Tool
```bash
# Basic lookup
dig api.example.com

# Short output (just the answer)
dig +short api.example.com

# Specific record type
dig api.example.com A
dig api.example.com MX
dig api.example.com TXT
dig api.example.com CNAME
dig api.example.com NS

# Query a specific nameserver
dig @8.8.8.8 api.example.com         # ask Google's DNS
dig @1.1.1.1 api.example.com         # ask Cloudflare's DNS
dig @ns1.dnsprovider.com example.com  # ask the authoritative server directly

# Trace the full resolution chain
dig +trace api.example.com

# Reverse lookup (IP → name)
dig -x 8.8.8.8

# Check TTL remaining
dig +ttlid api.example.com
```

### Understanding dig Output
```
;; QUESTION SECTION:
;api.example.com.       IN      A

;; ANSWER SECTION:
api.example.com.  300   IN  A   52.14.123.45
#                 ^^^           ^^^^^^^^^^^^
#                 TTL (seconds) IP address

;; AUTHORITY SECTION:
example.com.      3600  IN  NS  ns1.dnsprovider.com.
# Who owns this zone

;; ADDITIONAL SECTION:
# IP of the nameservers (glue records)

;; Query time: 12 msec
;; SERVER: 8.8.8.8#53
```

### TTL and Caching
TTL is the number of seconds a record can be cached. Low TTL (60–300s) means faster propagation when you change records but more DNS queries. High TTL (3600+) means less DNS traffic but slower propagation.

**Before planned DNS changes:** lower the TTL to 60s at least 24 hours in advance (so cached records expire quickly).

```bash
# How long until my DNS change propagates?
# Check TTL of current record:
dig +short +ttlid api.example.com A
# If TTL is 3600, you may have to wait up to 1 hour for all caches to expire
```

### Internal DNS (Service Discovery)
In container environments, DNS is used for service discovery:
```
Kubernetes: my-service.my-namespace.svc.cluster.local
Docker Compose: just use the service name (e.g. "db", "redis")
AWS: internal load balancers get DNS names in *.elb.amazonaws.com
```

### Common DNS Problems
```bash
# Problem: "Name or service not known"
# → Check /etc/resolv.conf, is the nameserver reachable?
dig @8.8.8.8 api.example.com   # bypass local resolver

# Problem: stale cached record
# → Check TTL, wait it out, or flush local cache:
systemd-resolve --flush-caches   # systemd-resolved
# macOS: dscacheutil -flushcache

# Problem: different answers from different locations
# → Compare authoritative vs recursive:
dig @ns1.authoritative.com api.example.com   # authoritative answer
dig api.example.com                          # what your resolver says

# Problem: NXDOMAIN (domain doesn't exist)
dig nonexistent.example.com
# Check: typo? correct zone? recently deleted?
```

## Examples

### Check All Record Types for a Domain
```bash
#!/usr/bin/env bash
DOMAIN="${1:-example.com}"
echo "=== DNS Records for $DOMAIN ==="

for TYPE in A AAAA MX TXT NS CNAME; do
    RESULT=$(dig +short "$DOMAIN" "$TYPE")
    [ -n "$RESULT" ] && echo "$TYPE: $RESULT"
done

echo "=== PTR (reverse DNS for first A) ==="
IP=$(dig +short "$DOMAIN" A | head -1)
[ -n "$IP" ] && dig +short -x "$IP"
```

### Verify DNS Propagation
```bash
#!/usr/bin/env bash
DOMAIN="$1"
EXPECTED="$2"
NAMESERVERS="8.8.8.8 1.1.1.1 9.9.9.9"

echo "Checking propagation of $DOMAIN → $EXPECTED"
for NS in $NAMESERVERS; do
    RESULT=$(dig +short "@$NS" "$DOMAIN" A)
    STATUS="✓" ; [ "$RESULT" != "$EXPECTED" ] && STATUS="✗"
    printf "%s  @%-12s  %s\n" "$STATUS" "$NS" "${RESULT:-NXDOMAIN}"
done
```

## Exercises

1. Use `dig +trace` on any domain and follow the resolution chain — identify the root server, TLD nameserver, and authoritative nameserver that answered.
2. Look up the MX records for a domain of your choice. Then look up the A record for each mail server. What IPs are they pointing to?
3. Write a script that takes a domain and checks if it responds differently from 3 different nameservers (8.8.8.8, 1.1.1.1, 9.9.9.9) — useful for detecting split-horizon DNS or caching issues.
4. Check `/etc/hosts` and `/etc/resolv.conf` on your machine. Add an entry to `/etc/hosts` that overrides a domain (e.g. `127.0.0.1 test.local`), then `dig test.local` and `ping test.local` — explain why one works and the other doesn't.

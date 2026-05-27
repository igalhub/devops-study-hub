---
title: DNS
module: networking
duration_min: 15
difficulty: beginner
tags: [networking, dns, dig, nslookup, records, resolution]
exercises: 4
---

## Overview

DNS (Domain Name System) is the distributed database that translates human-readable names like `api.example.com` into IP addresses that routers can act on. Every service call your application makes — whether it's hitting a database, calling a third-party API, or resolving a Kubernetes service — starts with a DNS lookup. When DNS breaks, failures surface as connection timeouts, NXDOMAIN errors, or mysterious slowdowns that look like application bugs. DNS literacy is a first-responder skill: before you can diagnose anything network-related, you need to understand what the system is doing and what it should be doing.

DNS is designed around three principles: **delegation** (no single server knows everything — authority is delegated through a hierarchy), **caching** (every answer carries a TTL that controls how long it can be reused), and **eventual consistency** (changes propagate over time as caches expire, not instantly). These principles explain most of the counterintuitive behavior you'll encounter — why a DNS change "takes time," why different clients see different answers, and why querying two nameservers can return different results.

In the DevOps toolchain, DNS sits at the intersection of infrastructure, networking, and deployment. You configure DNS records when you launch a service, manage TTLs during blue-green deployments, rely on internal DNS for Kubernetes service discovery, and debug it when services can't find each other. Cloud providers (AWS Route 53, GCP Cloud DNS, Cloudflare) expose DNS as an API, making it a first-class piece of infrastructure-as-code.

---

## Concepts

### The DNS Resolution Chain

When any process on a Linux system resolves a name, it goes through several layers before hitting the network. Understanding this chain is critical — the answer your app gets may come from a local cache, `/etc/hosts`, or a full recursive lookup, depending on configuration.

```
Your app (getaddrinfo() syscall)
  → /etc/nsswitch.conf  ← determines lookup order: "files dns" or "files mdns dns"
    → /etc/hosts        ← checked first; static overrides always win
    → Local stub resolver
        systemd-resolved: 127.0.0.53:53
        OR the nameserver listed in /etc/resolv.conf directly
      → Recursive resolver (8.8.8.8, 1.1.1.1, or your VPC's resolver)
        → Root nameservers (13 clusters: a.root-servers.net … m.root-servers.net)
          → TLD nameservers (.com, .net, .io — managed by registries)
            → Authoritative nameservers for the zone (your DNS provider)
              → Final answer
```

Each step caches the result for the TTL duration. The recursive resolver is where most caching happens — it serves cached answers to all clients behind it.

**Key insight:** `dig` bypasses `/etc/hosts` and `nsswitch.conf`. It speaks directly to DNS. `getent hosts` or `ping` use the full stack including `/etc/hosts`. This is why `dig test.local` may return NXDOMAIN while `ping test.local` resolves correctly from a `/etc/hosts` entry.

```bash
# Which resolver is your system actually using?
cat /etc/resolv.conf

# On systemd-resolved systems, the real config is here:
resolvectl status

# Test the full nsswitch stack (includes /etc/hosts):
getent hosts api.example.com

# Test only DNS (bypasses /etc/hosts):
dig +short api.example.com
```

---

### Key Configuration Files

Two files control DNS behavior on any Linux host. Misconfiguring either causes hard-to-diagnose failures.

**`/etc/resolv.conf`** — tells the system which DNS servers to query and how to handle short names:

```bash
cat /etc/resolv.conf
```

```
nameserver 10.0.0.2        # primary resolver (e.g. VPC internal resolver)
nameserver 8.8.8.8         # fallback
search us-east-1.compute.internal example.internal  # appended to single-label names
options ndots:5            # names with fewer than 5 dots get search domains appended first
```

**`/etc/hosts`** — static name-to-IP mappings, checked before DNS:

```bash
cat /etc/hosts
```

```
127.0.0.1   localhost
::1         localhost ip6-localhost
10.0.0.100  db.internal db   # multiple aliases on one line
10.0.0.101  redis.internal
```

**`ndots` gotcha:** the `ndots:5` option in Kubernetes `/etc/resolv.conf` means that `api.example.com` (3 dots = 4 labels, fewer than 5) gets search domains appended *before* trying the FQDN. So a lookup for `api.example.com` inside a pod might first try `api.example.com.default.svc.cluster.local`, then `api.example.com.svc.cluster.local`, then `api.example.com.cluster.local`, and only then `api.example.com.` — adding latency to every external DNS call. **Fix:** append a trailing dot to force FQDN resolution: `api.example.com.`

---

### DNS Record Types

| Type | Purpose | Typical Value |
|------|---------|--------------|
| **A** | Maps name → IPv4 address | `1.2.3.4` |
| **AAAA** | Maps name → IPv6 address | `2001:db8::1` |
| **CNAME** | Alias — maps name → another name | `www.example.com → example.com` |
| **MX** | Mail exchanger with priority | `10 mail.example.com` |
| **TXT** | Arbitrary text; used for SPF, DKIM, domain verification | `"v=spf1 include:sendgrid.net ~all"` |
| **NS** | Authoritative nameservers for a zone | `ns1.dnsprovider.com` |
| **PTR** | Reverse DNS: IP → name | `4.3.2.1.in-addr.arpa → api.example.com` |
| **SRV** | Service location: priority, weight, port, host | `10 20 443 backend.example.com` |
| **SOA** | Start of Authority: serial, refresh, retry, expire | Used internally by resolvers |
| **CAA** | Specifies which CAs may issue TLS certs | `0 issue "letsencrypt.org"` |

**CNAME restriction:** A CNAME cannot coexist with other records at the same name. You cannot put a CNAME on a bare domain (`example.com`) because that zone also needs an SOA and NS record. This is why DNS providers offer "ALIAS" or "ANAME" records — they resolve the CNAME target server-side and return the resulting A record.

**SRV records in Kubernetes:** `_http._tcp.my-service.my-namespace.svc.cluster.local` — some service meshes and discovery systems use SRV to expose port information alongside the hostname.

---

### `dig` — The Primary DNS Debugging Tool

`dig` is the standard tool for inspecting DNS. Learn its flags; you'll use it constantly.

```bash
# Basic A record lookup
dig api.example.com

# Short output (just the answer, no metadata)
dig +short api.example.com

# Query a specific record type
dig api.example.com AAAA
dig api.example.com MX
dig api.example.com TXT
dig api.example.com NS
dig api.example.com SOA

# Query a specific nameserver (bypasses local resolver)
dig @8.8.8.8 api.example.com        # Google Public DNS
dig @1.1.1.1 api.example.com        # Cloudflare
dig @ns1.dnsprovider.com example.com # Ask the authoritative server directly

# Trace every step of the resolution chain
dig +trace api.example.com

# Reverse lookup (IP → hostname via PTR)
dig -x 8.8.8.8

# Show TTL in output
dig +ttlid api.example.com A

# Show only the answer section
dig +noall +answer api.example.com

# Batch queries from a file
dig -f domains.txt +short
```

---

### Reading `dig` Output

Most engineers glance at the ANSWER SECTION and ignore the rest. The other sections contain diagnostic information you need during incidents.

```
; <<>> DiG 9.18.1 <<>> api.example.com
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 12345
;;              ^^^^^^^^^^^^^^  ^^^^^^^^
;;              NOERROR = found | NXDOMAIN = doesn't exist
;;              SERVFAIL = resolver couldn't get an answer
;;              REFUSED = server won't answer (firewall, ACL)

;; QUESTION SECTION:
;api.example.com.       IN      A      ← what we asked for

;; ANSWER SECTION:
api.example.com.  300   IN  A   52.14.123.45
;;               ^^^              ^^^^^^^^^^^^
;;               TTL in seconds   The actual answer

;; AUTHORITY SECTION:
example.com.      3600  IN  NS  ns1.dnsprovider.com.
;;  Who is authoritative for this zone — useful to identify which
;;  provider controls the DNS (not necessarily who owns the domain)

;; ADDITIONAL SECTION:
ns1.dnsprovider.com.  3600  IN  A  198.51.100.1
;;  Glue records: IP of the nameservers so the resolver doesn't
;;  need another lookup to contact them

;; Query time: 12 msec
;; SERVER: 8.8.8.8#53    ← which resolver actually answered
;; WHEN: Mon Jan 01 00:00:00 UTC 2025
;; MSG SIZE  rcvd: 88
```

**`status` codes to know:**
- `NOERROR` — query succeeded (even if ANSWER is empty — that means the record type doesn't exist)
- `NXDOMAIN` — the domain itself doesn't exist
- `SERVFAIL` — the resolver failed to get an authoritative answer (misconfigured zone, unreachable nameserver)
- `REFUSED` — the server won't process the query (ACL, firewall)

---

### TTL and DNS Propagation

TTL (Time To Live) is the number of seconds a resolver may cache an answer. It is set by whoever manages the authoritative zone — not the client.

| TTL | Use case |
|-----|---------|
| 60s | Active deployments, canary releases, blue-green switches |
| 300s | Services that change occasionally |
| 3600s | Stable infrastructure (origin IPs, MX records) |
| 86400s | Near-static records (NS records, rarely-changed infra) |

**Pre-change checklist:**
1. Check current TTL: `dig +ttlid api.example.com A`
2. If TTL > 300, lower it to 60 and wait for that TTL to expire (i.e., wait for all cached copies to expire — at least the current TTL duration)
3. Make your record change
4. Verify from multiple resolvers
5. Raise TTL back after you're confident

```bash
# Check TTL of a live record (shows remaining cache time at 8.8.8.8)
dig +noall +answer +ttlid @8.8.8.8 api.example.com A

# Poll until a new IP appears (useful during cutover)
watch -n 5 'dig +short @8.8.8.8 api.example.com A'
```

**Negative TTL:** NXDOMAIN responses are also cached, for the duration specified in the SOA record's minimum TTL field. If you create a record for a name that was recently queried and got NXDOMAIN, resolvers may continue returning NXDOMAIN until their negative cache expires. This trips up engineers who delete and recreate records quickly.

---

### Internal DNS and Service Discovery

In modern infrastructure, DNS is the universal service discovery mechanism. Cloud and container platforms all rely on it.

**Kubernetes DNS (CoreDNS):**
```
# Full FQDN format:
<service>.<namespace>.svc.cluster.local

# From within the same namespace, short names work:
curl http://my-service            # resolves via search domain
curl http://my-service.my-ns      # explicit namespace
curl http://my-service.my-ns.svc.cluster.local  # FQDN

# Headless services return individual pod IPs (no ClusterIP):
# pod-ip.my-service.my-namespace.svc.cluster.local
```

**Docker Compose:**
```yaml
services:
  api:
    image: myapp:latest
  db:
    image: postgres:15
# "api" can reach "db" simply as hostname "db"
# Docker's embedded DNS resolver handles it
```

**AWS VPC DNS:**
```
# VPC resolver is always at: base_of_VPC_CIDR + 2
# e.g., VPC 10.0.0.0/16 → resolver at 10.0.2

# EC2 internal hostnames:
ip-10-0-1-50.us-east-1.compute.internal

# RDS, ElastiCache, ELB all get DNS names — never hardcode their IPs
mydb.abc123.us-east-1.rds.amazonaws.com
my-alb-1234567890.us-east-1.elb.amazonaws.com
```

**Split-horizon DNS:** the same name resolves to different IPs depending on where the query originates. Common pattern: `api.example.com` resolves to a public IP from the internet but to a private IP from inside the VPC. Debugging this requires querying both the internal resolver and a public resolver and comparing results.

```bash
# Are you getting the internal or external answer?
dig @10.0.0.2 api.example.com A     # internal VPC resolver
dig @8.8.8.8 api.example.com A      # external resolver
```

---

### DNS in the Context of TLS and Security

DNS affects security in ways that catch engineers off guard.

**CAA records** restrict which Certificate Authorities can issue certificates for your domain. If your CA isn't listed, issuance fails:
```bash
dig example.com CAA
# 0 issue "letsencrypt.org"
# 0 issuewild ";"          ← no wildcard certs allowed
```

**SPF/DKIM/DMARC** are all TXT records. Email deliverability failures are often DNS problems:
```bash
dig example.com TXT | grep spf
dig _dmarc.example.com TXT
dig selector1._domainkey.example.com TXT
```

**DNSSEC** adds cryptographic signatures to DNS responses, preventing spoofing. Check if a domain uses it:
```bash
dig +dnssec example.com A
# Look for RRSIG records in the ANSWER section
```

---

### Common DNS Failure Patterns

```bash
# ── PATTERN 1: "Name or service not known" ──────────────────────────
# The resolver is unreachable or misconfigured
ping 8.8.8.8                           # check network connectivity first
cat /etc/resolv.conf                   # is there a nameserver listed?
dig @8.8.8.8 api.example.com           # bypass local resolver

# ── PATTERN 2: Stale cached record ──────────────────────────────────
# You updated DNS but the old IP is still being returned
dig +ttlid api.example.com A           # how long until this cache entry expires?
dig @ns1.authoritative.com api.example.com  # what does authoritative say?

# Flush local DNS cache:
resolvectl flush-caches                # systemd-resolved (most Linux distros)
dscacheutil -flushcache                # macOS (also restart mDNSResponder)

# ── PATTERN 3: SERVFAIL ──────────────────────────────────────────────
# The resolver can't get an answer — usually a broken zone or unreachable NS
dig +trace api.example.com             # where does the chain break?
dig @ns1.authoritative.com example.com SOA  # is the authoritative server responding?

# ── PATTERN 4: Works from some places, not others
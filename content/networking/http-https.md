---
title: HTTP & HTTPS
module: networking
duration_min: 15
difficulty: beginner
tags: [networking, http, https, tls, ssl, headers, status-codes, curl]
exercises: 4
---

## Overview
HTTP is the protocol your services speak. Understanding it means you can debug API failures, diagnose TLS certificate problems, read access logs intelligently, and configure services correctly. This lesson covers the protocol mechanics, status codes, headers, and TLS — with curl as the primary diagnostic tool.

## Concepts

### HTTP Request Structure
Every HTTP request has:
1. **Request line:** `METHOD /path HTTP/1.1`
2. **Headers:** key-value metadata
3. **Blank line**
4. **Body** (optional, for POST/PUT/PATCH)

```
GET /api/v1/users HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGci...
Accept: application/json
User-Agent: curl/8.1.0

```

### HTTP Methods
| Method | Meaning | Idempotent | Body |
|---|---|---|---|
| GET | Retrieve resource | Yes | No |
| POST | Create resource / submit data | No | Yes |
| PUT | Replace resource entirely | Yes | Yes |
| PATCH | Update resource partially | No | Yes |
| DELETE | Remove resource | Yes | No |
| HEAD | Same as GET but no body (check headers) | Yes | No |
| OPTIONS | What methods are allowed? | Yes | No |

**Idempotent** = calling it multiple times has the same effect as calling it once.

### HTTP Status Codes
| Range | Category | Key examples |
|---|---|---|
| 2xx | Success | 200 OK, 201 Created, 204 No Content |
| 3xx | Redirect | 301 Moved Permanently, 302 Found, 304 Not Modified |
| 4xx | Client error | 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 429 Too Many Requests |
| 5xx | Server error | 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout |

**Common confusions:**
- 401 = missing or invalid credentials (try authenticating)
- 403 = authenticated but not permitted (correct credentials, wrong permissions)
- 502 = your proxy/LB couldn't reach the backend
- 503 = backend is down or overloaded
- 504 = backend responded too slowly

### Key HTTP Headers
**Request:**
```
Authorization: Bearer <token>
Authorization: Basic <base64(user:pass)>
Content-Type: application/json
Accept: application/json, text/html
Host: api.example.com
Cookie: session=abc123
X-Request-ID: 7f3d8c2a
```

**Response:**
```
Content-Type: application/json; charset=utf-8
Content-Length: 1234
Cache-Control: max-age=3600, public
ETag: "abc123"
Location: /api/v1/users/42     (with 201 or 3xx)
Retry-After: 60                (with 429 or 503)
Set-Cookie: session=abc; HttpOnly; Secure; SameSite=Strict
```

### HTTPS and TLS
HTTPS = HTTP over TLS (Transport Layer Security). TLS provides:
1. **Encryption** — traffic is unreadable to anyone between client and server
2. **Authentication** — the server proves it's who it says it is (certificate)
3. **Integrity** — data can't be tampered with in transit

**TLS handshake (simplified):**
```
Client → Server: ClientHello (supported TLS versions, cipher suites)
Server → Client: ServerHello + Certificate
Client → Server: Key exchange
Both: derive session keys
Data flows encrypted
```

**Certificate chain:**
```
Root CA (trusted by your OS/browser)
  └── Intermediate CA
        └── Your certificate (example.com)
```

**Common certificate problems:**
```bash
# Expired certificate
curl: (60) SSL certificate problem: certificate has expired

# Wrong hostname
curl: (60) SSL certificate problem: hostname doesn't match

# Self-signed (not trusted)
curl: (60) SSL certificate problem: self-signed certificate

# Check certificate details
openssl s_client -connect api.example.com:443 -servername api.example.com < /dev/null 2>/dev/null \
    | openssl x509 -noout -dates -subject -issuer

# Check cert expiry
echo | openssl s_client -connect api.example.com:443 2>/dev/null \
    | openssl x509 -noout -enddate
```

### curl for HTTP Debugging
```bash
# Basic GET
curl https://api.example.com/health

# Show response headers
curl -I https://api.example.com/health      # HEAD request
curl -v https://api.example.com/health      # verbose (request + response headers)

# POST JSON
curl -X POST https://api.example.com/users \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"name": "Alice", "role": "admin"}'

# Include response headers in output
curl -si https://api.example.com/health

# Follow redirects
curl -L https://api.example.com/old-endpoint

# Timing breakdown
curl -o /dev/null -s -w "
  dns:     %{time_namelookup}s
  connect: %{time_connect}s
  tls:     %{time_appconnect}s
  ttfb:    %{time_starttransfer}s
  total:   %{time_total}s
  code:    %{http_code}
" https://api.example.com/

# Store cookie and reuse
curl -c cookies.txt -b cookies.txt https://api.example.com/login -d "user=x&pass=y"
```

### HTTP/1.1 vs HTTP/2 vs HTTP/3
| | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---|---|---|---|
| Multiplexing | No (one req/connection) | Yes (multiple streams) | Yes |
| Transport | TCP | TCP | QUIC (UDP) |
| Header compression | No | Yes (HPACK) | Yes (QPACK) |
| When to care | Old services | Most modern APIs | Latency-sensitive |

```bash
# Check what HTTP version a server uses
curl -v https://api.example.com/ 2>&1 | grep "< HTTP"
# < HTTP/2 200
```

## Examples

### API Health Check Script
```bash
#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://localhost:8000/health}"
TIMEOUT=5

HTTP_CODE=$(curl -o /dev/null -s -w "%{http_code}" --max-time "$TIMEOUT" "$URL")

case "$HTTP_CODE" in
    200|204) echo "OK ($HTTP_CODE): $URL" ; exit 0 ;;
    000)     echo "UNREACHABLE: $URL" ; exit 1 ;;
    *)       echo "UNHEALTHY ($HTTP_CODE): $URL" ; exit 1 ;;
esac
```

### Debug a 502 Bad Gateway
```bash
# Check: is the backend actually running?
systemctl status myapp

# Check: is it listening on the expected port?
ss -tlnp | grep :8080

# Check: can nginx reach it directly?
curl -v http://127.0.0.1:8080/health

# Check: nginx config is correct
nginx -t

# Check: nginx error log
tail -f /var/log/nginx/error.log
```

## Exercises

1. Use `curl -v` to inspect the full request and response headers for `https://httpbin.org/get`. Identify: the TLS version used, the Content-Type of the response, and the HTTP version.
2. Use the `curl` timing template from the examples to measure DNS lookup time, TCP connection time, TLS handshake time, and TTFB for three different URLs. Compare and explain differences.
3. Simulate a POST request to `https://httpbin.org/post` with a JSON body `{"env": "staging", "version": "1.2.3"}` and a custom header `X-Deploy-Token: test123`. Confirm the request body and header appear in the response.
4. Check the TLS certificate expiry for three domains of your choice using `openssl s_client`. Write a script that takes a domain and outputs "OK (expires: DATE)" or "EXPIRING SOON" if within 30 days.

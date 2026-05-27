---
title: HTTP & HTTPS
module: networking
duration_min: 15
difficulty: beginner
tags: [networking, http, https, tls, ssl, headers, status-codes, curl]
exercises: 4
---

## Overview

HTTP (HyperText Transfer Protocol) is the application-layer protocol that underpins nearly every interaction between services in a modern infrastructure. As a DevOps engineer, you encounter HTTP constantly: in health checks, load balancer configs, reverse proxy rules, CI/CD pipeline webhook calls, container readiness probes, and API integrations. A surface-level understanding gets you through simple setups; a deep understanding lets you diagnose why a deployment broke at 2 AM when a 502 starts cascading across your cluster.

HTTP's design is intentionally simple: a stateless request-response protocol where the client sends a structured message and the server replies with a structured response. That statelessness is both a strength and a source of bugs — each request must carry all the context the server needs (credentials, content type, session state), which means misconfigured headers are a surprisingly common root cause of production incidents. HTTPS layers TLS on top of HTTP to add encryption, authentication, and integrity — and since most modern services enforce HTTPS, understanding TLS certificate mechanics is a practical requirement, not an academic one.

In the DevOps toolchain, HTTP knowledge connects directly to your work with nginx/Caddy/HAProxy configuration, Kubernetes Ingress and Service definitions, Prometheus scraping, container health checks, API gateway rules, and observability pipelines. The tools in this lesson — primarily `curl` and `openssl` — are available on virtually every server and are the first tools you should reach for when something between two services stops working.

---

## Concepts

### HTTP Request Structure

Every HTTP request is plain text with a defined structure. Understanding this structure means you can construct requests manually, read raw logs, and spot malformed requests without needing a GUI.

```
POST /api/v1/deployments HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGci...
Content-Type: application/json
Accept: application/json
X-Request-ID: 7f3d8c2a-1234-5678-abcd-ef0123456789
Content-Length: 47

{"service": "payments", "version": "v2.3.1"}
```

The four parts:
1. **Request line** — method, path, and protocol version
2. **Headers** — one per line, colon-separated key-value pairs
3. **Blank line** — mandatory separator; its absence causes parse failures
4. **Body** — only present for POST, PUT, PATCH; must match `Content-Type`

**Host header is mandatory in HTTP/1.1.** A server can host multiple virtual hosts on the same IP. Without `Host`, the server doesn't know which site you're asking for. Missing or wrong `Host` is a common cause of unexpected 400 or 404 responses when debugging proxy configs.

HTTP responses follow the same pattern, but the first line is a status line:

```
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Location: /api/v1/deployments/9912
X-Request-ID: 7f3d8c2a-1234-5678-abcd-ef0123456789
Content-Length: 82

{"id": 9912, "service": "payments", "version": "v2.3.1", "status": "queued"}
```

---

### HTTP Methods

| Method  | Meaning                              | Idempotent | Safe | Body |
|---------|--------------------------------------|------------|------|------|
| GET     | Retrieve a resource                  | Yes        | Yes  | No   |
| POST    | Create a resource / trigger an action| No         | No   | Yes  |
| PUT     | Replace a resource entirely          | Yes        | No   | Yes  |
| PATCH   | Partially update a resource          | No         | No   | Yes  |
| DELETE  | Remove a resource                    | Yes        | No   | No   |
| HEAD    | Same as GET but response has no body | Yes        | Yes  | No   |
| OPTIONS | Ask what methods the server accepts  | Yes        | Yes  | No   |

**Idempotent** means calling the method N times produces the same result as calling it once. **Safe** means the method does not modify server state.

**Why DevOps engineers care about idempotency:** Infrastructure automation and retry logic depend on it. If your deployment script retries a failed PUT, the resource ends up in one known state. If it retries a failed POST, you may create duplicate records. Design your internal tooling APIs accordingly, and look for `Retry-After` headers to know when it's safe to retry a 429 or 503.

**HEAD is underused.** It's ideal for health checks and cache validation — you get the status code and all response headers (including `Content-Length` and `Last-Modified`) without downloading the body. Useful for checking if a large artifact exists in object storage before downloading it.

```bash
# Check if an artifact exists without downloading it
curl -I https://artifacts.example.com/releases/app-v2.3.1.tar.gz
# HTTP/2 200
# Content-Length: 48291034
# Last-Modified: Tue, 14 Jan 2025 09:22:11 GMT
```

---

### HTTP Status Codes

| Range | Category      | Common codes and meaning |
|-------|---------------|--------------------------|
| 2xx   | Success       | 200 OK, 201 Created, 202 Accepted, 204 No Content |
| 3xx   | Redirect      | 301 Moved Permanently, 302 Found, 304 Not Modified |
| 4xx   | Client error  | 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable Entity, 429 Too Many Requests |
| 5xx   | Server error  | 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout |

**The codes you'll debug most often in production:**

| Code | What it actually means | Where to look |
|------|------------------------|---------------|
| 400  | Request is malformed — wrong body, missing required field | Application logs, request body |
| 401  | No credentials or invalid credentials | Auth service logs, token expiry |
| 403  | Valid credentials, but no permission | IAM/RBAC config, service mesh policy |
| 404  | Path doesn't exist at this server | Is the route registered? Is the service running? |
| 409  | Conflict — resource already exists or state mismatch | Idempotency key, database constraints |
| 422  | Request is well-formed but semantically invalid | Validation logic in the application |
| 429  | Rate limited — check `Retry-After` header | API gateway config, client retry logic |
| 502  | Your reverse proxy reached the backend and got garbage back, or couldn't connect at all | Proxy error logs, backend health |
| 503  | Backend explicitly saying it's unavailable | Backend logs, health check endpoint |
| 504  | Backend connected but took too long | Timeout config in proxy, slow query |

**502 vs 504 distinction is critical.** A 502 means the gateway got a bad or no response (connection refused, backend crashed). A 504 means the connection was established but the backend didn't respond within the timeout. They point to different problems: a 502 suggests the process is down; a 504 suggests it's alive but slow.

**304 Not Modified** saves bandwidth. When a client has a cached copy with an `ETag` or `Last-Modified` date, it sends `If-None-Match` or `If-Modified-Since`. If the resource hasn't changed, the server returns 304 with no body — the client uses its cache. Misconfigured CDN or cache headers that suppress 304 responses cause unnecessary data transfer.

---

### Key HTTP Headers

Headers carry metadata that controls caching, authentication, content negotiation, routing, and observability. Knowing which header does what lets you configure proxies and debug problems without guessing.

**Request headers:**

| Header | Purpose | Example |
|--------|---------|---------|
| `Host` | Target virtual host | `api.example.com` |
| `Authorization` | Credentials | `Bearer eyJ...` or `Basic dXNlcjpwYXNz` |
| `Content-Type` | Body format | `application/json` |
| `Accept` | Acceptable response formats | `application/json, */*;q=0.5` |
| `X-Request-ID` | Distributed tracing correlation | `7f3d8c2a-...` |
| `If-None-Match` | Cache validation via ETag | `"abc123"` |
| `X-Forwarded-For` | Original client IP behind a proxy | `203.0.113.42` |

**Response headers:**

| Header | Purpose | Example |
|--------|---------|---------|
| `Content-Type` | Body format + encoding | `application/json; charset=utf-8` |
| `Cache-Control` | Caching directives | `max-age=3600, public` |
| `ETag` | Resource version fingerprint | `"d41d8cd9"` |
| `Location` | Redirect target or created resource URL | `/api/v1/users/42` |
| `Retry-After` | Seconds or date before retrying | `60` |
| `Set-Cookie` | Create a client-side cookie | `session=abc; HttpOnly; Secure` |
| `Strict-Transport-Security` | Enforce HTTPS | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | Prevent MIME sniffing | `nosniff` |

**`Authorization: Basic` encoding is not encryption.** The value is just `base64(username:password)`. It's trivially reversible. Basic auth over plain HTTP exposes credentials in transit. Only use it over HTTPS.

```bash
# Decode a Basic auth header to verify what's being sent
echo "dXNlcjpteXNlY3JldA==" | base64 -d
# user:mysecret
```

**`X-Forwarded-For` is spoofable.** A client can set this header to any value. If your application uses it for IP-based access control or rate limiting, you need your load balancer to overwrite (not append) this header — otherwise a malicious client can bypass controls by setting a trusted IP in the header themselves.

**Correlation headers (`X-Request-ID`, `X-Trace-ID`) are your best friend in distributed debugging.** Generate them at the edge (API gateway or first service), propagate them through every downstream call, and log them in every service. When a user reports a failed request, one ID lets you reconstruct the entire call chain across services.

---

### HTTPS and TLS

HTTPS is HTTP sent through a TLS (Transport Layer Security) tunnel. TLS provides three guarantees:

1. **Confidentiality** — traffic is encrypted; a network observer sees only ciphertext
2. **Authentication** — the server presents a certificate proving its identity
3. **Integrity** — a message authentication code (MAC) detects tampering in transit

**TLS handshake (TLS 1.3, simplified):**

```
Client → Server: ClientHello
                 - Max TLS version supported: TLS 1.3
                 - Supported cipher suites: TLS_AES_256_GCM_SHA384, ...
                 - Key share (Diffie-Hellman public value)

Server → Client: ServerHello
                 - Selected cipher suite
                 - Server's key share
                 - Certificate (signed by a CA)
                 - CertificateVerify (proves server owns the private key)
                 - Finished (MAC of the handshake)

Client → Server: Finished
Both sides:      Derive symmetric session keys from the DH exchange
                 Encrypted application data flows
```

In TLS 1.3, the handshake completes in **one round trip** (1-RTT), down from two in TLS 1.2. This directly reduces connection latency, which matters for services that make many short-lived HTTPS calls.

**Certificate chain of trust:**

```
Root CA          (pre-installed in your OS/browser trust store)
  └── Intermediate CA   (issued by Root CA, used to sign end-entity certs)
        └── example.com certificate   (presented by your server)
```

Your server must serve the full chain (your cert + intermediates). If it only serves the leaf certificate, some clients that don't have the intermediate cached will fail with a chain verification error — even though your cert itself is valid.

**Common certificate problems and their signatures:**

```bash
# Expired certificate
curl: (60) SSL certificate problem: certificate has expired
# Fix: renew the certificate. Check expiry before it happens (see Exercise 4).

# Hostname mismatch — the cert is for a different domain
curl: (60) SSL certificate problem: SSL: no alternative certificate subject
#      name matches target host name 'api.example.com'
# Fix: cert must have example.com in Subject or Subject Alternative Names (SAN).
#      Wildcard certs (*.example.com) cover one subdomain level.

# Self-signed certificate — no trusted CA in the chain
curl: (60) SSL certificate problem: self-signed certificate in certificate chain
# Fix in prod: use a real CA (Let's Encrypt, internal PKI).
# Fix for internal tooling: trust the CA explicitly:
curl --cacert /etc/ssl/certs/internal-ca.crt https://internal.example.com/

# Bypass verification (NEVER in production — defeats authentication)
curl -k https://api.example.com/
```

**Inspect a live certificate:**

```bash
# See expiry, subject, and issuer
openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer

# notBefore=Jan 14 00:00:00 2025 GMT
# notAfter=Apr 14 23:59:59 2025 GMT
# subject=CN=api.example.com
# issuer=C=US, O=Let's Encrypt, CN=R11

# See Subject Alternative Names (what hostnames the cert covers)
openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName

# Verify the full chain explicitly
openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>&1 | grep -E "Verify|depth|error"
```

**SNI (Server Name Indication)** is why `-servername` matters. On a server hosting multiple HTTPS virtual hosts (one IP, many domains), the server needs to know which certificate to present before the TLS handshake completes — before it sees the `Host` header. SNI carries the hostname in the ClientHello. Without it, the server sends the wrong cert. Always pass `-servername` with `openssl s_client`.

---

### curl for HTTP Debugging

`curl` is the universal HTTP debugging tool. It's available everywhere, scriptable, and exposes every layer of the protocol.

```bash
# Verbose output: shows TLS handshake, request headers, response headers, body
# Lines starting with > are sent; lines starting with < are received
curl -v https://api.example.com/health

# HEAD request — headers only, no body download
curl -I https://api.example.com/health

# Show response headers + body (useful in scripts)
curl -si https://api.example.com/health

# POST with JSON body
curl -X POST https://api.example.com/users \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"name": "Alice", "role": "admin"}'

# POST with a file as body (useful for large payloads)
curl -X POST https://api.example.com/configs \
     -H "Content-Type: application/json" \
     -d @config.json

# Follow redirects (critical for 301/302 chains)
curl -L https://api.example.com/old-path

# Set a timeout — never curl in automation without one
curl --max-time 10 https://api.example.com/health

# Trust an internal CA (for internal services with private PKI)
curl --cacert /etc/ssl/certs/internal-ca.crt https://internal.svc/health

# Detailed timing breakdown — paste this template directly into scripts
curl -o /dev/
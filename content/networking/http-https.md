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

**HTTP/1.1 vs HTTP/2 vs HTTP/3:** In HTTP/2, the wire format changes (binary framing, header compression, multiplexed streams over one TCP connection), but the semantics — methods, status codes, headers — stay the same. HTTP/3 moves the transport layer from TCP to QUIC (UDP-based), reducing head-of-line blocking further. From a DevOps perspective, the practical difference is: HTTP/2 requires TLS in almost all real implementations, and multiplexing means a single connection handles many requests in parallel, which changes how connection pool sizing works in proxies.

---

### HTTP Methods

| Method  | Meaning                               | Idempotent | Safe | Body |
|---------|---------------------------------------|------------|------|------|
| GET     | Retrieve a resource                   | Yes        | Yes  | No   |
| POST    | Create a resource / trigger an action | No         | No   | Yes  |
| PUT     | Replace a resource entirely           | Yes        | No   | Yes  |
| PATCH   | Partially update a resource           | No         | No   | Yes  |
| DELETE  | Remove a resource                     | Yes        | No   | No   |
| HEAD    | Same as GET but response has no body  | Yes        | Yes  | No   |
| OPTIONS | Ask what methods the server accepts   | Yes        | Yes  | No   |

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

**OPTIONS and CORS preflight:** Browsers send an OPTIONS request before a cross-origin POST or PUT to ask the server which methods and headers it allows. If your API gateway or reverse proxy doesn't forward OPTIONS correctly, browser clients get CORS errors even though the API itself works fine. When debugging CORS, always check whether OPTIONS returns the correct `Access-Control-Allow-Origin` and `Access-Control-Allow-Methods` headers.

---

### HTTP Status Codes

| Range | Category     | Common codes and meaning |
|-------|--------------|--------------------------|
| 2xx   | Success      | 200 OK, 201 Created, 202 Accepted, 204 No Content |
| 3xx   | Redirect     | 301 Moved Permanently, 302 Found, 304 Not Modified |
| 4xx   | Client error | 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable Entity, 429 Too Many Requests |
| 5xx   | Server error | 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout |

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
| 502  | Proxy reached backend and got garbage back, or couldn't connect | Proxy error logs, backend health |
| 503  | Backend explicitly saying it's unavailable | Backend logs, health check endpoint |
| 504  | Backend connected but took too long to respond | Timeout config in proxy, slow query |

**502 vs 504 distinction is critical.** A 502 means the gateway got a bad or no response (connection refused, backend crashed, upstream sent invalid HTTP). A 504 means the connection was established but the backend didn't respond within the timeout. They point to different problems: a 502 suggests the process is down or returning garbage; a 504 suggests it's alive but slow or deadlocked. In nginx, check `error.log` for the upstream error that produced the 502 — it often includes the actual OS error (`Connection refused`, `no live upstreams`).

**304 Not Modified** saves bandwidth. When a client has a cached copy with an `ETag` or `Last-Modified` date, it sends `If-None-Match` or `If-Modified-Since`. If the resource hasn't changed, the server returns 304 with no body — the client uses its cache. Misconfigured CDN or cache headers that suppress 304 responses cause unnecessary data transfer and slower page loads.

**201 vs 202:** Return 201 when the resource is fully created and its URL is known (include a `Location` header pointing to it). Return 202 when the work is queued or async — the resource doesn't exist yet. CI/CD webhooks and job-submission APIs typically return 202.

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
| `User-Agent` | Identifies the client software | `curl/7.88.1` |

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

**`X-Forwarded-For` is spoofable.** A client can set this header to any value. If your application uses it for IP-based access control or rate limiting, configure your load balancer to overwrite (not append) this header — otherwise a malicious client can bypass controls by setting a trusted IP themselves. In nginx, use `real_ip_module` to rewrite it from a trusted upstream only.

**Correlation headers (`X-Request-ID`, `X-Trace-ID`) are your best friend in distributed debugging.** Generate them at the edge (API gateway or first service), propagate them through every downstream call, and log them in every service. When a user reports a failed request, one ID lets you reconstruct the entire call chain across services.

**`Cache-Control` directives you need to know:**

| Directive | Meaning |
|-----------|---------|
| `no-store` | Never cache — contains sensitive data |
| `no-cache` | Can cache, but must revalidate with the server before serving |
| `max-age=N` | Cache is valid for N seconds |
| `private` | Only the client browser can cache — not a shared CDN |
| `public` | Any cache (CDN, proxy) can store this response |
| `s-maxage=N` | Override `max-age` for shared caches (CDNs) specifically |

**`Strict-Transport-Security` (HSTS) has a one-way ratchet.** Once a browser receives an HSTS header, it refuses plain HTTP connections to that domain for the `max-age` duration. If you later need to roll back to HTTP (e.g., cert misconfiguration), browsers that already received HSTS will not connect until `max-age` expires. Don't set `max-age` to a year until you're confident your HTTPS setup is stable.

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
                 - Finished (MAC of the entire handshake)

Client → Server: Finished
Both sides:      Derive symmetric session keys from the DH exchange
                 Encrypted application data flows
```

In TLS 1.3, the handshake completes in **one round trip** (1-RTT), down from two in TLS 1.2. This directly reduces connection latency, which matters for services that make many short-lived HTTPS calls. TLS 1.3 also removed weak cipher suites (RC4, 3DES) and RSA key exchange — forward secrecy is now mandatory.

**Certificate chain of trust:**

```
Root CA          (pre-installed in your OS/browser trust store)
  └── Intermediate CA   (issued by Root CA, used to sign end-entity certs)
        └── example.com certificate   (presented by your server)
```

Your server must serve the full chain (your cert + intermediates). If it only serves the leaf certificate, some clients that don't have the intermediate cached will fail with a chain verification error — even though your cert itself is valid. This is one of the most common TLS misconfiguration bugs in production.

**Common certificate problems and their curl error signatures:**

```bash
# Expired certificate
# curl: (60) SSL certificate problem: certificate has expired
# Fix: renew the certificate. Use monitoring to alert before expiry.

# Hostname mismatch — cert is for a different domain
# curl: (60) SSL: no alternative certificate subject name matches
#       target host name 'api.example.com'
# Fix: cert must include the hostname in Subject or Subject Alternative Names (SAN).
# Wildcard certs (*.example.com) cover exactly one subdomain level —
# *.example.com covers api.example.com but NOT deep.api.example.com.

# Self-signed or unknown CA
# curl: (60) SSL certificate problem: self-signed certificate in certificate chain
# Fix in prod: use a real CA (Let's Encrypt, internal PKI).
# Fix for internal tooling: trust the CA explicitly:
curl --cacert /etc/ssl/certs/internal-ca.crt https://internal.example.com/

# Never bypass verification in production — this disables authentication entirely.
# -k / --insecure makes the encrypted tunnel meaningless because you accept any cert,
# including an attacker's. Only use it for local development throwaway testing.
curl -k https://localhost:8443/
```

**Inspect a live certificate with openssl:**

```bash
# See expiry, subject, and issuer
openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer

# notBefore=Jan 14 00:00:00 2025 GMT
# notAfter=Apr 14 23:59:59 2025 GMT
# subject=CN=api.example.com
# issuer=C=US, O=Let's Encrypt, CN=R11

# See Subject Alternative Names (every hostname the cert is valid for)
openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName
# subjectAltName: DNS:api.example.com, DNS:www.example.com

# Verify the full chain; check each depth level for errors
openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>&1 | grep -E "depth|Verify|error"
# depth=2 C=US, O=Internet Security Research Group, CN=ISRG Root X1
# depth=1 C=US, O=Let's Encrypt, CN=R11
# depth=0 CN=api.example.com
# Verify return code: 0 (ok)

# Check how many days until expiry (paste into monitoring scripts)
expiry=$(openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2)
openssl x509 -checkend $((30*86400)) -noout <<< \
  "$(openssl s_client -connect api.example.com:443 -servername api.example.com \
     </dev/null 2>/dev/null | openssl x509)"
# exit code 1 = expires within 30 days; 0 = still valid
```

**SNI (Server Name Indication)** is why `-servername` matters. On a server hosting multiple HTTPS virtual hosts (one IP, many domains), the server needs to know which certificate to present before the TLS handshake completes — before it sees the `Host` header. SNI carries the hostname in the ClientHello. Without it, the server sends a default cert, which is often the wrong one. Always pass `-servername` when using `openssl s_client`.

**Mutual TLS (mTLS):** Standard TLS only authenticates the server. In mTLS, both sides present certificates — the client proves its identity to the server. This is common in service meshes (Istio, Linkerd) where every pod has a certificate and services authenticate each other without application-level tokens. If you see `400 No required SSL certificate was sent` or `SSL_ERROR_HANDSHAKE_FAILURE_ALERT`, the server is likely requiring client certificates that you haven't configured.

---

### curl for HTTP Debugging

`curl` is the universal HTTP debugging tool. It's available everywhere, scriptable, and exposes every layer of the protocol.

```bash
# Verbose output: shows TLS handshake, request headers, response headers, body.
# Lines with > are sent by the client; lines with < are received from the server.
curl -v https://api.example.com/health

# HEAD request — response headers only, no body download
curl -I https://api.example.com/health

# Show response headers prepended to body (-s silences progress meter)
curl -si https://api.example.com/health

# POST with JSON body; always set Content-Type explicitly
curl -X POST https://api.example.com/users \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"name": "Igal", "role": "admin"}'

# POST with a file as the body (useful for large payloads)
curl -X POST https://api.example.com/configs \
     -H "Content-Type: application/json" \
     -d @config.json

# Follow redirects — critical for 301/302 chains (e.g., HTTP → HTTPS redirect)
curl -L https://api.example.com/old-path

# Set a connect and total timeout; always do this in automation scripts.
# Without timeouts, a hung connection blocks your pipeline indefinitely.
curl --connect-timeout 5 --max-time 30 https://api.example.com/health

# Trust a private CA certificate (internal services with self-managed PKI)
curl --cacert /etc/ssl/certs/internal-ca.crt https://internal.svc/health

# Detailed timing breakdown — paste this template into scripts to profile latency
curl -o /dev/null -s -w \
  "dns_resolution: %{time_namelookup}s\n\
tcp_connect:    %{time_connect}s\n\
tls_handshake:  %{time_appconnect}s\n\
ttfb:           %{time_starttransfer}s\n\
total:          %{time_total}s\n\
http_code:      %{http_code}\n" \
  https://api.example.com/health

# Output example:
# dns_resolution: 0.003s
# tcp_connect:    0.018s
# tls_handshake:  0.045s
# ttfb:           0.112s
# total:          0.114s
# http_code:      200

# Override DNS — test a new backend without changing real DNS
# Useful when verifying a deployment before a DNS cutover
curl --resolve api.example.com:443:192.168.1.50 https://api.example.com/health

# Send a custom Host header — simulate a virtual host on a proxy
curl -H "Host: api.example.com" http://10.0.0.1/health

# Write response body to a file and print headers to stdout
curl -D - -o response.json https://api.example.com/data

# Only output the HTTP status code (useful in scripts)
curl -o /dev/null -s -w "%{http_code}" https://api.example.com/health
```

**`time_appconnect` is the TLS overhead.** The difference between `time_appconnect` and `time_connect` is pure TLS handshake time. If this is high (>100ms), investigate cipher negotiation, certificate chain length, or OCSP stapling configuration. If `time_connect` itself is high, the problem is network latency or TCP, not TLS.

**Exit codes matter in scripts.** `curl` exits with 0 even on 4xx/5xx responses by default — it received a valid HTTP response, which is a "success" from curl's perspective. Use `--fail` (or `-f`) to make curl exit with code 22 on HTTP error responses. Use `--fail-with-body` (curl ≥ 7.76) to exit non-zero on errors while still printing the response body (useful for seeing error messages from the API).

```bash
# Will exit 0 even if the server returns 500 — wrong for health checks
curl https://api.example.com/health

# Will exit 22 on 4xx/5xx — correct for CI scripts and health checks
curl --fail https://api.example.com/health

# Exit non-zero on error AND print the error response body
curl --fail-with-body https://api.example.com/health
```

---

### Nginx HTTP Configuration Patterns

As a DevOps engineer, you configure HTTP behavior at the reverse proxy layer — not just consume it from the client side. These are the most common patterns you'll encounter.

```nginx
server {
    listen 80;
    server_name api.example.com;

    # Redirect all HTTP to HTTPS — use 301 for permanent, 302 for temporary
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/ssl/certs/api.example.com.crt;  # includes full chain
    ssl_certificate_key /etc/ssl/private/api.example.com.key;

    # Modern TLS: disable TLS 1.0 and 1.1 (deprecated, insecure)
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers   ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;  # Let clients pick in TLS 1.3

    # HSTS: tell browsers to only connect via HTTPS for 1 year
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Security headers
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;

    location /api/ {
        proxy_pass         http://backend:8080;

        # Pass the real client IP to the backend
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Host $host;

        # Propagate the correlation ID; generate one if the client didn't send it
        proxy_set_header   X-Request-ID $request_id;

        # Timeouts: tune these for your backend's expected response times
        proxy_connect_timeout 5s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    # Health check endpoint — doesn't proxy, answered by nginx directly
    location /healthz {
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }
}
```

**`proxy_set_header Host $host` is required.** Without it, nginx forwards the backend's internal address as the `Host` header, which breaks virtual-host routing on the backend. This is a frequent source of unexpected 404s when setting up a new proxy.

**`proxy_read_timeout` vs application timeout:** nginx's `proxy_read_timeout` is how long nginx waits for the backend to send a response. If your backend has a 30s database query, set this to at least 35s. If the backend times out first, it returns 500 or closes the connection and nginx returns 502. If nginx times out first, it returns 504. Knowing which timeout fired tells you where to tune.

---

### Kubernetes Health Check Probes

Kubernetes uses HTTP to determine container health. Understanding the probe types prevents outages during deployments.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: api
        image: api:v2.3.1
        ports:
        - containerPort: 8080
        livenessProbe:
          # If this fails, Kubernetes restarts the container.
          # Use for detecting deadlocks or unrecoverable errors.
          # Don't check dependencies here — if the DB is down, you don't
          # want to restart all pods and cause a thundering herd on recovery.
          httpGet:
            path: /healthz/live
            port: 8080
          initialDelaySeconds: 10   # Give the app time to start
          periodSeconds: 15
          failureThreshold: 3       # 3 consecutive failures → restart
          timeoutSeconds: 5

        readinessProbe:
          # If this fails, Kubernetes removes the pod from Service endpoints.
          # Traffic stops routing to it, but the pod is NOT restarted.
          # Use for checking dependencies (DB connections, cache warm-up).
          # This is what prevents a new deployment from receiving traffic
          # before it's actually ready.
          httpGet:
            path: /healthz/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
          failureThreshold: 2
          timeoutSeconds: 3

        startupProbe:
          # Kubernetes won't run liveness/readiness until this passes.
          # Use for slow-starting apps (JVM warm-up, large model loading).
          # failureThreshold * periodSeconds = max startup time allowed (300s here).
          httpGet:
            path: /healthz/startup
            port: 8080
          failureThreshold: 30
          periodSeconds: 10
```

**Liveness vs Readiness is the most common misconfiguration.** If you put dependency checks in the liveness probe and a downstream service flaps, Kubernetes will restart all your healthy pods, making the outage worse. Liveness = "is this process alive and not deadlocked." Readiness = "is this pod ready to serve traffic right now."

---

## Examples

### Example 1: Debugging a 502 Bad Gateway in a Proxy Setup

**Scenario:** A new nginx reverse proxy is deployed in front of a backend API. Users are getting 502 errors. Diagnose and fix the issue.

```bash
# Step 1: Confirm the 502 and get the full response headers
curl -si https://api.example.com/health
# HTTP/2 502
# server: nginx/1.24.0
# content-type: text/html
# (nginx error page body)

# Step 2: Check if the backend is reachable at all from the proxy server
# SSH into the proxy and test the backend directly (bypassing nginx)
curl -si http://backend-service:8080/health
# curl: (7) Failed to connect to backend-service port 8080: Connection refused

# Connection refused = process is not running or wrong port.
# If we got a response here, the problem is in the nginx config, not the backend.

# Step 3: Verify nginx config syntax
nginx -t
# nginx: [emerg] unknown directive "proxy_pss" in /etc/nginx/conf.d/api.conf:12
# Fix the typo. Reload nginx.

# Step 4: After fixing the config, reload nginx without downtime
nginx -s reload

# Step 5: Verify the fix
curl -si https://api.example.com/health
# HTTP/2 200
# content-type: application/json
# x-request-id: 3f9c1a2b-...
# {"status": "ok"}

# Step 6: Verify the X-Forwarded-For header reaches the backend correctly
curl -si https://api.example.com/headers   # an endpoint that echoes request headers
# Confirm "X-Forwarded-For" contains your real IP, not the proxy's internal IP
```

---

### Example 2: Diagnosing TLS Certificate Expiry Before It Causes an Outage

**Scenario:** Build a shell script that checks certificate expiry for a list of services and exits non-zero if any cert expires within 30 days. Run it in CI on a schedule.

```bash
#!/usr/bin/env bash
# cert-check.sh — check TLS certificate expiry for a list of hostnames
# Exit code 1 if any cert expires within WARN_DAYS days.

set -euo pipefail

WARN_DAYS=30
WARN_SECONDS=$((WARN_DAYS * 86400))
FAILED=0

HOSTS=(
  "api.example.com:443"
  "auth.example.com:443"
  "grafana.internal.example.com:443"
)

check_cert() {
  local host_port="$1"
  local host="${host_port%%:*}"
  local port="${host_port##*:}"

  # Fetch the certificate; -servername is essential for SNI
  local cert
  cert=$(openssl s_client \
    -connect "$host_port" \
    -servername "$host" \
    </dev/null 2>/dev/null \
    | openssl x509 2>/dev/null)

  if [[ -z "$cert" ]]; then
    echo "ERROR: Could not retrieve certificate for $host_port"
    return 1
  fi

  # Check if cert expires within WARN_SECONDS
  if ! echo "$cert" | openssl x509 -checkend "$WARN_SECONDS" -noout; then
    local expiry
    expiry=$(echo "$cert" | openssl x509 -noout -enddate | cut -d= -f2)
    echo "WARNING: $host certificate expires at: $expiry (within ${WARN_DAYS} days)"
    return 1
  else
    local expiry
    expiry=$(echo "$cert" | openssl x509 -noout -enddate | cut -d= -f2)
    echo "OK: $host valid until $expiry"
    return 0
  fi
}

for host_port in "${HOSTS[@]}"; do
  check_cert "$host_port" || FAILED=1
done

exit "$FAILED"
```

```bash
# Run the script
chmod +x cert-check.sh
./cert-check.sh

# OK: api.example.com valid until Apr 14 23:59:59 2025 GMT
# OK: auth.example.com valid until Mar 02 12:00:00 2025 GMT
# WARNING: grafana.internal.example.com certificate expires at:
#          Feb 01 00:00:00 2025 GMT (within 30 days)

# Verify the exit code for CI pipeline integration
echo "Exit code: $?"
# Exit code: 1  (grafana cert is expiring — pipeline fails, alert fires)
```

---

### Example 3: Tracing a Slow API Call with curl Timing

**Scenario:** Users report that a specific API endpoint is slow. Use curl's timing breakdown to identify whether the latency is in DNS, TCP, TLS, or the application itself.

```bash
# curl timing template — measures each phase of the request lifecycle
cat > /tmp/curl-timing.fmt << 'EOF'
    dns_resolution:  %{time_namelookup}s
    tcp_connect:     %{time_connect}s
    tls_handshake:   %{time_appconnect}s
    request_sent:    %{time_pretransfer}s
    ttfb:            %{time_starttransfer}s  <- server processing time starts here
    total:           %{time_total}s
    http_code:       %{http_code}
    bytes_received:  %{size_download} bytes
EOF

# Run 5 times to see variance (spot intermittent slowness)
for i in {1..5}; do
  echo "--- Run $i ---"
  curl -o /dev/null -s -w "@/tmp/curl-timing.fmt" \
    -H "Authorization: Bearer $TOKEN" \
    https://api.example.com/reports/summary
  echo
done

# Example output showing a slow backend (TTFB is the problem):
# --- Run 1 ---
#     dns_resolution:  0.003s
#     tcp_connect:     0.019s
#     tls_handshake:   0.048s
#     request_sent:    0.048s
#     ttfb:            3.241s   <- 3.2 seconds in backend processing
#     total:           3.243s
#     http_code:       200

# --- Run 2 ---
#     dns_resolution:  0.003s
#     tcp_connect:     0.020s
#     tls_handshake:   0.046s
#     ttfb:            0.087s   <- fast this time — intermittent problem
#     total:           0.089s

# Diagnosis: TLS and TCP are consistently fast (~50ms combined).
# TTFB spikes indicate slow queries or lock contention in the backend.
# Next step: check backend APM traces / slow query log for /reports/summary.

# Verify your endpoint handles the Authorization header correctly:
curl -v -o /dev/null -H "Authorization: Bearer $TOKEN" \
  https://api.example.com/reports/summary 2>&1 | grep -E "< HTTP|> Auth"
# > Authorization: Bearer eyJ...
# < HTTP/2 200
```

---

### Example 4: Testing a Kubernetes Readiness Probe Endpoint

**Scenario:** Before deploying a new service to Kubernetes, verify the health check endpoints behave correctly — including failure scenarios.

```bash
# Run the container locally to test health endpoints before pushing
docker run -d --name api-test -p 8080:8080 api:v2.3.1

# 1. Test the liveness endpoint (should always return 200 if process is alive)
curl -si http://localhost:8080/healthz/live
# HTTP/1.1 200 OK
# Content-Type: application/json
# {"status": "alive"}

# 2. Test the readiness endpoint (checks DB connection, cache, etc.)
curl -si http://localhost:8080/healthz/ready
# HTTP/1.1 200 OK
# {"status": "ready", "db": "connected", "cache": "connected"}

# 3. Simulate a dependency failure — stop the DB and recheck readiness
docker stop postgres-dev
curl -si http://localhost:8080/healthz/ready
# HTTP/1.1 503 Service Unavailable          <- correct: 503, not 200
# {"status": "not ready", "db": "unreachable", "cache": "connected"}

# Critical: a 503 readiness probe must return a non-2xx status code.
# If the endpoint returns 200 with {"status": "error"} in the body,
# Kubernetes will think it's healthy — it only checks the HTTP status code.

# 4. Simulate what Kubernetes does: check exit code from curl --fail
curl --fail -si http://localhost:8080/healthz/ready
echo "Exit: $?"
# Exit: 22  <- non-zero, Kubernetes marks pod NotReady, stops routing traffic

# 5. Test the startup probe path
curl -si http://localhost:8080/healthz/startup
# HTTP/1.1 200 OK
# {"status": "started", "migrations": "complete"}

# 6. Cleanup
docker stop api-test && docker rm api-test
```

---

## Exercises

### Exercise 1: Decode and Analyze a Full HTTP Transaction

Using `curl -v`, capture a complete HTTP transaction to an API of your choice (use `https://httpbin.org` if you don't have one available). From the verbose output:

1. Identify the TLS version and cipher suite negotiated during the handshake.
2. Find the value of the `Content-Type` response header and explain what the `charset` parameter means.
3. Identify which HTTP version was used (HTTP/1.1 or HTTP/2). If HTTP/2 was used, explain why you see fewer headers in the verbose output than you would with HTTP/1.1.
4. Make a second request to the same URL and compare `time_appconnect` between the two. Explain why it might be zero on the second request.

*Hint:* `curl -v --write-out "\ntls: %{ssl_version} %{ssl_cipher}\n" https://httpbin.org/get`

---

### Exercise 2: Reproduce and Fix a Common 4xx Error

Use `https://httpbin.org` to trigger each of the following error conditions with `curl`, capture the response, and explain what change in the request fixes it:

1. Send a `POST` to `https://httpbin.org/post` with a JSON body but **without** a `Content-Type` header. Observe the response. Add the correct header and compare.
2. Send a request to `https://httpbin.org/basic-auth/admin/secret` without credentials. Observe the status code. Now send the correct `Authorization: Basic` header (compute the base64 value yourself — don't use `curl -u`).
3. Send a request to `https://httpbin.org/status/429`. Read the response headers. Write a bash snippet that reads the `Retry-After` header value from the response and sleeps for that duration before retrying.

---

### Exercise 3: Inspect and Validate a TLS Certificate Chain

Pick any public HTTPS site (or use `api.github.com`) and use `openssl s_client` to answer all of the following:

1. How many certificates are in the chain? Name each one (subject CN) and its role (root, intermediate, or end-entity).
2. What is the exact expiry date of the end-entity certificate?
3. Does the certificate cover only the exact hostname you connected to, or does it cover additional names? List all Subject Alternative Names.
4. What TLS version was negotiated? How would you force `openssl s_client` to attempt TLS 1.1 only, and what do you expect to happen?
5. Write a one-liner that exits with code `1` if the certificate expires within the next 14 days and code `0` if it does not.

---

### Exercise 4: Build a Health Check Script for a CI Pipeline

Write a bash script named `wait-for-healthy.sh` that:

1. Accepts a URL as its first argument and an optional timeout in seconds as the second argument (default: 60 seconds).
2. Polls the URL every 5 seconds using `curl --fail --max-time 5`.
3. Exits with code `0` as soon as the endpoint returns a 2xx status.
4. Exits with code `1` if the total timeout is exceeded before the endpoint becomes healthy, printing a clear error message.
5. Prints a timestamped status line on each poll attempt.

Test it against `https://httpbin.org/status/200` (should succeed immediately) and `https://httpbin.org/status/503` (should time out).

*This is a real pattern used in CI pipelines to wait for a freshly deployed service to pass its health check before running integration tests. Do not use `sleep 30` and hope for the best — that either wastes time or isn't long enough.*
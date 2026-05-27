---
title: REST API Fundamentals
module: postman
duration_min: 20
difficulty: beginner
tags: [postman, rest, http, api, request, response, headers, status-codes, curl]
exercises: 4
---

## Overview

REST (Representational State Transfer) is the dominant API style for web services, and understanding it is table stakes for DevOps work. Every modern infrastructure tool — Kubernetes, Vault, Terraform Cloud, GitHub Actions, PagerDuty, Datadog — exposes a REST API. Automating deployments, writing infrastructure-as-code integrations, building runbooks, and debugging production incidents all require you to read, construct, and reason about HTTP requests and responses. If you cannot fluently read an API response and know why a `403` is different from a `401`, you will be blocked constantly.

REST is not a protocol — it is a set of architectural constraints defined by Roy Fielding in 2000. The key constraints are: statelessness (each request contains all information needed to process it, no server-side session), a uniform interface (resources identified by URLs, manipulated through representations), and client-server separation. In practice, "RESTful" APIs communicate over HTTP, use JSON bodies, identify resources with nouns in paths, and use HTTP methods to express intent. These constraints make APIs predictable and cacheable, which matters when you are scripting against them.

In the DevOps toolchain, REST API knowledge connects directly to several adjacent skills: `curl` for ad-hoc debugging and shell scripting, Postman for manual exploration and writing automated test suites, CI/CD pipelines that call deployment APIs, and observability tooling that queries time-series databases over HTTP. This lesson covers the protocol layer — request anatomy, methods, status codes, headers — and the two primary tools for interacting with it: `curl` and Postman.

---

## Concepts

### HTTP Request Anatomy

Every HTTP interaction is a request/response pair. Understanding the structure of both sides lets you construct correct requests and diagnose problems precisely.

```
POST /api/users HTTP/1.1
Host: api.example.com
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
Accept: application/json
X-Request-ID: 550e8400-e29b-41d4-a716-446655440000

{
  "name": "Igal Vexler",
  "email": "igal@example.com",
  "role": "admin"
}
```

| Part | Location | Purpose |
|------|----------|---------|
| **Method** | First line | What action to perform (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) |
| **Path** | First line | Which resource (`/api/users`, `/api/users/123`) |
| **HTTP version** | First line | Protocol version (`HTTP/1.1`, `HTTP/2`) |
| **Headers** | Before blank line | Metadata: auth, content negotiation, tracing |
| **Body** | After blank line | Data payload — only present on `POST`, `PUT`, `PATCH` |
| **Query params** | Appended to path | Filters, sorting, pagination (`?role=admin&limit=10`) |

The response follows the same structure: a status line (`HTTP/1.1 201 Created`), response headers, a blank line, and an optional body.

**The blank line between headers and body is mandatory.** Servers use it to know where headers end. A missing or malformed `Content-Type` header is one of the most common causes of `400 Bad Request` errors when scripting.

### HTTP Methods

HTTP methods define the intent of the request. REST maps CRUD operations to methods, but the semantics go deeper than just "create/read/update/delete."

| Method | Meaning | Has Body | Idempotent | Safe |
|--------|---------|----------|------------|------|
| `GET` | Read a resource | No | Yes | Yes |
| `POST` | Create a resource | Yes | No | No |
| `PUT` | Replace a resource (full update) | Yes | Yes | No |
| `PATCH` | Partial update | Yes | No | No |
| `DELETE` | Delete a resource | No | Yes | No |
| `HEAD` | Like GET, returns headers only | No | Yes | Yes |
| `OPTIONS` | List allowed methods (used in CORS) | No | Yes | Yes |

**Idempotent** means calling the operation N times produces the same server state as calling it once. `PUT /users/1` with the same body always results in the same user record — the second call is a no-op. `POST /users` creates a new user on every call, so it is not idempotent.

**Safe** means the operation does not modify server state. All safe methods are also idempotent, but not vice versa. `DELETE` is idempotent (deleting an already-deleted resource leaves the same state: absent) but not safe.

**`PUT` vs `PATCH`:** `PUT` requires sending the complete resource representation. If you `PUT` a user object and omit the `email` field, a correct implementation will set `email` to null. `PATCH` sends only the fields to change. Use `PATCH` for partial updates — it is less error-prone when resources have many fields.

**`DELETE` returning 404 on a second call:** Some APIs return `404` if you try to delete an already-deleted resource. This technically breaks idempotency. When scripting retry logic, treat `404` on a `DELETE` as a success condition to avoid false failures.

### HTTP Status Codes

Status codes are the API's machine-readable signal about what happened. Grouping them by class is the fastest way to triage a problem.

```
1xx — Informational (rarely seen in practice)
  100 Continue         — server received request headers, client should send body

2xx — Success
  200 OK               — request succeeded; body contains the result
  201 Created          — resource was created (POST); Location header has its URL
  204 No Content       — success but no body (common for DELETE, sometimes PUT)

3xx — Redirection
  301 Moved Permanently — URL has changed; update your scripts/configs
  304 Not Modified      — cached copy is still valid (conditional GET with ETag)

4xx — Client Errors (you sent something wrong)
  400 Bad Request       — malformed JSON, missing required field, invalid value
  401 Unauthorized      — not authenticated (no token, expired token, wrong scheme)
  403 Forbidden         — authenticated but not authorized for this resource/action
  404 Not Found         — resource does not exist at this path
  405 Method Not Allowed — valid path, wrong HTTP method
  409 Conflict          — resource already exists, or state conflict (e.g., duplicate key)
  422 Unprocessable     — valid JSON format but semantic validation failed
  429 Too Many Requests — rate limited; check Retry-After header

5xx — Server Errors (the server failed)
  500 Internal Server Error — unhandled exception, bug in the server code
  502 Bad Gateway           — reverse proxy got an invalid response from upstream
  503 Service Unavailable   — server temporarily overloaded or in maintenance
  504 Gateway Timeout       — upstream service took too long to respond
```

**`401` vs `403`:** This distinction matters for debugging. `401` means the server does not know who you are — check your token, its expiry, and the `Authorization` header format. `403` means the server knows exactly who you are but you do not have permission — check RBAC roles, scopes, or resource ownership.

**`502` vs `504`:** Both indicate a problem between a proxy and an upstream service. `502` means the upstream responded with something invalid or closed the connection unexpectedly. `504` means the upstream never responded within the timeout window. In Kubernetes, both often point to a crashing pod or misconfigured service.

**`422` vs `400`:** `400` is for structural problems (unparseable JSON, wrong content-type). `422` is for semantic problems (valid JSON, but the value `"age": -5` fails business validation). Not all APIs respect this distinction — many use `400` for both.

### Important Headers

Headers carry metadata that controls authentication, caching, content negotiation, and observability. In DevOps automation, headers are frequently the source of hard-to-diagnose bugs.

```
# Request headers
Authorization: Bearer <token>          # Auth — most common for APIs
Authorization: Basic <base64(user:pw)> # Basic auth (legacy, avoid over plain HTTP)
Content-Type: application/json         # Format of the request body you are sending
Accept: application/json               # Formats you will accept in the response
X-Request-ID: <uuid>                   # Trace a single request across distributed logs
If-None-Match: "abc123"                # Conditional GET — only return if ETag changed

# Response headers
Content-Type: application/json         # Format of the response body
Location: /api/users/123               # URL of newly created resource (on 201)
X-RateLimit-Limit: 100                 # Total requests allowed in window
X-RateLimit-Remaining: 95             # Requests left in current window
X-RateLimit-Reset: 1716700000         # Unix timestamp when the window resets
ETag: "abc123"                         # Version fingerprint for caching
Cache-Control: max-age=3600, public    # Cache directives
Retry-After: 30                        # Seconds to wait before retrying (429, 503)
```

**`Authorization: Bearer` vs `Authorization: Token`:** These are different schemes. GitHub uses `token <value>` for personal access tokens and `Bearer <value>` for OAuth tokens. Sending the wrong scheme returns `401` even with a valid credential. Always check the API documentation for the exact format.

**`Content-Type` on responses:** If a server returns `Content-Type: text/html` with a `500` error, you may be hitting a load balancer error page, not the application. When parsing API responses in scripts, check `Content-Type` before trying to `jq` the output — `jq` will fail on HTML.

**ETag-based caching workflow:**
1. First request returns `ETag: "v1"` in the response headers.
2. Subsequent request sends `If-None-Match: "v1"`.
3. If the resource has not changed, server returns `304 No Content` — no body transferred.
4. Client uses its cached copy.

This is how CI pipelines avoid re-downloading large artifacts on every run.

### curl Fundamentals

`curl` is the universal HTTP client for shell scripting and debugging. Mastering a small set of flags covers 95% of DevOps use cases.

```bash
# Basic GET
curl https://api.example.com/users

# Silence the progress meter, pipe to jq for pretty output
curl -s https://api.example.com/users | jq .

# GET with auth and query parameters
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/users?role=admin&limit=10" | jq .

# POST — create a resource
curl -s -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "Igal", "email": "igal@example.com", "role": "admin"}' \
  | jq '{id, name, created_at}'

# POST from a file (useful for large bodies)
curl -s -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @payload.json

# PATCH — partial update
curl -s -X PATCH https://api.example.com/users/123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role": "viewer"}' | jq .

# DELETE — note: no body, check for 204 vs 200
curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  https://api.example.com/users/123

# Inspect response headers only (HEAD request)
curl -sI https://api.example.com/health

# Verbose mode — prints request headers, response headers, body
# Use this when debugging auth or SSL issues
curl -v https://api.example.com/health 2>&1 | less

# Print headers to stdout AND the body (useful for checking ETag, Location)
curl -D - -s https://api.example.com/users/123

# Timing breakdown — diagnose slow endpoints
curl -w "\nDNS:     %{time_namelookup}s\nConnect: %{time_connect}s\nTLS:     %{time_appconnect}s\nTTFB:    %{time_starttransfer}s\nTotal:   %{time_total}s\n" \
  -o /dev/null -s https://api.example.com/health

# Follow redirects (301, 302)
curl -L https://api.example.com/old-path

# Store and send cookies
curl -c cookies.txt -b cookies.txt https://api.example.com/session
```

| Flag | Meaning |
|------|---------|
| `-s` | Silent — suppress progress meter |
| `-v` | Verbose — show full request and response headers |
| `-I` | HEAD request — headers only |
| `-D -` | Dump response headers to stdout |
| `-X METHOD` | Set HTTP method |
| `-H "Key: Value"` | Add a request header |
| `-d 'body'` | Request body (string or `@filename`) |
| `-o /dev/null` | Discard the response body |
| `-w "format"` | Print timing/status info after request |
| `-L` | Follow redirects |
| `--fail` | Exit with non-zero status on 4xx/5xx |

**`--fail` in CI scripts:** Always use `curl --fail` (or `curl -f`) in CI pipelines. Without it, `curl` exits `0` even on a `500` error — your pipeline will appear to succeed when it failed. Combine with `-s` and `-S` (`-sS`) to suppress progress but still show errors.

```bash
# CI-safe curl: fail on HTTP error, show error messages, silent progress
curl -fsSL -H "Authorization: Bearer $TOKEN" https://api.example.com/deploy \
  -d '{"version": "1.2.3"}' || { echo "Deployment API call failed"; exit 1; }
```

### Postman Basics

Postman provides a GUI for building, saving, and organizing API requests — useful when you are exploring an unfamiliar API or building a collection that the whole team uses.

#### Making Requests

1. **Method + URL** — select the method from the dropdown; enter the URL in the address bar.
2. **Params tab** — add query parameters as key-value pairs; Postman appends them to the URL.
3. **Authorization tab** — select the auth type (`Bearer Token`, `Basic Auth`, `API Key`). Postman injects the header automatically — you do not add it manually in the Headers tab.
4. **Headers tab** — add custom headers (`X-Request-ID`, `Accept`, custom `Content-Type` overrides).
5. **Body tab** — for `POST`/`PUT`/`PATCH`, select `raw → JSON`. Postman sets `Content-Type: application/json` automatically.
6. **Send** — execute the request.

#### Reading Responses

| Panel | What to look for |
|-------|-----------------|
| **Status** | Code + label, color-coded (green = 2xx, red = 4xx/5xx) |
| **Body → Pretty** | Auto-formatted JSON; use this for readability |
| **Body → Raw** | Exact bytes received — use when Pretty rendering looks wrong |
| **Headers** | All response headers: `ETag`, `Location`, `X-RateLimit-*` |
| **Test Results** | Pass/fail output of any test scripts attached to the request |

#### Environments and Variables

Environments let you switch between `dev`, `staging`, and `prod` without editing every request. Define a variable once; reference it everywhere.

```
# Define in Environment:
base_url   = https://api.staging.example.com
token      = eyJhbGci...

# Use in requests:
URL:     {{base_url}}/users
Header:  Authorization: Bearer {{token}}
```

**Postman environment variables vs global variables:** Use environment variables for values that change between environments (`base_url`, `token`). Use global variables sparingly — they bleed across all workspaces and environments, making them a source of subtle test pollution.

#### Collections

A Collection is a saved, organized set
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
  "name": "Alex Chen",
  "email": "alex@example.com",
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

The response mirrors this structure: a status line (`HTTP/1.1 201 Created`), response headers, a blank line, and an optional body.

**The blank line between headers and body is mandatory.** Servers use it to know where headers end. A missing or malformed `Content-Type` header is one of the most common causes of `400 Bad Request` errors when scripting — the server receives your JSON but does not know to parse it as JSON.

**Query parameters vs path segments:** Use path segments to identify a specific resource (`/users/123`). Use query parameters to filter, sort, or paginate a collection (`/users?role=admin&limit=10&page=2`). Mixing these up produces `404` errors when the server's router does not match the pattern you sent.

---

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

**Idempotent** means calling the operation N times produces the same server state as calling it once. `PUT /users/1` with the same body always results in the same user record — the second call is a no-op. `POST /users` creates a new user on every call, so it is not idempotent. This distinction matters in retry logic: it is safe to auto-retry idempotent methods; retrying `POST` blindly can create duplicate records.

**Safe** means the operation does not modify server state. All safe methods are also idempotent, but not vice versa. `DELETE` is idempotent (deleting an already-deleted resource leaves the same state: absent) but not safe.

**`PUT` vs `PATCH`:** `PUT` requires sending the complete resource representation. If you `PUT` a user object and omit the `email` field, a correct implementation will set `email` to null. `PATCH` sends only the fields to change. Use `PATCH` for partial updates — it is less error-prone when resources have many fields and reduces the risk of accidentally nulling data you did not intend to touch.

**`DELETE` returning `404` on a second call:** Some APIs return `404` if you try to delete an already-deleted resource. This technically breaks idempotency. When scripting retry logic, treat `404` on a `DELETE` as a success condition to avoid false failures in your pipelines.

---

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

**`401` vs `403`:** This distinction matters for debugging. `401` means the server does not know who you are — check your token, its expiry, and the `Authorization` header format. `403` means the server knows exactly who you are but you do not have permission — check RBAC roles, scopes, or resource ownership. Confusing these two wastes significant debugging time.

**`502` vs `504`:** Both indicate a problem between a proxy and an upstream service. `502` means the upstream responded with something invalid or closed the connection unexpectedly. `504` means the upstream never responded within the timeout window. In Kubernetes, both often point to a crashing pod (`502`) or an overloaded/unreachable service (`504`).

**`422` vs `400`:** `400` is for structural problems (unparseable JSON, wrong content-type). `422` is for semantic problems (valid JSON, but the value `"age": -5` fails business validation). Not all APIs respect this distinction — many use `400` for both. When writing API clients, handle both codes the same way: surface the error message from the body to the operator.

**`429` handling in automation:** When you receive a `429`, read the `Retry-After` header before retrying. Immediately retrying without backing off will keep triggering the rate limiter and delay your recovery. Implement exponential backoff with jitter in any script that calls APIs in a loop.

---

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

**`Authorization: Bearer` vs `Authorization: Token`:** These are different schemes. GitHub uses `token <value>` for personal access tokens and `Bearer <value>` for OAuth tokens. Sending the wrong scheme returns `401` even with a valid credential. Always check the API documentation for the exact format — copying a header from a different API is a common source of auth failures.

**`Content-Type` on responses:** If a server returns `Content-Type: text/html` with a `500` error, you may be hitting a load balancer error page, not the application. When parsing API responses in scripts, check `Content-Type` before trying to pipe output to `jq` — `jq` will fail on HTML with a cryptic parse error that obscures the real problem.

**ETag-based caching workflow:**
1. First request returns `ETag: "v1"` in the response headers.
2. Subsequent request sends `If-None-Match: "v1"`.
3. If the resource has not changed, server returns `304 Not Modified` — no body transferred.
4. Client uses its cached copy.

This is how CI pipelines avoid re-downloading large artifacts on every run. It is also how tools like `kubectl` avoid unnecessary API server load when polling for resource state.

**`X-Request-ID` and tracing:** Always generate and send a `X-Request-ID` (or `X-Correlation-ID`) in automated scripts that call APIs in production. When something goes wrong, you can grep the API server logs for that UUID and reconstruct the full call chain. Without it, correlating your script's call to a log entry is nearly impossible in a busy system.

---

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
  -d '{"name": "Alex", "email": "alex@example.com", "role": "admin"}' \
  | jq '{id, name, created_at}'

# POST from a file (useful for large bodies or reusable payloads)
curl -s -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @payload.json

# PATCH — partial update
curl -s -X PATCH https://api.example.com/users/123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role": "viewer"}' | jq .

# DELETE — capture status code, discard body
curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  https://api.example.com/users/123

# Inspect response headers only (HEAD request)
curl -sI https://api.example.com/health

# Verbose mode — prints request headers, response headers, and body
# Use this when debugging auth or SSL issues
curl -v https://api.example.com/health 2>&1 | less

# Dump response headers to stdout AND show the body
# Useful for capturing ETag, Location, or rate-limit headers
curl -D - -s https://api.example.com/users/123

# Timing breakdown — diagnose slow endpoints
curl -w "\nDNS:     %{time_namelookup}s\nConnect: %{time_connect}s\nTLS:     %{time_appconnect}s\nTTFB:    %{time_starttransfer}s\nTotal:   %{time_total}s\n" \
  -o /dev/null -s https://api.example.com/health

# Follow redirects automatically (301, 302)
curl -L https://api.example.com/old-path

# Store cookies to file and send them on subsequent requests
curl -c cookies.txt -b cookies.txt https://api.example.com/session
```

| Flag | Meaning |
|------|---------|
| `-s` | Silent — suppress progress meter |
| `-S` | Show errors even when silent (use with `-s`) |
| `-v` | Verbose — show full request and response headers |
| `-I` | HEAD request — headers only |
| `-D -` | Dump response headers to stdout |
| `-X METHOD` | Set HTTP method |
| `-H "Key: Value"` | Add a request header |
| `-d 'body'` | Request body (string or `@filename`) |
| `-o /dev/null` | Discard the response body |
| `-w "format"` | Print timing/status info after request |
| `-L` | Follow redirects |
| `-f` / `--fail` | Exit non-zero on 4xx/5xx responses |

**`--fail` in CI scripts:** Always use `curl --fail` (or `-f`) in CI pipelines. Without it, `curl` exits `0` even on a `500` error — your pipeline will appear to succeed when it silently failed. Combine with `-s` and `-S` to suppress the progress meter while still printing error messages to stderr.

```bash
# CI-safe curl: fail on HTTP error, show errors, silent progress
curl -fsSL \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST https://api.example.com/deploy \
  -d '{"version": "1.2.3"}' \
  || { echo "ERROR: Deployment API call failed"; exit 1; }
```

**Quoting and special characters in `-d`:** When your JSON contains shell-special characters, use single quotes around the entire body or read from a file with `@payload.json`. Variable interpolation inside single quotes does not work — switch to double quotes or use `printf` to build the body when you need to inject shell variables into JSON.

```bash
# Wrong — $USER is not expanded inside single quotes on some shells
curl -d '{"user": "$USER"}' ...

# Correct — use double quotes and escape inner quotes
curl -d "{\"user\": \"$USER\"}" ...

# Better — build the body cleanly with jq
BODY=$(jq -n --arg user "$USER" '{"user": $user}')
curl -d "$BODY" ...
```

---

### Postman Basics

Postman provides a GUI for building, saving, and organizing API requests — useful when you are exploring an unfamiliar API or building a shared collection that the whole team uses for testing and documentation.

#### Making Requests

1. **Method + URL** — select the method from the dropdown; enter the URL in the address bar.
2. **Params tab** — add query parameters as key-value pairs; Postman appends them to the URL automatically and handles URL encoding.
3. **Authorization tab** — select the auth type (`Bearer Token`, `Basic Auth`, `API Key`). Postman injects the correct header format automatically — do not also add it manually in the Headers tab or you will send it twice.
4. **Headers tab** — add custom headers (`X-Request-ID`, `Accept`, custom `Content-Type` overrides).
5. **Body tab** — for `POST`/`PUT`/`PATCH`, select `raw → JSON`. Postman sets `Content-Type: application/json` automatically when you choose this mode.
6. **Send** — execute the request; results appear in the lower panel.

#### Reading Responses

| Panel | What to look for |
|-------|-----------------|
| **Status** | Code + label, color-coded (green = 2xx, orange = 3xx, red = 4xx/5xx) |
| **Body → Pretty** | Auto-formatted JSON; use this for readability |
| **Body → Raw** | Exact bytes received — use when Pretty rendering looks wrong or content is not JSON |
| **Headers** | All response headers: `ETag`, `Location`, `X-RateLimit-*`, `Content-Type` |
| **Test Results** | Pass/fail output of any test scripts attached to the request |

#### Environments and Variables

Environments let you switch between `dev`, `staging`, and `prod` without editing every request. Define a variable once; reference it everywhere with the `{{variable_name}}` syntax.

```
# Define in Environment (Postman → Environments → New):
base_url   = https://api.staging.example.com
token      = eyJhbGci...
user_id    = 42

# Use in requests:
URL:     {{base_url}}/users/{{user_id}}
Header:  Authorization: Bearer {{token}}
Body:    {"notify_url": "{{base_url}}/webhooks/callback"}
```

Switch environments from the dropdown in the top-right corner of Postman. All requests in all collections instantly use the new values — no find-and-replace needed.

**Postman environment variables vs global variables:** Use environment variables for values that change between environments (`base_url`, `token`). Use global variables sparingly — they bleed across all workspaces and environments, making them a source of subtle test pollution and inconsistent behavior between team members.

**Setting variables dynamically from response data:** After a login request, you often need to store the returned token for subsequent requests. Use a test script to extract it automatically:

```javascript
// In the Tests tab of your login request:
const json = pm.response.json();
pm.environment.set("token", json.access_token);
// Now {{token}} is populated for all subsequent requests in this session
```

#### Collections

A Collection is a saved, organized set of requests grouped into folders. Collections serve three purposes in DevOps workflows:

1. **Team documentation** — a living, runnable record of every API endpoint, with example payloads and expected responses. More reliable than wiki docs that go stale.
2. **Automated regression testing** — every request can have test scripts (JavaScript) that assert status codes, response shape, and values. Run the whole collection with a single click or via the CLI runner.
3. **Onboarding** — a new team member imports the collection and environment, sets their token, and can immediately call every API without reading documentation first.

#### Writing Tests in Postman

Postman's test scripts run after each response. They use a JavaScript assertion library (`pm.test`, `pm.expect`) built into the Postman sandbox.

```javascript
// Assert status code
pm.test("Status is 201", () => {
  pm.response.to.have.status(201);
});

// Assert response body shape
pm.test("Response has an id field", () => {
  const json = pm.response.json();
  pm.expect(json).to.have.property("id");
  pm.expect(json.id).to.be.a("number");
});

// Assert a specific header is present
pm.test("Location header is set", () => {
  pm.response.to.have.header("Location");
});

// Assert response time is acceptable
pm.test("Response time under 500ms", () => {
  pm.expect(pm.response.responseTime).to.be.below(500);
});
```

**Running collections in CI:** Export a collection and environment as JSON, then run them with Newman (Postman's CLI runner):

```bash
# Install Newman
npm install -g newman

# Run collection against staging, output JUnit XML for CI reporting
newman run my-api-collection.json \
  --environment staging.postman_environment.json \
  --reporters cli,junit \
  --reporter-junit-export results.xml
```

This integrates Postman collections directly into Jenkins, GitHub Actions, or GitLab CI pipelines — the same requests your team uses for manual testing become your automated API regression suite.

---

## Examples

### Example 1: Querying the GitHub API with curl

This example demonstrates authentication, reading response headers for rate-limit awareness, and extracting specific fields with `jq`.

```bash
# Store your token in an environment variable — never hardcode tokens
export GITHUB_TOKEN="ghp_your_personal_access_token"

# List repositories for an org, extract just names and visibility
curl -fsSL \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/orgs/hashicorp/repos?type=public&per_page=5" \
  | jq '.[] | {name, visibility, language, stargazers_count}'

# Verify it worked: you should see a JSON array of repo objects
# Expected output (truncated):
# {
#   "name": "terraform",
#   "visibility": "public",
#   "language": "Go",
#   "stargazers_count": 40123
# }

# Check rate limit headers before running bulk operations
curl -fsSI \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/rate_limit \
  | grep -i "x-ratelimit"
# X-RateLimit-Limit: 5000
# X-RateLimit-Remaining: 4987
# X-RateLimit-Reset: 1716700000

# Convert the reset timestamp to a human-readable time (macOS/Linux)
date -d @1716700000   # Linux
date -r 1716700000    # macOS
```

### Example 2: Creating and Updating a Resource (Full CRUD Cycle)

This example uses the public JSONPlaceholder API (no auth required) to demonstrate POST, GET, PATCH, and DELETE in sequence.

```bash
BASE="https://jsonplaceholder.typicode.com"

# 1. CREATE — POST returns 201 and the new object with an assigned id
NEW_POST=$(curl -fsS -X POST "$BASE/posts" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "DevOps API Testing",
    "body": "curl is the best debugging tool",
    "userId": 1
  }')
echo "$NEW_POST" | jq .
# Capture the id for subsequent requests
POST_ID=$(echo "$NEW_POST" | jq -r '.id')
echo "Created post with id: $POST_ID"

# 2. READ — GET the resource we just created
curl -fsS "$BASE/posts/$POST_ID" | jq '{id, title}'

# 3. PARTIAL UPDATE — PATCH only the title, leave body unchanged
curl -fsS -X PATCH "$BASE/posts/$POST_ID" \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title"}' \
  | jq '{id, title, body}'
# body should still be present — PATCH does not remove fields you did not send

# 4. DELETE — expect 200 with empty body {} from JSONPlaceholder
STATUS=$(curl -fsS -o /dev/null -w "%{http_code}" \
  -X DELETE "$BASE/posts/$POST_ID")
echo "Delete status: $STATUS"
# Should print: Delete status: 200
```

### Example 3: Triggering a GitHub Actions Workflow Dispatch via API

This is a realistic DevOps scenario: triggering a deployment pipeline from a script, then polling to confirm it started.

```bash
export GITHUB_TOKEN="ghp_your_personal_access_token"
OWNER="my-org"
REPO="my-app"
WORKFLOW="deploy.yml"
REF="main"

# Trigger the workflow with an input parameter
RESPONSE=$(curl -fsS -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/$OWNER/$REPO/actions/workflows/$WORKFLOW/dispatches" \
  -d "{\"ref\": \"$REF\", \"inputs\": {\"environment\": \"staging\"}}")

# workflow_dispatch returns 204 No Content on success — empty body
# If $RESPONSE is empty and exit code was 0, the trigger succeeded
echo "Trigger exit code: $?"

# Poll for the most recently created run to confirm it started
# Wait a few seconds for GitHub to register the run
sleep 5

curl -fsS \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/$OWNER/$REPO/actions/runs?event=workflow_dispatch&per_page=1" \
  | jq '.workflow_runs[0] | {id, status, conclusion, created_at, head_branch}'
# Expected:
# {
#   "id": 9876543210,
#   "status": "queued",
#   "conclusion": null,
#   "created_at": "2024-05-26T10:00:00Z",
#   "head_branch": "main"
# }
```

### Example 4: Using Postman Collection Runner in CI with Newman

This example shows the full setup: a Postman collection that tests a health endpoint and a create-user flow, exported and run in a GitHub Actions pipeline.

```yaml
# .github/workflows/api-tests.yml
name: API Integration Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  api-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Newman
        run: npm install -g newman newman-reporter-htmlextra

      - name: Run Postman Collection (Staging)
        env:
          API_TOKEN: ${{ secrets.STAGING_API_TOKEN }}
        run: |
          # Inject the secret token into the environment file at runtime
          # so the token is never stored in the exported environment JSON
          cat postman/staging.environment.json \
            | jq --arg token "$API_TOKEN" \
              '(.values[] | select(.key == "token")).value = $token' \
            > /tmp/staging-injected.json

          newman run postman/api-tests.collection.json \
            --environment /tmp/staging-injected.json \
            --reporters cli,junit,htmlextra \
            --reporter-junit-export results/junit.xml \
            --reporter-htmlextra-export results/report.html \
            --bail  # stop collection run on first test failure

      - name: Upload Test Results
        if: always()   # upload even if tests failed
        uses: actions/upload-artifact@v4
        with:
          name: api-test-results
          path: results/
```

```
# Postman collection test script on the POST /users request:
pm.test("User created with correct role", () => {
  pm.response.to.have.status(201);
  const json = pm.response.json();
  pm.expect(json.role).to.eql("admin");
  pm.environment.set("created_user_id", json.id);  // pass id to next request
});
```

---

## Exercises

### Exercise 1: Diagnose a Failing API Call

The following `curl` command is broken in two ways. Without running it first, identify both bugs. Then fix it and confirm it returns a `200` with a JSON body.

```bash
curl -X GET https://jsonplaceholder.typicode.com/posts/1
  -H 'Content-Type: application/json'
  -H 'Accept: text/html'
  -d '{"limit": 10}'
```

**What to find:**
- Why is the `Accept` header wrong for a JSON API?
- Why is a request body on a `GET` semantically incorrect?
- Why will this command fail before even reaching the server?
- Write the corrected command and pipe the response through `jq` to extract only the `title` field.

---

### Exercise 2: Inspect Rate-Limit Headers and Handle `429`

Call the GitHub public API in a loop and write a script that gracefully handles rate limiting.

```bash
# Starting point — run this and observe what happens after many calls
for i in $(seq 1 10); do
  curl -s https://api.github.com/repos/torvalds/linux | jq '.stargazers_count'
done
```

**Your task:**
1. Modify the loop to capture the HTTP status code separately from the body.
2. If the status code is `429` or `403` (GitHub uses `403` for rate limits on unauthenticated requests), read the `X-RateLimit-Reset` header, calculate how many seconds until reset, sleep that long, then retry the request.
3. Add a `X-Request-ID` header with a unique UUID to each request (use `uuidgen` or `cat /proc/sys/kernel/random/uuid`).

---

### Exercise 3: Build and Test a Postman Collection

Using Postman with the JSONPlaceholder API (`https://jsonplaceholder.typicode.com`):

1. Create an environment with a variable `base_url = https://jsonplaceholder.typicode.com`.
2. Build a collection with three requests in order:
   - `POST /posts` — create a post, extract the `id` from the response and save it to an environment variable `post_id` in the Tests tab.
   - `GET /posts/{{post_id}}` — fetch the post you just created; assert the status is `200` and the `id` matches `{{post_id}}`.
   - `DELETE /posts/{{post_id}}` — delete it; assert the status is `200`.
3. Write a test on the `POST` request that fails if the response time exceeds `1000ms`.
4. Export the collection and environment as JSON files. Verify you can run the exported collection with `newman run` from the terminal.

---

### Exercise 4: Debug a `403` vs `401` in the Wild

Use the GitHub API to explore the difference between unauthenticated and unauthorized requests.

```bash
# Request 1 — no token
curl -sI https://api.github.com/user

# Request 2 — invalid token
curl -sI -H "Authorization: Bearer invalidtoken123" https://api.github.com/user

# Request 3 — valid token but accessing a private resource you do not own
# (substitute a real org name you are not a member of)
curl -sI \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/orgs/some-private-org/members
```

**Your task:**
1. Run all three requests and record the status code and the `WWW-Authenticate` or `X-GitHub-Media-Type` response headers.
2. Write a one-paragraph explanation of why each request failed differently, referencing the specific HTTP semantics of `401` vs `403`.
3. Write a `curl` command that correctly authenticates and retrieves your own user profile (`GET /user`), then extracts your `login`, `public_repos`, and `created_at` fields using `jq`.
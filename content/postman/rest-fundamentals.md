---
title: REST API Fundamentals
module: postman
duration_min: 20
difficulty: beginner
tags: [postman, rest, http, api, request, response, headers, status-codes, curl]
exercises: 4
---

## Overview
REST (Representational State Transfer) is the dominant API style for web services. Understanding the HTTP request/response model — methods, status codes, headers, and body formats — is prerequisite knowledge for everything in DevOps that involves an API, which is almost everything. This lesson covers the protocol fundamentals and how to explore APIs with both curl and Postman.

## Concepts

### HTTP Request Anatomy
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

Parts:
- **Method** — what action to perform (GET, POST, PUT, PATCH, DELETE)
- **Path** — which resource (`/api/users`, `/api/users/123`)
- **Headers** — metadata about the request (auth, content type, client info)
- **Body** — data sent with the request (POST/PUT/PATCH only)
- **Query params** — filters/options in the URL (`/api/users?role=admin&limit=10`)

### HTTP Methods
| Method | Meaning | Has Body | Idempotent |
|---|---|---|---|
| GET | Read a resource | No | Yes |
| POST | Create a resource | Yes | No |
| PUT | Replace a resource (full update) | Yes | Yes |
| PATCH | Partial update | Yes | No |
| DELETE | Delete a resource | No | Yes |
| HEAD | Like GET, headers only | No | Yes |
| OPTIONS | Describe what methods are allowed | No | Yes |

**Idempotent** means calling it multiple times has the same effect as calling it once. `PUT /users/1` with the same body = same result. `POST /users` creates a new user each time.

### HTTP Status Codes
```
1xx — Informational
  100 Continue

2xx — Success
  200 OK                 — request succeeded, body contains result
  201 Created            — resource was created (POST), Location header has URL
  204 No Content         — success, no body (DELETE, PUT with no response)

3xx — Redirection
  301 Moved Permanently  — URL changed permanently
  304 Not Modified       — cached version is still fresh (ETag/Last-Modified)

4xx — Client Errors
  400 Bad Request        — malformed request, invalid JSON, missing required field
  401 Unauthorized       — not authenticated (no or invalid token)
  403 Forbidden          — authenticated but not authorized for this resource
  404 Not Found          — resource doesn't exist
  409 Conflict           — resource already exists, or state conflict
  422 Unprocessable      — valid format but semantic validation failed
  429 Too Many Requests  — rate limited

5xx — Server Errors
  500 Internal Server Error — unhandled exception, bug in the server
  502 Bad Gateway           — upstream service is down
  503 Service Unavailable   — server temporarily overloaded or in maintenance
  504 Gateway Timeout       — upstream service took too long
```

### Important Headers
```
Request headers:
  Authorization: Bearer <token>         — authentication
  Content-Type: application/json        — format of the request body
  Accept: application/json              — formats the client accepts
  X-Request-ID: <uuid>                  — trace requests through logs
  If-None-Match: "<etag>"               — conditional GET (caching)

Response headers:
  Content-Type: application/json        — format of the response body
  Location: /api/users/123              — URL of newly created resource (201)
  X-RateLimit-Remaining: 95            — how many requests left in the window
  X-RateLimit-Reset: 1716700000        — Unix timestamp when limit resets
  ETag: "abc123"                        — version identifier for caching
  Cache-Control: max-age=3600          — how long to cache the response
```

### curl Fundamentals
```bash
# GET request
curl https://api.example.com/users

# With headers and pretty-printed JSON
curl -s https://api.example.com/users | jq .

# GET with auth header and query params
curl -H "Authorization: Bearer $TOKEN" \
     "https://api.example.com/users?role=admin&limit=10"

# POST with JSON body
curl -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "Alex", "email": "alex@example.com"}'

# PATCH (partial update)
curl -X PATCH https://api.example.com/users/123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role": "viewer"}'

# DELETE
curl -X DELETE https://api.example.com/users/123 \
  -H "Authorization: Bearer $TOKEN"

# Show response headers
curl -I https://api.example.com/health       # HEAD request (headers only)
curl -v https://api.example.com/health       # verbose (request + response headers + body)
curl -D - https://api.example.com/health     # headers to stdout, body to stdout

# Timing breakdown
curl -w "\nDNS: %{time_namelookup}s\nConnect: %{time_connect}s\nTTFB: %{time_starttransfer}s\nTotal: %{time_total}s\n" \
  -o /dev/null -s https://api.example.com/health
```

### Postman Basics

#### Making Requests
1. **New Request** — set method, URL, headers, body
2. **Authorization tab** — set Bearer Token, Basic Auth, API Key — Postman injects the header automatically
3. **Body tab** — select `raw → JSON` for JSON bodies; Postman sets `Content-Type: application/json` automatically
4. **Params tab** — add query parameters without editing the URL manually
5. **Send** — execute the request; see response status, body, headers, timing

#### Reading Responses
- **Status code** — top right of response panel, color-coded
- **Body** — Pretty / Raw / Preview tabs; Pretty auto-formats JSON
- **Headers** — all response headers
- **Cookies** — any Set-Cookie headers
- **Test Results** — output of test scripts (covered in the Automated Tests lesson)

### REST Resource Design
```
# Resources are nouns, methods are verbs:
GET    /users           — list users
POST   /users           — create a user
GET    /users/123       — get user 123
PUT    /users/123       — replace user 123
PATCH  /users/123       — partial update user 123
DELETE /users/123       — delete user 123

GET    /users/123/posts          — get posts for user 123
POST   /users/123/posts          — create a post for user 123
DELETE /users/123/posts/456      — delete post 456 of user 123

# Query params for filtering, sorting, pagination:
GET /users?role=admin&limit=20&offset=40&sort=created_at:desc
```

## Examples

### Exploring a Public API with curl
```bash
# GitHub API — no auth needed for public repos
# Get a repo's recent commits
curl -s https://api.github.com/repos/torvalds/linux/commits?per_page=3 \
  | jq '.[].commit | {message: .message, author: .author.name, date: .author.date}'

# Check rate limit headers
curl -sI https://api.github.com/repos/torvalds/linux \
  | grep -i x-ratelimit

# Authenticated request (higher rate limits)
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/user | jq '{login, name, public_repos}'
```

## Exercises

1. Use curl to make a GET request to `https://api.github.com/repos/torvalds/linux`. Extract just `name`, `stargazers_count`, and `open_issues_count` using `jq`. Then use curl's `-w` flag to measure DNS resolution time, connection time, and TTFB.
2. Create a Postman request to the GitHub REST API. Set the `Authorization` header to a personal access token. Make a GET to `/user` and verify you can see your profile. Make a POST to create a new gist.
3. Use curl to make a request and intentionally trigger each of these status codes against a test API: 400 (send a malformed body), 401 (omit auth), 404 (non-existent resource), 429 (hit rate limit by looping). Document what response body each returns.
4. Use the curl timing format to compare response times for the same endpoint across 5 requests. Calculate the average TTFB. Then add `If-None-Match` with the `ETag` from the first response and verify you get a `304 Not Modified`.

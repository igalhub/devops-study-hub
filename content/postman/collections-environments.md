---
title: Collections and Environments
module: postman
duration_min: 20
difficulty: intermediate
tags: [postman, collections, environments, variables, pre-request, scripts, workflows]
exercises: 4
---

## Overview
Collections organize related API requests into a folder hierarchy with shared configuration. Environments let you switch between dev/staging/prod with a single dropdown — same collection, different base URLs and credentials. Together they eliminate copy-paste errors, make API docs executable, and form the foundation for automated testing. Pre-request scripts let you generate tokens, timestamps, and signatures dynamically before each request.

## Concepts

### Collections
A collection is a named group of API requests that share:
- Base URL (via collection variable or environment)
- Auth configuration (set at collection level, inherited by all requests)
- Pre-request scripts (run before every request in the collection)
- Test scripts (run after every request)
- Documentation

**Organize by resource or workflow:**
```
MyApp API (collection)
├── Auth
│   ├── POST /auth/login
│   └── POST /auth/refresh
├── Users
│   ├── GET /users
│   ├── POST /users
│   ├── GET /users/:id
│   ├── PATCH /users/:id
│   └── DELETE /users/:id
├── Orders
│   ├── GET /orders
│   └── POST /orders
└── Workflows
    └── Create User → Create Order → Verify
```

### Variables
Variables let you parameterize requests. Four scopes, in precedence order (highest first):

```
Local     — set in a script, available only during current request
Data      — from a CSV/JSON file in collection runs
Environment — tied to the active environment (dev, staging, prod)
Collection — stored on the collection, available to all requests in it
Global    — available across all collections (avoid — use collection vars instead)
```

```
Reference syntax: {{base_url}}/api/users/{{user_id}}
```

#### Setting Variables in Scripts
```javascript
// Pre-request script — set a variable before the request runs
pm.environment.set("timestamp", new Date().toISOString());
pm.environment.set("nonce", Math.random().toString(36).substring(2));

// Test script — extract a value from the response and save it
const json = pm.response.json();
pm.environment.set("access_token", json.access_token);
pm.environment.set("user_id", json.user.id);
```

### Environments
An environment is a set of key-value pairs. Switching the active environment changes all `{{variable}}` references in your collection simultaneously.

**Typical environment setup:**
```
Development:
  base_url = http://localhost:8000
  api_key  = dev-key-abc123
  user_id  = (initially empty — filled by login script)

Staging:
  base_url = https://staging.api.myapp.com
  api_key  = staging-key-xyz789
  user_id  = (initially empty)

Production:
  base_url = https://api.myapp.com
  api_key  = (use Postman Vault for secrets, not plain env vars)
  user_id  = (initially empty)
```

Sensitive values (real API keys, passwords) should use **Postman Vault** (secrets) rather than environment variables — vault values are never synced to Postman's cloud.

### Auth Configuration
Set auth at the collection level so all requests inherit it:

**Collection → Authorization tab:**
```
Type: Bearer Token
Token: {{access_token}}
```

Requests inherit this auth unless they override it. One token rotation in the collection updates everything.

**OAuth 2.0 flow (configured in Postman):**
```
Grant Type: Authorization Code
Auth URL: https://auth.myapp.com/oauth/authorize
Access Token URL: https://auth.myapp.com/oauth/token
Client ID: {{client_id}}
Client Secret: {{client_secret}}
Scope: read:users write:users
```

Click "Get New Access Token" — Postman opens a browser, you authenticate, and the token is stored automatically.

### Pre-Request Scripts
Pre-request scripts execute before the request is sent. Use them for:
- Generating authentication signatures/timestamps
- Refreshing expired tokens
- Setting dynamic headers

```javascript
// Auto-refresh an expired JWT before each request
const tokenExpiry = pm.environment.get("token_expiry");
const now = Math.floor(Date.now() / 1000);

if (!tokenExpiry || now >= parseInt(tokenExpiry) - 60) {
    // Token is expired or expires in < 60 seconds — refresh it
    pm.sendRequest({
        url: pm.environment.get("base_url") + "/auth/refresh",
        method: "POST",
        header: { "Content-Type": "application/json" },
        body: {
            mode: "raw",
            raw: JSON.stringify({
                refresh_token: pm.environment.get("refresh_token")
            })
        }
    }, (err, response) => {
        const json = response.json();
        pm.environment.set("access_token", json.access_token);
        pm.environment.set("token_expiry", json.expires_at);
    });
}
```

```javascript
// HMAC signature for an API that requires request signing
const crypto = require('crypto-js');

const timestamp = Date.now().toString();
const body = pm.request.body ? pm.request.body.raw : '';
const secret = pm.environment.get("api_secret");

const signature = crypto.HmacSHA256(timestamp + body, secret).toString();

pm.request.headers.add({ key: "X-Timestamp", value: timestamp });
pm.request.headers.add({ key: "X-Signature", value: signature });
```

### Chaining Requests
Use test scripts to pass data from one request to the next:

```javascript
// Request 1: POST /auth/login
// Test script:
const json = pm.response.json();
pm.environment.set("access_token", json.access_token);
pm.environment.set("user_id", json.user.id);

// Request 2: POST /orders (uses {{user_id}} in body)
// Body:
{
  "user_id": "{{user_id}}",
  "items": [{"product_id": "prod_123", "quantity": 2}]
}

// Request 2 test script:
const order = pm.response.json();
pm.environment.set("order_id", order.id);

// Request 3: GET /orders/{{order_id}}
// Uses the order_id set by Request 2
```

### Collection Runner
Run an entire collection (or folder) in sequence:
1. **Run collection** button → Collection Runner opens
2. Select environment
3. Set iteration count and delay
4. Optionally upload a data file (CSV/JSON) for data-driven runs
5. Click **Run** — each request executes in order, test results aggregated

```javascript
// In a test script: control flow
// Skip to a specific request
postman.setNextRequest("GET /users/:id");

// Stop the collection run
postman.setNextRequest(null);
```

### Importing and Exporting
```bash
# Export collection as JSON
# File → Export → Collection v2.1 → myapp-api.postman_collection.json

# Import from OpenAPI spec
# Import → Upload Files → select openapi.yaml
# Postman generates requests from the spec automatically

# Import from curl command
# Import → Raw Text → paste curl command
# Postman converts it to a Postman request
```

Exporting a collection to JSON and committing it to Git makes the API documentation versioned and executable.

## Examples

### Login → Use Token Pattern
```javascript
// Collection pre-request script — ensure we always have a valid token
const token = pm.environment.get("access_token");
const expiry = pm.environment.get("token_expiry");

if (!token || Date.now() / 1000 >= parseInt(expiry || 0)) {
    pm.sendRequest({
        url: pm.variables.get("base_url") + "/auth/login",
        method: "POST",
        header: [{ key: "Content-Type", value: "application/json" }],
        body: {
            mode: "raw",
            raw: JSON.stringify({
                username: pm.environment.get("username"),
                password: pm.environment.get("password")
            })
        }
    }, (err, res) => {
        if (!err && res.code === 200) {
            const data = res.json();
            pm.environment.set("access_token", data.token);
            pm.environment.set("token_expiry", Math.floor(Date.now() / 1000) + 3600);
        }
    });
}
```

## Exercises

1. Create a Postman collection for a public API (GitHub or JSONPlaceholder). Set `{{base_url}}` as a collection variable. Create two environments (local and production) with different base URLs. Verify switching environments changes all requests without editing them.
2. Write a pre-request script on a collection that: checks if `access_token` is set and less than 30 seconds from expiry; if so, calls the refresh endpoint and updates the environment variable. Test by artificially setting a past expiry timestamp.
3. Chain three requests: (1) POST to create a user, saving the `id` from the response; (2) POST to create an order for that user, using `{{user_id}}`; (3) GET the order by the `id` from step 2. Verify the full chain works end-to-end in the Collection Runner.
4. Export your collection to a JSON file. Write a README explaining the variables that need to be set before running. Commit both to a git repo. Import the collection from the file on a fresh Postman install and verify it works.


---

### Quick Checks

5. Count environment variables in a stub file. Run: `printf 'base_url=https://api.example.com\napi_key=secret123\ntimeout=30\nenv=prod\n' | wc -l`

```expected_output
4
```

hint: Think about how you can count the number of lines produced by a command's output.
hint: Use the pipe operator to send the output of printf into wc -l, which counts newline characters.

6. Extract the base URL from an environment variable file. Run: `printf 'base_url=https://api.example.com\napi_key=secret123\n' | awk -F= '/^base_url/{print $2}'`

```expected_output
https://api.example.com
```

hint: Think about how you can filter lines in a stream by a specific key name and then extract the value after a delimiter.
hint: Use awk with -F= to set the equals sign as the field separator, then match lines starting with your target key using a regex anchor like /^base_url/ and print the second field with $2.

---
title: Automated API Tests
module: postman
duration_min: 20
difficulty: intermediate
tags: [postman, newman, testing, assertions, ci, contract-testing, api-testing]
exercises: 4
---

## Overview

Postman's test scripts turn manual API exploration into automated regression tests. Every request in a collection can carry JavaScript assertions that run after the response arrives — checking status codes, headers, body shape, field types, and latency. Because these scripts live inside the collection JSON, they travel with the collection into version control, into CI pipelines, and onto other developers' machines without any extra tooling setup. The result is a first-class regression safety net that sits closest to the API surface: it validates what the API actually returns, not what the application code thinks it returns.

Newman is the CLI runner that executes Postman collections outside the GUI — in CI pipelines, on a schedule, or as a deployment gate. A `newman run` command exits with a non-zero code when any test fails, which makes it a natural pipeline step: deploy to staging, run Newman, fail the pipeline if the API has regressed. Newman also supports multiple reporters (CLI, JUnit, HTML) so the same run produces human-readable and machine-readable output simultaneously — one for engineers triaging failures, one for GitHub's test dashboard.

In the broader DevOps toolchain, Postman/Newman sits between deployment and promotion. Unit tests and integration tests run during the build; Newman runs after the app is deployed to a real environment. It can act as a smoke-test gate (did the deployment break anything obvious?), a contract-test gate (does the deployed API still match the OpenAPI spec?), or a regression suite (do all the edge cases still pass?). This placement makes it complementary to, not a replacement for, earlier test layers.

---

## Concepts

### Test Script Basics

Test scripts in Postman run after the response is received. They live in the **Tests** tab of each request and are plain JavaScript executed in a sandboxed V8 environment. The core primitive is `pm.test(name, fn)` — it registers a named test case, and the function body contains one or more `pm.expect()` assertions using a Chai-style API.

```javascript
// Each pm.test() is an independent test case — one failure does not skip others
pm.test("Status code is 200", () => {
    pm.response.to.have.status(200);
});

pm.test("Response time is under 500ms", () => {
    pm.expect(pm.response.responseTime).to.be.below(500);
});

pm.test("Response is JSON", () => {
    pm.response.to.be.json;         // shorthand — checks Content-Type header
});

pm.test("Response has required fields", () => {
    const json = pm.response.json();
    pm.expect(json).to.have.property("id");
    pm.expect(json).to.have.property("email");
    pm.expect(json.email).to.be.a("string").and.include("@");
});
```

**Gotcha:** `pm.response.to.be.json` checks the `Content-Type` header, not whether the body parses as JSON. If your API returns `Content-Type: text/plain` with a JSON body, this check passes the wrong assumption. Use `pm.response.json()` inside a try/catch to verify actual parsability.

**Gotcha:** `pm.test` does not throw — it records pass/fail and continues. If you want one assertion failure to abort the rest of the test function, put all assertions for a single logical unit inside one `pm.test` call.

---

### Status and Response Assertions

Postman exposes response metadata through `pm.response`. The following covers the most commonly needed assertions:

```javascript
// Status code — by number or reason phrase
pm.response.to.have.status(201);
pm.response.to.have.status("Created");
pm.expect(pm.response.code).to.be.oneOf([200, 201]);   // acceptable range

// Headers — existence and value
pm.response.to.have.header("Content-Type");
pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json");
pm.response.to.have.header("Location");
pm.expect(pm.response.headers.get("Location")).to.match(/\/api\/users\/\d+/);

// Cache and security headers — useful for contract hardening
pm.expect(pm.response.headers.get("Cache-Control")).to.include("no-store");
pm.expect(pm.response.headers.get("X-Content-Type-Options")).to.eql("nosniff");

// Timing
pm.expect(pm.response.responseTime).to.be.below(1000);

// Body — raw text contains
pm.response.to.have.body;                                // body is non-empty
pm.expect(pm.response.text()).to.include("success");
```

| Assertion style | When to use |
|---|---|
| `pm.response.to.have.status(200)` | Readability; Chai-BDD style |
| `pm.expect(pm.response.code).to.eql(200)` | When you need to compose or reuse the value |
| `pm.expect(code).to.be.oneOf([200,201])` | Endpoint returns different codes by path |
| `pm.response.to.have.header("X")` | Just checking presence |
| `pm.response.headers.get("X")` | Checking the actual value |

---

### JSON Assertions

JSON response validation is the core of most API test suites. `pm.response.json()` parses the body once; store it in a variable before writing multiple assertions.

```javascript
const json = pm.response.json();

// Type checks
pm.expect(json).to.be.an("object");
pm.expect(json.users).to.be.an("array");
pm.expect(json.users.length).to.be.above(0);
pm.expect(json.users).to.have.lengthOf.above(0);       // equivalent, more readable

// Value checks
pm.expect(json.status).to.eql("active");               // deep equality
pm.expect(json.count).to.be.a("number").and.be.above(0);
pm.expect(json.tags).to.include("admin");              // array includes value
pm.expect(json.created_at).to.match(/^\d{4}-\d{2}-\d{2}T/);  // ISO date format

// Nested fields
pm.expect(json.user.address.country).to.eql("IL");

// Array item validation — fails on first bad item; add label for diagnosis
json.users.forEach((user, index) => {
    pm.expect(user, `users[${index}] missing id`).to.have.property("id");
    pm.expect(user, `users[${index}] missing email`).to.have.property("email");
    pm.expect(user.role, `users[${index}].role invalid`).to.be.oneOf(["admin", "viewer", "editor"]);
});
```

**Schema validation with Ajv (preferred over tv4):** Postman bundles `tv4` for legacy reasons, but `tv4` does not support JSON Schema draft-07+. For `format: "email"`, `nullable`, or `anyOf` you need Ajv, which is also bundled.

```javascript
// Ajv is available as a global in Postman sandbox
const Ajv = require("ajv");
const ajv = new Ajv();

const schema = {
    type: "object",
    required: ["id", "name", "email"],
    properties: {
        id:    { type: "integer", minimum: 1 },
        name:  { type: "string", minLength: 1 },
        email: { type: "string", format: "email" },
        role:  { type: "string", enum: ["admin", "viewer", "editor"] }
    },
    additionalProperties: false   // fail if API adds undocumented fields
};

pm.test("Response matches schema", () => {
    const valid = ajv.validate(schema, pm.response.json());
    pm.expect(valid, ajv.errorsText()).to.be.true;
});
```

**`additionalProperties: false` is a contract decision.** It fails if the API adds new undocumented fields. Enable it when you are writing contract tests; disable it for smoke tests where forward compatibility matters more than strictness.

---

### Error Case Testing

Error path tests are as important as happy-path tests. They verify that the API returns structured error responses (not HTML 500 pages or stack traces), uses the correct status codes, and includes useful error messages.

```javascript
// --- In a request with a missing required field ---

pm.test("Returns 400 for missing email", () => {
    pm.response.to.have.status(400);
});

pm.test("Error body is JSON, not an HTML error page", () => {
    // APIs under frameworks sometimes return HTML on unhandled errors
    pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json");
    const json = pm.response.json();           // will throw if body is not valid JSON
    pm.expect(json).to.have.property("message");
    pm.expect(json.message).to.be.a("string").and.have.length.above(0);
});

pm.test("Error message references the missing field", () => {
    const json = pm.response.json();
    pm.expect(json.message.toLowerCase()).to.include("email");
});

// --- In a request with a duplicate resource ---

pm.test("Returns 409 for duplicate email", () => {
    pm.response.to.have.status(409);
});

pm.test("409 body has error code field", () => {
    const json = pm.response.json();
    pm.expect(json).to.have.property("error_code");
    pm.expect(json.error_code).to.eql("DUPLICATE_EMAIL");
});
```

**Do not test error cases in the same request as success cases.** Create a dedicated folder in your collection (e.g., `Error Cases / POST /users`) where each request is pre-configured with the bad input. This makes the collection self-documenting and lets Newman run error suites in isolation.

---

### Variables, Pre-request Scripts, and Chaining Requests

Real API test suites need to chain requests — create a resource, then verify it, then delete it. Postman's variable scopes and pre-request scripts make this possible.

| Scope | Set with | Read with | Lifetime |
|---|---|---|---|
| Global | `pm.globals.set()` | `pm.globals.get()` | Until explicitly cleared |
| Environment | `pm.environment.set()` | `pm.environment.get()` | Active environment session |
| Collection | `pm.collectionVariables.set()` | `pm.collectionVariables.get()` | Collection run |
| Local | `pm.variables.set()` | `pm.variables.get()` | Current request only |

```javascript
// In the Tests tab of POST /users — capture the created ID
pm.test("User created successfully", () => {
    pm.response.to.have.status(201);
    const json = pm.response.json();
    pm.expect(json).to.have.property("id");
    // Store for subsequent requests in this run
    pm.collectionVariables.set("created_user_id", json.id);
});

// In the next request (GET /users/{{created_user_id}}) — verify the resource exists
pm.test("Fetched user matches created user", () => {
    const json = pm.response.json();
    pm.expect(json.id).to.eql(pm.collectionVariables.get("created_user_id"));
});
```

**Use `collectionVariables` (not `environment`) for values that are generated during a test run**, like IDs returned from a POST. Environment variables are for config (base URLs, credentials). Mixing them creates a race condition when you run multiple Newman instances against the same environment file.

---

### Test Organisation and Failure Messages

Grouping assertions and labelling them well is the difference between a test output that says "AssertionError: expected 0 to be above 0" and one that says "users[3].id: expected 0 to be above 0".

```javascript
// Use the second argument to pm.expect() as a label — it appears in failure output
pm.test("User object is valid", () => {
    const user = pm.response.json();
    pm.expect(user.id,         "id should be a positive integer").to.be.a("number").above(0);
    pm.expect(user.email,      "email should match RFC format").to.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    pm.expect(user.created_at, "created_at should be ISO 8601").to.match(/^\d{4}-\d{2}-\d{2}T/);
    pm.expect(user.role,       "role should be a known enum value").to.be.oneOf(["admin", "viewer", "editor"]);
});

// Split into multiple pm.test() blocks when the concepts are distinct —
// a failure in one does not mask failures in others
pm.test("Identity fields are present and typed correctly", () => {
    const json = pm.response.json();
    pm.expect(json.id).to.be.a("number").above(0);
    pm.expect(json.email).to.be.a("string");
});

pm.test("Timestamps are ISO 8601", () => {
    const json = pm.response.json();
    pm.expect(json.created_at).to.match(/^\d{4}-\d{2}-\d{2}T/);
    pm.expect(json.updated_at).to.match(/^\d{4}-\d{2}-\d{2}T/);
});
```

---

### Newman — CLI Runner

Newman executes a collection JSON file from the command line. It exits `0` on all-pass, non-zero on any failure — making it suitable as a CI gate.

```bash
# Install globally (or as a local devDependency — prefer local in CI)
npm install -g newman
npm install -g newman-reporter-htmlextra   # richer HTML output

# Minimal run
newman run myapp-api.postman_collection.json

# With environment file (staging config: base_url, api_key, etc.)
newman run myapp-api.postman_collection.json \
  -e staging.postman_environment.json

# Override a single env variable at runtime — useful for feature branch URLs
newman run myapp-api.postman_collection.json \
  -e staging.postman_environment.json \
  --env-var "base_url=https://pr-142.staging.myapp.com"

# Multiple reporters: CLI for terminal, JUnit for CI, HTML for humans
newman run myapp-api.postman_collection.json \
  -e staging.postman_environment.json \
  --reporters cli,junit,htmlextra \
  --reporter-junit-export results/newman.xml \
  --reporter-htmlextra-export results/report.html

# Run only a specific folder (e.g., smoke tests)
newman run myapp-api.postman_collection.json \
  --folder "Smoke Tests"

# Data-driven: iterate each row of a CSV as a separate variable set
newman run myapp-api.postman_collection.json \
  -d test-users.csv \
  --iteration-count 5

# Stop on first failure — useful as a deployment gate
newman run myapp-api.postman_collection.json \
  -e staging.postman_environment.json \
  --bail

# Check exit code explicitly in shell scripts
newman run myapp-api.postman_collection.json -e staging.postman_environment.json
if [ $? -ne 0 ]; then
  echo "API tests failed — blocking promotion" && exit 1
fi
```

| Newman flag | Purpose |
|---|---|
| `-e` | Environment file |
| `-d` | Data file (CSV or JSON) for data-driven runs |
| `--folder` | Run only a named folder |
| `--env-var` | Override a single variable at runtime |
| `--bail` | Stop after first test failure |
| `--timeout-request` | Per-request timeout in ms |
| `--iteration-count` | How many times to iterate the collection |
| `--reporters` | Comma-separated list: `cli`, `junit`, `htmlextra` |

**Newman does not save variable changes back to the environment file.** Variables set with `pm.environment.set()` during a run live only in that run's memory. If you need to pass a value (like an auth token) between a `newman run` and a subsequent step, write it to a file from within the test script using the `pm.sendRequest` + file tricks, or use a pre-request script that fetches a fresh token at startup.

---

### Newman in CI (GitHub Actions)

```yaml
# .github/workflows/api-tests.yml
name: API regression tests

on:
  push:
    branches: [main, staging]
  workflow_dispatch:          # allow manual trigger

jobs:
  api-tests:
    runs-on: ubuntu-24.04
    needs: deploy             # gate: run after deployment completes

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Newman and reporters
        # Install locally so the version is pinned via package.json
        run: |
          npm ci
          # Or globally if no package.json:
          # npm install -g newman newman-reporter-htmlextra

      - name: Run API tests
        run: |
          npx newman run postman/myapp-api.postman_collection.json \
            -e postman/staging.postman_environment.json \
            --env-var "base_url=${{ vars.STAGING_URL }}" \
            --reporters cli,junit,htmlextra \
            --reporter-junit-export results/newman.xml \
            --reporter-htmlextra-export results/report.html \
            --timeout-request 5000 \
            --bail
        # Non-zero exit from Newman will fail this step and the job

      - name: Publish JUnit results to GitHub test dashboard
        uses: mikepenz/action-junit-report@v4
        if: always()          # report even when tests fail
        with:
          report_paths: results/newman.xml
          check_name: "Newman API Tests"

      - name: Upload HTML report as artifact
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: newman-report-${{ github.run_id }}
          path: results/report.html
          retention-days: 14
```

**`if: always()` on reporting steps is mandatory.** Without it, GitHub Actions skips the upload/publish steps when Newman exits non-zero, which means the test report is unavailable precisely when you need it most.

---

### API Contract Testing

Contract testing verifies that a deployed API conforms to its OpenAPI specification. It catches the class of bug where the implementation drifts from the documented contract — a renamed field, a dropped required property, a changed type.

```bash
# portman generates a Postman collection with contract tests from an OpenAPI spec
npm install -g @apideck/portman

portman \
  --oasFile openapi.yaml \
  --localPostmanCollection myapp.postman_collection.json \
  --cliOptionsFile portman-config.yml

# Run the generated contract collection
newman run myapp.postman_collection.json \
  -e staging.postman_environment.json
```

Manual contract test using Ajv — embed this in any request to gate the deployed schema:

```javascript
// This pattern is useful for endpoints not covered by portman
const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true });   // report all violations, not just the first

const userListSchema = {
    type: "array",
    items: {
        type: "object",
        required: ["id", "name", "email"],
        properties: {
            id:    { type: "integer", minimum: 1 },
            name:  { type: "string",  minLength: 1 },
            email: { type: "string" }
        },
        additionalProperties: false   // strict: undocumented fields fail the contract
    }
};

pm.test("GET /users response matches OpenAPI schema", () => {
    const valid = ajv.validate(userListSchema, pm.response.json());
    // ajv.errorsText() gives a human-readable list of all violations
    pm.expect(valid, ajv.errorsText()).to.be.true;
});
```

**Contract tests and smoke tests have different tolerances for `additionalProperties`.** Smoke tests should be lenient (allow new fields — they are non-breaking additions). Contract tests should be strict (fail on undocumented fields — they indicate spec drift). Maintain separate folders or collections for each mode.

---

### Performance Baselines

Postman test scripts can track response time trends across runs by persisting a rolling average in environment variables.

```javascript
// Assert against a fixed SLA — simplest form
pm.test("Response time within SLA (300ms)", () => {
    pm.expect(pm.response.responseTime).to.be.below(300);
});

// Assert against a dynamic baseline — detects regressions relative to history
pm.test("Response time has not regressed by more than 50%", () => {
    const baseline = pm.environment.get("baseline_response_time");
    if (baseline) {
        // 1.5× the rolling average is the regression threshold
        const threshold = parseInt(baseline) * 1.5;
        pm.expect(pm.response.responseTime,
            `Regression: ${pm.response.responseTime}ms vs baseline ${baseline}ms`)
            .to.be.below(threshold);
    }
});

// Update the rolling average (last 10 samples) — runs regardless of the test above
(function updateBaseline() {
    const raw = pm.environment.get("response_time_samples") || "[]";
    const samples = JSON.parse(raw);
    samples.push(pm.response.responseTime);
    if (samples.length > 10) samples.shift();   // keep window at 10
    const avg = Math.ceil(samples.reduce((a, b) => a + b, 0) / samples.length);
    pm.environment.set("response_time_samples", JSON.stringify(samples));
    pm.environment.set("baseline_response_time", avg);
})();
```

**Performance tests in Newman are not load tests.** Newman sends one request at a time. Use these checks to catch a 10× regression (e.g., an N+1 query introduced in a deployment), not to measure throughput under concurrency. For load testing, use k6 or Gatling.

---

## Examples

### Example 1: Full CRUD Test Suite for `/api/users`

**Setup:** Export a Postman collection with four requests in a folder named `Users CRUD`: `POST /users`, `GET /users/:id`, `PUT /users/:id`, `DELETE /users/:id`. Each request references `{{base_url}}` from the environment file.

**staging.postman_environment.json:**
```json
{
  "id": "env-staging",
  "name": "staging",
  "values": [
    { "key": "base_url", "value": "https://staging.myapp.com", "enabled": true },
    { "key": "api_key",  "value": "test-api-key-abc123",         "enabled": true }
  ]
}
```

**POST /users — Tests tab:**
```javascript
pm.test("201 Created", () => pm.response.to.have.status(201));

pm.test("Location header points to new resource", () => {
    pm.response.to.have.header("Location");
    pm.expect(pm.response.headers.get("Location")).to.match(/\/api\/users\/\d+/);
});

pm.test("Response body has id, name, email", () => {
    const json = pm.response.json();
    pm.expect(json.id).to.be.a("number").above(0);
    pm.expect(json.name).to.be.a("string").and.have.length.above(0);
    pm.expect(json.email).to.include("@");
    // Persist for downstream requests
    pm.collectionVariables.set("user_id", json.id);
    pm.collectionVariables.set("user_email", json.email);
});
```

**GET /users/{{user_id}} — Tests tab:**
```javascript
pm.test("200 OK and email matches created user", () => {
    pm.response.to.have.status(200);
    const json = pm.response.json();
    pm.expect(json.email).to.eql(pm.collectionVariables.get("user_email"));
});
```

**DELETE /users/{{user_id}} — Tests tab:**
```javascript
pm.test("204 No Content on delete", () => pm.response.to.have.status(204));
pm.test("Body is empty after delete", () => {
    pm.expect(pm.response.text()).to.have.lengthOf(0);
});
```

**Run it:**
```bash
newman run users-crud.postman_collection.json \
  -e staging.postman_environment.json \
  --reporters cli,junit \
  --reporter-junit-export results/users-crud.xml

# Verify: exit 0 = all pass
echo "Exit code: $?"
```

---

### Example 2: Error Case Collection for `POST /users`

**Setup:** A folder named `POST /users — Error Cases` with three requests, each with a different malformed body pre-configured.

**Request 1: Missing email — Tests tab:**
```javascript
pm.test("400 for missing email", () => pm.response.to.have.status(400));
pm.test("Error body is JSON with message field referencing email", () => {
    pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json");
    const json = pm.response.json();
    pm.expect(json.message).to.be.a("string").and.include("email");
});
```

**Request 2: Duplicate email — Tests tab:**
```javascript
pm.test("409 Conflict for duplicate email", () => pm.response.to.have.status(409));
pm.test("error_code is DUPLICATE_EMAIL", () => {
    pm.expect(pm.response.json().error_code).to.eql("DUPLICATE_EMAIL");
});
```

**Request 3: Malformed JSON body — Tests tab:**
```javascript
pm.test("400 for unparseable body", () => pm.response.to.have.status(400));
pm.test("Response is JSON even for malformed input", () => {
    pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json");
});
```

**Run only error cases:**
```bash
newman run users-api.postman_collection.json \
  -e staging.postman_environment.json \
  --folder "POST /users — Error Cases" \
  --reporters cli
```

---

### Example 3: Data-Driven Login Tests with a CSV

**test-credentials.csv:**
```csv
username,password,expected_status
admin@myapp.com,correct-password,200
admin@myapp.com,wrong-password,401
nonexistent@myapp.com,any-password,401
admin@myapp.com,,400
```

**POST /auth/login — Tests tab:**
```javascript
// pm.iterationData accesses the current CSV row
pm.test(`Status is ${pm.iterationData.get("expected_status")}`, () => {
    pm.response.to.have.status(parseInt(pm.iterationData.get("expected_status")));
});

// Only validate token presence on expected 200s
if (pm.iterationData.get("expected_status") === "200") {
    pm.test("Token is returned on successful login", () => {
        const json = pm.response.json();
        pm.expect(json).to.have.property("token");
        pm.expect(json.token).to.be.a("string").and.have.length.above(10);
    });
}
```

**Run:**
```bash
newman run auth.postman_collection.json \
  -e staging.postman_environment.json \
  -d test-credentials.csv \
  --reporters cli,htmlextra \
  --reporter-htmlextra-export results/auth-report.html
```

**Verify:** The HTML report shows 4 iterations. The 200 row shows the token assertion; the others skip it.

---

### Example 4: Newman as a Deployment Gate in GitHub Actions

```yaml
# .github/workflows/deploy-and-test.yml
name: Deploy to staging and run API tests

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: ./scripts/deploy.sh staging
        env:
          DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}

  api-tests:
    runs-on: ubuntu-24.04
    needs: deploy     # only run after successful deploy

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Newman
        run: npm install -g newman newman-reporter-htmlextra

      - name: Run smoke tests
        run: |
          newman run postman/myapp-api.postman_collection.json \
            -e postman/staging.postman_environment.json \
            --env-var "base_url=${{ vars.STAGING_URL }}" \
            --folder "Smoke Tests" \
            --reporters cli,junit,htmlextra \
            --reporter-junit-export results/smoke.xml \
            --reporter-htmlextra-export results/smoke-report.html \
            --timeout-request 5000 \
            --bail
        # newman exits non-zero on failure → job fails → no promotion

      - name: Publish test results
        uses: mikepenz/action-junit-report@v4
        if: always()
        with:
          report_paths: results/smoke.xml
          check_name: "Staging API Smoke Tests"
          fail_on_failure: true   # mark the check as failed in the PR UI

      - name: Upload HTML report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: smoke-report-${{ github.run_id }}
          path: results/smoke-report.html
          retention-days: 7
```

**Verify it worked:**
- A passing run: the `api-tests` job is green; the JUnit check appears in the PR; the artifact is downloadable.
- A failing run: Newman exits non-zero; the job is red; the JUnit check shows which tests failed; the HTML artifact is still uploaded (`if: always()`).

---

## Exercises

**Exercise 1: Write a full test script for `POST /users`**

Using a real or mock API (e.g., `https://jsonplaceholder.typicode.com/users` or a locally running service), write a Postman test script that asserts all of the following without copy-pasting directly from the Concepts section:
- Status code is 201 (or 200 if using JSONPlaceholder which returns 201 for POST)
- `Content-Type` header includes `application/json`
- Response body contains `id` (positive integer), `name` (non-empty string), and `email` (contains `@`)
- Response time is under 800ms
- Save the returned `id` to a collection variable named `created_id`

Run the request in the Postman GUI and confirm all tests pass in the test results panel.

---

**Exercise 2: Test error paths for `POST /users`**

Create two additional requests in the same collection that test error cases:
1. Send a POST body missing the `email` field. Assert: status is 400, body is JSON, body contains a `message` field that is a non-empty string.
2. Send a POST with an invalid `email` format (e.g., `"email": "notanemail"`). Assert: status is 400 or 422, and the response is not an HTML page (check `Content-Type`).

Then write a one-line explanation of *why* you test for `Content-Type: application/json` on error responses, not just on success responses.

---

**Exercise 3: Run a collection with Newman and inspect the exit code**

1. Export your collection and environment from Postman to JSON files.
2. Install Newman globally: `npm install -g newman`
3. Run the collection against your environment. Observe the CLI output — note where pass/fail counts appear.
4. Intentionally break one assertion (e.g., change `below(800)` to `below(1)`). Re-export and re-run. Confirm the exit code is non-zero: `echo $?`
5. Add `--reporters cli,junit --reporter-junit-export results/test.xml` and inspect the generated XML. Find the `<testcase>` element for the failing test.

**Goal:** understand what Newman's exit code means for CI pipelines and what the JUnit XML looks like.

---

**Exercise 4: Add Newman to a GitHub Actions workflow**

Given an existing workflow file that has a `deploy` job, add an `api-tests` job that:
1. Depends on `deploy` using `needs`
2. Installs Newman
3. Runs your collection with the JUnit reporter, outputting to `results/api.xml`
4. Publishes results with `mikepenz/action-junit-report@v4` using `if: always()`
5. Uploads the XML as an artifact using `actions/upload-artifact@v4` using `if: always()`

Push a commit that intentionally fails a test (e.g., assert a field name that does not exist). Verify in the GitHub Actions UI that: the job is red, the test report appears in the PR checks tab, and the artifact is still present despite the failure.

---

### Quick Checks

6. Count test assertions in a Postman script stub. Run: `printf 'pm.test("Status 200", fn1);\npm.test("Has id", fn2);\npm.test("Content-Type", fn3);\n' | grep -c 'pm.test'`

```expected_output
3
```

hint: Think about how you can search for a specific pattern in text and count how many lines match it directly.
hint: Use grep with the -c flag, which counts matching lines instead of printing them, to find occurrences of 'pm.test' in the piped input.

7. Extract the expected status code from a test snippet. Run: `echo 'pm.response.to.have.status(201);' | sed 's/.*status(\([0-9]*\)).*/\1/'`

```expected_output
201
```

hint: Think about how you can use a stream editor to search for a pattern and extract just a portion of the matched text.
hint: Use sed with a capturing group in the regex — the pattern \([0-9]*\) captures the digits inside status(), and \1 in the replacement refers back to that captured group.

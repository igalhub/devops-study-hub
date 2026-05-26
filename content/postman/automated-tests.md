---
title: Automated API Tests
module: postman
duration_min: 20
difficulty: intermediate
tags: [postman, newman, testing, assertions, ci, contract-testing, api-testing]
exercises: 4
---

## Overview
Postman's test scripts turn manual API exploration into automated regression tests. Newman is the CLI runner that executes Postman collections outside the GUI — in CI pipelines, on a schedule, or as part of a deployment gate. A well-tested API collection catches breaking changes before they reach production: endpoint URLs that moved, response fields that were renamed, status codes that changed, or performance that degraded.

## Concepts

### Test Script Basics
Test scripts run after the response is received. They live in the **Tests** tab of each request.

```javascript
// Basic structure — pm.test wraps each assertion
pm.test("Status code is 200", () => {
    pm.response.to.have.status(200);
});

pm.test("Response time is under 500ms", () => {
    pm.expect(pm.response.responseTime).to.be.below(500);
});

pm.test("Response is JSON", () => {
    pm.response.to.be.json;
});

pm.test("Response has required fields", () => {
    const json = pm.response.json();
    pm.expect(json).to.have.property("id");
    pm.expect(json).to.have.property("email");
    pm.expect(json.email).to.be.a("string").and.include("@");
});
```

### Status and Response Assertions
```javascript
// Status code
pm.response.to.have.status(201);
pm.response.to.have.status("Created");         // by reason phrase
pm.expect(pm.response.code).to.be.oneOf([200, 201]);

// Headers
pm.response.to.have.header("Content-Type");
pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json");
pm.response.to.have.header("Location");
pm.expect(pm.response.headers.get("Location")).to.match(/\/api\/users\/\d+/);

// Timing
pm.expect(pm.response.responseTime).to.be.below(1000);

// Body — string contains
pm.response.to.have.body;
pm.expect(pm.response.text()).to.include("success");
```

### JSON Assertions
```javascript
const json = pm.response.json();

// Type checks
pm.expect(json).to.be.an("object");
pm.expect(json.users).to.be.an("array");
pm.expect(json.users.length).to.be.above(0);

// Value checks
pm.expect(json.status).to.eql("active");
pm.expect(json.count).to.be.a("number").and.be.above(0);
pm.expect(json.tags).to.include("admin");
pm.expect(json.created_at).to.match(/^\d{4}-\d{2}-\d{2}T/);   // ISO date format

// Nested objects
pm.expect(json.user.address.country).to.eql("IL");

// Array items
json.users.forEach(user => {
    pm.expect(user).to.have.property("id");
    pm.expect(user).to.have.property("email");
    pm.expect(user.role).to.be.oneOf(["admin", "viewer", "editor"]);
});

// Schema validation with Ajv (built into Postman)
const schema = {
    type: "object",
    required: ["id", "name", "email"],
    properties: {
        id: { type: "number" },
        name: { type: "string", minLength: 1 },
        email: { type: "string", format: "email" },
        role: { type: "string", enum: ["admin", "viewer", "editor"] }
    },
    additionalProperties: false
};
pm.expect(tv4.validate(json, schema)).to.be.true;
```

### Error Case Testing
```javascript
// Test 400 — missing required field
pm.test("Returns 400 for missing email", () => {
    pm.response.to.have.status(400);
});

pm.test("Error response has message field", () => {
    const json = pm.response.json();
    pm.expect(json).to.have.property("message");
    pm.expect(json.message).to.include("email");
});

// Test 404 — non-existent resource
pm.test("Returns 404 for unknown user", () => {
    pm.response.to.have.status(404);
});

pm.test("404 body is not an HTML error page", () => {
    pm.response.to.be.json;   // should return JSON, not HTML
});
```

### Test Organisation with Describe Blocks
```javascript
// Group related assertions — helps with failure messages
pm.test("User object is valid", () => {
    const user = pm.response.json();
    pm.expect(user.id, "id should be a positive integer").to.be.a("number").above(0);
    pm.expect(user.email, "email should be a valid email").to.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    pm.expect(user.created_at, "created_at should be an ISO timestamp").to.match(/^\d{4}-\d{2}-\d{2}T/);
    pm.expect(user.role, "role should be a known value").to.be.oneOf(["admin", "viewer", "editor"]);
});
```

### Newman — CLI Runner
```bash
# Install Newman
npm install -g newman

# Run a collection (exported from Postman)
newman run myapp-api.postman_collection.json

# With an environment file
newman run myapp-api.postman_collection.json \
  -e staging.postman_environment.json

# With multiple reporters
newman run myapp-api.postman_collection.json \
  -e staging.postman_environment.json \
  --reporters cli,junit,htmlextra \
  --reporter-junit-export results.xml \
  --reporter-htmlextra-export report.html

# Run a specific folder only
newman run myapp-api.postman_collection.json \
  --folder "Users"

# Set a variable override at runtime
newman run myapp-api.postman_collection.json \
  -e staging.postman_environment.json \
  --env-var "base_url=https://feature-branch.staging.myapp.com"

# Data-driven testing (iterate over a CSV)
newman run myapp-api.postman_collection.json \
  -d test-users.csv \
  --iteration-count 5
```

### Newman in CI (GitHub Actions)
```yaml
jobs:
  api-tests:
    runs-on: ubuntu-24.04
    needs: deploy    # run after deployment

    steps:
      - uses: actions/checkout@v4

      - name: Install Newman
        run: npm install -g newman newman-reporter-htmlextra

      - name: Run API tests
        run: |
          newman run postman/myapp-api.postman_collection.json \
            -e postman/staging.postman_environment.json \
            --env-var "base_url=${{ vars.STAGING_URL }}" \
            --reporters cli,junit,htmlextra \
            --reporter-junit-export results/newman.xml \
            --reporter-htmlextra-export results/report.html \
            --bail   # stop on first failure

      - name: Publish test results
        uses: mikepenz/action-junit-report@v4
        if: always()   # run even if tests fail
        with:
          report_paths: results/newman.xml

      - name: Upload HTML report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: newman-report
          path: results/report.html
```

### API Contract Testing
Contract testing verifies that an API conforms to its documented spec (OpenAPI/Swagger). Postman can generate test suites from an OpenAPI spec:

```bash
# Install portman (OpenAPI → Postman collection with contract tests)
npm install -g @apideck/portman

portman --cliOptionsFile portman-config.yml \
  --localPostmanCollection myapp.postman_collection.json \
  --oasFile openapi.yaml
```

```javascript
// Manual contract test — verify response matches OpenAPI schema
const schema = {
    type: "array",
    items: {
        type: "object",
        required: ["id", "name", "email"],
        properties: {
            id: { type: "integer" },
            name: { type: "string" },
            email: { type: "string" }
        }
    }
};

pm.test("Response matches OpenAPI schema", () => {
    const valid = tv4.validate(pm.response.json(), schema);
    pm.expect(valid, tv4.error ? tv4.error.message : "schema invalid").to.be.true;
});
```

### Performance Baselines
```javascript
// Track response time over time — fail if regression detected
pm.test("Response time within SLA", () => {
    pm.expect(pm.response.responseTime).to.be.below(300);
});

pm.test("Response time regression check", () => {
    const baseline = pm.environment.get("baseline_response_time");
    if (baseline) {
        const threshold = parseInt(baseline) * 1.5;   // 50% regression threshold
        pm.expect(pm.response.responseTime).to.be.below(threshold);
    }
    // Update baseline (rolling average)
    const current = pm.environment.get("response_time_samples") || "[]";
    const samples = JSON.parse(current);
    samples.push(pm.response.responseTime);
    if (samples.length > 10) samples.shift();
    pm.environment.set("response_time_samples", JSON.stringify(samples));
    pm.environment.set("baseline_response_time",
        Math.ceil(samples.reduce((a, b) => a + b, 0) / samples.length));
});
```

## Exercises

1. Write test scripts for a `POST /users` endpoint that verify: status is 201, `Location` header is present and matches `/api/users/\d+`, response body has `id`, `name`, and `email` fields, `id` is a positive integer, and response time is under 500ms.
2. Write test scripts for error cases on the same endpoint: a request missing `email` should return 400 with a JSON body containing a `message` field (not an HTML error page); a duplicate email should return 409.
3. Export a collection with tests to a JSON file. Install Newman and run it from the command line with a staging environment file. Add a `--bail` flag to stop on the first failure. Verify the exit code is non-zero when a test fails.
4. Add a Newman run step to a GitHub Actions workflow that runs after a staging deployment. Publish the JUnit XML results to GitHub's test reporter and upload the HTML report as an artifact. Verify failing tests cause the CI job to fail.

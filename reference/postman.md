# Postman / API Testing — Quick Reference

## Newman CLI

| Command | Description |
|---------|-------------|
| `newman run collection.json` | Run a collection |
| `newman run collection.json -e environment.json` | With environment |
| `newman run collection.json -d data.json` | Data-driven run |
| `newman run collection.json -n 3` | Run 3 iterations |
| `newman run collection.json --bail` | Stop on first failure |
| `newman run collection.json -r html,cli --reporter-html-export report.html` | Generate HTML report |
| `newman run url` | Run from Postman URL |
| `newman run collection.json --timeout 10000` | 10s request timeout |

## Environment & Variables

| Context | Set | Get |
|---------|-----|-----|
| Global | `pm.globals.set("key", val)` | `pm.globals.get("key")` |
| Environment | `pm.environment.set("key", val)` | `pm.environment.get("key")` |
| Collection | `pm.collectionVariables.set("key", val)` | `pm.collectionVariables.get("key")` |
| Local (request) | `pm.variables.set("key", val)` | `pm.variables.get("key")` |

## Pre-request Script Patterns

```javascript
// Set dynamic timestamp
pm.environment.set("timestamp", Date.now());

// Generate random ID
pm.environment.set("userId", Math.floor(Math.random() * 10000));

// Set auth header from env variable
pm.request.headers.add({ key: "Authorization", value: "Bearer " + pm.environment.get("token") });
```

## Test Script Patterns

```javascript
// Status code
pm.test("Status is 200", () => pm.response.to.have.status(200));

// Response time
pm.test("Under 500ms", () => pm.expect(pm.response.responseTime).to.be.below(500));

// Body contains
pm.test("Has id field", () => {
  const body = pm.response.json();
  pm.expect(body).to.have.property("id");
});

// Save token from response
const body = pm.response.json();
pm.environment.set("token", body.access_token);

// Chain requests — set next request
postman.setNextRequest("Get User");

// Skip rest of collection
postman.setNextRequest(null);
```

## Common Assertions

| Assertion | Code |
|-----------|------|
| Status code | `pm.response.to.have.status(200)` |
| Status range | `pm.expect(pm.response.code).to.be.within(200, 299)` |
| Header present | `pm.response.to.have.header("Content-Type")` |
| Header value | `pm.expect(pm.response.headers.get("Content-Type")).to.include("json")` |
| Body string | `pm.expect(pm.response.text()).to.include("success")` |
| JSON field | `pm.expect(pm.response.json().name).to.eql("Alice")` |
| Array length | `pm.expect(pm.response.json().items).to.have.lengthOf(3)` |
| Schema valid | `pm.response.to.have.jsonSchema(schema)` |

## curl Equivalents

| Postman concept | curl equivalent |
|----------------|-----------------|
| GET request | `curl -X GET url` |
| POST JSON | `curl -X POST -H "Content-Type: application/json" -d '{"k":"v"}' url` |
| Auth header | `curl -H "Authorization: Bearer TOKEN" url` |
| Query params | `curl "url?key=val&key2=val2"` |
| Follow redirect | `curl -L url` |
| Verbose | `curl -v url` |

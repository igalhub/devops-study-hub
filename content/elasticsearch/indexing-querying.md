---
title: Indexing & Querying
module: elasticsearch
duration_min: 25
difficulty: intermediate
tags: [elasticsearch, query-dsl, aggregations, bulk-api, search]
exercises: 3
---

## Overview

Writing data into Elasticsearch and retrieving it efficiently are the two most operationally critical skills for anyone working with the ELK stack. A poorly written bulk ingest pipeline can saturate a cluster's indexing thread pool in minutes; a query that runs aggregations on a `text` field instead of a `keyword` field can OOM a node's heap. These are production incidents, not theoretical problems.

This lesson covers the full cycle: creating an index with a correct mapping, indexing documents individually and in bulk, constructing Query DSL queries that match the field types in your mapping, running aggregations, and safely paginating large result sets. All examples use `curl` commands you can run directly against the Docker container started in the Architecture lesson. If you haven't started it yet, run this first:

```bash
docker run -d \
  --name es-dev \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.12.0
```

Verify: `curl -s http://localhost:9200/ | jq .name`

## Setting Up the Practice Index

Before the examples make sense, create the index and seed it with data. Run this entire block:

```bash
# Create the index with explicit mappings
curl -s -X PUT http://localhost:9200/services \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "service_name":  { "type": "keyword" },
      "level":         { "type": "keyword" },
      "message":       { "type": "text" },
      "@timestamp":    { "type": "date", "format": "strict_date_optional_time" },
      "response_time": { "type": "integer" }
    }
  }
}
EOF

# Bulk-index 6 sample documents
curl -s -X POST http://localhost:9200/_bulk \
  -H "Content-Type: application/x-ndjson" \
  -d @- << 'EOF'
{ "index": { "_index": "services", "_id": "svc-001" } }
{ "service_name": "payment-api", "level": "ERROR", "message": "Connection pool exhausted", "@timestamp": "2024-03-15T10:23:00Z", "response_time": 5021 }
{ "index": { "_index": "services", "_id": "svc-002" } }
{ "service_name": "cart-api", "level": "INFO", "message": "Item added to cart", "@timestamp": "2024-03-15T10:24:00Z", "response_time": 45 }
{ "index": { "_index": "services", "_id": "svc-003" } }
{ "service_name": "cart-api", "level": "ERROR", "message": "Redis timeout after 5000ms", "@timestamp": "2024-03-15T10:25:00Z", "response_time": 5000 }
{ "index": { "_index": "services", "_id": "svc-004" } }
{ "service_name": "auth-api", "level": "ERROR", "message": "Database connection timeout", "@timestamp": "2024-03-15T10:26:00Z", "response_time": 3100 }
{ "index": { "_index": "services", "_id": "svc-005" } }
{ "service_name": "auth-api", "level": "INFO", "message": "Token issued successfully", "@timestamp": "2024-03-15T10:27:00Z", "response_time": 12 }
{ "index": { "_index": "services", "_id": "svc-006" } }
{ "service_name": "health-check", "level": "INFO", "message": "All services healthy", "@timestamp": "2024-03-15T10:28:00Z", "response_time": 3 }
EOF
```

Note the `Content-Type: application/x-ndjson` header — the Bulk API requires newline-delimited JSON (NDJSON), not regular JSON. Each line is a complete JSON object. A regular `application/json` Content-Type will cause a parse error.

Verify the documents were indexed:

```bash
curl -s "http://localhost:9200/services/_count" | jq .count
# Expected: 6
```

## Concepts

### Indexing Documents

**Single document — explicit ID (idempotent):**

```bash
curl -s -X PUT http://localhost:9200/services/_doc/svc-007 \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "service_name": "payment-api",
  "level": "WARN",
  "message": "Retry attempt 3 of 5",
  "@timestamp": "2024-03-15T10:30:00Z",
  "response_time": 1200
}
EOF
```

Using `PUT` with an explicit ID is idempotent — running it twice creates the document once. The response contains `"result": "created"` on first run and `"result": "updated"` on subsequent runs (it replaces the full document).

**Single document — auto-generated ID:**

```bash
curl -s -X POST http://localhost:9200/services/_doc \
  -H "Content-Type: application/json" \
  -d '{ "service_name": "api-gateway", "level": "INFO", "message": "Request routed", "@timestamp": "2024-03-15T10:31:00Z", "response_time": 5 }' | jq ._id
```

Elasticsearch generates a base64-encoded UUID as `_id`. Use `POST` when you don't have a meaningful natural key.

**Partial update — patch one field without replacing the document:**

```bash
curl -s -X POST http://localhost:9200/services/_update/svc-007 \
  -H "Content-Type: application/json" \
  -d '{ "doc": { "level": "ERROR" } }' | jq .result
# Expected: "updated"
```

`_update` fetches the current document, merges your `doc` patch into it, and re-indexes the result. This is cheaper than a full replace when the document is large and only one field changed. However, it still causes a reindex internally — there is no in-place mutation in Elasticsearch.

**Upsert — create if missing, update if present:**

```bash
curl -s -X POST http://localhost:9200/services/_update/svc-999 \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "doc": { "service_name": "new-svc", "level": "INFO", "message": "Started", "@timestamp": "2024-03-15T11:00:00Z", "response_time": 0 },
  "doc_as_upsert": true
}
EOF
```

### Bulk API

Single-document requests have per-request HTTP and index-refresh overhead. For bulk ingest — Logstash, Filebeat, custom pipelines — use `_bulk`. The body alternates between an **action line** and an optional **source line** (delete actions have no source).

```bash
curl -s -X POST http://localhost:9200/_bulk \
  -H "Content-Type: application/x-ndjson" \
  -d @- << 'EOF'
{ "index":  { "_index": "services", "_id": "svc-010" } }
{ "service_name": "order-api", "level": "INFO", "message": "Order placed", "@timestamp": "2024-03-15T11:00:00Z", "response_time": 88 }
{ "create": { "_index": "services", "_id": "svc-011" } }
{ "service_name": "order-api", "level": "ERROR", "message": "Payment declined", "@timestamp": "2024-03-15T11:01:00Z", "response_time": 420 }
{ "update": { "_index": "services", "_id": "svc-010" } }
{ "doc": { "level": "WARN" } }
{ "delete": { "_index": "services", "_id": "svc-007" } }
EOF
```

Bulk action types:
- `index` — create or replace (idempotent if `_id` is given)
- `create` — fail with 409 if document with that `_id` already exists
- `update` — partial update (requires a `doc` or `script` in the source line)
- `delete` — no source line needed

**Critical behaviour:** the Bulk API always returns HTTP 200, even if some individual operations failed. You must inspect the response body for `"errors": true` and then iterate the `items` array for per-document `"error"` objects. Never assume success from the HTTP status code alone.

```bash
# Check bulk response for errors
curl -s -X POST http://localhost:9200/_bulk \
  -H "Content-Type: application/x-ndjson" \
  -d '{ "create": { "_index": "services", "_id": "svc-010" } }
{ "service_name": "dupe", "level": "INFO", "message": "This will fail", "@timestamp": "2024-03-15T11:00:00Z", "response_time": 1 }
' | jq '{errors: .errors, first_item_status: .items[0].create.status}'
# Expected: errors: true, status: 409 (document already exists)
```

Tuning guidance:
- Target **5–15 MB** per bulk request body. Measure by counting bytes, not documents.
- Start with **1 worker thread per data node primary shard**, then tune up until throughput plateaus.
- Monitor `_cat/thread_pool/write?v` to see queue depth — if queue is consistently > 0, you're saturating write threads.

### Query DSL

All searches go through `POST /<index>/_search` (GET also works but some clients don't support GET with a body). The request body is JSON using the **Query DSL**.

#### Full-text vs Exact Search

| Query type | Field type | How it works |
|-----------|-----------|--------------|
| `match` | `text` | Analyzes the search term, scores by relevance (BM25) |
| `term` | `keyword` | Exact byte match, no analysis |
| `terms` | `keyword` | Exact match for any value in a list |
| `range` | `date`, numeric | Between/gte/lte comparison |
| `match_phrase` | `text` | Terms must appear in order, no gaps |
| `wildcard` | `keyword` | Glob-style pattern — avoid on large indices |

**`match` query — full-text search on a `text` field:**

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "query": {
    "match": {
      "message": "connection timeout"
    }
  }
}
EOF
```

The `match` query analyzes `"connection timeout"` into tokens `["connection", "timeout"]` and searches for documents containing either term. Documents with both tokens score higher. This is why `match` is appropriate for human-language queries on `text` fields — it handles tokenization, lowercasing, and stemming.

**`term` query — exact match on a `keyword` field:**

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d '{ "query": { "term": { "level": "ERROR" } } }' | jq '.hits.total.value'
# Expected: 3 (svc-001, svc-003, svc-004)
```

Do **not** use `match` on `keyword` fields for exact filtering — it will still work (both use the same analyzer for keyword by default: none), but `term` is semantically correct and clearer. More importantly: never use `term` on a `text` field — `text` fields are tokenized, so the raw value `"Connection pool exhausted"` is not stored; searching for it with `term` returns zero results.

**`range` query — timestamp-based:**

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "query": {
    "range": {
      "@timestamp": {
        "gte": "2024-03-15T10:25:00Z",
        "lte": "2024-03-15T10:28:00Z"
      }
    }
  },
  "_source": ["service_name", "level", "@timestamp"]
}
EOF
```

The `_source` field controls which fields are returned. Use it to reduce response size — especially important when documents are large.

For live data you can use math expressions: `"gte": "now-1h"` means one hour ago at query time. The `now` keyword always refers to the time on the coordinating node, not the ingest time.

#### Bool Query

The `bool` query is the standard way to combine multiple conditions. It has four clause types with different semantics:

| Clause | Scores | Must match |
|--------|--------|-----------|
| `must` | Yes | Yes — document must satisfy all `must` clauses |
| `should` | Yes | No — boosts score when matched |
| `filter` | No (cached) | Yes — like `must` but result is cached as a bitset |
| `must_not` | No | Document must **not** match — cached |

Use `filter` for any condition that does not affect relevance ranking (status codes, date ranges, term matches). `filter` results are cached at the segment level, making repeated filters near-instant on warm caches.

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "query": {
    "bool": {
      "filter": [
        { "term":  { "level": "ERROR" } },
        { "range": { "@timestamp": { "gte": "2024-03-15T10:00:00Z" } } }
      ],
      "must": [
        { "match": { "message": "timeout" } }
      ],
      "must_not": [
        { "term": { "service_name": "health-check" } }
      ]
    }
  }
}
EOF
```

Walk through this query:
1. `filter` narrows to ERROR-level documents created after 10:00 — these two filters hit the cache on repeated calls.
2. `must` further narrows to documents whose `message` field contains "timeout" (analyzed); documents matching this score higher based on BM25 term frequency.
3. `must_not` excludes the health-check service entirely, even if it had errors with "timeout" in the message.

Result: `svc-003` (Redis timeout) and `svc-004` (Database connection timeout) — two ERROR docs with "timeout" in message, not from health-check.

### Aggregations

Aggregations run alongside queries and process **field data** — the pre-loaded, doc-values representation of keyword and numeric fields. They do **not** affect the returned hits array. Set `"size": 0` to suppress hits when you only care about aggregations.

The critical rule: aggregations require fields that have doc values enabled. By default, `keyword`, numeric, `date`, `boolean`, and `ip` fields have doc values. **`text` fields do not** — running a `terms` aggregation on a `text` field fails unless you enable `fielddata: true` on the mapping, which loads the inverted index into heap and is expensive. The solution is to use the `.keyword` sub-field.

#### Terms Aggregation — count by unique value

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "aggs": {
    "errors_by_service": {
      "terms": { "field": "service_name", "size": 10 }
    }
  }
}
EOF
```

Response structure to understand:

```json
{
  "aggregations": {
    "errors_by_service": {
      "buckets": [
        { "key": "auth-api",    "doc_count": 2 },
        { "key": "cart-api",    "doc_count": 2 },
        { "key": "health-check","doc_count": 1 },
        { "key": "payment-api", "doc_count": 1 }
      ]
    }
  }
}
```

`key` is the field value; `doc_count` is how many documents matched. The `size: 10` in the agg limits how many buckets to return — it does not limit which documents are processed.

#### Date Histogram — event volume over time

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "query": { "term": { "level": "ERROR" } },
  "aggs": {
    "errors_over_time": {
      "date_histogram": {
        "field": "@timestamp",
        "calendar_interval": "1h"
      }
    }
  }
}
EOF
```

`calendar_interval` values: `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`. Use `fixed_interval` (e.g. `"5m"`, `"30m"`) when you need exact durations that don't vary with DST or month lengths.

#### Metric Aggregations

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "aggs": {
    "avg_response_time": { "avg":   { "field": "response_time" } },
    "response_stats":    { "stats": { "field": "response_time" } }
  }
}
EOF
```

`stats` returns `count`, `min`, `max`, `avg`, and `sum` in a single pass — prefer it over running five separate aggregations.

#### Nested (sub-)aggregations — percentiles per service

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "aggs": {
    "by_service": {
      "terms": { "field": "service_name" },
      "aggs": {
        "p95_latency": {
          "percentiles": { "field": "response_time", "percents": [50, 95, 99] }
        }
      }
    }
  }
}
EOF
```

Sub-aggregations run within the scope of each parent bucket. Here, for every unique `service_name`, Elasticsearch computes the p50, p95, and p99 response time. This is the pattern that powers Kibana dashboards.

### Pagination

#### `from` / `size` — simple offset pagination

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d '{ "from": 0, "size": 2, "sort": [{ "@timestamp": "asc" }], "query": { "match_all": {} } }' | jq '.hits.hits[]._source.service_name'
```

Works fine up to `from + size = 10,000` (the `index.max_result_window` default). Beyond that, Elasticsearch refuses the request. It is also expensive at deep pages: every shard must fetch `from + size` documents and ship them to the coordinating node, which then discards all but `size` of them. At page 500 with size 20, you're shipping 10,020 documents per shard across the network.

#### `search_after` — cursor-based pagination (recommended)

```bash
# First page — no search_after, must have a sort
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 2,
  "sort": [{ "@timestamp": "asc" }, { "_id": "asc" }],
  "query": { "match_all": {} }
}
EOF
```

From the response, grab the `sort` array from the **last hit** — this is your cursor for the next page:

```json
{
  "hits": {
    "hits": [
      { "_id": "svc-001", "sort": ["2024-03-15T10:23:00.000Z", "svc-001"] },
      { "_id": "svc-002", "sort": ["2024-03-15T10:24:00.000Z", "svc-002"] }
    ]
  }
}
```

Pass those `sort` values as `search_after` in the next request:

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 2,
  "sort": [{ "@timestamp": "asc" }, { "_id": "asc" }],
  "search_after": ["2024-03-15T10:24:00.000Z", "svc-002"],
  "query": { "match_all": {} }
}
EOF
```

The `_id` field as a secondary sort key guarantees a stable tie-breaker. Without a tie-breaker, two documents with the same timestamp create an ambiguous boundary and you may miss documents or see duplicates across pages.

`search_after` does not accumulate state on the server — it is stateless. This means there is no cleanup required but it also means if new documents are indexed between pages, you may see them appear in or disappear from later pages.

#### Point in Time (PIT) — consistent view across pages

For a fully consistent snapshot while the index is actively changing:

```bash
# 1. Open a PIT — returns a PIT ID
PIT_ID=$(curl -s -X POST "http://localhost:9200/services/_pit?keep_alive=5m" | jq -r .id)
echo "PIT ID: $PIT_ID"

# 2. First page — note: use /_search without index name when using PIT
curl -s -X GET http://localhost:9200/_search \
  -H "Content-Type: application/json" \
  -d @- << EOF
{
  "size": 2,
  "pit": { "id": "$PIT_ID", "keep_alive": "5m" },
  "sort": [{ "@timestamp": "asc" }, { "_id": "asc" }],
  "query": { "match_all": {} }
}
EOF

# 3. Close the PIT when done (frees server-side resources)
curl -s -X DELETE http://localhost:9200/_pit \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$PIT_ID\"}" | jq .
```

A PIT holds a frozen view of the index segments. Documents indexed after the PIT was opened are invisible to it. Keep-alive must be renewed with each request or the PIT expires.

### Explain API — debugging why a document was or wasn't returned

```bash
curl -s -X GET http://localhost:9200/services/_explain/svc-003 \
  -H "Content-Type: application/json" \
  -d '{ "query": { "match": { "message": "timeout" } } }' | jq '{matched: .matched, explanation: .explanation.description}'
```

The response shows the BM25 scoring breakdown: term frequency in the document, inverse document frequency across the index, and field-length normalization. When a document is not returned and you expect it to be, use `_explain` to see exactly which clause failed and why.

## Worked Example — Investigating a Spike in 500 Errors

Scenario: alerting fires for elevated 5xx rate. You need to identify which service, which endpoint, and when the spike started.

```bash
# Step 1 — Count errors by service in the last 2 hours with 5-minute buckets
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        { "term":  { "level": "ERROR" } },
        { "range": { "@timestamp": { "gte": "now-2h" } } }
      ]
    }
  },
  "aggs": {
    "by_service": {
      "terms": { "field": "service_name", "size": 20 },
      "aggs": {
        "over_time": {
          "date_histogram": {
            "field": "@timestamp",
            "fixed_interval": "5m"
          }
        },
        "avg_latency": { "avg": { "field": "response_time" } }
      }
    }
  }
}
EOF
```

Step 2 — once you've identified the service, pull raw log lines for context:

```bash
SERVICE="payment-api"
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << EOF
{
  "size": 20,
  "sort": [{ "@timestamp": "desc" }],
  "query": {
    "bool": {
      "filter": [
        { "term": { "service_name": "$SERVICE" } },
        { "term": { "level": "ERROR" } }
      ]
    }
  },
  "_source": ["@timestamp", "message", "response_time"]
}
EOF
```

## Exercises

### Exercise 1 — Create, Index, and Query k8s-events

**Part A — Create the index with explicit mappings:**

```bash
curl -s -X PUT http://localhost:9200/k8s-events \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "pod_name":    { "type": "keyword" },
      "namespace":   { "type": "keyword" },
      "event_type":  { "type": "keyword" },
      "reason":      { "type": "keyword" },
      "message":     { "type": "text" },
      "@timestamp":  { "type": "date", "format": "strict_date_optional_time" }
    }
  }
}
EOF
```

**Part B — Index 10 documents using the Bulk API:**

```bash
curl -s -X POST http://localhost:9200/_bulk \
  -H "Content-Type: application/x-ndjson" \
  -d @- << 'EOF'
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "frontend-abc12", "namespace": "production", "event_type": "Warning", "reason": "OOMKilled", "message": "Container killed: OOMKilled, memory limit exceeded", "@timestamp": "2024-03-15T09:00:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "frontend-def34", "namespace": "production", "event_type": "Warning", "reason": "OOMKilled", "message": "Pod evicted: OOMKilled due to memory pressure", "@timestamp": "2024-03-15T09:10:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "backend-ghi56", "namespace": "staging", "event_type": "Warning", "reason": "BackOff", "message": "Back-off restarting failed container", "@timestamp": "2024-03-15T09:20:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "backend-jkl78", "namespace": "production", "event_type": "Normal", "reason": "Pulled", "message": "Successfully pulled image nginx:1.25", "@timestamp": "2024-03-15T09:30:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "worker-mno90", "namespace": "production", "event_type": "Warning", "reason": "FailedScheduling", "message": "Insufficient memory: 0/3 nodes available", "@timestamp": "2024-03-15T10:00:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "worker-pqr11", "namespace": "production", "event_type": "Warning", "reason": "OOMKilled", "message": "Container main was OOMKilled, restarting", "@timestamp": "2024-03-15T10:10:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "cache-stu22", "namespace": "staging", "event_type": "Normal", "reason": "Started", "message": "Container started successfully", "@timestamp": "2024-03-15T10:20:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "db-vwx33", "namespace": "production", "event_type": "Warning", "reason": "BackOff", "message": "Back-off restarting failed database container", "@timestamp": "2024-03-15T10:30:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "proxy-yza44", "namespace": "production", "event_type": "Normal", "reason": "Scheduled", "message": "Successfully assigned pod to node worker-1", "@timestamp": "2024-03-15T10:40:00Z" }
{ "index": { "_index": "k8s-events" } }
{ "pod_name": "api-bcd55", "namespace": "production", "event_type": "Warning", "reason": "OOMKilled", "message": "OOMKilled: container exceeded memory limit 512Mi", "@timestamp": "2024-03-15T10:50:00Z" }
EOF
```

**Part C — Write the bool query:**

```bash
curl -s -X GET http://localhost:9200/k8s-events/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "query": {
    "bool": {
      "filter": [
        { "term":  { "event_type": "Warning" } },
        { "term":  { "namespace": "production" } },
        { "range": { "@timestamp": { "gte": "now-48h" } } }
      ],
      "must": [
        { "match": { "message": "OOMKilled" } }
      ]
    }
  },
  "_source": ["pod_name", "reason", "message", "@timestamp"]
}
EOF
```

Expected: documents svc-001, svc-002, svc-006, svc-010 (all Warning + production + OOMKilled in message). The `match` query on `message` handles variations in how "OOMKilled" appears in the text.

### Exercise 2 — Aggregations on k8s-events

Write a single query that returns both (a) a `terms` aggregation counting events by `reason`, and (b) a `date_histogram` with `1h` intervals showing event volume over the last 7 days:

```bash
curl -s -X GET http://localhost:9200/k8s-events/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "query": {
    "range": { "@timestamp": { "gte": "now-7d" } }
  },
  "aggs": {
    "events_by_reason": {
      "terms": { "field": "reason", "size": 20 }
    },
    "events_over_time": {
      "date_histogram": {
        "field": "@timestamp",
        "calendar_interval": "1h",
        "min_doc_count": 0
      }
    }
  }
}
EOF
```

`min_doc_count: 0` in the date histogram makes Elasticsearch return buckets for hours with zero events — useful for detecting gaps in log ingestion.

**Why keyword vs text matters for aggregations:** The `reason` field is mapped as `keyword`. If it were mapped as `text`, this `terms` aggregation would fail with an error like `"fielddata is disabled on text fields by default"`. The `reason` field stores values like `"OOMKilled"` and `"BackOff"` that are single tokens anyway — `keyword` is the correct type. If you had a field that needed both full-text search and aggregation, you'd use a multi-field mapping: `"type": "text"` with a `"fields": { "keyword": { "type": "keyword" } }` sub-field, then aggregate on `reason.keyword`.

### Exercise 3 — search_after Pagination Loop

You have 50,000 documents in `k8s-events` and need to export all of them in sorted order. Here is a bash script implementing `search_after` pagination with page size 1,000:

```bash
#!/bin/bash
PAGE_SIZE=1000
TOTAL_FETCHED=0
LAST_SORT=""
OUTPUT_FILE="k8s-events-export.ndjson"

> "$OUTPUT_FILE"   # empty the file

while true; do
  if [ -z "$LAST_SORT" ]; then
    # First page — no search_after
    RESPONSE=$(curl -s -X GET http://localhost:9200/k8s-events/_search \
      -H "Content-Type: application/json" \
      -d @- << EOF
{
  "size": $PAGE_SIZE,
  "sort": [{ "@timestamp": "asc" }, { "_id": "asc" }],
  "query": { "match_all": {} }
}
EOF
    )
  else
    # Subsequent pages — pass sort values from last hit
    RESPONSE=$(curl -s -X GET http://localhost:9200/k8s-events/_search \
      -H "Content-Type: application/json" \
      -d @- << EOF
{
  "size": $PAGE_SIZE,
  "sort": [{ "@timestamp": "asc" }, { "_id": "asc" }],
  "search_after": $LAST_SORT,
  "query": { "match_all": {} }
}
EOF
    )
  fi

  # Count hits in this page
  HIT_COUNT=$(echo "$RESPONSE" | jq '.hits.hits | length')

  if [ "$HIT_COUNT" -eq 0 ]; then
    echo "Done. Total exported: $TOTAL_FETCHED"
    break
  fi

  # Write hits to output file
  echo "$RESPONSE" | jq -c '.hits.hits[]._source' >> "$OUTPUT_FILE"

  # Extract sort array from last hit for next page
  LAST_SORT=$(echo "$RESPONSE" | jq -c '.hits.hits[-1].sort')

  TOTAL_FETCHED=$((TOTAL_FETCHED + HIT_COUNT))
  echo "Fetched $HIT_COUNT docs (total: $TOTAL_FETCHED), last sort: $LAST_SORT"
done
```

**Why `from/size` is unsuitable for this use case:**

`from/size` at depth 50,000 with size 1,000 means `from=49000, size=1000`. Every shard must collect and return 50,000 documents to the coordinating node (to correctly rank them all), which then discards 49,000. With 3 shards you're materializing 150,000 document references in memory just to get 1,000 results. This is the **deep pagination problem** — memory and CPU cost grows linearly with page depth. Elasticsearch enforces `max_result_window=10,000` by default precisely to prevent this from happening accidentally.

`search_after` instead uses the sort values as a seek pointer into each shard's sorted data structure. Each page fetch reads only `size` documents per shard regardless of how deep into the result set you are. Constant cost per page.

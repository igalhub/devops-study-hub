---
title: Indexing & Querying
module: elasticsearch
duration_min: 25
difficulty: intermediate
tags: [elasticsearch, query-dsl, aggregations, bulk-api, search]
exercises: 3
---

## Overview
Writing data into Elasticsearch and retrieving it efficiently are the two most operationally critical skills. Knowing how to bulk-index without overwhelming a cluster, how to construct Query DSL queries that actually use mappings correctly, and how to paginate large result sets safely are all common production pain points — and frequent interview questions for DevOps and SRE roles that work with the ELK stack.

## Concepts

### Indexing Documents

**Single document — explicit ID:**
```bash
PUT /services/_doc/svc-001
{
  "service_name": "payment-api",
  "level": "ERROR",
  "message": "Connection pool exhausted",
  "@timestamp": "2024-03-15T10:23:00Z",
  "response_time": 5021
}
```

**Single document — auto-generated ID (POST):**
```bash
POST /services/_doc
{
  "service_name": "auth-api",
  "level": "INFO",
  "message": "Token issued",
  "@timestamp": "2024-03-15T10:24:00Z"
}
```

**Partial update with `_update`:**
```bash
POST /services/_update/svc-001
{
  "doc": { "level": "WARN" }
}
```

Use `PUT` when you control the document ID (idempotent upserts). Use `POST` when you want Elasticsearch to generate IDs. Use `_update` to patch a single field without reindexing the whole document.

### Bulk API

Single-document requests have per-request HTTP overhead. For bulk ingest — Logstash, Beats, custom pipelines — use `_bulk`. The body alternates between an **action line** and an optional **source line**.

```bash
POST /_bulk
{ "index": { "_index": "services", "_id": "svc-002" } }
{ "service_name": "cart-api", "level": "INFO", "message": "Item added", "@timestamp": "2024-03-15T10:25:00Z" }
{ "index": { "_index": "services", "_id": "svc-003" } }
{ "service_name": "cart-api", "level": "ERROR", "message": "Redis timeout", "@timestamp": "2024-03-15T10:26:00Z" }
{ "delete": { "_index": "services", "_id": "svc-001" } }
```

Bulk action types: `index` (create or replace), `create` (fail if exists), `update` (partial), `delete`.

Tuning guidance:
- Target **5–15 MB** per bulk request body.
- Use **parallel workers** — one per data node shard primary as a starting point.
- Watch `_bulk` response for per-item `errors: true` — bulk never returns a non-200 HTTP status for document-level errors.

### Query DSL

All searches go through `POST /<index>/_search`. The request body is a JSON query using the **Query DSL**.

#### Full-text vs Exact Search

| Query type | Field type | How it works |
|-----------|-----------|--------------|
| `match` | `text` | Analyzes the search term, scores by relevance |
| `term` | `keyword` | Exact byte match, no analysis |
| `terms` | `keyword` | Exact match for any value in a list |
| `range` | `date`, numeric | Between/gte/lte comparison |
| `match_phrase` | `text` | Terms must appear in order |
| `wildcard` | `keyword` | Glob-style pattern (expensive — avoid on large indices) |

**`match` query — full-text:**
```bash
GET /services/_search
{
  "query": {
    "match": {
      "message": "connection pool exhausted"
    }
  }
}
```

**`term` query — exact match:**
```bash
GET /services/_search
{
  "query": {
    "term": {
      "level": "ERROR"
    }
  }
}
```

**`range` query — last hour:**
```bash
GET /services/_search
{
  "query": {
    "range": {
      "@timestamp": {
        "gte": "now-1h",
        "lte": "now"
      }
    }
  }
}
```

#### Bool Query

The `bool` query is the workhorse. It combines clauses with different semantics:

| Clause | Scoring | Must match |
|--------|---------|-----------|
| `must` | Yes | Yes |
| `should` | Yes | No (boosts score) |
| `filter` | No (cached) | Yes |
| `must_not` | No | Must not match |

Use `filter` whenever you do not need relevance scoring — it is faster because Elasticsearch caches bitsets for filter results.

```bash
GET /services/_search
{
  "query": {
    "bool": {
      "filter": [
        { "term":  { "level": "ERROR" } },
        { "range": { "@timestamp": { "gte": "now-24h" } } }
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
```

### Aggregations

Aggregations run alongside queries and do not affect the returned hits. They operate on **field data** — keyword and numeric fields. Running aggregations on `text` fields requires `fielddata: true` (heap-expensive — avoid it).

#### Terms Aggregation
```bash
GET /services/_search
{
  "size": 0,
  "aggs": {
    "errors_by_service": {
      "terms": { "field": "service_name", "size": 10 }
    }
  }
}
```

#### Date Histogram
```bash
GET /services/_search
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
```

#### Metric Aggregations — avg, stats
```bash
GET /services/_search
{
  "size": 0,
  "aggs": {
    "avg_response_time": { "avg":   { "field": "response_time" } },
    "response_stats":    { "stats": { "field": "response_time" } }
  }
}
```

`stats` returns `count`, `min`, `max`, `avg`, and `sum` in one pass.

#### Nested (sub-)aggregations
```bash
GET /services/_search
{
  "size": 0,
  "aggs": {
    "by_service": {
      "terms": { "field": "service_name" },
      "aggs": {
        "p95_latency": {
          "percentiles": { "field": "response_time", "percents": [95] }
        }
      }
    }
  }
}
```

### Pagination

#### `from` / `size` (default)
```bash
GET /services/_search
{
  "from": 0,
  "size": 20,
  "query": { "match_all": {} }
}
```

Works fine up to `from + size = 10 000` (the `index.max_result_window` default). Beyond that, Elasticsearch refuses the request. Also expensive at deep pages because every shard fetches `from + size` docs and the coordinator discards most of them.

#### `search_after` (recommended for deep pagination)
```bash
# First page
GET /services/_search
{
  "size": 20,
  "sort": [{ "@timestamp": "desc" }, { "_id": "asc" }],
  "query": { "match_all": {} }
}

# Next page — pass sort values from the last hit
GET /services/_search
{
  "size": 20,
  "sort": [{ "@timestamp": "desc" }, { "_id": "asc" }],
  "search_after": ["2024-03-15T10:26:00Z", "svc-003"],
  "query": { "match_all": {} }
}
```

`search_after` uses a live cursor — no heap accumulation, no `max_result_window` limit. The sort must include a tie-breaker (usually `_id` or a unique field) to guarantee stable ordering.

#### Point in Time (PIT)
Combine with `search_after` for a consistent view while the index is changing:
```bash
POST /services/_pit?keep_alive=5m
# Returns: { "id": "46ToAwMDaWQy..." }

GET /_search
{
  "pit": { "id": "46ToAwMDaWQy...", "keep_alive": "5m" },
  "sort": [{ "@timestamp": "desc" }],
  "search_after": ["2024-03-15T10:26:00Z"]
}
```

### Explain API

When a document does not appear in search results or you need to understand scoring:

```bash
GET /services/_explain/svc-002
{
  "query": {
    "match": { "message": "timeout" }
  }
}
```

The response shows the TF-IDF/BM25 breakdown and exactly which clauses matched or failed. Essential for debugging relevance issues.

## Examples

### Investigating a Spike in 500 Errors

Scenario: alerting fires for elevated 5xx rate. You need to find which service, which endpoint, and when the spike started.

```bash
# Count errors by service in the last 2 hours
GET /logs-*/_search
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        { "term":  { "http.status_code": 500 } },
        { "range": { "@timestamp": { "gte": "now-2h" } } }
      ]
    }
  },
  "aggs": {
    "by_service": {
      "terms": { "field": "service_name", "size": 20 },
      "aggs": {
        "over_time": {
          "date_histogram": { "field": "@timestamp", "fixed_interval": "5m" }
        }
      }
    }
  }
}
```

This gives you a per-service breakdown with 5-minute buckets — enough to pinpoint onset time and blast radius without loading raw log lines.

## Exercises

1. Index 10 documents into an index named `k8s-events` representing Kubernetes pod events. Fields: `pod_name` (keyword), `namespace` (keyword), `event_type` (keyword — `Normal` or `Warning`), `reason` (keyword), `message` (text), `@timestamp` (date). Then write a `bool` query that returns only `Warning` events from the `production` namespace in the last 48 hours containing the word "OOMKilled" in the message.

2. Write an aggregation query against `k8s-events` that produces: (a) a `terms` aggregation counting events by `reason`, and (b) a `date_histogram` with `1h` intervals showing event volume over the last 7 days. Set `size: 0` so no raw hits are returned. Explain the difference between running this on a `keyword` field vs a `text` field.

3. You have 50 000 documents in `k8s-events` and need to export all of them in sorted order. Implement `search_after` pagination with a page size of 1 000, sorted by `@timestamp` descending and `_id` ascending. Write pseudocode (or a bash `curl` loop) that collects all pages and explain why `from/size` is unsuitable for this use case.

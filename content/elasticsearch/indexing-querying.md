---
title: Indexing & Querying
module: elasticsearch
duration_min: 25
difficulty: intermediate
tags: [elasticsearch, query-dsl, aggregations, bulk-api, search]
exercises: 3
---

## Overview

Writing data into Elasticsearch and retrieving it efficiently are the two most operationally critical skills for anyone working with the ELK stack. A poorly written bulk ingest pipeline can saturate a cluster's indexing thread pool in minutes; a query that runs aggregations on a `text` field instead of a `keyword` field can OOM a node's heap. These are production incidents, not theoretical problems — and they almost always trace back to misunderstanding either the mapping of a field or the semantics of a query type.

Elasticsearch is built on Apache Lucene. Every index is divided into shards, each shard is a self-contained Lucene index, and each Lucene index is composed of immutable segments. When you index a document, it lands in an in-memory buffer, gets flushed to a new segment on disk, and is eventually merged with other segments. This immutability is why "updating" a document is actually a delete-and-reindex internally — there is no in-place mutation. Understanding this model explains why certain operations are expensive (deep pagination, updating many documents), why certain query structures are fast (filter caching, doc values), and why index design decisions made at creation time are difficult to change later.

In the broader DevOps toolchain, Elasticsearch sits at the query layer of the observability stack. Beats and Logstash handle collection and transformation; Elasticsearch handles storage and search; Kibana renders the results. The patterns in this lesson — bulk indexing, bool queries, aggregation pipelines, and cursor-based pagination — are the same patterns Kibana uses internally when it renders a dashboard. Understanding them lets you debug slow queries, optimize ingest pipelines, and build custom tooling that talks directly to the Elasticsearch API.

All examples use `curl` commands you can run directly against a local Docker container:

```bash
docker run -d \
  --name es-dev \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.12.0

# Verify it's up — should return the node name
curl -s http://localhost:9200/ | jq .name
```

## Setting Up the Practice Index

Run this entire block before working through the Concepts section. It creates an index with an explicit mapping and seeds it with six log documents representing API services.

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

Note the `Content-Type: application/x-ndjson` header on the bulk request. The Bulk API requires newline-delimited JSON (NDJSON), not a JSON array. Each line must be a single complete JSON object terminated by `\n`. Sending `application/json` returns a parse error.

```bash
# Verify: should return 6
curl -s "http://localhost:9200/services/_count" | jq .count
```

## Concepts

### Mappings and Field Types

A mapping defines the schema of an index — which fields exist, their data types, and how they are indexed and stored. Elasticsearch can infer mappings dynamically, but **dynamic mapping in production is a hazard**: a new field with an unexpected value type can cause a mapping conflict that makes the index unwritable, and the default type for a string field (`text`) is wrong for most operational log data.

| Field type | Doc values | Analyzed | Use case |
|------------|-----------|----------|----------|
| `keyword`  | Yes | No (exact) | Service names, log levels, status codes, IDs |
| `text`     | No | Yes (tokenized) | Human-readable messages, descriptions |
| `date`     | Yes | No | Timestamps — always use ISO 8601 |
| `integer` / `long` | Yes | No | Response times, counts, byte sizes |
| `boolean`  | Yes | No | Flags |
| `ip`       | Yes | No | IP addresses — enables CIDR range queries |

**Doc values** are a column-oriented on-disk representation of field data used for sorting, aggregations, and scripting. They are enabled by default for all types except `text`. When you run a `terms` aggregation, Elasticsearch reads doc values — not the inverted index. This is fast and memory-efficient.

**The dual-field pattern** — when a field needs both full-text search and aggregation/sorting, map it as `text` with a `keyword` sub-field:

```bash
curl -s -X PUT http://localhost:9200/services/_mapping \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "properties": {
    "message": {
      "type": "text",
      "fields": {
        "keyword": { "type": "keyword", "ignore_above": 256 }
      }
    }
  }
}
EOF
```

After this, `message` is searchable with `match`, and `message.keyword` is aggregatable and sortable. The `ignore_above: 256` prevents indexing keyword values longer than 256 characters — without it, a very long message field would be stored in full as a keyword, inflating index size.

**You cannot change the type of an existing field.** If you map `response_time` as `text` and later want `integer`, you must reindex. Use the `_reindex` API or create a new index and re-ingest. Plan mappings before any data lands.

### Indexing Documents

#### Single Document — PUT (idempotent with explicit ID)

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

`PUT` with an explicit `_id` is idempotent — running it twice results in a full replacement on the second run. The response field `"result"` is `"created"` on first write and `"updated"` on subsequent writes. The `_version` counter increments each time.

#### Single Document — POST (auto-generated ID)

```bash
curl -s -X POST http://localhost:9200/services/_doc \
  -H "Content-Type: application/json" \
  -d '{ "service_name": "api-gateway", "level": "INFO", "message": "Request routed", "@timestamp": "2024-03-15T10:31:00Z", "response_time": 5 }' \
  | jq '._id'
```

Elasticsearch generates a base64-encoded UUID. Use `POST` when you have no meaningful natural key. Use `PUT` with an explicit ID when the document represents a known entity (a pod, a host, a deployment) where idempotency matters.

#### Partial Update

```bash
curl -s -X POST http://localhost:9200/services/_update/svc-007 \
  -H "Content-Type: application/json" \
  -d '{ "doc": { "level": "ERROR" } }' | jq .result
# Expected: "updated"
```

`_update` fetches the current document, merges the `doc` patch, and re-indexes the result. It is cheaper than a full `PUT` when documents are large and only one field changed. **However, internally it is still a delete-plus-reindex** — Lucene segments are immutable, so there is no in-place field edit. The old document version is marked as deleted and a new segment entry is written.

#### Upsert — create if missing, update if present

```bash
curl -s -X POST http://localhost:9200/services/_update/svc-999 \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "doc": {
    "service_name": "new-svc",
    "level": "INFO",
    "message": "Started",
    "@timestamp": "2024-03-15T11:00:00Z",
    "response_time": 0
  },
  "doc_as_upsert": true
}
EOF
```

`doc_as_upsert: true` makes the `doc` payload serve as both the update patch (if the document exists) and the full document body (if it does not). This is the standard pattern for maintaining state documents — host inventory records, deployment status, configuration snapshots.

### Bulk API

Single-document requests carry per-request HTTP overhead and trigger per-request index refresh bookkeeping. For any ingest pipeline — Logstash output, Filebeat, a custom Go/Python shipper — use `_bulk`.

The Bulk API request body alternates between an **action line** and a **source line**. Each line is a complete JSON object followed by a literal newline (`\n`). The final line must also end with `\n`. A missing trailing newline is a common cause of parse errors.

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

| Action   | Idempotent | Source line required | Behavior on ID conflict |
|----------|-----------|---------------------|------------------------|
| `index`  | Yes (if `_id` given) | Yes | Replaces existing document |
| `create` | No | Yes | Returns 409 if `_id` exists |
| `update` | Yes | Yes (requires `doc` or `script`) | Partial merge |
| `delete` | Yes | No | No-op if document missing |

**Critical behavior:** The Bulk API always returns HTTP 200, even when individual operations fail. You must inspect `"errors": true` in the response body and iterate the `items` array to find per-document errors. Never assume success from the HTTP status code alone.

```bash
# Force a 409 by trying to create a document that already exists
curl -s -X POST http://localhost:9200/_bulk \
  -H "Content-Type: application/x-ndjson" \
  -d '{ "create": { "_index": "services", "_id": "svc-010" } }
{ "service_name": "dupe", "level": "INFO", "message": "This will 409", "@timestamp": "2024-03-15T11:00:00Z", "response_time": 1 }
' | jq '{errors: .errors, status: .items[0].create.status}'
# Expected: errors: true, status: 409
```

**Bulk sizing guidance:**

- Target **5–15 MB** per request body. Measure bytes, not document count — document sizes vary widely.
- Start with **1 concurrent worker per primary shard** and scale up until throughput plateaus or the write thread pool queue fills.
- Monitor queue depth: `curl -s "http://localhost:9200/_cat/thread_pool/write?v&h=name,active,queue,rejected"`. A consistently non-zero queue means ingest is outpacing write threads.

### Query DSL

All searches use `POST /<index>/_search` with a JSON body. `GET` also works but some HTTP clients reject GET requests with a body — `POST` is safer in scripts.

#### Query Types Reference

| Query type    | Target field type | Behavior |
|---------------|------------------|----------|
| `match`       | `text`           | Analyzes the term, scores by BM25 relevance |
| `term`        | `keyword`        | Exact byte match, no analysis, no scoring overhead |
| `terms`       | `keyword`        | Exact match for any value in a provided list |
| `range`       | `date`, numeric  | `gte`, `lte`, `gt`, `lt` comparisons |
| `match_phrase`| `text`           | All terms must appear in order with no gaps |
| `wildcard`    | `keyword`        | Glob pattern — avoid on large indices, cannot use index |
| `exists`      | any              | Returns documents where field is present and non-null |
| `match_all`   | —                | Matches every document; useful as a base for filter-only queries |

**`match` on a `text` field:**

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d '{ "query": { "match": { "message": "connection timeout" } } }' \
  | jq '.hits.hits[]._source.message'
```

The analyzer splits `"connection timeout"` into tokens `["connection", "timeout"]` and returns documents containing either token, scoring documents with both higher. This is appropriate for human-readable log messages.

**`term` on a `keyword` field:**

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d '{ "query": { "term": { "level": "ERROR" } } }' \
  | jq '.hits.total.value'
# Expected: 3
```

**Do not use `term` on a `text` field.** The text `"Connection pool exhausted"` is stored in the inverted index as tokens `["connection", "pool", "exhausted"]`. The raw string is not stored, so `{ "term": { "message": "Connection pool exhausted" } }` returns zero results. Use `match` for text fields.

**`range` with date math:**

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "query": {
    "range": {
      "@timestamp": {
        "gte": "now-1h",
        "lte": "now"
      }
    }
  },
  "_source": ["service_name", "level", "@timestamp"]
}
EOF
```

`now` is evaluated on the coordinating node at query time. Date math expressions: `now-1h`, `now-7d`, `now/d` (round down to day boundary), `2024-03-15||+1d` (anchor plus offset). The `_source` parameter controls which fields are returned in the response — use it to reduce payload size when documents are large.

#### Bool Query

The `bool` query is the standard composition layer for combining conditions. Every production query of any complexity uses it.

| Clause     | Contributes to score | Must match | Cached |
|------------|---------------------|-----------|--------|
| `must`     | Yes (BM25)          | Yes       | No     |
| `should`   | Yes (boost)         | No        | No     |
| `filter`   | No                  | Yes       | Yes    |
| `must_not` | No                  | Must not  | Yes    |

**Use `filter` for anything that does not affect relevance ranking** — date ranges, term matches on status codes, log levels, service names. Filter results are cached as bitsets at the segment level. Repeated filter-heavy queries on warm caches return in microseconds.

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

Execution order:
1. `filter` narrows the candidate set to ERROR documents after 10:00. These two filter results are cached separately and combined with a bitwise AND.
2. `must` further narrows to documents where `message` contains "timeout". This clause computes BM25 scores.
3. `must_not` removes any health-check documents. Cached as an exclusion bitset.

Result: `svc-003` (Redis timeout) and `svc-004` (Database connection timeout).

**`should` without `must` or `filter`:** when a `bool` query has only `should` clauses, at least one must match (controlled by `minimum_should_match`, default 1). When `should` is combined with `must` or `filter`, zero `should` clauses need to match — they only boost the score of documents that do match them. This is a common source of confusion.

### Aggregations

Aggregations process field data across matched documents and return computed summaries — counts, averages, percentiles, histograms. They run alongside the query but are independent of the hits array. Set `"size": 0` when you only want aggregation results; this skips the top-hits fetch entirely.

**Aggregations require doc values.** `keyword`, numeric, `date`, `boolean`, and `ip` fields have doc values by default. `text` fields do not. Running a `terms` aggregation on a `text` field raises: `"fielddata is disabled on text fields by default"`. The fix is to aggregate on the `.keyword` sub-field (see the dual-field pattern in the Mappings section), not to enable `fielddata: true` — loading fielddata for text fields loads the entire inverted index into heap and is expensive in both memory and time.

#### Terms Aggregation

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

`size: 10` in the aggregation controls how many buckets (unique values) are returned, not how many documents are processed. All matched documents are always processed. Higher `size` increases accuracy of bucket counts but costs more memory.

**Terms aggregation accuracy:** the default `terms` aggregation uses a distributed algorithm that can under-count bucket `doc_count` on multi-shard indices. Each shard returns its top `size` buckets; the coordinating node merges them. A bucket that ranks 11th on each shard individually might rank 3rd globally — but it was never returned by any shard. For exact counts, use `"shard_size"` (how many buckets each shard returns before merging) larger than `"size"`, or use the `composite` aggregation for precise enumeration.

#### Date Histogram

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
        "calendar_interval": "1h",
        "min_doc_count": 0,
        "extended_bounds": {
          "min": "2024-03-15T10:00:00Z",
          "max": "2024-03-15T11:00:00Z"
        }
      }
    }
  }
}
EOF
```

`min_doc_count: 0` returns buckets for intervals with zero events — essential for detecting gaps in log ingestion. Without it, empty hours disappear from the histogram and gaps look like normal periods. `extended_bounds` forces the histogram to cover the full specified range even if no data exists at the edges.

Use `calendar_interval` for human-meaningful periods (`minute`, `hour`, `day`, `week`, `month`) that respect DST and calendar variations. Use `fixed_interval` (`"5m"`, `"30m"`, `"6h"`) for exact durations.

#### Metric Aggregations

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "aggs": {
    "avg_response_time":  { "avg":         { "field": "response_time" } },
    "max_response_time":  { "max":         { "field": "response_time" } },
    "response_stats":     { "stats":       { "field": "response_time" } },
    "response_percentiles": {
      "percentiles": { "field": "response_time", "percents": [50, 95, 99] }
    }
  }
}
EOF
```

`stats` returns `count`, `min`, `max`, `avg`, and `sum` in a single pass — prefer it over running five separate metric aggregations. `percentiles` uses the TDigest algorithm — results are approximate (typically within 1–5%) but memory-bounded regardless of dataset size.

#### Nested Sub-aggregations

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
        },
        "error_rate": {
          "filter": { "term": { "level": "ERROR" } }
        }
      }
    }
  }
}
EOF
```

Sub-aggregations run within the scope of each parent bucket. For each unique `service_name`, this query computes latency percentiles and counts ERROR documents. `"error_rate"` here is a `filter` aggregation — it returns the count of documents matching the filter within each service bucket, which you can divide by the bucket's `doc_count` to get an error rate. This is the pattern behind Kibana metric panels.

### Pagination

#### `from` / `size` — offset pagination

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d '{
    "from": 0,
    "size": 2,
    "sort": [{ "@timestamp": "asc" }],
    "query": { "match_all": {} }
  }' | jq '.hits.hits[]._source.service_name'
```

Works for shallow pages. The default `index.max_result_window` is 10,000 — requests with `from + size > 10000` are rejected. At deep pages, every shard must fetch and sort `from + size` documents and ship them to the coordinating node, which discards all but `size`. Cost grows linearly with page depth.

#### `search_after` — cursor-based pagination

`search_after` uses the sort key of the last-seen document as a seek pointer. Cost per page is constant regardless of depth.

**Requirements:** the sort must include a tie-breaker field with globally unique values — `_id` is the standard choice. Without a tie-breaker, two documents with identical sort values create an ambiguous boundary.

```bash
# First page — no search_after
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

Grab the `sort` array from the last hit in the response:

```json
{ "_id": "svc-002", "sort": ["2024-03-15T10:24:00.000Z", "svc-002"] }
```

Pass it as `search_after` in the next request:

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

`search_after` is **stateless** — no server-side cursor is held between pages. New documents indexed between pages may appear in or disappear from later pages if their sort keys fall within the range you're iterating. For a consistent snapshot during active indexing, use a Point in Time.

#### Point in Time (PIT) — consistent snapshot across pages

```bash
# Open a PIT — hold a frozen view of current segments
PIT_ID=$(curl -s -X POST "http://localhost:9200/services/_pit?keep_alive=5m" | jq -r .id)

# Search against the PIT — omit the index name in the URL
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

# Always close the PIT when done — it holds segment references open on disk
curl -s -X DELETE http://localhost:9200/_pit \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$PIT_ID\"}" | jq .succeeded
```

A PIT pins the current segment generation — documents indexed after the PIT was opened are completely invisible to it. `keep_alive` must be renewed with each page request. Unclosed PITs hold file handles and consume heap; always close them explicitly.

### Explain API — Debugging Queries

```bash
curl -s -X GET http://localhost:9200/services/_explain/svc-003 \
  -H "Content-Type: application/json" \
  -d '{ "query": { "match": { "message": "timeout" } } }' \
  | jq '{matched: .matched, reason: .explanation.description}'
```

`_explain` shows exactly why a document matched or did not match a query, including the full BM25 scoring breakdown: term frequency in the document, inverse document frequency across the index, and field-length normalization. When a document is missing from results you expect, use `_explain` to identify which clause excluded it before guessing at the mapping.

## Examples

### Example 1 — Incident Triage: Identifying the Source of Error Spikes

**Scenario:** An alert fires indicating elevated error rate. You need to identify which service, the error pattern, and when it started — in under two minutes.

```bash
# Step 1: Count errors by service with 5-minute time buckets over the last 2 hours
# Use filter (not must) for level and time — no relevance scoring needed
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
            "fixed_interval": "5m",
            "min_doc_count": 0
          }
        },
        "avg_latency": { "avg": { "field": "response_time" } }
      }
    }
  }
}
EOF
```

```bash
# Step 2: Once you've identified the culprit service, retrieve recent raw error messages
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

**Verify:** the first query returns a `by_service` bucket per service with `over_time` sub-buckets. Look for a bucket whose `doc_count` spikes sharply at a specific 5-minute interval — that's the start time of the incident. The second query returns the raw messages sorted newest-first for root cause analysis.

### Example 2 — SLO Reporting: P95 Latency per Service

**Scenario:** You need a weekly SLO report showing p50/p95/p99 response times per service, with error counts.

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "size": 0,
  "query": {
    "range": { "@timestamp": { "gte": "now-7d", "lte": "now" } }
  },
  "aggs": {
    "per_service": {
      "terms": { "field": "service_name", "size": 50 },
      "aggs": {
        "latency_percentiles": {
          "percentiles": {
            "field": "response_time",
            "percents": [50, 95, 99],
            "tdigest": { "compression": 100 }
          }
        },
        "error_count": {
          "filter": { "term": { "level": "ERROR" } }
        },
        "total_requests": {
          "value_count": { "field": "response_time" }
        }
      }
    }
  }
}
EOF
```

The `tdigest.compression` parameter controls accuracy vs memory trade-off for percentile calculation. Higher values (default 100) are more accurate. The `error_count` filter aggregation returns the count of ERROR documents within each service bucket; divide by `total_requests.value` to compute error rate in a downstream system.

**Verify:** each bucket in `per_service.buckets` should have `latency_percentiles.values`, `error_count.doc_count`, and `total_requests.value`. A service with zero errors returns `"error_count": { "doc_count": 0 }`.

### Example 3 — Bulk Export with `search_after` Pagination

**Scenario:** Export all documents from the `services` index to NDJSON for archival, handling an arbitrarily large result set.

```bash
#!/bin/bash
set -euo pipefail

INDEX="services"
PAGE_SIZE=100          # Use 1000+ in production; small here for demo clarity
OUTPUT="export.ndjson"
TOTAL=0
LAST_SORT=""

> "$OUTPUT"  # Truncate output file

echo "Starting export from index: $INDEX"

while true; do
  if [ -z "$LAST_SORT" ]; then
    # First page: no search_after
    RESPONSE=$(curl -s -X GET "http://localhost:9200/${INDEX}/_search" \
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
    # Subsequent pages: use sort values from last hit as cursor
    RESPONSE=$(curl -s -X GET "http://localhost:9200/${INDEX}/_search" \
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

  HIT_COUNT=$(echo "$RESPONSE" | jq '.hits.hits | length')

  # Empty page means we've exhausted all results
  if [ "$HIT_COUNT" -eq 0 ]; then
    echo "Export complete. Total documents: $TOTAL"
    break
  fi

  # Append _source of each hit as a line of NDJSON
  echo "$RESPONSE" | jq -c '.hits.hits[]._source' >> "$OUTPUT"

  # Extract the sort array from the last hit for use as next page's cursor
  LAST_SORT=$(echo "$RESPONSE" | jq -c '.hits.hits[-1].sort')

  TOTAL=$((TOTAL + HIT_COUNT))
  echo "Page fetched: $HIT_COUNT docs | Running total: $TOTAL | Cursor: $LAST_SORT"
done
```

```bash
# Run the script
bash export.sh

# Verify line count matches document count
wc -l export.ndjson
curl -s "http://localhost:9200/services/_count" | jq .count
```

### Example 4 — Mapping a New Index with Multi-field and Disabling Unwanted Fields

**Scenario:** You're onboarding a new microservice whose logs include a free-text `error_detail` field that needs full-text search, an `endpoint` field that needs both exact filtering and aggregation, and a `trace_id` field that should be stored but never searched or aggregated (to save index space).

```bash
curl -s -X PUT http://localhost:9200/api-logs \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "index.mapping.total_fields.limit": 200
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "@timestamp":    { "type": "date", "format": "strict_date_optional_time" },
      "service_name":  { "type": "keyword" },
      "level":         { "type": "keyword" },
      "response_time": { "type": "integer" },
      "endpoint": {
        "type": "text",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 512 }
        }
      },
      "error_detail":  { "type": "text" },
      "trace_id": {
        "type": "keyword",
        "index": false,
        "doc_values": false
      }
    }
  }
}
EOF
```

`"dynamic": "strict"` rejects any document containing a field not in the mapping with a 400 error. This prevents accidental schema drift in production — a field typo in your shipper config fails loudly instead of silently creating a new unmapped field. `"index": false, "doc_values": false` on `trace_id` stores the value in `_source` (so you can retrieve it) but excludes it from the inverted index and doc values entirely — it cannot be searched or aggregated, but it also costs nothing in index overhead.

**Verify:**

```bash
# Should succeed
curl -s -X POST http://localhost:9200/api-logs/_doc \
  -H "Content-Type: application/json" \
  -d '{ "@timestamp": "2024-03-15T12:00:00Z", "service_name": "order-api", "level": "ERROR", "response_time": 3200, "endpoint": "/api/v1/orders", "error_detail": "Database write timeout after 3000ms", "trace_id": "abc-123-def" }' \
  | jq .result

# Should fail with strict_dynamic_mapping_exception
curl -s -X POST http://localhost:9200/api-logs/_doc \
  -H "Content-Type: application/json" \
  -d '{ "@timestamp": "2024-03-15T12:01:00Z", "service_name": "order-api", "level": "INFO", "response_time": 10, "endpoint": "/health", "unknown_field": "this will be rejected" }' \
  | jq .error.type
```

## Exercises

### Exercise 1 — Design and Query a Kubernetes Events Index

**Task:** Without copying the mapping from the examples, design and create an index called `k8s-events` for Kubernetes event logs. The index must support:
- Exact filtering by `namespace`, `event_type` (`Normal` / `Warning`), and `reason` (`OOMKilled`, `BackOff`, etc.)
- Full-text search on `message`
- Date range queries on `@timestamp`
- A `terms` aggregation on `reason`

After creating the index, use the Bulk API to index at least 8 documents with varied `namespace`, `event_type`, and `reason` values. Then write a `bool` query that returns only `Warning` events in the `production` namespace where the message contains "OOM", sorted by `@timestamp` descending.

**Verification:** run `curl -s http://localhost:9200/k8s-events/_mapping | jq .` and confirm no `text` field is used where `keyword` is semantically correct.

---

### Exercise 2 — Aggregation Pipeline: Error Rate by Namespace

**Task:** Using the `k8s-events` index from Exercise 1, write a **single query** with `"size": 0` that produces:
1. A `terms` aggregation bucketing documents by `namespace`
2. Within each namespace bucket: a sub-aggregation counting only `Warning` events (use a `filter` aggregation)
3. Within each namespace bucket: a `date_histogram` with `calendar_interval: "1h"` showing event volume over time

Do not run three separate queries. The result should let you compare warning rates across namespaces and see their temporal distribution in one response.

**Gotcha to avoid:** the `reason` and `namespace` fields must be mapped as `keyword` for `terms` aggregations to work. If you get `"fielddata is disabled on text fields"`, check your mapping and use the `.keyword` sub-field or recreate the index with the correct type.

---

### Exercise 3 — Implement and Verify `search_after` Pagination

**Task:** Write a bash script (not copy-pasted from the Concepts section — reconstruct it from understanding) that:
1. Opens a Point in Time on `k8s-events` with a 2-minute keep-alive
2. Fetches all documents in pages of 3, using `search_after` with `@timestamp` ascending and `_id` as the tie-breaker
3. Prints each document's `pod_name` and `event_type` as it paginates
4. Closes the PIT when all pages are exhausted

Then answer these questions in comments in your script:
- Why is `_id` included as a secondary sort key?
- What happens to the PIT if you forget to close it?
- How does this differ from just using `from: 0, size: 3`, `from: 3, size: 3`, etc.?

**Verification:** the total number of lines printed should equal the output of `curl -s http://localhost:9200/k8s-events/_count | jq .count`.

---

### Exercise 4 — Debug a Broken Query with `_explain`

**Task:** Index this document into your `services` index:

```bash
curl -s -X PUT http://localhost:9200/services/_doc/svc-debug \
  -H "Content-Type: application/json" \
  -d '{ "service_name": "debug-svc", "level": "ERROR", "message": "Upstream connection refused by remote host", "@timestamp": "2024-03-15T12:00:00Z", "response_time": 999 }'
```

Now run this query — it returns zero results even though `svc-debug` appears to match:

```bash
curl -s -X GET http://localhost:9200/services/_search \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "bool": {
        "must": [{ "term": { "message": "Upstream connection refused by remote host" } }],
        "filter": [{ "term": { "level": "error" } }]
      }
    }
  }'
```

Use `_explain` on `svc-debug` with this query to identify **both** bugs. Fix the query so it returns `svc-debug`. Explain in a comment why each original clause was wrong given the field mapping.
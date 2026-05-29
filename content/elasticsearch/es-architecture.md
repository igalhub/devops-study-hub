---
title: Architecture & Data Model
module: elasticsearch
duration_min: 20
difficulty: beginner
tags: [elasticsearch, architecture, indexing, mappings, ilm]
exercises: 3
---

## Overview

Elasticsearch is a distributed, RESTful search and analytics engine built on Apache Lucene. It stores documents as JSON and makes them searchable in near-real-time by maintaining an **inverted index** — a data structure that maps every token (word) in every field to the list of documents containing it. This is fundamentally different from a relational database: you trade rigid schema enforcement and row-level locking for flexible, horizontal scalability and millisecond full-text search across billions of documents. The trade-off is intentional — Elasticsearch is optimized for read-heavy, append-heavy workloads, not transactional updates.

In a DevOps context, Elasticsearch is the backbone of the ELK (Elasticsearch, Logstash, Kibana) and Elastic Stack, ingesting logs, metrics, and traces from across your infrastructure. Understanding its data model — how a cluster organizes shards, replicas, and indices — is prerequisite knowledge before you can tune performance, diagnose split-brain scenarios, or build reliable ILM policies that keep disk usage under control. A misconfigured shard count you cannot undo without a full reindex, or a dynamic mapping that stores an IP address as `text`, will cost you far more time to fix than getting it right upfront.

From version 8.0 onward, Elasticsearch runs with security enabled by default (TLS + authentication). The examples in this lesson use a single-node Docker container with security disabled so you can focus on the data model itself. The Security lesson covers how to enable and configure authentication properly.

## Running Elasticsearch Locally with Docker

All exercises in this lesson use a single-node Elasticsearch container. Run it once before starting:

```bash
docker run -d \
  --name es-dev \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.12.0
```

- `discovery.type=single-node` — tells ES not to wait for other nodes; forms a cluster by itself immediately
- `xpack.security.enabled=false` — disables authentication and TLS; never use this in production
- `ES_JAVA_OPTS=-Xms512m -Xmx512m` — caps the JVM heap at 512 MB; without this, ES defaults to half your system RAM

Wait ~30 seconds, then verify:

```bash
curl -s http://localhost:9200/ | jq '.tagline'
# Expected: "You Know, for Search"
```

If you get a connection refused, inspect container logs: `docker logs es-dev`.

### Translating DevTools Notation to curl

Elasticsearch documentation uses Kibana DevTools shorthand (`GET /_cluster/health`). On the command line everything is a `curl` call:

```bash
# GET
curl -s http://localhost:9200/_cluster/health | jq .

# PUT with JSON body (heredoc avoids escaping quotes)
curl -s -X PUT http://localhost:9200/my-index \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 }
}
EOF

# POST (auto-generated document ID)
curl -s -X POST http://localhost:9200/my-index/_doc \
  -H "Content-Type: application/json" \
  -d '{ "field": "value" }' | jq .

# DELETE
curl -s -X DELETE http://localhost:9200/my-index | jq .

# Check existence only — returns 200 or 404, no body
curl -o /dev/null -w "%{http_code}\n" -s -I http://localhost:9200/my-index
```

Install `jq` if you don't have it: `sudo apt-get install jq` or `brew install jq`.

## Concepts

### Cluster, Nodes, and Roles

A **cluster** is one or more nodes that share the same `cluster.name`. Every cluster elects a single **master node** responsible for cluster-wide state: index mappings, shard routing tables, and node membership. If the master dies, surviving master-eligible nodes hold an election. Node roles are declared in `elasticsearch.yml` and control what work a node performs:

| Role | `node.roles` value | Responsibility |
|------|--------------------|----------------|
| Master-eligible | `master` | Participates in master elections; manages cluster state |
| Data | `data` | Stores shards; handles indexing, CRUD, search |
| Coordinating-only | `[]` (empty list) | Routes requests to the right shards, merges results |
| Ingest | `ingest` | Runs ingest pipelines (grok, geoIP, etc.) before indexing |
| ML | `ml` | Executes machine-learning jobs |

**In production, always run 3 dedicated master nodes** (separate from data nodes). A data node under heavy GC pressure can pause for seconds — if it also holds the master role, that pause looks like a node failure and can trigger unnecessary elections or a split-brain.

```yaml
# elasticsearch.yml — dedicated master node configuration
node.roles: [ master ]
cluster.name: prod-logs
node.name: master-1
network.host: 10.0.1.10
discovery.seed_hosts: ["10.0.1.10", "10.0.1.11", "10.0.1.12"]
cluster.initial_master_nodes: ["master-1", "master-2", "master-3"]
```

**`cluster.initial_master_nodes` is a bootstrap-only setting.** It tells the cluster which nodes are allowed to form the initial quorum. Once the cluster is formed and state is persisted to disk, remove this setting from `elasticsearch.yml` before restarting nodes. If you leave it in and later add more master-eligible nodes, the cluster can bootstrap a second independent cluster on restart — a split-brain scenario.

Verify roles on your running node:

```bash
curl -s "http://localhost:9200/_cat/nodes?v&h=name,node.role,master"
# node.role letters: m=master-eligible, d=data, i=ingest, c=coordinating
# master column: * = elected master
```

### Indices, Shards, and Replicas

An **index** is a logical namespace for a collection of documents. Physically, an index is divided into **primary shards**, each of which is an independent Lucene index holding a subset of the documents. **Replica shards** are exact copies of primaries; they serve read requests and provide failover.

```
Index: logs-app-2024
├── Primary shard 0  (node-1)   ←→  Replica 0 (node-2)
├── Primary shard 1  (node-2)   ←→  Replica 1 (node-3)
└── Primary shard 2  (node-3)   ←→  Replica 2 (node-1)
```

Create an index with explicit shard configuration:

```bash
curl -s -X PUT http://localhost:9200/logs-app-2024 \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 0
  }
}
EOF
```

Verify the index and shard allocation:

```bash
curl -s "http://localhost:9200/_cat/indices?v&h=index,health,pri,rep,docs.count,store.size"
curl -s "http://localhost:9200/_cat/shards/logs-app-2024?v&h=shard,prirep,state,node"
```

**Key constraints:**
- `number_of_shards` is fixed at index creation. To change it, you must create a new index and use the `_reindex` API to copy data across.
- `number_of_replicas` can be changed at any time with `PUT /<index>/_settings`.
- On a single-node cluster, set `number_of_replicas: 0`. Elasticsearch will not place a replica on the same node as its primary — replicas stay `UNASSIGNED` and the cluster turns **yellow** if you request replicas with only one node.

**Shard sizing rule of thumb:** target **10–50 GB per shard**. Too many small shards (under-sizing) wastes heap because every shard has fixed overhead (~few MB of heap). Too few large shards (over-sizing) reduces parallelism and makes recovery after a node failure slow.

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Cluster status `yellow` | Unassigned replicas | Add nodes or set `number_of_replicas: 0` |
| Cluster status `red` | One or more primary shards unassigned | Node lost with no replica; restore from snapshot |
| High heap usage | Too many small shards | Shrink index or increase shard size targets |
| Slow recovery | Shards are too large (>100 GB) | Reduce `max_primary_shard_size` on rollover |

### Index vs Data Stream

| | Plain Index | Data Stream |
|--|-------------|-------------|
| Use case | General documents | Time-series: logs, metrics, traces |
| Write target | The index directly | Hidden auto-named backing indices |
| Rollover | Manual or via ILM | Automatic via ILM |
| Read | Single index name | All backing indices, transparently |
| Required field | None | `@timestamp` (must be `date` type) |
| Custom document IDs | Supported | **Not supported** — IDs are auto-generated |

Data streams are the correct abstraction for log pipelines. Under the hood, a data stream is a named alias pointing to a sequence of backing indices (e.g., `.ds-logs-myapp-2024.03.15-000001`). When an ILM rollover fires, a new backing index is created and the write alias advances to it. Older backing indices transition through warm/cold/delete phases independently.

```bash
# 1. Create the index template (data_stream: {} activates data stream mode)
curl -s -X PUT http://localhost:9200/_index_template/logs-template \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "index_patterns": ["logs-*"],
  "data_stream": {},
  "template": {
    "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" }
      }
    }
  }
}
EOF

# 2. Create the data stream — the template applies automatically
curl -s -X PUT http://localhost:9200/_data_stream/logs-myapp | jq .

# 3. Index a document — must use POST; no custom IDs allowed
curl -s -X POST http://localhost:9200/logs-myapp/_doc \
  -H "Content-Type: application/json" \
  -d '{ "@timestamp": "2024-03-15T10:00:00Z", "level": "INFO", "message": "App started" }' | jq .

# 4. Inspect the backing indices
curl -s "http://localhost:9200/_data_stream/logs-myapp" | jq '.data_streams[0].indices'
```

### Mappings and Field Types

A **mapping** defines the schema for documents in an index: what fields exist, their types, and how they are indexed. Elasticsearch performs **dynamic mapping** if no explicit mapping exists — it infers types from the first document it sees. Dynamic mapping is convenient for exploration but dangerous in production: a log field containing `"200"` gets mapped as `long`, an IP address gets mapped as `text`, and a date string in an unexpected format gets mapped as `keyword`.

**You cannot change a field's type after the mapping is set.** The inverted index is already built for that type. To fix a wrong field type you must create a new index with the correct mapping and reindex all data into it.

Key field types:

| Type | Use for | Supports aggregation? | Supports full-text search? |
|------|---------|----------------------|---------------------------|
| `keyword` | Exact match: hostnames, status codes, IDs | ✅ | ❌ |
| `text` | Analyzed free text: log messages, descriptions | ❌ | ✅ |
| `date` | Timestamps; configurable format | ✅ | ❌ |
| `integer` / `long` | Counts, durations, numeric IDs | ✅ | ❌ |
| `float` / `double` | Percentages, latencies | ✅ | ❌ |
| `boolean` | Flags | ✅ | ❌ |
| `ip` | IPv4/IPv6 addresses; supports CIDR range queries | ✅ | ❌ |
| `object` | Nested JSON (fields flattened into parent doc) | ✅ | depends on subfield type |
| `nested` | Arrays of objects that must be independently queried | ✅ | ✅ |

**`keyword` vs `text`** is a frequent interview topic. `keyword` stores the raw, unchanged string — useful for `term` queries, `terms` aggregations, and sorting. `text` is run through an analyzer: tokenized, lowercased, and optionally stemmed — useful for `match` queries but not aggregatable. A field can have **both** via `fields` (multi-fields):

```bash
curl -s -X PUT http://localhost:9200/services \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "mappings": {
    "properties": {
      "service_name":  { "type": "keyword" },
      "log_message": {
        "type": "text",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 }
        }
      },
      "timestamp":     { "type": "date", "format": "strict_date_optional_time" },
      "response_time": { "type": "integer" },
      "success":       { "type": "boolean" },
      "client_ip":     { "type": "ip" }
    }
  }
}
EOF
```

With this mapping, `log_message` supports `match` queries (full-text) and `log_message.keyword` supports `terms` aggregations. The `ignore_above: 256` prevents very long strings from being stored in the keyword sub-field — strings longer than 256 characters are silently dropped from that sub-field only, not from the parent `text` field.

**`object` vs `nested`:** If you have an array of objects and need to query each object's fields as a unit, use `nested`. With `object`, the array is flattened — `{ "tags": [{"name":"error","count":5}, {"name":"warn","count":2}] }` becomes `tags.name: [error, warn]` and `tags.count: [5, 2]`, destroying the relationship between name and count within each tag. `nested` preserves that relationship but is significantly more expensive to query and index.

Verify dynamic mapping on a document you just indexed:

```bash
# Index without explicit mapping
curl -s -X POST http://localhost:9200/dynamic-test/_doc \
  -H "Content-Type: application/json" \
  -d '{ "host": "web-01", "count": 42, "ratio": 0.75, "active": true }' | jq .

# Inspect what Elasticsearch inferred
curl -s http://localhost:9200/dynamic-test/_mapping | jq '.["dynamic-test"].mappings.properties'
# count → long, ratio → float, active → boolean, host → text + keyword sub-field
```

To **disable dynamic mapping** on an index and reject unknown fields entirely:

```bash
curl -s -X PUT http://localhost:9200/strict-index \
  -H "Content-Type: application/json" \
  -d '{ "mappings": { "dynamic": "strict", "properties": { "host": { "type": "keyword" } } } }' | jq .
# Indexing a document with an unknown field now returns a 400 error
```

### Index Lifecycle Management (ILM)

ILM automates moving indices through phases as data ages, balancing query performance against storage cost. Without ILM, a log index grows indefinitely on expensive hot storage. With ILM, data ages automatically into cheaper tiers and is deleted when no longer needed.

**ILM phases and what they do:**

| Phase | Trigger | Typical actions |
|-------|---------|----------------|
| **Hot** | Immediately on creation | `rollover`: create a new index when size or age threshold is hit |
| **Warm** | `min_age` after rollover | `shrink`: reduce primary shards; `forcemerge`: collapse segments for faster reads |
| **Cold** | `min_age` after rollover | Move to cold-tier nodes; data stays searchable but slower |
| **Frozen** | `min_age` after rollover | Data loaded from disk on demand; minimal heap usage |
| **Delete** | `min_age` after rollover | Remove the index entirely |

`min_age` in warm/cold/delete is measured from the **rollover time**, not from the ILM policy creation time. If an index never rolls over (too small), it will not progress past hot phase until `max_age` fires.

```bash
# Create a complete ILM policy
curl -s -X PUT http://localhost:9200/_ilm/policy/logs-policy \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": { "max_size": "50gb", "max_age": "1d" }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink":     { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 }
        }
      },
      "cold": {
        "min_age": "15d",
        "actions": {}
      },
      "delete": {
        "min_age": "30d",
        "actions": { "delete": {} }
      }
    }
  }
}
EOF
```

Attach the policy to an index at creation time:

```bash
curl -s -X PUT http://localhost:9200/logs-app-managed \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "index.lifecycle.name": "logs-policy",
    "index.lifecycle.rollover_alias": "logs-app"
  }
}
EOF
```

Or attach it to an existing index:

```bash
curl -s -X PUT http://localhost:9200/logs-app-2024/_settings \
  -H "Content-Type: application/json" \
  -d '{ "index.lifecycle.name": "logs-policy" }' | jq .
```

Diagnose ILM progress and errors:

```bash
curl -s "http://localhost:9200/logs-app-managed/_ilm/explain" | jq .
# Key fields: phase, action, step, age, failed_step, step_info (contains error details)
```

**Common ILM failure:** the `shrink` action requires all shards of the index to land on a single node. If your cluster has allocation rules (rack awareness, frozen tiers) that prevent this, shrink will stall with a `step_info` error. Check `_ilm/explain` — it will tell you exactly which step failed and why.

### The Inverted Index and Near-Real-Time Search

Understanding why Elasticsearch search is fast — and what "near-real-time" actually means — requires understanding the write path.

When a document is indexed:
1. It is written to an in-memory **buffer** and the **transaction log (translog)**.
2. Every second (default), the buffer is **refreshed** into a new in-memory Lucene **segment**. The segment is now searchable. This 1-second delay is what "near-real-time" means.
3. Every 30 minutes (default) or when the translog exceeds 512 MB, segments are **flushed** to disk (fsync). The translog is then cleared.
4. In the background, small segments are **merged** into larger ones to reduce the number of files Elasticsearch must scan on each query.

**Implications for DevOps:**

- If you need a document searchable immediately (e.g., integration tests), call `POST /<index>/_refresh` after indexing. Do not do this in production pipelines — it is expensive.
- The translog provides durability: if a node crashes between flushes, documents are replayed from the translog on restart.
- Forcemerge (used in warm phase) collapses all segments into one. This is a heavy I/O operation — only safe on read-only indices.

```bash
# Force a refresh so a just-indexed document is immediately searchable
curl -s -X POST http://localhost:9200/my-index/_refresh | jq .

# Check segment count (high segment count = slower reads)
curl -s "http://localhost:9200/_cat/segments/my-index?v&h=index,shard,segment,size,docs.count"
```

### REST API Overview

All Elasticsearch operations use standard HTTP verbs:

| Verb | Purpose | Example |
|------|---------|---------|
| `PUT` | Create or replace a resource | Create index, put document by ID |
| `POST` | Append or update | Index doc (auto ID), `_search`, `_bulk`, `_reindex` |
| `GET` | Read | Get document, mapping, settings, search |
| `DELETE` | Delete | Delete index, document, ILM policy |
| `HEAD` | Check existence | Returns 200 or 404, no response body |

Essential operational commands:

```bash
# Cluster health — green/yellow/red
curl -s http://localhost:9200/_cluster/health | jq '{status, number_of_nodes, active_shards, unassigned_shards}'

# List indices with key stats
curl -s "http://localhost:9200/_cat/indices?v&h=index,health,pri,rep,docs.count,store.size&s=store.size:desc"

# Explain why a shard is unassigned
curl -s "http://localhost:9200/_cluster/allocation/explain" \
  -H "Content-Type: application/json" \
  -d '{ "index": "my-index", "shard": 0, "primary": false }' | jq '.explanation'

# Check index mapping
curl -s http://localhost:9200/my-index/_mapping | jq .

# Check index settings
curl -s http://localhost:9200/my-index/_settings | jq .

# Bulk index multiple documents in one request (newline-delimited JSON)
curl -s -X POST http://localhost:9200/_bulk \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @- << 'EOF'
{"index": {"_index": "my-index"}}
{"field": "value1", "@timestamp": "2024-03-15T10:00:00Z"}
{"index": {"_index": "my-index"}}
{"field": "value2", "@timestamp": "2024-03-15T10:01:00Z"}
EOF
```

**`_bulk` is the correct way to ingest data at scale.** Single-document `POST /_doc` requests have per-request HTTP and cluster overhead. Bulk requests of 5–15 MB are the standard recommendation — measure your throughput and tune batch size accordingly.

## Examples

### Example 1 — Designing a Logging Index for a Microservices Platform

**Scenario:** 5 services each emitting ~10,000 logs/minute. Requirements: 30-day retention, fast search on the last 7 days.

```bash
# Step 1 — Create the ILM policy
curl -s -X PUT http://localhost:9200/_ilm/policy/service-logs-policy \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "policy": {
    "phases": {
      "hot":  {
        "actions": {
          "rollover": { "max_size": "30gb", "max_age": "1d" }
        }
      },
      "warm": {
        "min_age": "3d",
        "actions": {
          "shrink":     { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 }
        }
      },
      "delete": {
        "min_age": "30d",
        "actions": { "delete": {} }
      }
    }
  }
}
EOF

# Step 2 — Create the index template with explicit mappings and ILM policy attached
curl -s -X PUT http://localhost:9200/_index_template/service-logs-template \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "index_patterns": ["service-logs-*"],
  "data_stream": {},
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0,
      "index.lifecycle.name": "service-logs-policy"
    },
    "mappings": {
      "properties": {
        "@timestamp":    { "type": "date" },
        "service_name":  { "type": "keyword" },
        "level":         { "type": "keyword" },
        "trace_id":      { "type": "keyword" },
        "message":       { "type": "text" },
        "response_time": { "type": "integer" },
        "client_ip":     { "type": "ip" }
      }
    }
  }
}
EOF

# Step 3 — Create the data stream; template auto-applies
curl -s -X PUT http://localhost:9200/_data_stream/service-logs-payment | jq .

# Step 4 — Index a test document
curl -s -X POST http://localhost:9200/service-logs-payment/_doc \
  -H "Content-Type: application/json" \
  -d '{
    "@timestamp":    "2024-03-15T10:23:00Z",
    "service_name":  "payment-api",
    "level":         "ERROR",
    "message":       "Connection pool exhausted after 5000ms",
    "response_time": 5021,
    "client_ip":     "10.0.2.100",
    "trace_id":      "4bf92f3577b34da6a3ce929d0e0e4736"
  }' | jq .

# Step 5 — Verify the backing index picked up the ILM policy
curl -s "http://localhost:9200/service-logs-payment/_ilm/explain" \
  | jq '.indices | to_entries[0].value | {phase, age, policy}'

# Step 6 — Query using a keyword filter (exact match on level)
curl -s -X POST http://localhost:9200/service-logs-payment/_search \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "bool": {
        "filter": [
          { "term":  { "level": "ERROR" } },
          { "range": { "@timestamp": { "gte": "now-1h" } } }
        ]
      }
    }
  }' | jq '.hits.total'
```

### Example 2 — Detecting and Fixing a Mapping Mistake

**Scenario:** A developer indexed documents without an explicit mapping. Elasticsearch inferred `response_code` as `long`, but you need to filter on values like `"200"`, `"404"`, and aggregate by status class. You realize it should be `keyword`.

```bash
# 1. Simulate the mistake — index without explicit mapping
curl -s -X POST http://localhost:9200/app-logs/_doc \
  -H "Content-Type: application/json" \
  -d '{ "response_code": 200, "path": "/api/users", "@timestamp": "2024-03-15T10:00:00Z" }' | jq .

# 2. Confirm the inferred mapping
curl -s http://localhost:9200/app-logs/_mapping \
  | jq '.["app-logs"].mappings.properties.response_code'
# → { "type": "long" }  — wrong for aggregation-by-string use case

# 3. Attempt to change the field type — this will fail
curl -s -X PUT http://localhost:9200/app-logs/_mapping \
  -H "Content-Type: application/json" \
  -d '{ "properties": { "response_code": { "type": "keyword" } } }' | jq '.error.reason'
# → "mapper [response_code] cannot be changed from type [long] to [keyword]"

# 4. Create a new index with the correct mapping
curl -s -X PUT http://localhost:9200/app-logs-v2 \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "response_code": { "type": "keyword" },
      "path":          { "type": "keyword" },
      "@timestamp":    { "type": "date" }
    }
  }
}
EOF

# 5. Reindex data into the corrected index
curl -s -X POST http://localhost:9200/_reindex \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "source": { "index": "app-logs" },
  "dest":   { "index": "app-logs-v2" },
  "script": {
    "source": "ctx._source.response_code = ctx._source.response_code.toString()",
    "lang": "painless"
  }
}
EOF
# The Painless script converts the long to a string during reindex

# 6. Verify the document arrived with the correct type
curl -s http://localhost:9200/app-logs-v2/_search | jq '.hits.hits[0]._source'
```

### Example 3 — Checking Cluster Health After Scaling Down

**Scenario:** You removed a data node during maintenance. You need to confirm the cluster recovered fully and identify any unassigned shards.

```bash
# Check overall health
curl -s http://localhost:9200/_cluster/health | jq '{status, unassigned_shards, relocating_shards}'

# List unassigned shards if status is yellow/red
curl -s "http://localhost:9200/_cat/shards?v&h=index,shard,prirep,state,node&s=state" \
  | grep -E "UNASSIGNED|INITIALIZING"

# Get an allocation explanation for the first unassigned shard
curl -s -X POST http://localhost:9200/_cluster/allocation/explain \
  -H "Content-Type: application/json" \
  -d '{ "index": "logs-app-2024", "shard": 0, "primary": false }' \
  | jq '.explanation'

# If unassigned replicas are expected (single-node scenario), disable them
curl -s -X PUT http://localhost:9200/logs-app-2024/_settings \
  -H "Content-Type: application/json" \
  -d '{ "number_of_replicas": 0 }' | jq .

# Re-check health — should return green
curl -s http://localhost:9200/_cluster/health | jq '.status'
```

## Exercises

### Exercise 1 — Create an Index with Explicit Mappings

Start the local Docker container. Create an index named `inventory` with these fields:

| Field | Type | Rationale |
|-------|------|-----------|
| `item_name` | `keyword` | Exact match and aggregation |
| `description` | `text` with `keyword` sub-field | Full-text search AND aggregation |
| `quantity` | `integer` | Numeric |
| `last_updated` | `date` | Timestamp |

After creating the index:
1. Retrieve the mapping and confirm all four fields have the expected types.
2. Index one document.
3. Attempt to index a second document with an extra field `price: 99.99`. Observe that Elasticsearch accepts it and dynamically adds the field to the mapping.
4. Retrieve the mapping again and note the new `price` field. Then explain: how would you prevent this from happening in production?

**Hint:** look at the `dynamic` mapping setting and what value you would set it to in order to reject unknown fields.

---

### Exercise 2 — Create and Attach an ILM Policy

Create an ILM policy named `inventory-policy` with these rules:
- Hot phase: rollover when the index reaches 5 GB or is 7 days old
- Warm phase: 14 days after rollover; forcemerge to 1 segment
- Delete phase: 60 days after rollover

Then:
1. Attach the policy to the `inventory` index from Exercise 1.
2. Use `_ilm/explain` to confirm the policy is attached and note the current phase.
3. Modify the policy to add a cold phase at 30 days (no actions required — just adding the phase). Use `PUT /_ilm/policy/inventory-policy` with the updated JSON.
4. Re-run `_ilm/explain` and confirm the policy version number incremented.

**Answer these questions in comments next to your curl commands:**
- Why does `min_age` in the warm phase count from rollover rather than from index creation?
- What happens to an index in the hot phase that never reaches the rollover thresholds?

---

### Exercise 3 — Design a Production Node Configuration

You are building a 9-node cluster to handle 500 GB/day of log ingest with Kibana dashboards running aggregation-heavy queries from an operations team of 20 people.

Write out the complete `node.roles` stanza and a brief rationale for each of these node types:
- 3 dedicated master nodes
- 5 data + ingest nodes
- 1 coordinating-only node

Then answer the following:

1. Why would adding ingest role to data nodes (instead of a separate ingest tier) be acceptable at this scale?
2. What would you change if aggregation queries from Kibana were causing heap pressure on data nodes?
3. The cluster was initially formed with `cluster.initial_master_nodes` set. A new master-eligible node is being added six months later. Should you set `cluster.initial_master_nodes` in the new node's config? Why or why not?
4. If one data node fails and contains primaries with no replicas (`number_of_replicas: 0`), what is the cluster status and what is your recovery path?

Write your configuration as valid `elasticsearch.yml` snippets — one per node type.

---

### Quick Checks

5. Calculate total shards for 3 primary shards with 1 replica each. Run: `python3 -c "primary=3; replicas=1; print(primary * (1 + replicas))"`

```expected_output
6
```

hint: Think about how total shards relate to primary shards and the number of copies (replicas) of each.
hint: Use Python to evaluate the formula where total shards equal primary multiplied by the quantity of one plus the replica count.

6. Extract the cluster name from an elasticsearch.yml stub. Run: `printf 'cluster.name: my-es-cluster\nnode.name: es-node-1\n' | awk '/^cluster.name:/{print $2}'`

```expected_output
my-es-cluster
```

hint: Think about how you can filter lines from structured text and extract a specific field value using a pattern-matching tool.
hint: Use awk with a pattern like /^cluster.name:/ to match the target line, then print the second whitespace-separated field with {print $2}.

---
title: Architecture & Data Model
module: elasticsearch
duration_min: 20
difficulty: beginner
tags: [elasticsearch, architecture, indexing, mappings, ilm]
exercises: 3
---

## Overview

Elasticsearch is a distributed, RESTful search and analytics engine built on Apache Lucene. It stores documents as JSON and makes them searchable in near-real-time by maintaining an inverted index — a data structure that maps every token (word) in every field to the list of documents containing it. This is fundamentally different from a relational database: you trade rigid schema enforcement for flexible, horizontal scalability and millisecond full-text search across billions of documents.

In a DevOps context Elasticsearch is the backbone of the ELK (Elasticsearch, Logstash, Kibana) and Elastic Stack, ingesting logs, metrics, and traces from across your infrastructure. Understanding its data model — how a cluster organises shards, replicas, and indices — is prerequisite knowledge before you can tune performance, diagnose split-brain scenarios, or build reliable ILM policies that keep your cluster's disk usage under control.

From version 8.0 onward, Elasticsearch runs with security enabled by default (TLS + authentication). The examples in this lesson use a single-node Docker container with security disabled so you can focus on the data model itself. The Security lesson covers how to enable and configure authentication properly.

## Running Elasticsearch Locally with Docker

All exercises in this lesson use a single-node Elasticsearch container. Run it once before starting the exercises:

```bash
docker run -d \
  --name es-dev \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.12.0
```

What each flag does:
- `-p 9200:9200` — maps the container's REST API port to your localhost
- `discovery.type=single-node` — tells ES not to wait for other nodes; forms a cluster by itself immediately
- `xpack.security.enabled=false` — disables authentication and TLS so you can call the API without credentials
- `ES_JAVA_OPTS=-Xms512m -Xmx512m` — limits the JVM heap to 512 MB; essential on a laptop (default is half system RAM)

Wait about 30 seconds, then verify it is running:

```bash
curl http://localhost:9200/
```

You should see a JSON response with `"tagline": "You Know, for Search"`. If it returns a connection refused error, check the container logs: `docker logs es-dev`.

### Translating DevTools Notation to curl

Most Elasticsearch documentation (and this lesson) uses Kibana DevTools shorthand:

```
GET /_cluster/health
PUT /my-index { ... }
```

On the command line everything is a `curl` call. The mapping is:

```bash
# GET request
curl -s http://localhost:9200/_cluster/health | jq .

# PUT request with a JSON body
curl -s -X PUT http://localhost:9200/my-index \
  -H "Content-Type: application/json" \
  -d '{ "settings": { "number_of_shards": 1 } }' | jq .

# POST request
curl -s -X POST http://localhost:9200/my-index/_doc \
  -H "Content-Type: application/json" \
  -d '{ "field": "value" }' | jq .

# DELETE request
curl -s -X DELETE http://localhost:9200/my-index | jq .
```

The `-s` flag suppresses curl's progress meter. `| jq .` pretty-prints the JSON response. Install jq if you don't have it: `sudo apt-get install jq` or `brew install jq`.

For multi-line JSON bodies, use a heredoc so you don't have to escape quotes:

```bash
curl -s -X PUT http://localhost:9200/my-index \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": {
    "number_of_shards": 2,
    "number_of_replicas": 0
  }
}
EOF
```

## Concepts

### Cluster, Nodes, and Roles

A **cluster** is one or more nodes that share the same `cluster.name`. Every cluster elects a **master** node responsible for cluster-wide state (mappings, shard routing, node membership). Node roles are declared in `elasticsearch.yml`:

| Role | Key | Responsibility |
|------|-----|----------------|
| Master-eligible | `master` | Participates in master elections |
| Data | `data` | Stores shards, handles CRUD & search |
| Coordinating-only | _(no roles)_ | Routes requests, merges results |
| Ingest | `ingest` | Runs ingest pipelines before indexing |
| ML | `ml` | Runs machine-learning jobs |

In production, always run **dedicated master nodes** (3 for quorum) separate from data nodes to prevent resource contention from killing master elections. On a single-node development cluster, the node takes all roles by default.

```yaml
# elasticsearch.yml — dedicated master node
node.roles: [ master ]
cluster.name: prod-logs
node.name: master-1
network.host: 10.0.1.10
discovery.seed_hosts: ["10.0.1.10", "10.0.1.11", "10.0.1.12"]
cluster.initial_master_nodes: ["master-1", "master-2", "master-3"]
```

Verify which roles your local node is playing:

```bash
curl -s http://localhost:9200/_cat/nodes?v&h=name,node.role,master
```

The `node.role` column contains letters: `m` = master-eligible, `d` = data, `i` = ingest, `c` = coordinating. The `master` column shows `*` for the elected master.

### Indices, Shards, and Replicas

An **index** is a logical namespace for a collection of documents. Physically, each index is split into **primary shards** and optionally one or more **replica shards**.

- **Primary shards** — determined at index creation, cannot be changed without reindex. Each primary holds a subset of the index's documents.
- **Replica shards** — exact copies of primaries; serve read requests and provide failover if a primary's node goes down.

Create an index with explicit shard settings:

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

On a single-node cluster, always set `number_of_replicas: 0`. Elasticsearch will not place a replica on the same node as its primary, so replicas stay unassigned and the cluster turns yellow if you set replicas > 0 with only one node.

Verify the index was created:

```bash
curl -s "http://localhost:9200/_cat/indices?v&h=index,health,pri,rep,docs.count,store.size"
```

Shard sizing rule of thumb: aim for **10–50 GB per shard**. Too many small shards waste heap; too few large shards reduce parallelism and make recovery slow.

### Index vs Data Stream

| | Index | Data Stream |
|---|---|---|
| Use case | General documents | Time-series (logs, metrics) |
| Write target | The index itself | Hidden backing indices |
| Rollover | Manual or ILM | Automatic via ILM |
| Read | Single index | All backing indices transparently |

Data streams require an **index template** with `data_stream: {}` enabled. The template must also map a `@timestamp` field as `date`. Documents written to a data stream must include `@timestamp`.

```bash
# 1. Create the index template first
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

# 2. Create the data stream (the template auto-applies)
curl -s -X PUT http://localhost:9200/_data_stream/logs-myapp | jq .

# 3. Index a document — must use POST (no custom IDs in data streams)
curl -s -X POST http://localhost:9200/logs-myapp/_doc \
  -H "Content-Type: application/json" \
  -d '{ "@timestamp": "2024-03-15T10:00:00Z", "level": "INFO", "message": "App started" }' | jq .

# 4. Verify backing indices
curl -s "http://localhost:9200/_data_stream/logs-myapp" | jq '.data_streams[0].indices'
```

### Mappings and Field Types

A **mapping** defines the schema for documents in an index. Elasticsearch infers mappings dynamically from the first document indexed, but dynamic mapping often produces incorrect types (a numeric string mapped as `long`, an IP address mapped as `text`). Always define explicit mappings in production.

Key field types:

| Type | Use for |
|------|---------|
| `keyword` | Exact-match, aggregations, sorting (IDs, status codes, hostnames) |
| `text` | Full-text search (log messages, descriptions) — analyzed and tokenized |
| `date` | Timestamps; format can be specified |
| `integer` / `long` | Numeric counts, durations |
| `float` / `double` | Decimal numbers |
| `boolean` | True/false flags |
| `ip` | IPv4/IPv6 addresses with CIDR query support |
| `object` | Nested JSON object (flat, not independently queryable) |
| `nested` | Array of objects where each object must be queried independently |

The `keyword` vs `text` split is a common interview question. `keyword` stores the raw value unchanged and supports exact match and aggregations but **not** full-text search. `text` is tokenized (split into terms, lowercased, stemmed) and supports full-text search but **not** aggregations. A field can have both via a `fields` sub-mapping (multi-fields):

```bash
# Mapping that supports both full-text search AND aggregation on the same field
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

With this mapping, `log_message` is searchable with `match` queries, and `log_message.keyword` is aggregatable. The `ignore_above: 256` truncates very long strings in the keyword sub-field to save space.

Retrieve the mapping to verify:

```bash
curl -s http://localhost:9200/services/_mapping | jq .
```

**You cannot change a field's type in an existing mapping.** If you map `price` as `keyword` and later need it as `float`, you must create a new index with the correct mapping and reindex. This is why getting mappings right upfront matters.

View dynamic mappings on an index after indexing a document to see what Elasticsearch inferred:

```bash
# Index a document without an explicit mapping
curl -s -X POST http://localhost:9200/dynamic-test/_doc \
  -H "Content-Type: application/json" \
  -d '{ "host": "web-01", "count": 42, "ratio": 0.75, "active": true }' | jq .

# See what Elasticsearch inferred
curl -s http://localhost:9200/dynamic-test/_mapping | jq '.["dynamic-test"].mappings.properties'
```

### Index Lifecycle Management (ILM)

ILM automates the transition of indices through phases — **hot → warm → cold → frozen → delete** — based on age or size. This is essential for log data: you want fast writes and low-latency search initially, then progressively cheaper storage as data ages.

Phase breakdown:
- **Hot** — actively written to; rollover triggers creation of a new backing index when size/age thresholds are hit
- **Warm** — no new writes; shrink to fewer shards, forcemerge to reduce segment count and improve read performance
- **Cold** — infrequent access; data is still searchable but not cached in heap
- **Frozen** — very infrequent access; data lives on disk only, loaded on demand (much lower cost)
- **Delete** — index is removed

```bash
# Create an ILM policy
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
          "shrink": { "number_of_shards": 1 },
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
```

Verify the policy was created:

```bash
curl -s http://localhost:9200/_ilm/policy/logs-policy | jq .
```

**Attaching an ILM policy to an index** requires setting `index.lifecycle.name` in the index settings. You can do this at creation time or update it on an existing index:

```bash
# At creation time
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

# Or update an existing index
curl -s -X PUT "http://localhost:9200/logs-app-2024/_settings" \
  -H "Content-Type: application/json" \
  -d '{ "index.lifecycle.name": "logs-policy" }' | jq .

# Check ILM status for an index
curl -s "http://localhost:9200/logs-app-managed/_ilm/explain" | jq .
```

The `_ilm/explain` endpoint shows the current phase, the time in the current phase, and any errors that blocked the transition.

### REST API Overview

Elasticsearch is fully REST-based. All operations use standard HTTP verbs:

| Verb | Purpose |
|------|---------|
| `PUT` | Create or replace a resource (index, document by ID) |
| `POST` | Append/update (document without ID, `_search`, `_bulk`) |
| `GET` | Read |
| `DELETE` | Delete |
| `HEAD` | Check existence without returning body |

Essential cluster-level commands:

```bash
# Check cluster health (green/yellow/red)
curl -s http://localhost:9200/_cluster/health | jq .

# List all indices with key stats
curl -s "http://localhost:9200/_cat/indices?v&h=index,health,pri,rep,docs.count,store.size"

# Get index mapping
curl -s http://localhost:9200/logs-app-2024/_mapping | jq .

# Get index settings
curl -s http://localhost:9200/logs-app-2024/_settings | jq .

# Check if an index exists (returns 200 or 404, no body)
curl -o /dev/null -w "%{http_code}\n" -s -I http://localhost:9200/logs-app-2024

# Delete an index
curl -s -X DELETE http://localhost:9200/logs-app-2024 | jq .
```

## Worked Example — Designing a Logging Index for a Microservices Platform

Scenario: You have 5 services each emitting ~10,000 logs/minute. You need 30-day retention with fast querying for the last 7 days. Here is the full setup sequence:

```bash
# Step 1 — Create the ILM policy
curl -s -X PUT http://localhost:9200/_ilm/policy/service-logs-policy \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "policy": {
    "phases": {
      "hot":  { "actions": { "rollover": { "max_size": "30gb", "max_age": "1d" } } },
      "warm": { "min_age": "3d", "actions": { "shrink": { "number_of_shards": 1 }, "forcemerge": { "max_num_segments": 1 } } },
      "delete": { "min_age": "30d", "actions": { "delete": {} } }
    }
  }
}
EOF

# Step 2 — Create the index template with explicit mappings
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

# Step 3 — Create the data stream; the template auto-applies
curl -s -X PUT http://localhost:9200/_data_stream/service-logs-payment | jq .

# Step 4 — Index a test document
curl -s -X POST http://localhost:9200/service-logs-payment/_doc \
  -H "Content-Type: application/json" \
  -d '{ "@timestamp": "2024-03-15T10:23:00Z", "service_name": "payment-api", "level": "ERROR", "message": "Connection pool exhausted", "response_time": 5021, "client_ip": "10.0.2.100" }' | jq .

# Step 5 — Verify the backing index picked up the ILM policy
curl -s "http://localhost:9200/service-logs-payment/_ilm/explain" | jq '.indices | to_entries[0].value | {phase, age, policy}'
```

This gives you keyword-fast filtering by service and level, full-text search on messages, and automatic index management — no manual rollover required.

## Exercises

### Exercise 1 — Create an Index with Explicit Mappings

Start the local Docker container described at the top of this lesson. Then create an index named `inventory` with the following explicit mapping:

| Field | Type | Rationale |
|-------|------|-----------|
| `item_name` | `keyword` | Exact match and aggregation |
| `description` | `text` | Full-text search |
| `quantity` | `integer` | Numeric |
| `last_updated` | `date` | Timestamp |

```bash
curl -s -X PUT http://localhost:9200/inventory \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "item_name":    { "type": "keyword" },
      "description":  { "type": "text" },
      "quantity":     { "type": "integer" },
      "last_updated": { "type": "date", "format": "strict_date_optional_time" }
    }
  }
}
EOF
```

Verify the mapping was applied correctly:

```bash
curl -s http://localhost:9200/inventory/_mapping | jq '.inventory.mappings.properties'
```

Confirm you can see all four fields with the types you specified. Then index one document and use `_mapping` again to confirm ES did not dynamically add any additional fields:

```bash
curl -s -X POST http://localhost:9200/inventory/_doc \
  -H "Content-Type: application/json" \
  -d '{ "item_name": "server-rack-42u", "description": "42U rack cabinet with cable management", "quantity": 3, "last_updated": "2024-03-15T00:00:00Z" }' | jq .
```

### Exercise 2 — Create and Attach an ILM Policy

Create an ILM policy named `inventory-policy` with these rules:
- Hot phase: rollover when the index reaches 5 GB or is 7 days old
- Warm phase: start 14 days after rollover; forcemerge to 1 segment
- Delete phase: delete 60 days after rollover

Then attach it to the `inventory` index you created in Exercise 1.

```bash
# Create the policy
curl -s -X PUT http://localhost:9200/_ilm/policy/inventory-policy \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": { "max_size": "5gb", "max_age": "7d" }
        }
      },
      "warm": {
        "min_age": "14d",
        "actions": {
          "forcemerge": { "max_num_segments": 1 }
        }
      },
      "delete": {
        "min_age": "60d",
        "actions": { "delete": {} }
      }
    }
  }
}
EOF

# Attach to the existing inventory index
curl -s -X PUT http://localhost:9200/inventory/_settings \
  -H "Content-Type: application/json" \
  -d '{ "index.lifecycle.name": "inventory-policy" }' | jq .

# Verify the policy is attached and check current ILM state
curl -s http://localhost:9200/inventory/_ilm/explain | jq '.indices.inventory | {policy, phase, age}'
```

### Exercise 3 — Design a Production Node Configuration

Design the node-role configuration for a 9-node production cluster handling 500 GB/day of logs. Write out the `node.roles` stanza for each node type and explain the rationale.

Recommended allocation: **3 dedicated master nodes**, **5 data nodes**, **1 coordinating-only node**.

```yaml
# master-1, master-2, master-3 — dedicated master nodes
node.roles: [ master ]
# Rationale: dedicated masters have no data responsibility, so
# GC pauses from indexing workloads cannot delay heartbeats
# and cause spurious master-election storms.

# data-1 through data-5 — data nodes
node.roles: [ data, ingest ]
# Rationale: ingest pipelines (geoIP, grok, timestamp parsing)
# run on the same node that holds the data, reducing network hops.
# 500 GB/day ÷ 5 nodes = 100 GB/day per node, well within
# a reasonable range for a 2–4 TB SSD node.

# coordinating-1 — coordinating-only node (no roles declared)
node.roles: []
# Rationale: heavy aggregation and search queries scatter/gather
# across all 5 data nodes. Offloading the merge step to a
# dedicated coordinating node prevents large aggregation results
# from consuming heap on data nodes that are also indexing.
```

Cluster configuration file shared by all nodes:

```yaml
# elasticsearch.yml (shared sections)
cluster.name: prod-logs
discovery.seed_hosts:
  - "10.0.1.10"   # master-1
  - "10.0.1.11"   # master-2
  - "10.0.1.12"   # master-3
cluster.initial_master_nodes:
  - "master-1"
  - "master-2"
  - "master-3"
```

Key question to answer: why must `cluster.initial_master_nodes` list exactly the initial master-eligible nodes and be removed from the config once the cluster is formed? (Answer: it prevents split-brain when the cluster restarts later with a different master-eligible set.)

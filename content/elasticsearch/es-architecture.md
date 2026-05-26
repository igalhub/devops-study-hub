---
title: Architecture & Data Model
module: elasticsearch
duration_min: 20
difficulty: beginner
tags: [elasticsearch, architecture, indexing, mappings, ilm]
exercises: 3
---

## Overview
Elasticsearch is a distributed, RESTful search and analytics engine built on Apache Lucene. In a DevOps context it is the backbone of the ELK/Elastic Stack, ingesting logs, metrics, and traces from across your infrastructure and making them searchable in near-real-time. Understanding its data model — how a cluster organises shards, replicas, and indices — is prerequisite knowledge before you can tune performance, diagnose split-brains, or build reliable ILM policies.

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

In production, always run **dedicated master nodes** (3 for quorum) separate from data nodes to prevent resource contention from killing master elections.

```yaml
# elasticsearch.yml — dedicated master node
node.roles: [ master ]
cluster.name: prod-logs
node.name: master-1
network.host: 10.0.1.10
discovery.seed_hosts: ["10.0.1.10", "10.0.1.11", "10.0.1.12"]
cluster.initial_master_nodes: ["master-1", "master-2", "master-3"]
```

### Indices, Shards, and Replicas

An **index** is a logical namespace for a collection of documents. Physically each index is split into **primary shards** and optionally one or more **replica shards**.

- **Primary shards** — determined at index creation, cannot be changed without reindex.
- **Replica shards** — copies of primaries; serve read requests and provide failover.

```bash
# Create an index with 3 primaries and 1 replica per primary
PUT /logs-app-2024
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1
  }
}
```

Shard sizing rule of thumb: aim for **10–50 GB per shard**. Too many small shards waste heap; too few large shards reduce parallelism.

### Index vs Data Stream

| | Index | Data Stream |
|---|---|---|
| Use case | General documents | Time-series (logs, metrics) |
| Write target | The index itself | Hidden backing indices |
| Rollover | Manual or ILM | Automatic via ILM |
| Read | Single index | All backing indices |

Data streams require an **index template** with `data_stream: {}` enabled.

```bash
# Create an index template for a data stream
PUT _index_template/logs-template
{
  "index_patterns": ["logs-*"],
  "data_stream": {},
  "template": {
    "settings": { "number_of_shards": 1 },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" }
      }
    }
  }
}
```

### Mappings and Field Types

A **mapping** defines the schema for documents in an index. Elasticsearch infers mappings dynamically, but dynamic mapping often produces incorrect types (e.g., a numeric string mapped as `long`). Always define explicit mappings in production.

Key field types:

| Type | Use for |
|------|---------|
| `keyword` | Exact-match, aggregations, sorting (IDs, status codes, hostnames) |
| `text` | Full-text search (log messages, descriptions) — analyzed/tokenized |
| `date` | Timestamps; format can be specified |
| `integer` / `long` | Numeric counts, durations |
| `boolean` | True/false flags |
| `ip` | IPv4/IPv6 addresses with CIDR query support |
| `object` | Nested JSON object (flat, not independently queryable) |
| `nested` | Array of objects where each object must be queried independently |

```bash
PUT /services
{
  "mappings": {
    "properties": {
      "service_name":  { "type": "keyword" },
      "log_message":   { "type": "text" },
      "timestamp":     { "type": "date", "format": "strict_date_optional_time" },
      "response_time": { "type": "integer" },
      "success":       { "type": "boolean" },
      "client_ip":     { "type": "ip" }
    }
  }
}
```

The `keyword`/`text` split is a common interview question: `keyword` stores the raw value and supports exact match and aggregations; `text` is tokenized and supports full-text search but **not** aggregations. A field can have both via a `fields` sub-mapping (multi-fields).

### Index Lifecycle Management (ILM)

ILM automates the transition of indices through phases — **hot → warm → cold → frozen → delete** — based on age or size. This is essential for log data where you want fast writes initially and cheap storage long-term.

```bash
PUT _ilm/policy/logs-policy
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
```

### REST API Overview

Elasticsearch is fully REST-based. All operations use standard HTTP verbs:

| Verb | Purpose |
|------|---------|
| `PUT` | Create or replace a resource (index, document by ID) |
| `POST` | Append/update (document without ID, `_search`, `_bulk`) |
| `GET` | Read |
| `DELETE` | Delete |
| `HEAD` | Check existence without returning body |

```bash
# Check cluster health
GET /_cluster/health

# List all indices
GET /_cat/indices?v&h=index,health,pri,rep,docs.count,store.size

# Get index mapping
GET /logs-app-2024/_mapping

# Delete an index
DELETE /logs-app-2024
```

## Examples

### Designing a Logging Index for a Microservices Platform

You have 5 services, each emitting ~10 k logs/minute. You need 30-day retention with fast querying for the last 7 days.

Approach:
1. Create a data stream `logs-{service}-{env}` backed by an index template.
2. Attach an ILM policy: rollover at 30 GB or 1 day → warm after 3 days (shrink + forcemerge) → delete after 30 days.
3. Map `service_name`, `level`, `trace_id` as `keyword`; `message` as `text`; `@timestamp` as `date`.
4. 1 primary shard per backing index (rolled daily, so size stays small), 1 replica for HA.

This gives you keyword-fast filtering by service/level, full-text search on messages, and zero manual index management.

## Exercises

1. Start a local single-node Elasticsearch cluster with Docker (`docker run -p 9200:9200 -e "discovery.type=single-node" elasticsearch:8.12.0`). Create an index `inventory` with explicit mappings: `item_name` (keyword), `description` (text), `quantity` (integer), `last_updated` (date). Verify the mapping with `GET /inventory/_mapping`.

2. Create an ILM policy named `inventory-policy` that rolls over when the index reaches 5 GB or 7 days old, moves to warm after 14 days (forcemerge to 1 segment), and deletes after 60 days. Attach it to the `inventory` index via its settings.

3. Design the node-role configuration for a 9-node production cluster handling 500 GB/day of logs. Specify how many master-eligible, data, and coordinating-only nodes you would deploy and why. Write out the relevant `node.roles` stanzas for each node type.

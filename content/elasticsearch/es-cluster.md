---
title: Cluster Management
module: elasticsearch
duration_min: 20
difficulty: intermediate
tags: [elasticsearch, cluster-health, cat-api, snapshots, aliases, reindex]
exercises: 3
---

## Overview
Running Elasticsearch in production means knowing how to interpret cluster health, diagnose shard problems, reroute data safely, and perform operations like reindex and snapshot/restore without downtime. These are the tasks that land on a DevOps or SRE engineer when the Kibana status turns yellow or red at 2 AM — and they are staples of Elastic-related interviews.

## Concepts

### Cluster Health

```bash
GET /_cluster/health
```

```json
{
  "cluster_name": "prod-logs",
  "status": "yellow",
  "timed_out": false,
  "number_of_nodes": 3,
  "number_of_data_nodes": 3,
  "active_primary_shards": 15,
  "active_shards": 15,
  "relocating_shards": 0,
  "initializing_shards": 0,
  "unassigned_shards": 5,
  "number_of_pending_tasks": 0
}
```

| Status | Meaning |
|--------|---------|
| `green` | All primary and replica shards assigned |
| `yellow` | All primaries assigned; one or more replicas unassigned |
| `red` | One or more primary shards unassigned — partial data loss risk |

**Yellow** on a single-node cluster is normal — there is nowhere to place a replica. In a multi-node cluster, yellow is a warning that you have lost HA. Red means some data is actively unavailable.

Wait for a specific status (useful in scripts):
```bash
GET /_cluster/health?wait_for_status=green&timeout=60s
```

### Cat APIs

The `_cat` APIs return human-readable tabular output. The `?v` flag adds column headers; `?h=col1,col2` selects specific columns; `?s=col` sorts by a column.

```bash
# Cluster-level summary
GET /_cat/health?v

# All nodes with heap and disk stats
GET /_cat/nodes?v&h=name,heap.percent,ram.percent,cpu,load_1m,node.role,master

# All indices sorted by store size (descending)
GET /_cat/indices?v&h=index,health,pri,rep,docs.count,store.size&s=store.size:desc

# Shard distribution — which shard lives on which node
GET /_cat/shards?v&h=index,shard,prirep,state,unassigned.reason,node

# Pending cluster tasks (useful during rolling restarts)
GET /_cat/pending_tasks?v
```

The `unassigned.reason` column in `_cat/shards` is critical for diagnosis. Common values:

| Reason | Meaning |
|--------|---------|
| `NODE_LEFT` | Node that held the shard left the cluster |
| `ALLOCATION_FAILED` | Shard allocation attempted but failed (check logs) |
| `INDEX_CREATED` | Freshly created — waiting for a node with space |
| `CLUSTER_RECOVERED` | Post-restart recovery in progress |

### Shard Allocation

**Check allocation explanation:**
```bash
GET /_cluster/allocation/explain
{
  "index": "logs-app-2024",
  "shard": 0,
  "primary": false
}
```

This is the first command to run when shards are stuck. The response tells you exactly why allocation failed — disk watermark breached, node attribute mismatch, allocation filter, etc.

**Manual shard reroute:**
```bash
POST /_cluster/reroute
{
  "commands": [
    {
      "move": {
        "index": "logs-app-2024",
        "shard": 0,
        "from_node": "data-node-1",
        "to_node": "data-node-2"
      }
    }
  ]
}
```

**Temporarily disable allocation** (useful before node maintenance):
```bash
PUT /_cluster/settings
{
  "persistent": {
    "cluster.routing.allocation.enable": "primaries"
  }
}
# Re-enable after maintenance
PUT /_cluster/settings
{
  "persistent": {
    "cluster.routing.allocation.enable": null
  }
}
```

Disk watermarks (defaults):
- Low: 85% — stop allocating new shards to this node
- High: 90% — start relocating shards away from this node
- Flood stage: 95% — index becomes read-only

### Reindex API

Reindex copies documents from a source index to a destination. Use cases: changing mappings (field types cannot be changed in-place), changing shard count, migrating data.

```bash
POST /_reindex
{
  "source": {
    "index": "logs-app-old",
    "query": {
      "range": { "@timestamp": { "gte": "2024-01-01" } }
    }
  },
  "dest": {
    "index": "logs-app-new",
    "op_type": "create"
  }
}
```

`op_type: create` prevents overwriting existing documents. For large reindexes, run asynchronously:

```bash
POST /_reindex?wait_for_completion=false
# Returns a task ID
GET /_tasks/<task_id>
# Cancel if needed
POST /_tasks/<task_id>/_cancel
```

### Index Aliases

An alias is a virtual index name that can point to one or more real indices. They are the standard way to enable zero-downtime reindex and index switching.

```bash
# Create an alias pointing to a new index
POST /_aliases
{
  "actions": [
    { "add":    { "index": "logs-app-v2", "alias": "logs-app" } },
    { "remove": { "index": "logs-app-v1", "alias": "logs-app" } }
  ]
}
```

Aliases support **filters** (give different users or apps a restricted view):
```bash
POST /_aliases
{
  "actions": [{
    "add": {
      "index": "logs-app-2024",
      "alias": "logs-errors",
      "filter": { "term": { "level": "ERROR" } }
    }
  }]
}
```

A **write alias** designates which index receives new documents when writing to the alias — exactly one index per alias can have `"is_write_index": true`.

### Snapshot and Restore

Snapshots are the primary backup mechanism. They are incremental — only segments changed since the last snapshot are written.

**Register a repository** (S3 example):
```bash
PUT /_snapshot/s3-backup
{
  "type": "s3",
  "settings": {
    "bucket": "my-es-backups",
    "region": "us-east-1",
    "base_path": "prod-cluster"
  }
}
```

**Create a snapshot:**
```bash
PUT /_snapshot/s3-backup/snapshot-2024-03-15
{
  "indices": "logs-*",
  "ignore_unavailable": true,
  "include_global_state": false
}
```

**Monitor progress:**
```bash
GET /_snapshot/s3-backup/snapshot-2024-03-15/_status
```

**Restore:**
```bash
POST /_snapshot/s3-backup/snapshot-2024-03-15/_restore
{
  "indices": "logs-app-2024",
  "rename_pattern": "logs-(.+)",
  "rename_replacement": "restored-logs-$1",
  "index_settings": {
    "index.number_of_replicas": 0
  }
}
```

Restore replicas as 0 initially for speed; scale back up after recovery completes.

### Rolling Upgrades

Elasticsearch supports rolling upgrades within the same major version without downtime. Steps:

1. Disable shard allocation: `cluster.routing.allocation.enable: none`
2. Stop one node, upgrade the Elasticsearch binary.
3. Start the node, wait for it to rejoin: `GET /_cat/nodes`
4. Re-enable allocation: `cluster.routing.allocation.enable: null`
5. Wait for cluster to go green: `GET /_cluster/health?wait_for_status=green`
6. Repeat for the next node.

Cross-major-version upgrades (e.g., 7 → 8) require reading the breaking changes docs and may need a full cluster restart or intermediate version hop.

### Cluster Settings

Settings have two persistence levels:

| Level | Key | Survives restart |
|-------|-----|-----------------|
| Transient | `transient` | No |
| Persistent | `persistent` | Yes |

Persistent settings override `elasticsearch.yml`. Transient are lost on full cluster restart. Prefer transient for temporary operational changes (watermarks, allocation), persistent for long-lived policy.

```bash
# Temporarily raise flood watermark during disk pressure
PUT /_cluster/settings
{
  "transient": {
    "cluster.routing.allocation.disk.watermark.flood_stage": "97%"
  }
}
```

## Examples

### Yellow Cluster Runbook

1. `GET /_cluster/health` — confirm yellow and count `unassigned_shards`.
2. `GET /_cat/shards?v&h=index,shard,prirep,state,unassigned.reason,node` — find which shards are unassigned.
3. `GET /_cluster/allocation/explain` — get the definitive reason from Elasticsearch.
4. Common fixes:
   - **Disk watermark**: free space, or temporarily raise the watermark setting.
   - **NODE_LEFT**: wait for the node to return, or force-allocate the replica elsewhere.
   - **Single-node cluster**: set `number_of_replicas: 0` on small dev/test indices.

## Exercises

1. Simulate a yellow cluster on a local Docker setup (two Elasticsearch nodes, one replica per index). Stop one container. Run `_cat/shards` and `_cluster/allocation/explain` and document every field in the explain output. Bring the node back and observe the recovery sequence using `_cat/recovery?v`.

2. Create an index `products-v1` with 2 shards and index 100 documents. Change the mapping by adding a new `sku` (keyword) field — without reindex. Then add a `price_float` field that should have been `float` but was indexed as `keyword`. Perform a reindex to `products-v2` with the corrected mapping. Flip the alias `products` from `products-v1` to `products-v2` atomically with a single `_aliases` call. Verify the old index is no longer the write target.

3. Set up an S3-compatible snapshot repository using MinIO in Docker (or a real S3 bucket). Take a snapshot of all indices, delete one index, then restore only that index using `rename_replacement` to restore it under a different name. Verify document counts match before and after using `_cat/indices`.


---

### Quick Checks

4. Calculate the minimum master-eligible nodes for quorum in a 5-node cluster. Run: `python3 -c "nodes=5; print(nodes // 2 + 1)"`

```expected_output
3
```

5. Count green-status clusters in a health summary. Run: `printf 'cluster_1: green\ncluster_2: yellow\ncluster_3: green\ncluster_4: green\n' | awk '{count[$2]++} END{print count["green"]}'`

```expected_output
3
```

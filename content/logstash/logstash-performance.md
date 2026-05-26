---
title: Performance Tuning
module: logstash
duration_min: 20
difficulty: intermediate
tags: [logstash, performance, tuning, jvm, monitoring]
exercises: 3
---

## Overview
A misconfigured Logstash node is a common cause of log pipeline backpressure, data loss, and excessive Elasticsearch indexing latency. Tuning Logstash is mostly a matter of matching worker threads and batch sizes to your workload profile, sizing queues correctly, and knowing where to look when things slow down. This lesson covers the levers available, how to read the monitoring API, and when Logstash is the right tool versus a direct Filebeat-to-Elasticsearch path.

## Concepts

### Pipeline Workers vs Batch Size

These two settings have different effects and are often confused:

| Setting | Controls | Effect of increasing |
|---|---|---|
| `pipeline.workers` | Parallelism (filter + output) | More CPU used; helps I/O-bound outputs |
| `pipeline.batch.size` | Events per worker iteration | Higher throughput, higher memory use, more latency |
| `pipeline.batch.delay` | Wait time (ms) to fill a batch | Higher = fewer, fuller batches |

**Starting point:**

```yaml
# logstash.yml or per-pipeline in pipelines.yml
pipeline.workers: 4          # match CPU core count
pipeline.batch.size: 250     # 2× default of 125
pipeline.batch.delay: 50
```

**Tuning rules:**
- If CPU is at 100% and you need more throughput: add Logstash nodes, not more workers.
- If Elasticsearch is the bottleneck (slow bulk indexing): increase `pipeline.workers` so more threads push concurrently.
- If memory is tight: lower `pipeline.batch.size` — each in-flight event holds its full field map in heap.
- If you have fast inputs but slow filters (heavy grok on complex patterns): more workers.

### Persistent Queue Sizing
The persistent queue (PQ) buffers events on disk between input and filter stages. Size it to absorb your worst-case burst — typically 2–3× your peak 5-minute ingest volume.

```yaml
queue.type: persisted
queue.max_bytes: 8gb
queue.checkpoint.writes: 1024   # fsync every N writes; lower = more durable, slower
queue.drain: false              # true = drain queue before shutdown (slower restart)
```

Monitor queue occupancy via the API:

```bash
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.queue'
```

Fields to watch:
- `queue.events` — events currently in queue (should stay near 0 under normal load)
- `queue.capacity.page_capacity_in_bytes` — page file size
- `queue.data.storage_size_in_bytes` — current disk used

If `queue.events` is consistently > 0, your filter/output stage is slower than your input — a backpressure condition.

### JVM Heap Settings
Logstash runs on the JVM. Heap is configured in `/etc/logstash/jvm.options`:

```
# /etc/logstash/jvm.options
-Xms2g
-Xmx2g
```

Rules:
- Set `-Xms` and `-Xmx` to the **same value** to avoid heap resizing pauses.
- Do not exceed 50% of available RAM (leave room for OS page cache and the persistent queue's off-heap I/O).
- Minimum practical heap for a loaded pipeline: 2 GB.
- For heavy pipelines (many grok patterns, large batch sizes): 4–8 GB.

```bash
# Check current JVM memory usage via API
curl -s http://localhost:9600/_node/stats/jvm | jq '.jvm.mem'
```

Watch for `jvm.gc.collectors.old.collection_time_in_millis` climbing — indicates heap pressure.

### Monitoring API
The monitoring API (port 9600 by default) is the primary operational view into Logstash.

```bash
# Node info (version, pipeline config)
curl -s http://localhost:9600/_node | jq .

# Full stats
curl -s http://localhost:9600/_node/stats | jq .

# Events stats for a specific pipeline
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.events'
```

Key metrics from `/_node/stats/pipelines/<id>`:

| Metric path | What it tells you |
|---|---|
| `events.in` | Total events received by input |
| `events.filtered` | Events that passed through filters |
| `events.out` | Events sent to output |
| `events.duration_in_millis` | Total wall time in pipeline |
| `plugins.filters[].events.duration_in_millis` | Time spent per filter plugin |
| `plugins.outputs[].events.out` | Successful output writes |
| `queue.events` | Current persistent queue depth |

If `events.in` >> `events.out`, check your output (Elasticsearch down? Network issues?).

### Profiling with slow_log
`slow_log` logs warnings when individual events take too long through a specific plugin.

```yaml
# logstash.yml
slowlog.threshold.warn: 2s
slowlog.threshold.info: 1s
slowlog.threshold.debug: 500ms
slowlog.threshold.trace: 100ms
```

Slow log entries appear in `logstash-slowlog-plain.log` and show which filter plugin caused the delay and the event payload (redact sensitive data in production).

Alternatively, use the `/_node/stats` API to compare `duration_in_millis` across filter plugins — the outlier is your bottleneck.

### Beats + Logstash + Elasticsearch Pipeline Scaling
A typical production topology:

```
[App Servers]
  Filebeat (per host)
      │  (Beats protocol, TLS)
      ▼
[Logstash Tier]  (2–4 nodes behind load balancer)
  Logstash       → persistent queue
      │  (Elasticsearch bulk API, HTTPS)
      ▼
[Elasticsearch Tier]
  Data nodes (ILM-managed indices)
```

Scaling guidance:

| Bottleneck | Fix |
|---|---|
| Logstash CPU saturated | Add Logstash nodes; distribute Filebeat outputs |
| Logstash I/O (PQ) saturated | Use faster disks (SSD) or reduce `queue.checkpoint.writes` |
| Elasticsearch bulk rejections | Increase Elasticsearch indexing thread pool or add data nodes |
| Network between LS and ES | Co-locate Logstash in same datacenter/VPC as Elasticsearch |
| Filebeat backpressure | Increase Filebeat `queue.mem.events` or add Logstash nodes |

Use Kibana Stack Monitoring → Logstash to visualise events throughput, JVM heap, and CPU across nodes.

### When to Use Filebeat Directly vs via Logstash

| Scenario | Recommendation |
|---|---|
| Simple JSON logs, no transformation needed | Filebeat → Elasticsearch directly |
| Structured logs already in correct format | Filebeat → Elasticsearch directly |
| Multiple heterogeneous log formats requiring grok | Filebeat → Logstash → Elasticsearch |
| Need to route logs to multiple outputs (ES + Kafka) | Logstash |
| Need complex enrichment (GeoIP, DNS lookup, JDBC) | Logstash |
| Tight latency budget, simple pipeline | Skip Logstash; use Filebeat ingest node pipelines in ES |
| Legacy syslog sources that can't run Filebeat | Logstash `syslog` input |

Logstash adds operational complexity (JVM, PQ management, another service to monitor). Justify it with functional requirements, not habit.

## Examples

### Tuning checklist for a loaded Logstash node

```bash
# 1. Check event throughput per pipeline
curl -s http://localhost:9600/_node/stats/pipelines | \
  jq '.pipelines | to_entries[] | {pipeline: .key, events_in: .value.events.in, events_out: .value.events.out}'

# 2. Find the slowest filter plugin
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '[.pipelines.main.plugins.filters[] | {name: .name, duration_ms: .events.duration_in_millis}] | sort_by(.duration_ms) | reverse'

# 3. Check JVM GC pressure
curl -s http://localhost:9600/_node/stats/jvm | \
  jq '.jvm.gc.collectors'

# 4. Check persistent queue depth
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.queue | {events: .events, size_bytes: .data.storage_size_in_bytes}'
```

### jvm.options for a 16 GB RAM host

```
# /etc/logstash/jvm.options
-Xms6g
-Xmx6g
-XX:+UseG1GC
-XX:G1ReservePercent=25
-XX:InitiatingHeapOccupancyPercent=30
```

G1GC is the recommended collector for Logstash heap sizes > 4 GB.

## Exercises

1. A Logstash pipeline is processing 50,000 events/second from Kafka but only delivering 30,000/second to Elasticsearch. The monitoring API shows `queue.events` growing steadily. Walk through the diagnostic steps you would take: which API endpoints, which metrics, and what the three most likely root causes are.

2. Your Logstash host has 8 CPU cores and 16 GB RAM. Calculate appropriate values for `pipeline.workers`, `pipeline.batch.size`, `-Xms`/`-Xmx`, and `queue.max_bytes` for a pipeline with heavy grok processing and Elasticsearch as the sole output. Justify each choice.

3. You need to ship the same log stream to both Elasticsearch and a Kafka topic for a downstream ML pipeline. Currently Filebeat ships directly to Elasticsearch. Explain why Logstash is needed here, draw the new topology, and write the output block of the Logstash pipeline config that handles the fan-out.

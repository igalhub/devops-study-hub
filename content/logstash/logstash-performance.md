---
title: Performance Tuning
module: logstash
duration_min: 20
difficulty: intermediate
tags: [logstash, performance, tuning, jvm, monitoring]
exercises: 3
---

## Overview

Logstash sits at the processing core of many ELK-stack pipelines, responsible for ingesting, transforming, and routing log data at scale. A misconfigured Logstash node is one of the most common causes of log pipeline backpressure, data loss, and excessive Elasticsearch indexing latency. Because Logstash is a JVM process with persistent on-disk queues, multi-threaded pipeline workers, and a plugin-per-stage architecture, its performance characteristics differ significantly from simpler log shippers like Filebeat — and its failure modes are correspondingly more nuanced.

Tuning Logstash is a matter of matching three resources to your workload profile: CPU (pipeline workers), memory (JVM heap and batch sizes), and disk I/O (persistent queue throughput). These levers interact — increasing batch size raises throughput but also heap pressure; adding workers increases parallelism but also contention on shared queue locks. The monitoring API provides the operational feedback loop that makes tuning empirical rather than guesswork.

In the broader DevOps toolchain, Logstash occupies the transformation tier between data collection (Filebeat, Fluentd, syslog) and storage/analysis (Elasticsearch, Kafka, S3). It is not always the right choice — Elasticsearch ingest node pipelines and Filebeat processors handle simple transformations with less operational overhead. Knowing when Logstash earns its place, and when it is unnecessary complexity, is as important as knowing how to tune it.

## Concepts

### Pipeline Workers vs Batch Size

These two settings are the primary performance levers and are frequently confused because both affect throughput. They operate at different stages of the pipeline and have distinct resource implications.

| Setting | Controls | Effect of increasing |
|---|---|---|
| `pipeline.workers` | Parallelism — number of threads running filter + output stages | More CPU used; higher concurrency to outputs; helps I/O-bound outputs |
| `pipeline.batch.size` | Events pulled per worker per iteration from the queue | Higher throughput per worker; higher heap use; increases per-batch latency |
| `pipeline.batch.delay` | Milliseconds a worker waits to fill a batch before processing | Higher = fewer, fuller batches; useful for bursty inputs |

```yaml
# logstash.yml — or per-pipeline in pipelines.yml
pipeline.workers: 4          # start at vCPU count; increase if output is I/O-bound
pipeline.batch.size: 250     # 2× the default of 125; raise for high-volume ES output
pipeline.batch.delay: 50     # ms; default 50 is reasonable for most workloads
```

**Tuning rules — apply in order:**

1. **CPU at 100%, throughput still low:** Don't add more workers past the point of diminishing returns. Add Logstash nodes. Worker threads beyond 2× vCPU count rarely help and increase lock contention.
2. **Elasticsearch is the bottleneck (slow bulk API, high indexing latency):** Increase `pipeline.workers` so more threads push bulk requests concurrently. Each worker generates one bulk request per batch.
3. **Memory pressure or OOM errors:** Lower `pipeline.batch.size`. Each in-flight event occupies its full field map in heap — a 1 KB event × 250 batch size × 4 workers = 1 MB minimum, but grok-parsed events with many fields can be 10–50× larger.
4. **Heavy grok filters on complex patterns, CPU not saturated:** Add workers. Filter stages are CPU-bound and fully parallelised.
5. **Many small events from a bursty input:** Increase `pipeline.batch.delay` to let batches fill before processing. Reduces per-event overhead.

**Gotcha:** `pipeline.workers` only parallelises filter and output stages. The input stage runs in its own thread(s) regardless. A single slow input plugin will not benefit from more workers.

**Gotcha:** Each Logstash pipeline defined in `pipelines.yml` has its own independent worker pool. If you run four pipelines each with `pipeline.workers: 4` on a 4-vCPU host, you have 16 competing threads on 4 cores — CPU contention will dominate. Size total workers across all pipelines to roughly 1.5–2× total vCPUs.

### Persistent Queue Sizing

The persistent queue (PQ) buffers events on disk between the input stage and the filter/output workers. Its primary purpose is absorbing bursts and surviving Logstash restarts without data loss. Without PQ, a Logstash crash drops any events in flight.

```yaml
# logstash.yml
queue.type: persisted
queue.max_bytes: 8gb            # cap disk usage; input blocks when queue is full
queue.checkpoint.writes: 1024   # fsync every N page writes; lower = more durable, slower disk I/O
queue.drain: false              # true = drain queue before shutdown; causes slower restarts
```

Size `queue.max_bytes` to absorb your worst-case burst window — typically 2–3× your peak 5-minute ingest volume expressed in bytes. If you ingest 500 MB/min at peak, a 3 GB queue gives you a 6-minute recovery window while your output catches up or you respond to an alert.

```bash
# Inspect queue stats for the 'main' pipeline
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.queue'
```

**Fields to watch:**

| Field | Normal value | Alarm condition |
|---|---|---|
| `queue.events` | Near 0 under steady load | Steadily growing → output bottleneck |
| `queue.capacity.page_capacity_in_bytes` | Matches your page file config | Unexpectedly large → check disk |
| `queue.data.storage_size_in_bytes` | < 20% of `queue.max_bytes` | > 80% → approaching backpressure |

**Gotcha:** When `queue.max_bytes` is reached, the input plugin blocks. For Beats inputs, this propagates backpressure to Filebeat, which pauses harvesting. For Kafka inputs, offsets stop advancing. This is safe — events are not dropped — but it is visible in Filebeat logs and Kafka consumer lag metrics. Monitor it so you know backpressure is intentional rather than a sign of a stalled output.

**Checkpoint tuning:** `queue.checkpoint.writes: 1024` means one fsync per 1024 page writes. On spinning disks or high-durability requirements, lower to 128–256. On NVMe with a deadline I/O scheduler, the default is fine. Use `iostat -x 1` to verify you are not saturating disk write throughput before attributing latency to other causes.

```bash
# Watch PQ disk I/O — look for await > 10ms on the PQ volume
iostat -x 1 5 | grep -E "Device|sdb"   # replace sdb with your PQ disk device
```

**queue.drain:** Setting `queue.drain: true` causes Logstash to finish processing all queued events before shutting down. This can delay a restart by minutes during high-backlog situations. Leave it `false` for rolling restarts in production — the PQ already preserves events across restarts, so draining is redundant.

### JVM Heap Settings

Logstash runs on the JVM; heap is the most common source of performance problems after pipeline misconfiguration. Heap is configured in `/etc/logstash/jvm.options` (or `config/jvm.options` in non-packaged installs).

```
# /etc/logstash/jvm.options
-Xms4g
-Xmx4g
-XX:+UseG1GC
-XX:G1ReservePercent=25
-XX:InitiatingHeapOccupancyPercent=30
```

**Sizing rules:**

| Host RAM | Recommended heap | Rationale |
|---|---|---|
| 8 GB | 2–3 GB | Leave 5+ GB for OS page cache and PQ I/O buffers |
| 16 GB | 4–6 GB | Ceiling of 50% of RAM; G1GC recommended above 4 GB |
| 32 GB | 8–12 GB | Do not exceed ~31 GB — JVM compressed OOPs disabled above that |
| 64 GB | 16–20 GB | Consider splitting into multiple Logstash processes instead |

**Critical rules:**
- Always set `-Xms` equal to `-Xmx`. Mismatched values cause the JVM to resize the heap at runtime, triggering full GC pauses that manifest as sudden throughput drops visible in pipeline event-rate graphs.
- Never exceed 50% of host RAM. The other half is needed for the OS page cache (which accelerates PQ reads/writes) and off-heap JVM internals.
- Do not go above ~31 GB. Above this threshold, the JVM disables compressed ordinary object pointers (OOPs), increasing per-object memory overhead by ~40% — more heap actually buys you less usable space.

```bash
# Check live heap usage — look at heap_used_in_bytes vs heap_max_in_bytes
curl -s http://localhost:9600/_node/stats/jvm | jq '.jvm.mem'

# Watch GC pressure — old-gen collection time climbing indicates heap exhaustion
curl -s http://localhost:9600/_node/stats/jvm | \
  jq '.jvm.gc.collectors.old | {collection_count, collection_time_in_millis}'
```

**GC collector choice:** G1GC (`-XX:+UseG1GC`) is the recommended collector for Logstash. It provides predictable pause times and handles fragmented heap well — important given Logstash's mixed short-lived (batch events) and long-lived (plugin state, compiled grok patterns) object allocations. ZGC is available in JDK 15+ and offers sub-millisecond pause times for very large heaps (> 16 GB), but is less tested with Logstash in production. Stick with G1GC unless you have evidence that GC pauses are the specific problem.

**Gotcha:** If `collection_time_in_millis` for the old collector grows faster than wall time (e.g., 500 ms of GC per second), Logstash is spending more than 50% of CPU on garbage collection. The pipeline will appear to stall intermittently — event throughput will drop in bursts rather than smoothly. Increase heap or reduce `pipeline.batch.size` before investigating anything else.

**`-XX:InitiatingHeapOccupancyPercent=30`:** This tells G1GC to begin concurrent marking when heap is 30% occupied, rather than waiting for the default 45%. For Logstash's allocation patterns this triggers earlier, smaller GC cycles rather than rarer, larger ones — net effect is lower maximum pause time at the cost of slightly more background GC CPU.

### Monitoring API

The monitoring API on port 9600 is the primary operational interface for Logstash. It requires no additional tooling and is always available when Logstash is running. Learn these endpoints — they are what you reach for during an incident before opening dashboards.

```bash
# Node info: version, pipeline config, OS info
curl -s http://localhost:9600/_node | jq .

# Full stats snapshot
curl -s http://localhost:9600/_node/stats | jq .

# Per-pipeline event counts
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.events'

# Compare in vs out across all pipelines — spot where events are being dropped or stuck
curl -s http://localhost:9600/_node/stats/pipelines | \
  jq '.pipelines | to_entries[] | {pipeline: .key, in: .value.events.in, out: .value.events.out, queue_depth: .value.queue.events}'

# Per-filter timing — identify which filter is the CPU bottleneck
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.plugins.filters[] | {id: .id, name: .name, duration_ms: .events.duration_in_millis, count: .events.in}'
```

**Key metrics from `/_node/stats/pipelines/<id>`:**

| Metric path | What it tells you |
|---|---|
| `events.in` | Total events received by input plugins |
| `events.filtered` | Events that completed the filter stage |
| `events.out` | Events successfully written to output |
| `events.duration_in_millis` | Cumulative wall time across all pipeline stages |
| `plugins.filters[n].events.duration_in_millis` | Time spent in a specific filter plugin — use for bottleneck identification |
| `plugins.outputs[n].events.out` | Successful writes per output plugin |
| `plugins.outputs[n].documents.successes` | For ES output: indexed documents |
| `plugins.outputs[n].documents.non_retryable_failures` | For ES output: dropped documents — these are lost |
| `queue.events` | Current event depth in persistent queue |

**Reading the numbers:** `events.in` minus `events.out` gives the current backlog. If this grows monotonically over time, your output is consistently slower than your input. Compare `plugins.filters[].events.duration_in_millis` values across filters — normalize by dividing by `events.in` to get average milliseconds per event. The highest value is your processing bottleneck.

**Gotcha:** All event counts are cumulative since last restart. To get rates, poll the API at a fixed interval and calculate the delta. A simple shell loop:

```bash
# Events-per-second over a 10-second window for the main pipeline
BEFORE=$(curl -s http://localhost:9600/_node/stats/pipelines/main | jq '.pipelines.main.events.out')
sleep 10
AFTER=$(curl -s http://localhost:9600/_node/stats/pipelines/main | jq '.pipelines.main.events.out')
echo "Events/sec: $(( (AFTER - BEFORE) / 10 ))"
```

**Integrating with Prometheus:** Logstash does not natively expose a `/metrics` endpoint in Prometheus format. The community `logstash-exporter` project scrapes the monitoring API and re-exposes metrics in Prometheus format. Alternatively, enable X-Pack monitoring to push metrics into Elasticsearch and visualize them in Kibana's Stack Monitoring UI — this is the approach used in managed ELK environments.

### Profiling with slow_log

`slow_log` logs warnings when individual events exceed per-plugin time thresholds. It is the most direct way to identify which specific filter (or which event shape) is causing latency spikes on individual events — as opposed to the aggregate duration statistics available from the monitoring API.

```yaml
# logstash.yml
slowlog.threshold.warn: 2s
slowlog.threshold.info: 1s
slowlog.threshold.debug: 500ms
slowlog.threshold.trace: 100ms
```

Slow log entries appear in `logstash-slowlog-plain.log` (location configured by `path.logs`). Each entry includes the plugin type and ID that exceeded the threshold, the wall time taken, and the full event payload at the moment of the slow call.

**Production caution:** Slow log entries include the full event payload. If your events contain passwords, API tokens, PII, or payment card data, enable slow log only during active debugging sessions. Ensure the slow log file path is excluded from any centralized log shipping configuration while active.

**Workflow:** Use the monitoring API first (aggregate view) to identify which filter plugin class is consuming the most time across all events. Then enable slow log temporarily to capture the specific events and field patterns that trigger the slowdown. The combination of both tools is faster than either alone — the API narrows the search to a plugin; slow log reveals the pattern.

**Common slow_log findings:**

| Cause | Symptom in slow log | Fix |
|---|---|---|
| Catastrophic grok backtracking | Single events taking > 2s in grok filter | Anchor patterns with `^`; avoid `.*` before literal strings; use `GREEDYDATA` only at end of pattern |
| DNS lookup filter without cache | Each event doing a live DNS resolution | Enable `hit_cache_size` and `hit_cache_ttl` in dns filter config |
| JDBC lookup filter at high rate | Long queue wait times in jdbc_streaming | Add `cache_expiration` and `cache_size` to avoid per-event DB queries |
| Large `translate` filter dictionary | File scanned per event instead of cached | Confirm `refresh_interval` is set; check that dictionary file is not being
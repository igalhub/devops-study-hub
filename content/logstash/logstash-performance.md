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

### Persistent Queue Sizing

The persistent queue (PQ) buffers events on disk between the input stage and the filter/output workers. Its primary purpose is absorbing bursts and surviving Logstash restarts without data loss. Without PQ, a Logstash crash drops any events in flight.

```yaml
# logstash.yml
queue.type: persisted
queue.max_bytes: 8gb            # cap disk usage; input blocks when queue is full
queue.checkpoint.writes: 1024   # fsync every N page writes; lower = more durable, slower disk I/O
queue.drain: false              # true = drain queue before shutdown; causes slower restarts
```

Size `queue.max_bytes` to absorb your worst-case burst window — typically 2–3× your peak 5-minute ingest volume expressed in bytes. If you ingest 500 MB/min at peak, a 3 GB queue gives you a 6-minute recovery window.

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

**Gotcha:** When `queue.max_bytes` is reached, the input plugin blocks. For Beats inputs, this propagates backpressure to Filebeat, which pauses harvesting. For Kafka inputs, offsets stop advancing. This is safe but visible — monitor it.

**Checkpoint tuning:** `queue.checkpoint.writes: 1024` means one fsync per 1024 page writes. On spinning disks or high-durability requirements, lower to 128–256. On NVMe with a deadline scheduler, the default is fine. Use `iostat -x 1` to verify you're not saturating disk write throughput.

```bash
# Verify disk write throughput is not saturated — look at %util for the PQ device
iostat -x 1 5 /dev/nvme0n1

# Check current PQ directory size vs configured max
du -sh /var/lib/logstash/queue/
```

**queue.drain trade-off:** Setting `queue.drain: true` means Logstash will not shut down until the persistent queue is empty. This guarantees no events are lost on graceful shutdown, but can delay a restart by minutes if the queue is deep. In practice, leave it `false` and rely on the PQ's durability guarantee — events will be replayed from the last checkpoint after restart.

### JVM Heap Settings

Logstash runs on the JVM; heap is the most common source of performance problems after pipeline misconfiguration. Heap is set in `/etc/logstash/jvm.options` (or `config/jvm.options` in non-packaged installs).

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
- Always set `-Xms` equal to `-Xmx`. Mismatched values cause the JVM to resize the heap at runtime, triggering full GC pauses that manifest as sudden throughput drops.
- Never exceed 50% of host RAM. The other half is needed for the OS page cache (which accelerates PQ reads/writes) and off-heap JVM internals.
- Do not go above ~31 GB. Above this threshold, the JVM disables compressed ordinary object pointers (OOPs), increasing per-object memory overhead by ~40%.

```bash
# Check live heap usage
curl -s http://localhost:9600/_node/stats/jvm | jq '.jvm.mem'

# Watch GC pressure — old-gen collection time climbing indicates heap exhaustion
curl -s http://localhost:9600/_node/stats/jvm | \
  jq '.jvm.gc.collectors.old | {collection_count, collection_time_in_millis}'
```

**GC collector choice:** G1GC (`-XX:+UseG1GC`) is the recommended collector for Logstash. It provides predictable pause times and handles fragmented heap well — important given Logstash's mixed short-lived (batch events) and long-lived (plugin state) object allocations. ZGC is available in JDK 15+ and offers lower pause times for very large heaps (> 16 GB), but is less tested with Logstash.

**Gotcha:** If `collection_time_in_millis` for the old collector grows faster than wall time (e.g., 500 ms of GC per second), Logstash is spending more than 50% of CPU on GC. The pipeline will appear to stall intermittently. Increase heap or reduce `pipeline.batch.size` before anything else.

### Monitoring API

The monitoring API on port 9600 is the primary operational interface for Logstash. It requires no additional tooling and is always available when Logstash is running. Learn these endpoints — they are what you use during an incident.

```bash
# Node info: version, pipeline config, OS info
curl -s http://localhost:9600/_node | jq .

# Full stats snapshot
curl -s http://localhost:9600/_node/stats | jq .

# Per-pipeline event counts
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.events'

# All pipeline summaries in one call
curl -s http://localhost:9600/_node/stats/pipelines | \
  jq '.pipelines | to_entries[] | {pipeline: .key, in: .value.events.in, out: .value.events.out}'
```

**Key metrics from `/_node/stats/pipelines/<id>`:**

| Metric path | What it tells you |
|---|---|
| `events.in` | Total events received by input plugins |
| `events.filtered` | Events that completed the filter stage |
| `events.out` | Events successfully written to output |
| `events.duration_in_millis` | Cumulative wall time across all pipeline stages |
| `plugins.filters[n].events.duration_in_millis` | Time spent in a specific filter plugin (use for bottleneck ID) |
| `plugins.outputs[n].events.out` | Successful writes per output plugin |
| `plugins.outputs[n].documents.successes` | For ES output: indexed documents |
| `plugins.outputs[n].documents.non_retryable_failures` | For ES output: dropped documents |
| `queue.events` | Current event depth in persistent queue |

**Reading the numbers:** `events.in` minus `events.out` gives the backlog. If this grows over time, your output is slower than your input. Compare `plugins.filters[].events.duration_in_millis` values across filters — the highest value is your processing bottleneck.

**Gotcha:** All event counts are cumulative since last restart. To get rates, poll the API at a fixed interval and calculate the delta. A simple shell loop:

```bash
# Events-per-second over a 10-second window
BEFORE=$(curl -s http://localhost:9600/_node/stats/pipelines/main | jq '.pipelines.main.events.out')
sleep 10
AFTER=$(curl -s http://localhost:9600/_node/stats/pipelines/main | jq '.pipelines.main.events.out')
echo "Events/sec: $(( (AFTER - BEFORE) / 10 ))"
```

**Integrating with Prometheus:** The monitoring API returns JSON — wrap it with a small exporter (e.g., `logstash_exporter`) to scrape into Prometheus and build dashboards in Grafana. In production environments this is preferable to polling the API by hand, and allows alerting on queue depth, GC time, and non-retryable failure rates.

### Profiling with slow_log

`slow_log` logs warnings when individual events exceed per-plugin time thresholds. It is the most direct way to identify which specific filter (or which input pattern) is causing latency spikes on individual events — as opposed to aggregate duration statistics from the API.

```yaml
# logstash.yml
slowlog.threshold.warn: 2s
slowlog.threshold.info: 1s
slowlog.threshold.debug: 500ms
slowlog.threshold.trace: 100ms
```

Slow log entries appear in `logstash-slowlog-plain.log` (location configured by `path.logs`). Each entry includes:
- The plugin type and ID that exceeded the threshold
- The event payload at the time of the slow call
- Wall time taken

**Production caution:** slow log entries include the full event payload. If your events contain passwords, tokens, PII, or credit card numbers, enable slow log only during active debugging sessions and ensure the log file is not shipped to a central store without field redaction.

**Workflow:** Use the monitoring API first (aggregate view across all events) to identify which filter plugin class is slow, then enable slow log to capture specific events and patterns causing the slowdown. The combination of both tools is faster than either alone.

**Common slow_log findings:**

| Cause | Symptom | Fix |
|---|---|---|
| Catastrophic grok backtracking | Single events taking > 2s in grok filter | Anchor patterns with `^`, avoid `.*` before literals |
| DNS lookup filter with no cache | Each event doing a live DNS query | Enable `hit_cache_size` and `hit_cache_ttl` in dns filter |
| JDBC lookup filter at high rate | Long queue waits in jdbc_streaming | Add `cache_expiration` and `cache_size` options |
| Large `translate` filter file | File loaded per event instead of cached | Ensure `refresh_interval` is set to avoid constant reloads |

**Grok pattern optimisation:** Catastrophic backtracking in grok is the single most common cause of extreme per-event latency. The pattern `%{GREEDYDATA}` before a literal string forces the regex engine to backtrack across the entire event string for every position. Replace with anchored alternatives:

```ruby
# Problematic — GREEDYDATA before a literal causes exponential backtracking
grok {
  match => { "message" => "%{GREEDYDATA:junk} ERROR %{GREEDYDATA:msg}" }
}

# Better — anchor the pattern and use a non-greedy alternative
grok {
  match => { "message" => "^%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:msg}" }
}
```

### Beats + Logstash + Elasticsearch Pipeline Scaling

Understanding the full pipeline topology is necessary to diagnose whether a bottleneck is in Logstash, upstream (Beats), or downstream (Elasticsearch).

```
[App Servers]
  Filebeat (per host, harvests log files)
      │  Beats protocol over TLS, port 5044
      ▼
[Load Balancer]  (HAProxy or AWS NLB — distributes Beats connections across LS nodes)
      │
  ┌───┴────────────────┐
  │  Logstash Node 1   │   Logstash Node 2   (horizontal scaling)
  │  PQ on local SSD   │   PQ on local SSD
  └───┬────────────────┘
      │  Elasticsearch bulk API, HTTPS, port 9200
      ▼
[Elasticsearch Tier]
  Hot data nodes (ILM-managed indices, one shard per node minimum)
```

**Scaling decisions by bottleneck:**

| Observed symptom | Likely bottleneck | Fix |
|---|---|---|
| Logstash CPU > 90%, queue not growing | Logstash filter CPU | Add Logstash nodes; distribute via LB |
| PQ growing, CPU moderate | Output bottleneck (ES) | Increase `pipeline.workers`; check ES bulk queue |
| Filebeat log: `Failed to connect` or `Publishing failed` | Logstash input overloaded or down | Add Logstash nodes; increase Filebeat `queue.mem.events` |
| ES bulk rejection errors in LS output logs | ES indexing thread pool exhausted | Increase ES `thread_pool.write.queue_size` or add data nodes |
| PQ disk full, input blocking | PQ undersized or output stalled | Fix output first; then increase `queue.max_bytes` or add disk |
| High GC pauses on Logstash | Heap undersized for batch size | Increase heap or reduce `pipeline.batch.size` |

**Load balancing Beats connections:** Beats maintains a persistent TCP connection to a single Logstash node. Use a Layer 4 load balancer (not Layer 7 HTTP) for Beats protocol. Configure multiple `hosts` in Filebeat's output block — Filebeat will round-robin connections across them, providing client-side load balancing without requiring a dedicated LB for small deployments.

```yaml
# filebeat.yml — client-side load balancing across two Logstash nodes
output.logstash:
  hosts:
    - "logstash-1.internal:5044"
    - "logstash-2.internal:5044"
  loadbalance: true
  ssl.enabled: true
  ssl.certificate_authorities: ["/etc/filebeat/ca.crt"]
```

### When to Use Filebeat Directly vs via Logstash

Adding Logstash means another JVM process to monitor, another set of queues to size, and another failure point. It is justified when Logstash provides functionality that cannot be reproduced in Filebeat processors or Elasticsearch ingest node pipelines.

| Requirement | Filebeat processors | ES ingest node | Logstash |
|---|---|---|---|
| Simple field rename / drop | ✓ | ✓ | ✓ |
| Grok parsing of custom formats | Limited | ✓ | ✓ |
| Multi-line event assembly | ✓ | ✗ | ✓ |
| Enrichment from external DB (JDBC) | ✗ | ✗ | ✓ |
| Fan-out to multiple outputs | ✗ | ✗ | ✓ |
| Conditional routing to different indices | ✗ | ✓ (limited) | ✓ |
| Protocol translation (syslog → ES) | ✗ | ✗ | ✓ |
| Persistent queue with backpressure | ✗ | ✗ | ✓ |

**Decision rule:** if your only requirement is field parsing and enrichment against a single Elasticsearch cluster, evaluate ES ingest pipelines first — they run inside Elasticsearch, require no extra host, and are managed via the Kibana Stack Management UI. Reach for Logstash when you need fan-out, external enrichment, protocol translation, or a durable intermediate buffer separate from Elasticsearch.

---

## Examples

### Example 1: Diagnosing and Fixing an Elasticsearch Output Bottleneck

**Scenario:** A production Logstash node is ingesting ~8,000 events/sec from Filebeat but the persistent queue is growing steadily. Elasticsearch bulk indexing latency has increased from 50 ms to 800 ms over the past hour.

**Step 1 — Confirm the bottleneck is downstream, not filter CPU:**

```bash
# Check CPU usage of the Logstash process
top -p $(pgrep -f logstash) -b -n 1 | awk 'NR>7 {print $9, $10, $12}'

# Pull pipeline stats — compare events.in vs events.out
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main | {
    in: .events.in,
    out: .events.out,
    queue_depth: .queue.events,
    workers: .reloads
  }'
```

Expected output shows `queue.events` growing and a widening gap between `events.in` and `events.out`, with CPU under 60%. This confirms the filter stage is not the bottleneck — the output cannot keep up.

**Step 2 — Increase workers to push more concurrent bulk requests to Elasticsearch:**

```yaml
# /etc/logstash/logstash.yml
pipeline.workers: 8          # was 4; each worker sends one bulk request per batch
pipeline.batch.size: 500     # was 250; larger batches reduce per-request overhead
pipeline.batch.delay: 50
```

```bash
# Apply without restart by using the reload API (if config.reload.automatic is enabled)
# Or restart cleanly — PQ preserves in-flight events
systemctl restart logstash

# Verify after 2 minutes — queue depth should stabilise or fall
watch -n 5 "curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.queue.events'"
```

**Step 3 — If ES bulk rejections appear in Logstash logs, tune Elasticsearch:**

```bash
# Check for bulk rejection errors in Logstash output plugin stats
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.plugins.outputs[] | select(.name == "elasticsearch") |
      {successes: .documents.successes, failures: .documents.non_retryable_failures}'

# On the Elasticsearch side — check write thread pool queue depth
curl -s http://es-node-1:9200/_cat/thread_pool/write?v&h=node_name,queue,rejected,completed
```

If `rejected` is non-zero, increase the write thread pool queue size in `elasticsearch.yml`:

```yaml
# elasticsearch.yml — on each data node
thread_pool.write.queue_size: 1000   # default 200
```

---

### Example 2: JVM Heap Tuning After OOM Crash

**Scenario:** Logstash crashed with `java.lang.OutOfMemoryError: Java heap space`. The host has 32 GB RAM. Current heap is set to 1 GB (the default).

**Step 1 — Identify the current heap configuration:**

```bash
grep -E "Xms|Xmx" /etc/logstash/jvm.options
# Output: -Xms1g  -Xmx1g  (dangerously low for production)
```

**Step 2 — Calculate correct heap and update:**

```bash
# Host RAM: 32 GB → recommended heap: 8–12 GB (≤ 50% of RAM, < 31 GB OOPs limit)
sudo tee /etc/logstash/jvm.options.d/heap.options <<'EOF'
# Set equal to prevent heap resize GC pauses
-Xms8g
-Xmx8g
# G1GC for predictable pause times with Logstash's mixed object lifetimes
-XX:+UseG1GC
-XX:G1ReservePercent=25
# Start GC earlier — reduces likelihood of promotion failure
-XX:InitiatingHeapOccupancyPercent=30
EOF

sudo systemctl restart logstash
```

**Step 3 — Verify heap is being used efficiently (not exhausted):**

```bash
# Poll heap usage every 30 seconds for 5 minutes
for i in $(seq 1 10); do
  curl -s http://localhost:9600/_node/stats/jvm | \
    jq '[.jvm.mem.heap_used_percent, .jvm.gc.collectors.old.collection_time_in_millis]'
  sleep 30
done
```

Healthy output: `heap_used_percent` stays under 75%; `collection_time_in_millis` grows slowly (seconds per minute, not hundreds of ms per second).

**Step 4 — If heap usage is still climbing, reduce batch size:**

```bash
# Reduce per-worker event accumulation to lower peak heap allocation
# Edit logstash.yml:
# pipeline.batch.size: 125   # back to default — halves peak heap per worker
sudo sed -i 's/pipeline.batch.size: 500/pipeline.batch.size: 125/' /etc/logstash/logstash.yml
sudo systemctl restart logstash
```

---

### Example 3: Using slow_log to Fix a Catastrophic Grok Pattern

**Scenario:** The monitoring API shows that filter `grok_main` accounts for 92% of `events.duration_in_millis`, but CPU is only at 40%. This combination (high filter duration, low CPU) indicates a blocking regex, not a throughput problem.

**Step 1 — Enable slow log to capture the offending events:**

```yaml
# logstash.yml — temporarily enable during this debugging session only
slowlog.threshold.warn: 500ms
slowlog.threshold.info: 100ms
```

```bash
sudo systemctl restart logstash

# Tail the slow log — entries appear within seconds if backtracking is severe
sudo tail -f /var/log/logstash/logstash-slowlog-plain.log
```

Slow log output (condensed):

```
[WARN][logstash.filters.grok] slow filter execution
  plugin_params=>{"match"=>{"message"=>"%{GREEDYDATA:prefix} user=%{WORD:user} %{GREEDYDATA:suffix}"}},
  took_in_millis=>1847,
  event_as_string=>{"message"=>"GET /api/health?check=true 200 12ms"}
```

The event `GET /api/health?check=true 200 12ms` does not contain `user=` — the regex backtracks across the full string trying every position. Time: 1847 ms for a single event.

**Step 2 — Fix the pattern and verify:**

```ruby
# logstash pipeline config — before
filter {
  grok {
    match => { "message" => "%{GREEDYDATA:prefix} user=%{WORD:user} %{GREEDYDATA:suffix}" }
  }
}

# After — use a conditional so non-user events skip the expensive match entirely
filter {
  if [message] =~ /user=/ {
    grok {
      match => { "message" => "^%{GREEDYDATA:prefix} user=%{WORD:user} %{GREEDYDATA:suffix}$" }
    }
  }
}
```

```bash
# After config reload, verify filter duration has dropped in the stats API
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.plugins.filters[] |
      select(.name == "grok") | {id: .id, duration_ms: .events.duration_in_millis}'
```

**Step 3 — Disable slow log after confirming the fix:**

```yaml
# logstash.yml — remove or comment slowlog thresholds
# slowlog.threshold.warn: 500ms
```

---

### Example 4: Multi-Pipeline Configuration for Workload Isolation

**Scenario:** A single Logstash node handles both high-volume access logs (10,000 events/sec, lightweight parsing) and low-volume security audit logs (50 events/sec, expensive JDBC enrichment lookups). The security pipeline's slow JDBC lookups are adding latency to the access log pipeline because they share the same worker pool.

**Solution:** Use `pipelines.yml` to give each pipeline independent worker and queue settings.

```yaml
# /etc/logstash/pipelines.yml
- pipeline.id: access_logs
  path.config: "/etc/logstash/conf.d/access_logs.conf"
  pipeline.workers: 8           # high throughput, lightweight filters
  pipeline.batch.size: 500
  queue.type: persisted
  queue.max_bytes: 4gb

- pipeline.id: security_audit
  path.config: "/etc/logstash/conf.d/security_audit.conf"
  pipeline.workers: 2           # low volume; don't waste workers on JDBC wait time
  pipeline.batch.size: 50       # small batches keep latency low for security alerting
  queue.type: persisted
  queue.max_bytes: 512mb        # small queue — security events must not be silently buffered for long
```

```bash
# Verify both pipelines are running after restart
curl -s http://localhost:9600/_node/stats/pipelines | \
  jq '.pipelines | keys'
# Expected: ["access_logs", "security_audit"]

# Confirm each pipeline's stats are independent
curl -s http://localhost:9600/_node/stats/pipelines/access_logs | \
  jq '.pipelines.access_logs.events'
curl -s http://localhost:9600/_node/stats/pipelines/security_audit | \
  jq '.pipelines.security_audit.events'
```

**Benefit:** The JDBC lookup latency in `security_audit` no longer delays batches in `access_logs`. Each pipeline has its own queue, its own worker pool, and independent backpressure. A stall in the security pipeline will not cause the access log queue to fill.

---

## Exercises

### Exercise 1: Establish a Performance Baseline and Identify a Bottleneck

Set up a local Logstash instance with a generator input to produce synthetic load, then use the monitoring API to characterise the pipeline's behaviour under different worker and batch size configurations.

1. Create a pipeline config that generates events at high rate and parses them with a moderate grok pattern:

```ruby
# /etc/logstash/conf.d/bench.conf
input {
  generator {
    message => "2024-01-15T12:00:00Z INFO user=alice action=login src_ip=10.0.0.1 status=success"
    count => 0   # 0 = infinite
    threads => 2
  }
}
filter {
  grok {
    match => { "message" => "%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} user=%{WORD:user} action=%{WORD:action} src_ip=%{IP:src_ip} status=%{WORD:status}" }
  }
  date { match => ["ts", "ISO8601"] }
}
output {
  null {}   # discard output — we're measuring filter throughput only
}
```

2. Start with `pipeline.workers: 1` and `pipeline.batch.size: 125`. Record events/sec using the rate script from the Monitoring API section.
3. Double `pipeline.workers` to 2, then 4. Record events/sec at each step. At what point does adding workers stop improving throughput? Note the CPU % at that point.
4. With `pipeline.workers` at your optimal value, vary `pipeline.batch.size`: try 50, 125, 250, 500. Record events/sec and watch `jvm.mem.heap_used_percent`. What trade-off do you observe?

**Expected outcome:** You should be able to produce a 2×2 table (workers × batch size → throughput) and identify the diminishing-returns point for workers on your hardware.

---

### Exercise 2: Reproduce and Resolve a Persistent Queue Backpressure Event

This exercise simulates an output bottleneck filling the persistent queue and demonstrates backpressure propagation.

1. Configure a pipeline with a small queue and a slow output:

```ruby
# /etc/logstash/conf.d/pq_test.conf
input {
  generator {
    message => "test event for pq exercise"
    count => 0
    threads => 4
  }
}
filter {
  mutate { add_field => { "processed" => "true" } }
}
output {
  # Simulate a slow output with a sleep — not for production use
  ruby {
    code => "sleep 0.01"  # 10ms per event = max ~100 events/sec output
  }
  null {}
}
```

```yaml
# logstash.yml — small queue to make the fill-up observable quickly
queue.type: persisted
queue.max_bytes: 64mb
```

2. Start Logstash and immediately begin polling queue depth every 5 seconds:

```bash
watch -n 5 "curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.queue | {events: .events, storage_bytes: .data.storage_size_in_bytes}'"
```

3. Observe the queue
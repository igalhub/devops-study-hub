---
title: Pipeline Configuration
module: logstash
duration_min: 20
difficulty: beginner
tags: [logstash, elk, pipelines, configuration]
exercises: 3
---

## Overview

Logstash is the data processing layer of the Elastic Stack. It ingests data from sources, transforms it through a filter chain, and ships it to one or more outputs. The core abstraction is the **pipeline**: a sequence of three stages — input, filter, and output — defined in a single `.conf` file using a domain-specific language that looks like a hybrid of Ruby and Nginx config. Understanding how pipelines are configured and how to run multiple pipelines efficiently is foundational for building reliable log ingestion systems.

In production DevOps environments, Logstash sits between log shippers (Filebeat, Kafka) and Elasticsearch, normalising heterogeneous log formats before indexing. Without Logstash, raw log lines land in Elasticsearch as opaque strings. With it, you get structured, typed, time-accurate documents that make search and dashboards possible. Every exercise in this lesson can be run using the Logstash CLI without a full ELK stack — the `stdout` output with `rubydebug` codec lets you see exactly what events would be written to Elasticsearch.

Logstash is a JVM application. It starts slowly (10–30 seconds) and uses significant memory, but once running it is highly throughput-capable. Package installs place config at `/etc/logstash/`; tarball/Docker installs use `$LS_HOME/config/`. The default package service name is `logstash`, managed via `systemctl start logstash`.

## Concepts

### Pipeline Architecture: Input → Filter → Output

Every Logstash pipeline has exactly three stages. Plugins at each stage are declared in a `.conf` file using this structure:

```ruby
input {
  plugin_name {
    option => "value"
  }
}

filter {
  plugin_name {
    option => "value"
  }
}

output {
  plugin_name {
    option => "value"
  }
}
```

Data flows as **events** — structured objects where each field is a key-value pair. Each event always carries two meta-fields:
- `@timestamp` — the event time (defaults to ingest time; filters should correct this to the log's actual time).
- `@version` — always `"1"`, used internally.

You can add any field you want. Fields set by filters are what end up as document fields in Elasticsearch.

### The .conf File DSL

The config language has a few rules to know:

**Value types:**
```ruby
# String (single or double quotes)
path => "/var/log/app.log"

# Array
hosts => ["es01:9200", "es02:9200"]

# Hash (key-value pairs)
details => { "env" => "production", "version" => "2" }

# Boolean
ssl => true

# Number
port => 5044

# Environment variable interpolation — Logstash resolves ${VAR} at startup
password => "${ES_PASSWORD}"
```

**Conditionals** — usable in any stage (most commonly filter and output):
```ruby
if [field_name] == "value" {
  # do something
} else if [field_name] =~ /regex/ {
  # regex match
} else {
  # default
}
```

**Operators:** `==`, `!=`, `<`, `>`, `<=`, `>=`, `=~` (regex match), `!~` (regex no match), `in`, `not in`.

**Field references:** fields are always referenced in square brackets: `[field_name]`. Nested fields: `[parent][child]`.

### Running Logstash from the CLI

```bash
# Run with a specific config file — Logstash stays running (tails inputs)
/usr/share/logstash/bin/logstash -f /etc/logstash/conf.d/basic.conf

# Test config syntax without running (exits immediately)
/usr/share/logstash/bin/logstash --config.test_and_exit -f /etc/logstash/conf.d/basic.conf

# Run with config from a directory (all .conf files merged)
/usr/share/logstash/bin/logstash -f /etc/logstash/conf.d/

# Run with environment variables set inline
ES_PASSWORD=secret /usr/share/logstash/bin/logstash -f /etc/logstash/conf.d/basic.conf

# Enable verbose logging for debugging
/usr/share/logstash/bin/logstash -f basic.conf --log.level debug
```

`--config.test_and_exit` validates syntax and plugin configuration but does not check pattern correctness — a grok pattern can be syntactically valid but match nothing. Always test with real log samples.

### logstash.yml — Global Settings

Located at `/etc/logstash/logstash.yml` (package install). These settings apply to all pipelines unless overridden in `pipelines.yml`.

```yaml
# /etc/logstash/logstash.yml

node.name: "logstash-prod-01"       # Identifies this node in monitoring
path.data: /var/lib/logstash        # Persistent queue and sincedb storage
path.logs: /var/log/logstash        # Logstash's own log output
http.host: "0.0.0.0"               # Monitoring API bind address
http.port: 9600                     # Monitoring API port
log.level: info                     # debug | info | warn | error
config.reload.automatic: true       # Watch for config changes and hot reload
config.reload.interval: 5s          # How often to check for config changes
```

Key settings table:

| Setting | Default | Purpose |
|---|---|---|
| `node.name` | hostname | Identifies the node in monitoring |
| `path.data` | `/var/lib/logstash` | Persistent queue, sincedb, DLQ |
| `path.logs` | `/var/log/logstash` | Logstash own log output |
| `http.host` | `127.0.0.1` | Monitoring API bind address |
| `http.port` | `9600` | Monitoring API port |
| `log.level` | `info` | `debug`, `info`, `warn`, `error` |
| `config.reload.automatic` | `false` | Hot reload pipelines on `.conf` change |
| `config.reload.interval` | `3s` | Polling interval when auto-reload is on |

Hot reload works for filter and output changes. Adding or removing input plugins usually requires a full restart.

### pipelines.yml — Multiple Pipelines

Running a single pipeline is the default. For multiple independent pipelines (e.g., one per application team), use `/etc/logstash/pipelines.yml`. Each pipeline gets its own workers, queue, and config path, providing full isolation — a slow pipeline does not block a fast one.

```yaml
# /etc/logstash/pipelines.yml

- pipeline.id: apache-logs
  path.config: "/etc/logstash/conf.d/apache.conf"
  pipeline.workers: 2
  pipeline.batch.size: 500
  pipeline.batch.delay: 50

- pipeline.id: app-metrics
  path.config: "/etc/logstash/conf.d/metrics.conf"
  pipeline.workers: 4
  pipeline.batch.size: 1000
  queue.type: persisted
  queue.max_bytes: 4gb
  dead_letter_queue.enable: true
```

If `pipelines.yml` exists, Logstash ignores any `-f` argument and uses the file instead. The `pipeline.id` is used as the identifier in the monitoring API and in persistent queue paths.

### Pipeline Workers and Batch Size

These two knobs control throughput and latency trade-offs:

- **`pipeline.workers`** — number of threads processing the filter and output stages. Default is the number of CPU cores. Increase when outputs are network I/O bound (waiting for Elasticsearch bulk API).
- **`pipeline.batch.size`** — how many events a worker collects before processing them. Higher batch = higher throughput per worker, higher memory use, higher latency per event. Default: 125.
- **`pipeline.batch.delay`** — milliseconds a worker waits to fill a batch before flushing it. Default: 50 ms. Lower = lower latency; higher = fuller batches.

Rule of thumb: start with `workers = CPU cores`, `batch.size = 250`. Watch the monitoring API and adjust. Do not set workers far above core count — context-switching overhead exceeds gains.

### Persistent Queues (PQ)

By default Logstash uses an **in-memory queue** between input and filter stages. If Logstash crashes mid-processing, in-flight events are lost. The **persistent queue** writes these events to disk, providing at-least-once delivery.

```yaml
# Per-pipeline in pipelines.yml, or globally in logstash.yml
queue.type: persisted
queue.max_bytes: 4gb
queue.checkpoint.writes: 1024   # fsync every N write operations
queue.drain: false               # if true, drain queue fully before shutdown
```

The queue is stored under `path.data/<pipeline_id>/queue`. With the persistent queue enabled:
- Events survive Logstash restarts.
- If Elasticsearch is temporarily down, events queue up on disk rather than being dropped.
- Size it to absorb 2–3× your peak 5-minute ingest volume.

Monitor queue depth:
```bash
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.queue | {events: .events, bytes: .data.storage_size_in_bytes}'
```

### Dead Letter Queue (DLQ)

Events that Elasticsearch rejects — due to mapping conflicts, oversized documents, or schema violations — are written to the **dead letter queue** instead of being silently dropped.

```yaml
# logstash.yml or per-pipeline in pipelines.yml
dead_letter_queue.enable: true
dead_letter_queue.max_bytes: 1gb
path.dead_letter_queue: /var/lib/logstash/dead_letter_queue
```

To replay and process DLQ events (e.g., after fixing a mapping issue), use the `dead_letter_queue` input plugin in a separate pipeline:

```ruby
input {
  dead_letter_queue {
    path => "/var/lib/logstash/dead_letter_queue"
    pipeline_id => "main"              # which pipeline's DLQ to read
    commit_offsets => true             # track position; don't re-read on restart
    start_timestamp => "2024-03-15T00:00:00Z"  # only replay from this time
  }
}

filter {
  # Fix the field that caused the rejection, e.g., remove a conflicting field
  mutate {
    remove_field => ["bad_field"]
  }
}

output {
  elasticsearch {
    hosts => ["https://elasticsearch:9200"]
    index => "logs-fixed-%{+YYYY.MM.dd}"
  }
}
```

DLQ events carry metadata about why they were rejected, accessible in the `[@metadata][dead_letter_queue]` field.

### Basic Pipeline: File → Filter → Stdout

A minimal pipeline that reads a log file, parses it, and prints to stdout. This is the standard development setup — no Elasticsearch needed.

```ruby
# /etc/logstash/conf.d/basic.conf

input {
  file {
    path => "/var/log/apache2/access.log"
    start_position => "beginning"    # "end" to tail only new lines
    sincedb_path => "/dev/null"      # don't remember position — re-read every restart
                                     # use a real path in production
    mode => "tail"                   # "read" for static files that won't grow
    tags => ["apache"]               # add tag to all events from this input
  }
}

filter {
  grok {
    # %{COMBINEDAPACHELOG} is a built-in compound pattern
    match => { "message" => "%{COMBINEDAPACHELOG}" }
  }
  date {
    # Parse the "timestamp" field grok extracted and set it as @timestamp
    match => [ "timestamp", "dd/MMM/yyyy:HH:mm:ss Z" ]
    target => "@timestamp"
  }
  mutate {
    convert => { "response" => "integer" }  # "200" → 200
    convert => { "bytes" => "integer" }
    remove_field => [ "message", "timestamp" ]  # clean up raw fields
  }
}

output {
  stdout {
    codec => rubydebug    # prints full event as a readable Ruby hash
  }
}
```

Test before running:
```bash
/usr/share/logstash/bin/logstash --config.test_and_exit -f /etc/logstash/conf.d/basic.conf
# Output: "Configuration OK" on success
```

Run it:
```bash
/usr/share/logstash/bin/logstash -f /etc/logstash/conf.d/basic.conf
```

Sample output from `rubydebug`:
```ruby
{
         "verb" => "GET",
         "auth" => "-",
       "ident" => "-",
     "request" => "/index.html",
    "response" => 200,
      "clientip" => "192.168.1.10",
       "bytes" => 512,
      "@timestamp" => 2024-03-15T14:32:01.000Z,
      "@version" => "1",
          "tags" => ["apache"],
      "httpversion" => "1.1"
}
```

### Checking Pipeline Status via Monitoring API

The monitoring API runs on port 9600 and requires no authentication by default:

```bash
# Node info (version, host, pipeline config summary)
curl -s http://localhost:9600/_node | jq .

# Per-pipeline stats: events in/out, duration, queue depth
curl -s http://localhost:9600/_node/stats/pipelines | jq .

# Stats for a specific pipeline
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '.pipelines.main.events'

# Hot threads (which threads are consuming CPU — for bottleneck debugging)
curl -s http://localhost:9600/_node/hot_threads
```

Sample `events` output:
```json
{
  "in": 150234,
  "filtered": 150100,
  "out": 150100,
  "duration_in_millis": 42310,
  "queue_push_duration_in_millis": 1230
}
```

`in` vs `out` discrepancy: events were dropped (by a `drop` filter) or failed (check DLQ). High `duration_in_millis` relative to event count: slow filters or slow outputs.

## Examples

### Multi-pipeline production directory layout

```
/etc/logstash/
├── logstash.yml          # global settings (node.name, log.level, PQ defaults)
├── pipelines.yml         # pipeline registry
├── jvm.options           # heap size and GC flags
└── conf.d/
    ├── apache.conf       # apache pipeline config
    ├── syslog.conf       # syslog pipeline config
    └── app-json.conf     # application JSON logs pipeline config
```

`pipelines.yml` with full options for an isolated, durable pipeline:

```yaml
- pipeline.id: nginx
  path.config: "/etc/logstash/conf.d/apache.conf"
  pipeline.workers: 2
  pipeline.batch.size: 500
  pipeline.batch.delay: 50
  queue.type: persisted
  queue.max_bytes: 2gb
  queue.checkpoint.writes: 1024
  dead_letter_queue.enable: true

- pipeline.id: app-json
  path.config: "/etc/logstash/conf.d/app-json.conf"
  pipeline.workers: 4
  pipeline.batch.size: 1000
  queue.type: memory
```

### Adding a static field to every event

Use the `mutate` filter with `add_field` — the simplest possible filter:

```ruby
# /etc/logstash/conf.d/add-env.conf
input {
  file {
    path => "/tmp/test.log"
    start_position => "beginning"
    sincedb_path => "/dev/null"
  }
}

filter {
  mutate {
    add_field => {
      "env"        => "production"
      "datacenter" => "eu-west-1"
      "app_version" => "${APP_VERSION}"   # from environment variable
    }
  }
}

output {
  stdout { codec => rubydebug }
}
```

### Using the monitoring API to diagnose a slow pipeline

```bash
# Find the slowest filter plugin in the main pipeline
curl -s http://localhost:9600/_node/stats/pipelines/main | \
  jq '[.pipelines.main.plugins.filters[] |
    {name: .name, id: .id, duration_ms: .events.duration_in_millis}
  ] | sort_by(.duration_ms) | reverse'

# Check if output is keeping up (events_out should be close to events_in)
curl -s http://localhost:9600/_node/stats/pipelines | \
  jq '.pipelines | to_entries[] | {
    pipeline: .key,
    events_in: .value.events.in,
    events_out: .value.events.out,
    queue_depth: .value.queue.events
  }'
```

## Exercises

1. Write a `pipelines.yml` that declares two pipelines: one named `nginx` pointing to `nginx.conf` with 2 workers, batch size 500, a persisted queue of 2gb, and dead letter queue enabled; one named `app` pointing to `app.conf` with 4 workers, batch size 1000, and an in-memory queue. The DLQ should be enabled only on the nginx pipeline.

2. Create a pipeline config at `/etc/logstash/conf.d/enrich.conf` that: reads from `/tmp/test.log` with `start_position => "beginning"` and `sincedb_path => "/dev/null"`; adds three fields via `mutate`: `env` = `"production"`, `datacenter` = `"eu-west-1"`, and `pipeline_version` = `"2"`; outputs to stdout with the `rubydebug` codec. Run it with `--config.test_and_exit` to verify, then show what the `rubydebug` output would look like for the input line `hello world`.

3. Using the monitoring API on a running Logstash instance, write the exact curl commands to: (a) retrieve the `events.in` and `events.out` for the `main` pipeline; (b) find the filter plugin with the highest `duration_in_millis`; (c) check the persistent queue depth. For each command, explain what a bad value would look like and what you would investigate first.

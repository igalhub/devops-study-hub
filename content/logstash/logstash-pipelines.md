---
title: Pipeline Configuration
module: logstash
duration_min: 20
difficulty: beginner
tags: [logstash, elk, pipelines, configuration]
exercises: 3
---

## Overview
Logstash is the data processing layer of the Elastic Stack. It ingests data from sources, transforms it through a filter chain, and ships it to one or more outputs. Understanding how pipelines are configured — and how to run multiple pipelines efficiently — is foundational for building reliable log ingestion systems. In production DevOps environments, Logstash sits between log shippers (Filebeat, Kafka) and Elasticsearch, normalising heterogeneous log formats before indexing.

## Concepts

### Pipeline Architecture: Input → Filter → Output
Every Logstash pipeline has exactly three stages. Plugins at each stage are declared in a `.conf` file.

```
Input plugins      →   Filter plugins   →   Output plugins
(file, beats, tcp)     (grok, mutate)       (elasticsearch, stdout)
```

Data flows as **events** — structured Ruby objects. Each event carries fields you can read and mutate in filters. The `@timestamp` and `@version` meta-fields are always present.

### logstash.yml — Global Settings
Located at `/etc/logstash/logstash.yml` (package install) or `$LS_HOME/config/logstash.yml`.

Key settings:

| Setting | Default | Purpose |
|---|---|---|
| `node.name` | hostname | Identifies the node in monitoring |
| `path.data` | `/var/lib/logstash` | Persistent queue, dead letter queue |
| `path.logs` | `/var/log/logstash` | Logstash own log output |
| `http.host` | `127.0.0.1` | Monitoring API bind address |
| `http.port` | `9600` | Monitoring API port |
| `log.level` | `info` | `debug`, `info`, `warn`, `error` |
| `config.reload.automatic` | `false` | Hot reload pipelines on change |
| `config.reload.interval` | `3s` | Polling interval when auto-reload on |

```yaml
# /etc/logstash/logstash.yml
node.name: "logstash-prod-01"
path.data: /var/lib/logstash
http.host: "0.0.0.0"
http.port: 9600
log.level: info
config.reload.automatic: true
config.reload.interval: 5s
```

### pipelines.yml — Multiple Pipelines
Running a single pipeline is the default. For multiple independent pipelines (e.g., one per application), use `/etc/logstash/pipelines.yml`. Each pipeline gets its own workers, queue, and config path, providing isolation.

```yaml
# /etc/logstash/pipelines.yml
- pipeline.id: apache-logs
  path.config: "/etc/logstash/conf.d/apache.conf"
  pipeline.workers: 2
  pipeline.batch.size: 500

- pipeline.id: app-metrics
  path.config: "/etc/logstash/conf.d/metrics.conf"
  pipeline.workers: 4
  pipeline.batch.size: 1000
  queue.type: persisted
```

### Pipeline Workers and Batch Size
These two knobs control throughput and latency:

- **`pipeline.workers`** — number of threads processing filter/output stages. Default is the number of CPU cores. Increase when outputs are slow (network I/O bound).
- **`pipeline.batch.size`** — events collected before handing to a worker. Higher batch → higher throughput, higher latency. Default: 125.
- **`pipeline.batch.delay`** — milliseconds to wait filling a batch before flushing. Default: 50 ms.

Rule of thumb: start with workers = CPU cores, batch size = 250, then tune based on monitoring API metrics.

### Persistent Queues
By default Logstash uses an **in-memory queue**. If Logstash crashes, in-flight events are lost. Enabling the **persistent queue** (PQ) writes events to disk between the input and filter stages, providing at-least-once delivery guarantees.

```yaml
# Per pipeline in pipelines.yml, or globally in logstash.yml
queue.type: persisted
queue.max_bytes: 4gb
queue.checkpoint.writes: 1024
```

The queue is stored under `path.data/<pipeline_id>/queue`. Size it to hold at least 2–3× the expected burst volume.

### Dead Letter Queue (DLQ)
Events that Elasticsearch rejects (mapping conflicts, document too large) are written to the **dead letter queue** instead of being dropped silently.

```yaml
dead_letter_queue.enable: true
dead_letter_queue.max_bytes: 1gb
path.dead_letter_queue: /var/lib/logstash/dead_letter_queue
```

Process DLQ events with the `dead_letter_queue` input plugin:

```ruby
input {
  dead_letter_queue {
    path => "/var/lib/logstash/dead_letter_queue"
    pipeline_id => "main"
    commit_offsets => true
  }
}
```

### Basic Pipeline Example: File → Filter → Stdout
A minimal pipeline that reads an Apache log file, parses the status code, and prints to stdout.

```ruby
# /etc/logstash/conf.d/basic.conf

input {
  file {
    path => "/var/log/apache2/access.log"
    start_position => "beginning"
    sincedb_path => "/dev/null"   # reread from start every restart (dev only)
  }
}

filter {
  grok {
    match => { "message" => "%{COMBINEDAPACHELOG}" }
  }
  date {
    match => [ "timestamp", "dd/MMM/yyyy:HH:mm:ss Z" ]
    target => "@timestamp"
  }
  mutate {
    convert => { "response" => "integer" }
    convert => { "bytes" => "integer" }
    remove_field => [ "message", "timestamp" ]
  }
}

output {
  stdout {
    codec => rubydebug
  }
}
```

Test a config before applying it:

```bash
/usr/share/logstash/bin/logstash --config.test_and_exit -f /etc/logstash/conf.d/basic.conf
```

## Examples

### Multi-pipeline production layout

```
/etc/logstash/
├── logstash.yml          # global settings
├── pipelines.yml         # pipeline registry
├── jvm.options           # heap, GC flags
└── conf.d/
    ├── apache.conf       # apache pipeline
    ├── syslog.conf       # syslog pipeline
    └── app-json.conf     # application JSON logs
```

`pipelines.yml` entry for isolated, persistent pipeline:

```yaml
- pipeline.id: syslog
  path.config: "/etc/logstash/conf.d/syslog.conf"
  pipeline.workers: 2
  pipeline.batch.size: 500
  queue.type: persisted
  queue.max_bytes: 2gb
  dead_letter_queue.enable: true
```

### Checking pipeline status via monitoring API

```bash
# Node info
curl -s http://localhost:9600/_node | jq .

# Per-pipeline stats (events in/out, filter duration)
curl -s http://localhost:9600/_node/stats/pipelines | jq .

# Hot threads (debugging throughput bottlenecks)
curl -s http://localhost:9600/_node/hot_threads
```

## Exercises

1. Write a `pipelines.yml` that declares two pipelines: one for `nginx.conf` with 2 workers and 500 batch size using a persisted queue, and one for `app.conf` with 4 workers and in-memory queue. Enable the dead letter queue on the nginx pipeline only.

2. Create a minimal pipeline config that reads `/tmp/test.log`, adds a field `env` with value `production` using a mutate filter, and outputs to stdout with the `rubydebug` codec. Verify it passes `--config.test_and_exit`.

3. Using the monitoring API on a running Logstash instance, retrieve the pipeline stats and identify the `events.out` count and `filter_duration_in_millis` for the `main` pipeline. Explain what a high filter duration would indicate and what you would investigate first.

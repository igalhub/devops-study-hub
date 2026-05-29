---
title: Intro & Metrics Model
module: prometheus
duration_min: 20
difficulty: beginner
tags: [prometheus, metrics, monitoring, observability]
exercises: 3
---

## Overview

Prometheus is an open-source systems monitoring and alerting toolkit originally built at SoundCloud, now a CNCF graduated project. It stores all collected data in a local time-series database (TSDB) and exposes a query API used by Grafana for dashboards, Alertmanager for notifications, and direct API consumers. For DevOps engineers, Prometheus is the de-facto standard for metrics in Kubernetes environments — understanding it from the data model up is a prerequisite for operating any modern infrastructure stack.

The core design decision in Prometheus is its pull-based architecture: Prometheus reaches out to targets over HTTP at a configured interval and reads their metrics. This is the inverse of push-based systems (StatsD, Graphite) where instrumented code sends data to a collector. Pull-based monitoring places the scrape schedule, target list, and retry logic entirely inside Prometheus — the monitored application needs only to expose an HTTP endpoint in the correct text format. Every metric carried by Prometheus is tagged with the `job` label (the scrape job name) and the `instance` label (the target address), providing consistent provenance without any application-side configuration.

Every unique combination of metric name and label values forms a distinct time series. Prometheus stores each as a sequence of `(timestamp, float64)` pairs in 2-hour blocks that are compacted and downsampled over time. Default retention is 15 days, configurable via `--storage.tsdb.retention.time`. The local TSDB is Prometheus's only required storage — remote write/read integrations exist (Thanos, Cortex, VictoriaMetrics) but are not needed to get started.

## Concepts

### Pull-Based Architecture

Prometheus polls targets over HTTP at a configured scrape interval. Targets expose metrics on a `/metrics` endpoint in the Prometheus exposition format (plain text). This is the inverse of push-based systems where instrumented code sends metrics to a collector.

**Advantages of pull:**
- Central config: Prometheus controls what is scraped and when.
- Easy health check: if the scrape fails, the target is down.
- No firewall holes needed from target to monitoring server (only Prometheus needs outbound access to targets).

**When push is needed:** short-lived jobs (batch, cron) cannot be scraped before they exit. Use the **Pushgateway** to push metrics, then Prometheus scrapes the gateway.

### Metric Types

| Type | Semantics | Example use case |
|------|-----------|-----------------|
| **Counter** | Monotonically increasing integer; only goes up (resets on restart) | HTTP requests total, errors total, bytes sent |
| **Gauge** | Arbitrary float that can go up or down | Memory usage, queue depth, temperature |
| **Histogram** | Samples observations into configurable buckets; also exposes `_count` and `_sum` | Request latency, response size |
| **Summary** | Pre-calculated client-side quantiles; also exposes `_count` and `_sum` | Same as histogram, but quantiles computed in app |

**Counter gotcha:** never use a counter for something that can decrease. Use a gauge. Counters are designed to be used with `rate()` and `increase()` in PromQL — these functions handle resets automatically.

**Histogram vs Summary:**
- Histograms: buckets are server-side (configurable), quantiles calculated in PromQL — aggregatable across instances.
- Summaries: quantiles calculated client-side — cannot be aggregated across instances. Prefer histograms in distributed systems.

### Labels

Labels are key-value pairs that identify dimensions of a metric. Every metric is identified by its name plus its complete label set.

```
http_requests_total{method="GET", status="200", handler="/api/users"} 1234
http_requests_total{method="POST", status="500", handler="/api/login"} 7
```

**Cardinality warning:** every unique combination of label values creates a new time series. High-cardinality labels (e.g. user IDs, request IDs, IP addresses) can cause memory exhaustion. A label with 10,000 unique values multiplied across 5 other label dimensions creates millions of series — this is a common production incident cause.

Good labels: `method`, `status`, `region`, `service`, `env`
Bad labels: `user_id`, `request_id`, `url` (unbounded)

### Exposition Format

Prometheus scrapes plain-text HTTP responses. Each line is one sample:

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 1234 1685000000000
http_requests_total{method="POST",status="500"} 7
```

- `# HELP` — human-readable description
- `# TYPE` — declares the metric type
- Timestamp (milliseconds) is optional; Prometheus uses scrape time if omitted

### prometheus.yml — Basic Scrape Config

The main configuration file controls global settings, scrape jobs, and rule files.

```yaml
global:
  scrape_interval: 15s        # how often to scrape targets
  evaluation_interval: 15s    # how often to evaluate alerting/recording rules
  scrape_timeout: 10s         # per-scrape timeout

# Rule files for alerting and recording rules
rule_files:
  - "rules/*.yml"

# Alertmanager integration
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]

scrape_configs:
  # Prometheus scrapes itself
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]

  # Application server
  - job_name: "app"
    scrape_interval: 10s      # override global for this job
    metrics_path: /metrics    # default; can be changed
    static_configs:
      - targets:
          - "app-1:8080"
          - "app-2:8080"
        labels:
          env: production

  # Node exporter (host metrics)
  - job_name: "node"
    static_configs:
      - targets:
          - "host1:9100"
          - "host2:9100"
```

**Key scrape config fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `job_name` | required | Label `job` applied to all metrics from this job |
| `scrape_interval` | global | Per-job override |
| `metrics_path` | `/metrics` | HTTP path to scrape |
| `scheme` | `http` | `http` or `https` |
| `static_configs` | — | Hardcoded target list |
| `relabel_configs` | — | Transform labels before scraping |

### Enabling the Lifecycle API

By default, Prometheus does not accept POST requests to trigger a config reload. Start it with `--web.enable-lifecycle` to enable the reload endpoint:

```bash
docker run -d \
  --name prometheus \
  -p 9090:9090 \
  -v /tmp/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --web.enable-lifecycle
```

With the lifecycle API enabled, you can reload the config without restarting the container:

```bash
curl -X POST http://localhost:9090/-/reload
```

Prometheus logs `msg="Completed loading of configuration file"` on success. The target page at `http://localhost:9090/targets` updates immediately.

### Data Model Summary

Every time series is uniquely identified by:
```
<metric_name>{<label_name>=<label_value>, ...}
```

Prometheus stores samples as `(timestamp, float64)` pairs. The local TSDB stores data in 2-hour blocks, compacted over time. Default retention is 15 days (configurable via `--storage.tsdb.retention.time`).

### Instrumenting Python Applications with prometheus_client

The `prometheus_client` library is the official Python client for Prometheus. It handles the exposition format, label management, and the `/metrics` HTTP server for you.

**Install:**

```bash
pip install prometheus_client
```

**The four instrumentation primitives:**

```python
from prometheus_client import Counter, Gauge, Histogram, Summary, start_http_server
```

**Counter** — use for values that only go up (requests, errors, bytes sent):

```python
# Declare at module level — name, help string, label names
http_requests_total = Counter(
    'http_requests_total',
    'Total number of HTTP requests',
    ['method', 'status']   # label names — values supplied at record time
)

# Increment by 1 (default)
http_requests_total.labels(method='GET', status='200').inc()

# Increment by arbitrary amount
http_requests_total.labels(method='POST', status='500').inc(3)
```

**Gauge** — use for values that go up and down (queue depth, memory, in-flight requests):

```python
in_flight_requests = Gauge(
    'in_flight_requests',
    'Number of requests currently being processed'
    # no labels needed here — single dimension
)

# Set to a specific value
in_flight_requests.set(42)

# Increment / decrement
in_flight_requests.inc()     # +1
in_flight_requests.dec()     # -1
in_flight_requests.inc(5)    # +5
```

**Histogram** — use for measuring distributions (latency, response size):

```python
request_duration_seconds = Histogram(
    'request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'handler'],
    buckets=[0.01, 0.05, 0.1, 0.5, 1.0, float('inf')]
    # float('inf') is always added automatically but explicit is clearer
)

import time

start = time.time()
# ... do work ...
duration = time.time() - start

# observe() records one measurement into the appropriate bucket
request_duration_seconds.labels(method='GET', handler='/api/users').observe(duration)
```

The histogram automatically creates three metric families on `/metrics`:
- `request_duration_seconds_bucket{le="0.01"}` — count of observations <= 0.01s
- `request_duration_seconds_count` — total number of observations
- `request_duration_seconds_sum` — sum of all observed values

**Starting the metrics endpoint:**

```python
import time
from prometheus_client import Counter, Gauge, Histogram, start_http_server

# Metric declarations
http_requests_total = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'status']
)
in_flight_requests = Gauge(
    'in_flight_requests',
    'Requests currently being processed'
)
request_duration_seconds = Histogram(
    'request_duration_seconds',
    'Request duration in seconds',
    ['method', 'handler'],
    buckets=[0.01, 0.05, 0.1, 0.5, 1.0]
)

def handle_request(method, handler):
    """Simulate handling an HTTP request."""
    in_flight_requests.inc()
    start = time.time()
    try:
        time.sleep(0.05)  # simulate work
        http_requests_total.labels(method=method, status='200').inc()
    except Exception:
        http_requests_total.labels(method=method, status='500').inc()
        raise
    finally:
        duration = time.time() - start
        request_duration_seconds.labels(method=method, handler=handler).observe(duration)
        in_flight_requests.dec()

if __name__ == '__main__':
    # Start /metrics HTTP server on port 8000 in a background thread
    start_http_server(8000)
    print("Metrics available at http://localhost:8000/metrics")

    # Simulate traffic
    while True:
        handle_request('GET', '/api/users')
        time.sleep(1)
```

**Verify the output:**

```bash
# See all three metric types in the exposition format
curl -s http://localhost:8000/metrics | grep -E '^(http_requests|in_flight|request_duration)'
```

Expected output (abbreviated):
```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 5.0
# HELP in_flight_requests Requests currently being processed
# TYPE in_flight_requests gauge
in_flight_requests 0.0
# HELP request_duration_seconds Request duration in seconds
# TYPE request_duration_seconds histogram
request_duration_seconds_bucket{handler="/api/users",le="0.01",method="GET"} 0.0
request_duration_seconds_bucket{handler="/api/users",le="0.05",method="GET"} 0.0
request_duration_seconds_bucket{handler="/api/users",le="0.1",method="GET"} 5.0
request_duration_seconds_bucket{handler="/api/users",le="0.5",method="GET"} 5.0
request_duration_seconds_bucket{handler="/api/users",le="1.0",method="GET"} 5.0
request_duration_seconds_bucket{handler="/api/users",le="+Inf",method="GET"} 5.0
request_duration_seconds_count{handler="/api/users",method="GET"} 5.0
request_duration_seconds_sum{handler="/api/users",method="GET"} 0.253...
```

**Scraping from Prometheus:** add a job that points at port 8000:

```yaml
scrape_configs:
  - job_name: "my-python-app"
    static_configs:
      - targets: ["localhost:8000"]
```

## Examples

**Run Prometheus locally with Docker:**

```bash
# Write a minimal config
cat > /tmp/prometheus.yml <<EOF
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]
EOF

# --web.enable-lifecycle allows config reload via POST /-/reload
docker run -d \
  --name prometheus \
  -p 9090:9090 \
  -v /tmp/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --web.enable-lifecycle
```

**Inspect the metrics endpoint:**

```bash
# View raw metrics from Prometheus itself
curl -s http://localhost:9090/metrics | grep '^prometheus_'

# Check scrape targets and their status
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job, health, lastScrape}'
```

**Query via the API:**

```bash
# Instant query
curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result'

# Range query (last 1 hour, 1m step)
curl -s 'http://localhost:9090/api/v1/query_range' \
  --data-urlencode 'query=prometheus_tsdb_head_series' \
  --data-urlencode 'start=2024-01-01T00:00:00Z' \
  --data-urlencode 'end=2024-01-01T01:00:00Z' \
  --data-urlencode 'step=60s'
```

**Add node_exporter and reload config:**

```bash
# Run node_exporter — --net=host lets it read host network interfaces
docker run -d --name node_exporter --net=host prom/node-exporter

# Append node job to config
cat >> /tmp/prometheus.yml <<EOF

  - job_name: "node"
    static_configs:
      - targets: ["localhost:9100"]
EOF

# Trigger hot reload (requires --web.enable-lifecycle)
curl -X POST http://localhost:9090/-/reload

# Confirm new target appears (health should be "up")
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health}'
```

## Exercises

1. Run Prometheus in Docker using the config above with `--web.enable-lifecycle`. Navigate to `http://localhost:9090/targets` and confirm the self-scrape target is UP. Then query `prometheus_build_info` in the expression browser and identify what labels are present.

2. Add a second scrape job to your `prometheus.yml` that scrapes `node_exporter` running on `localhost:9100` (run it with `docker run -d --net=host prom/node-exporter`). Reload Prometheus config with `curl -X POST http://localhost:9090/-/reload` and confirm the new target appears.

3. Instrument a small Python HTTP server with the `prometheus_client` library. Create a counter (`http_requests_total` with labels `method` and `status`), a gauge (`in_flight_requests`), and a histogram (`request_duration_seconds` with buckets `[0.01, 0.05, 0.1, 0.5, 1.0]`). Verify all three appear on `/metrics` and increment as you make requests.


---

### Quick Checks

4. Classify a metric by its name convention. Run: `python3 -c "name='http_requests_total'; print('counter' if name.endswith('_total') else 'gauge')"`

```expected_output
counter
```

5. Count label-value pairs in a metric label set. Run: `echo '{method="GET",code="200",handler="/api"}' | tr ',' '\n' | wc -l`

```expected_output
3
```

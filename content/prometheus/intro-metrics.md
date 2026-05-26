---
title: Intro & Metrics Model
module: prometheus
duration_min: 20
difficulty: beginner
tags: [prometheus, metrics, monitoring, observability]
exercises: 3
---

## Overview
Prometheus is an open-source systems monitoring and alerting toolkit originally built at SoundCloud, now a CNCF graduated project. It uses a pull-based model — Prometheus scrapes HTTP endpoints (called targets) at a configured interval, storing all data in a local time-series database. This architecture makes it easy to add monitoring without coordinating a push destination, and naturally decouples metric producers from the monitoring system. For DevOps engineers, Prometheus is the de-facto standard for metrics in Kubernetes environments and pairs tightly with Grafana for dashboards and Alertmanager for notifications.

## Concepts

### Pull-Based Architecture
Prometheus polls targets over HTTP at a configured scrape interval. Targets expose metrics on a `/metrics` endpoint in the Prometheus exposition format (plain text). This is the inverse of push-based systems (StatsD, Graphite) where instrumented code sends metrics to a collector.

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

### Data Model Summary
Every time series is uniquely identified by:
```
<metric_name>{<label_name>=<label_value>, ...}
```

Prometheus stores samples as `(timestamp, float64)` pairs. The local TSDB (time-series database) stores data in 2-hour blocks, compacted over time. Default retention is 15 days (configurable via `--storage.tsdb.retention.time`).

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

docker run -d \
  --name prometheus \
  -p 9090:9090 \
  -v /tmp/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus
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

## Exercises

1. Run Prometheus in Docker using the config above. Navigate to `http://localhost:9090/targets` and confirm the self-scrape target is UP. Then query `prometheus_build_info` in the expression browser and identify what labels are present.

2. Add a second scrape job to your `prometheus.yml` that scrapes `node_exporter` running on `localhost:9100` (run it with `docker run -d --net=host prom/node-exporter`). Reload Prometheus config with `curl -X POST http://localhost:9090/-/reload` (requires `--web.enable-lifecycle` flag) and confirm the new target appears.

3. Instrument a small Python HTTP server with the `prometheus_client` library. Create a counter (`http_requests_total` with labels `method` and `status`), a gauge (`in_flight_requests`), and a histogram (`request_duration_seconds` with buckets `[0.01, 0.05, 0.1, 0.5, 1.0]`). Verify all three appear on `/metrics` and increment as you make requests.

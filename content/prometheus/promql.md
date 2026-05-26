---
title: PromQL
module: prometheus
duration_min: 25
difficulty: intermediate
tags: [prometheus, promql, queries, alerting, recording-rules]
exercises: 4
---

## Overview
PromQL (Prometheus Query Language) is a functional query language for selecting and aggregating time-series data. It is the primary skill gap between engineers who can deploy Prometheus and those who can actually operate it. Every alert, every Grafana panel, every recording rule is a PromQL expression. Mastering PromQL means being able to answer production questions like "what is the 99th-percentile latency of my API over the last 5 minutes, broken down by endpoint?" — and knowing why naive approaches give wrong answers with counters or histograms.

## Concepts

### Data Types

| Type | Description | Example |
|------|-------------|---------|
| **Instant vector** | Set of time series, each with one sample at a point in time | `http_requests_total` |
| **Range vector** | Set of time series, each with a range of samples | `http_requests_total[5m]` |
| **Scalar** | Single float value | `1.5` |
| **String** | String literal (rarely used) | `"foo"` |

Most functions take a range vector and return an instant vector.

### Selectors and Matchers

```promql
# Exact match
http_requests_total{job="app", status="200"}

# Regex match (RE2 syntax)
http_requests_total{status=~"5.."}

# Negation
http_requests_total{status!="200"}

# Negative regex
http_requests_total{handler!~"/health.*"}

# Range vector — all samples in the last 5 minutes
http_requests_total{job="app"}[5m]

# Offset — compare to 1 hour ago
http_requests_total offset 1h
```

**Important:** an instant vector selector returns one sample per matched series (the most recent sample within the lookback delta, default 5 minutes). If a target goes down and stops being scraped, the series disappears from instant queries after the lookback window.

### Operators

**Arithmetic:** `+  -  *  /  %  ^`

```promql
# Convert bytes to megabytes
node_memory_MemFree_bytes / 1024 / 1024

# Ratio
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes
```

**Comparison:** `==  !=  >  <  >=  <=`

```promql
# Returns only series where the value is true (non-zero)
http_requests_total > 100

# Use bool modifier to get 0/1 instead of filtering
http_requests_total > bool 100
```

**Logical/set:** `and  or  unless`

```promql
# Alert: high error rate AND high traffic (not just low-traffic noise)
(rate(http_errors_total[5m]) / rate(http_requests_total[5m]) > 0.05)
  and
rate(http_requests_total[5m]) > 10
```

**Vector matching:** when operating on two instant vectors, Prometheus matches series by label set. Use `on()` or `ignoring()` to control which labels are used for matching, and `group_left` / `group_right` for many-to-one joins.

```promql
# Ratio — must have matching label sets
rate(http_errors_total[5m]) / rate(http_requests_total[5m])

# Join metrics with different label sets
rate(http_requests_total[5m])
  * on(instance) group_left(role)
instance_info{role="frontend"}
```

### Aggregation Operators

Aggregations collapse or group instant vectors across label dimensions.

| Function | Description |
|----------|-------------|
| `sum()` | Sum all values |
| `avg()` | Average |
| `min()` / `max()` | Min/max |
| `count()` | Count of series |
| `topk(k, v)` | Top k series by value |
| `bottomk(k, v)` | Bottom k series |
| `quantile(φ, v)` | φ-quantile across series (not histogram!) |
| `stddev()` | Standard deviation |

```promql
# Total request rate across all instances of the "app" job
sum(rate(http_requests_total{job="app"}[5m]))

# Per-handler request rate, summed across all instances
sum by(handler) (rate(http_requests_total{job="app"}[5m]))

# Same, but keeping all labels except instance
sum without(instance) (rate(http_requests_total[5m]))

# Top 5 endpoints by request rate
topk(5, sum by(handler) (rate(http_requests_total[5m])))
```

### Key Functions

**rate() and irate():**

```promql
# rate(): per-second average rate over the window — smooth, use for alerts and graphs
rate(http_requests_total[5m])

# irate(): rate based on last two samples only — spiky, use for dashboards showing instant spikes
irate(http_requests_total[5m])
```

**Always use `rate()` on counters, never subtract raw counter values** — counters reset to 0 on process restart, and raw subtraction will produce negative spikes. `rate()` handles resets automatically.

**increase():**
```promql
# Total increase over the window (rate * window duration)
increase(http_requests_total[1h])
```

**Histogram functions:**

```promql
# Calculate quantile from a histogram metric
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# Must sum across instances first when you have multiple replicas
histogram_quantile(0.99,
  sum by(le) (rate(http_request_duration_seconds_bucket[5m]))
)
```

The `le` label is special — it represents the histogram bucket upper bound. Always include `le` in `sum by()` when aggregating histograms.

**Other useful functions:**

```promql
# Predict value 1 hour from now using linear regression
predict_linear(node_filesystem_free_bytes[1h], 3600)

# Derivative (per-second rate of a gauge)
deriv(node_load1[5m])

# Apply a function to each timestamp in a range vector
avg_over_time(node_load1[5m])
max_over_time(node_load1[1h])

# Absolute value, ceiling, floor
abs(delta(node_load1[10m]))

# Clamp values
clamp_max(node_load1, 1.0)
clamp_min(node_load1, 0.0)
```

### Common Production Patterns

**HTTP error ratio (SLI):**
```promql
# Error rate as a fraction of total — used for error budget SLOs
sum(rate(http_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m]))
```

**Latency SLO — fraction of requests under 300ms:**
```promql
sum(rate(http_request_duration_seconds_bucket{le="0.3"}[5m]))
/
sum(rate(http_request_duration_seconds_count[5m]))
```

**CPU utilization:**
```promql
# Per-CPU mode breakdown
sum by(mode) (rate(node_cpu_seconds_total[5m]))

# Overall CPU usage (not idle)
1 - avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))
```

**Memory available fraction:**
```promql
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes
```

**Disk filling up — predict time to full:**
```promql
predict_linear(node_filesystem_free_bytes{fstype!="tmpfs"}[6h], 4 * 3600) < 0
```

### Recording Rules
Recording rules pre-compute expensive or frequently-used queries and store the result as a new time series. They are critical for:
- Queries too expensive to run at dashboard render time (histograms aggregated across many instances)
- Alerting rules that reference complex expressions

```yaml
# rules/recording.yml
groups:
  - name: http_aggregations
    interval: 30s   # evaluation interval; defaults to global evaluation_interval
    rules:

      # Pre-compute per-job request rate
      - record: job:http_requests_total:rate5m
        expr: sum by(job) (rate(http_requests_total[5m]))

      # Pre-compute 99th percentile latency per job
      - record: job:http_request_duration_seconds:p99
        expr: |
          histogram_quantile(0.99,
            sum by(job, le) (rate(http_request_duration_seconds_bucket[5m]))
          )

      # Error ratio per job (for SLO alerting)
      - record: job:http_error_ratio:rate5m
        expr: |
          sum by(job) (rate(http_requests_total{status=~"5.."}[5m]))
          /
          sum by(job) (rate(http_requests_total[5m]))
```

**Naming convention:** `level:metric:operations` — e.g. `job:http_requests_total:rate5m`. This is the official Prometheus naming convention and signals intent clearly.

Recording rules are referenced by name in alert rules and dashboards, just like any other metric:
```promql
job:http_error_ratio:rate5m{job="api"} > 0.05
```

## Examples

**Investigate an error spike:**
```promql
# Which handlers are throwing 5xx errors right now?
topk(10, sum by(handler) (rate(http_requests_total{status=~"5.."}[5m])))

# Compare error rate to 1 hour ago
sum by(handler) (rate(http_requests_total{status=~"5.."}[5m]))
/
sum by(handler) (rate(http_requests_total{status=~"5.."}[5m] offset 1h))
```

**Check if a deployment affected latency:**
```promql
# P99 latency: now vs 30 minutes ago
histogram_quantile(0.99, sum by(le) (rate(http_request_duration_seconds_bucket[5m])))
  /
histogram_quantile(0.99, sum by(le) (rate(http_request_duration_seconds_bucket[5m] offset 30m)))
```

## Exercises

1. Given a counter metric `api_requests_total{service, method, status_code}`, write a PromQL query that returns the per-second error rate (status_code >= 500) for each service, averaged over the last 10 minutes.

2. Write a PromQL expression for the 95th-percentile request duration from a histogram metric `api_duration_seconds_bucket`, aggregated across all instances of each service. Make sure the `le` label is preserved in the aggregation.

3. Write a recording rule group that pre-computes: (a) per-service request rate over 5m, (b) per-service error ratio over 5m, (c) p99 latency per service. Follow the `level:metric:operations` naming convention.

4. Write a PromQL expression that alerts when a disk is predicted to fill up within 4 hours, using `node_filesystem_free_bytes` with a 6-hour linear regression window. Exclude `tmpfs` filesystems.

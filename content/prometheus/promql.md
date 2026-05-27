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

The most important mental model: PromQL operates on vectors, not tables or rows. An instant vector is a snapshot of many time series at one point in time; a range vector is a window of samples from those same series over a time range. Functions like `rate()`, `histogram_quantile()`, and aggregations transform between these types. Once you internalize that, the function signatures stop being arbitrary and start being logical.

Recording rules extend PromQL by letting you pre-compute expensive expressions and store their output as new time series. This is not optional for production: a dashboard querying a histogram aggregated across 50 instances without recording rules will timeout under load. The pattern of writing good recording rules — pre-computing at the `job` level, following the naming convention, layering aggregations — is one of the things that separates junior and senior SREs.

## Concepts

### Data Types

| Type | Description | Example |
|------|-------------|---------|
| **Instant vector** | Set of time series, each with one sample at a point in time | `http_requests_total` |
| **Range vector** | Set of time series, each with a range of samples | `http_requests_total[5m]` |
| **Scalar** | Single float value | `1.5` |
| **String** | String literal (rarely used) | `"foo"` |

Most functions take a range vector and return an instant vector. The `[5m]` notation is the range selector — it says "give me all samples within the last 5 minutes for each series."

### Selectors and Matchers

Label matchers filter which time series are selected. Four matcher operators:

```promql
# Exact match
http_requests_total{job="app", status="200"}

# Regex match (RE2 syntax) — matches 500, 501, 502, ...
http_requests_total{status=~"5.."}

# Negation — everything except 200
http_requests_total{status!="200"}

# Negative regex — exclude health checks
http_requests_total{handler!~"/health.*"}

# Range vector — all samples in the last 5 minutes
http_requests_total{job="app"}[5m]

# Offset — compare to 1 hour ago
http_requests_total offset 1h
```

**Important:** an instant vector selector returns one sample per matched series (the most recent sample within the lookback delta, default 5 minutes). If a target goes down and stops being scraped, the series disappears from instant queries after the lookback window.

**Regex syntax is RE2:** anchors are implicit at word boundaries but not the full string. `status=~"5.."` matches any string that contains a character followed by two characters — if you want to match only 3-character codes starting with 5, use `status=~"5.."` with the understanding that `.` matches any character. To match `500` exclusively, use `status="500"`.

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
# Returns only series where the value is true (non-zero) — filters the vector
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

**`by` and `without` clauses** control which labels are preserved in the result:

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

The aggregation drops all labels not listed in `by()`. If you want to group by `job` and `handler`, list both: `sum by(job, handler)`.

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

**Selecting status codes >= 500:** counters with a `status_code` label use string values, not integers. To select all 5xx codes with regex:

```promql
# Matches 500, 501, 502, 503, 504, etc.
rate(api_requests_total{status_code=~"5.."}[10m])
```

This works because Prometheus label values are always strings. The `5..` pattern matches any 3-character string starting with "5". If your status codes could be 4 digits (e.g., `5000`), adjust the regex: `status_code=~"5[0-9]+"`.

### Histogram Functions — Step by Step

Histograms are the most powerful and misunderstood metric type. Here is exactly what happens and how to query them.

**What a histogram produces:** for a metric `api_duration_seconds` with buckets `[0.1, 0.5, 1.0]`, the client library emits:

```
api_duration_seconds_bucket{le="0.1"}  42    # 42 requests took <= 0.1s
api_duration_seconds_bucket{le="0.5"}  89    # 89 requests took <= 0.5s
api_duration_seconds_bucket{le="1.0"}  96    # 96 requests took <= 1.0s
api_duration_seconds_bucket{le="+Inf"} 100   # 100 total requests (always equals _count)
api_duration_seconds_count             100   # same as +Inf bucket
api_duration_seconds_sum               48.3  # sum of all durations
```

The `le` label (less-than-or-equal) is special — it is automatically added by Prometheus client libraries and must be preserved when aggregating.

**Step 1: convert cumulative bucket counters to per-second rates:**

```promql
rate(api_duration_seconds_bucket[5m])
```

This produces one rate time series per `{le, ...other labels}` combination.

**Step 2: sum across instances (preserve `le`):**

```promql
sum by(service, le) (rate(api_duration_seconds_bucket[5m]))
```

If you forget `le` in `by()`, all bucket series collapse into one, and `histogram_quantile` receives garbage. Always include `le`.

**Step 3: calculate the quantile:**

```promql
histogram_quantile(0.95,
  sum by(service, le) (rate(api_duration_seconds_bucket[5m]))
)
```

`histogram_quantile(φ, v)` takes a quantile (0 to 1) and an instant vector where one of the labels is `le`. It uses linear interpolation within the bucket containing the quantile to estimate the actual value. The result is an instant vector with one series per label combination (minus `le`).

**Complete working expressions:**

```promql
# P99 latency per service across all instances
histogram_quantile(0.99,
  sum by(service, le) (rate(api_duration_seconds_bucket[5m]))
)

# P95 latency — no service label (aggregated across everything)
histogram_quantile(0.95,
  sum by(le) (rate(api_duration_seconds_bucket[5m]))
)

# Fraction of requests under 300ms (SLO compliance)
sum(rate(api_duration_seconds_bucket{le="0.3"}[5m]))
/
sum(rate(api_duration_seconds_count[5m]))
```

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

**Per-service error rate using status_code label:**

```promql
# Rate of 5xx responses per service, averaged over 10 minutes
sum by(service) (rate(api_requests_total{status_code=~"5.."}[10m]))
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

`predict_linear(v, t)` fits a linear regression over range vector `v` and extrapolates `t` seconds into the future. A result `< 0` means the disk is predicted to be full in `t` seconds — here, 4 hours. The `[6h]` window provides enough history for a stable regression.

### Recording Rules

Recording rules pre-compute expensive or frequently-used queries and store the result as a new time series. They are critical for:
- Queries too expensive to run at dashboard render time (histograms aggregated across many instances)
- Alerting rules that reference complex expressions

Recording rules live in a separate YAML file referenced by `rule_files` in `prometheus.yml`. The file is evaluated at `evaluation_interval` (default 15s).

**File structure:**

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

**Naming convention:** `level:metric:operations` — e.g. `job:http_requests_total:rate5m`. The three parts mean:
- `level` — aggregation level: `job`, `instance`, `cluster`, `service`
- `metric` — the original metric name (preserves traceability)
- `operations` — what was done: `rate5m`, `p99`, `ratio`, `sum`

Recording rules are referenced by name in alert rules and dashboards, just like any other metric:

```promql
job:http_error_ratio:rate5m{job="api"} > 0.05
```

**Writing a recording rule group for a service with labels `service`, `method`, `status_code`:**

```yaml
groups:
  - name: api_slo
    rules:
      # Per-service request rate over 5m
      - record: service:api_requests_total:rate5m
        expr: sum by(service) (rate(api_requests_total[5m]))

      # Per-service error ratio over 5m (5xx / total)
      - record: service:api_error_ratio:rate5m
        expr: |
          sum by(service) (rate(api_requests_total{status_code=~"5.."}[5m]))
          /
          sum by(service) (rate(api_requests_total[5m]))

      # P99 latency per service
      - record: service:api_duration_seconds:p99
        expr: |
          histogram_quantile(0.99,
            sum by(service, le) (rate(api_duration_seconds_bucket[5m]))
          )
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

**Disk fill prediction with context:**

```promql
# Returns the predicted free bytes 4 hours from now — if < 0, disk fills within 4h
predict_linear(node_filesystem_free_bytes{fstype!="tmpfs"}[6h], 4 * 3600)

# As an alert condition (returns only series predicted to fill)
predict_linear(node_filesystem_free_bytes{fstype!="tmpfs"}[6h], 4 * 3600) < 0
```

## Exercises

1. Given a counter metric `api_requests_total{service, method, status_code}`, write a PromQL query that returns the per-second error rate (status_code >= 500) for each service, averaged over the last 10 minutes.

2. Write a PromQL expression for the 95th-percentile request duration from a histogram metric `api_duration_seconds_bucket`, aggregated across all instances of each service. Make sure the `le` label is preserved in the aggregation.

3. Write a recording rule group that pre-computes: (a) per-service request rate over 5m, (b) per-service error ratio over 5m, (c) p99 latency per service. Follow the `level:metric:operations` naming convention.

4. Write a PromQL expression that alerts when a disk is predicted to fill up within 4 hours, using `node_filesystem_free_bytes` with a 6-hour linear regression window. Exclude `tmpfs` filesystems.

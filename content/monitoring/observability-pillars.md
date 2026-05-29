---
title: Observability Pillars
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, observability, metrics, logs, traces, sli, slo, datadog]
exercises: 4
---

## Overview

Observability is the ability to understand what your system is doing from its external outputs — without having to redeploy or modify the code to ask new questions. The three pillars — metrics, logs, and traces — each answer a different question about a running system. Metrics tell you *something is wrong* (a number crossed a threshold). Logs tell you *what happened* (the sequence of events at that moment). Traces tell you *where time was spent* (which service or query caused the latency). Each pillar has different cost, cardinality, and query characteristics; a mature observability setup uses all three together, not one in isolation.

The key design principle is **correlation**: the three pillars become exponentially more powerful when they share a common identifier — a trace ID — so an engineer can pivot from a metric spike on a dashboard directly to the logs and distributed trace for that specific request. Without correlation, you have three separate islands of data and you waste time manually reconstructing what happened by cross-referencing timestamps. This is the difference between a system that is merely monitored and one that is truly observable.

In the DevOps toolchain, observability sits between deployment and incident response. After a deploy, metrics tell you immediately if error rates or latency regressed. During an incident, logs and traces tell you why. After the incident, SLOs and error budgets tell you how to prioritize reliability work versus feature work going forward. The dominant tools in this space are Prometheus + Grafana (open source metrics and dashboarding), Loki (open source log aggregation), Jaeger/Tempo (open source tracing), Datadog (SaaS, unified across all three pillars), and the OpenTelemetry project (vendor-neutral instrumentation SDK and wire format that works with any backend).

---

## Concepts

### Metric Types

| Type | Semantics | Example use case |
|------|-----------|-----------------|
| **Counter** | Monotonically increasing integer; only resets to 0 on process restart | HTTP requests total, errors total, bytes sent |
| **Gauge** | Arbitrary float that can go up or down at any time | Memory usage, active connections, queue depth |
| **Histogram** | Samples observations into configurable buckets; stores `_count`, `_sum`, `_bucket` | Request latency, response payload size |
| **Summary** | Pre-calculated client-side quantiles; stores `_count`, `_sum`, and quantile series | Same as histogram but computed in the application process |

**Counter gotcha:** never use a counter for a value that can decrease — use a gauge instead. Counters are designed to be consumed with `rate()` in PromQL, which detects resets by watching for a value decrease and compensates automatically. If you misuse a counter for something like active connections, `rate()` will produce nonsense.

**Histogram vs Summary:**
- **Histograms**: buckets stored server-side; quantiles calculated at query time in PromQL with `histogram_quantile()`. Results can be aggregated across instances (10 pods → one fleet-wide p99).
- **Summaries**: quantiles computed client-side in the application process. Cannot be aggregated. If you have 10 pods each reporting their own p99, there is no mathematically valid way to combine them into a fleet-wide p99. **Prefer histograms in distributed systems.**

```python
from prometheus_client import Counter, Histogram, Gauge, start_http_server

# Counter: label dimensions create separate time series per combination
REQUEST_COUNT = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']   # bounded label values only
)

# Histogram: buckets tuned to the expected latency range (seconds)
# Default buckets are too coarse for sub-10ms services — always tune them
REQUEST_DURATION = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['endpoint'],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5]
)

# Gauge: reflects the actual current value
ACTIVE_CONNECTIONS = Gauge('active_connections', 'Current active connections')

def handle_request(method, endpoint, status):
    with REQUEST_DURATION.labels(endpoint=endpoint).time():
        ACTIVE_CONNECTIONS.inc()
        try:
            result = do_work()
            REQUEST_COUNT.labels(method=method, endpoint=endpoint, status=status).inc()
            return result
        finally:
            ACTIVE_CONNECTIONS.dec()

start_http_server(8000)  # exposes /metrics for Prometheus to scrape
```

### Labels and Cardinality

Labels are key-value pairs attached to a metric. Every unique combination of label values creates a separate time series stored in Prometheus memory. Labels are what make metrics queryable and filterable — but they are the primary cause of memory exhaustion in poorly instrumented systems.

```
http_requests_total{method="GET",  endpoint="/api/users", status="200"} 10432
http_requests_total{method="POST", endpoint="/api/users", status="201"} 312
http_requests_total{method="GET",  endpoint="/api/users", status="500"} 7
```

**Cardinality warning:** each unique label value combination is an independent time series. A service with 50 endpoints × 5 methods × 10 status codes = 2,500 series. That is fine. A service that adds `user_id` as a label with 1 million users = 1 billion potential series. That is an OOM crash.

| Label | Cardinality | Safe? | Notes |
|-------|-------------|-------|-------|
| `env` (prod/staging/dev) | ~3 | ✅ | Ideal |
| `status` (200/404/500) | ~10 | ✅ | Use status class (2xx) if needed |
| `method` (GET/POST/PUT) | ~5 | ✅ | |
| `endpoint` (/api/users) | ~50 | ✅ | Must be normalized — no IDs in path |
| `version` | ~10 | ✅ | Useful during deploys |
| `user_id` | millions | ❌ | Use logs or traces |
| `request_id` | unbounded | ❌ | Use traces |
| `ip_address` | unbounded | ❌ | Use logs |
| Raw URL path (`/api/users/usr_12345`) | unbounded | ❌ | Normalize to `/api/users/{id}` |

**Rule of thumb:** if the label value set is not bounded and enumerable at deploy time, it does not belong as a metric label. User-specific data belongs in logs or traces.

### The Four Golden Signals

From the Google SRE book — the minimum viable set of metrics for any user-facing service. If you instrument nothing else, instrument these four.

| Signal | What it measures | Example metric |
|--------|-----------------|----------------|
| **Latency** | Time to serve a request | `http_request_duration_seconds` (p50, p95, p99) |
| **Traffic** | Demand on the system | `http_requests_total` rate per second |
| **Errors** | Rate of failed requests | `http_requests_total{status=~"5.."}` / total |
| **Saturation** | How "full" the service is | CPU%, memory%, disk I/O%, queue depth |

**Latency gotcha:** always track error latency separately from success latency. A spike in 500s that respond immediately (fast failures) will pull your average latency *down*, hiding a real degradation behind a misleading "improvement." Filter by `status` in latency queries.

**Saturation gotcha:** saturation is often a leading indicator — it predicts problems before errors or latency degrade. A queue that is 90% full will become a dropped-request problem in minutes. Alert on saturation trends, not just thresholds.

```promql
# p99 latency for successful requests only
histogram_quantile(0.99,
  rate(http_request_duration_seconds_bucket{status!~"5.."}[5m])
)

# Error rate as a percentage of total traffic
sum(rate(http_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m])) * 100

# Requests per second (traffic signal)
sum(rate(http_requests_total[1m]))

# CPU saturation across all pods of a service
avg by (service) (
  rate(container_cpu_usage_seconds_total{namespace="production"}[5m])
)
```

### SLIs, SLOs, and Error Budgets

Metrics are only actionable when they are tied to an agreed definition of "good." Service Level Indicators (SLIs), Service Level Objectives (SLOs), and error budgets are the framework for that.

- **SLI**: the actual measurement. "The fraction of requests that completed in under 200ms."
- **SLO**: the target. "99.5% of requests should complete in under 200ms over a 30-day rolling window."
- **Error budget**: what remains. If your SLO is 99.5%, your error budget is 0.5% — the allowable amount of "badness." If you've consumed it, you freeze risky deploys and focus on reliability.

```promql
# SLI: fraction of requests completing under 200ms (good requests / total)
sum(rate(http_request_duration_seconds_bucket{le="0.2"}[30d]))
/
sum(rate(http_request_duration_seconds_count[30d]))

# Error budget remaining (assuming 99.5% SLO)
# If this drops below 0, you've burned your budget
(
  sum(rate(http_request_duration_seconds_bucket{le="0.2"}[30d]))
  /
  sum(rate(http_request_duration_seconds_count[30d]))
  - 0.995
) / 0.005 * 100
# Result: 100 = full budget, 0 = fully consumed, negative = over budget
```

**SLO window gotcha:** a 30-day rolling window is more operationally useful than a calendar month. It means your budget is always evaluated over the last 720 hours, not reset on the 1st of the month. Alerting on fast burn rates (consuming 2% of a monthly budget in 1 hour) catches incidents before they exhaust the budget.

### Structured Logging

Logs are immutable records of discrete events. Structured logs (JSON) are dramatically more queryable than plain text — every field becomes a searchable, filterable dimension in Datadog Logs, Loki, or Elasticsearch. Plain text requires fragile regex parsing; structured logs are parsed at zero additional cost.

**Plain text (hard to query reliably):**
```
2024-01-15 10:23:41 ERROR Payment failed for user usr_12345: insufficient funds
```

**Structured JSON (every field queryable):**
```json
{
  "timestamp": "2024-01-15T10:23:41.123Z",
  "level": "ERROR",
  "message": "Payment failed",
  "service": "payment-service",
  "version": "1.4.2",
  "env": "production",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "user_id": "usr_12345",
  "reason": "insufficient_funds",
  "amount_cents": 9999,
  "currency": "USD"
}
```

```python
import logging
import json
import sys
from datetime import datetime, timezone

class JSONFormatter(logging.Formatter):
    # Fields in logging.LogRecord that are internal bookkeeping — skip them
    _SKIP = frozenset({
        'msg', 'args', 'levelname', 'levelno', 'pathname', 'filename',
        'module', 'exc_info', 'exc_text', 'stack_info', 'lineno',
        'funcName', 'created', 'msecs', 'relativeCreated', 'thread',
        'threadName', 'processName', 'process', 'name', 'message',
        'taskName',
    })

    def format(self, record):
        log_entry = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'level': record.levelname,
            'message': record.getMessage(),
            'logger': record.name,
            'service': 'payment-service',
            'version': '1.4.2',
            'env': 'production',
        }
        # Merge any extra fields passed via the extra={} kwarg
        for key, value in record.__dict__.items():
            if key not in self._SKIP:
                log_entry[key] = value
        if record.exc_info:
            log_entry['exception'] = self.formatException(record.exc_info)
        return json.dumps(log_entry)

def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JSONFormatter())
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger

logger = get_logger(__name__)

# Always pass trace_id in extra={} — links this log line to a distributed trace
logger.info('Payment processed', extra={
    'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
    'user_id': 'usr_12345',
    'amount_cents': 9999,
    'currency': 'USD',
})

logger.error('Payment failed', extra={
    'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
    'user_id': 'usr_12345',
    'reason': 'insufficient_funds',
})
```

**Log level discipline:**

| Level | Use for | Example |
|-------|---------|---------|
| `DEBUG` | Verbose internals; disabled in production | SQL query text, raw request body, variable state |
| `INFO` | Normal operational milestones | Request received, job completed, user logged in |
| `WARNING` | Unexpected but handled; worth investigating | Retry attempt 2/3, cache miss forcing DB fallback |
| `ERROR` | Operation failed; requires attention | DB connection refused, payment gateway rejected charge |
| `CRITICAL` | System-level failure; page someone immediately | Cannot write to disk, out of memory, data corruption |

**Sampling warning:** a high-traffic service can produce hundreds of millions of log lines per day. Log `INFO` and above on the happy path in production. On errors, log with full `DEBUG`-level context for that specific request. Some platforms (Datadog, Honeycomb) support **tail-based sampling** — buffer all logs for a request and only persist them if the request ended in an error or exceeded a latency threshold. This dramatically reduces log volume while keeping 100% of the interesting events.

### Distributed Tracing

A **trace** is the complete record of a single request as it flows through multiple services. Each unit of work within a trace is a **span**. Spans record: service name, operation name, start time, duration, status code, and arbitrary key-value attributes. Spans are nested — child spans represent work done within a parent operation.

```
Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736  (total: 87ms)
│
└── [api-gateway]       handle_request        0ms → 87ms
    ├── [auth-service]  verify_token          2ms → 9ms
    ├── [user-service]  get_user             10ms → 45ms
    │   └── [postgres]  SELECT users          12ms → 40ms  ← 28ms — slow query
    └── [api-gateway]   serialize_response   46ms → 51ms
```

The trace tree immediately shows that 28ms of the 87ms total was spent in a single PostgreSQL query. This is invisible in metrics (which aggregate across all requests) and buried in logs (which require manual correlation). Tracing is the only pillar that answers "where did the time go for this specific request?"

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

# Configure once at application startup — not per-request
provider = TracerProvider()
# OTLP is the vendor-neutral wire format; swap the endpoint for any backend
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://otel-collector:4317"))
)
trace.set_tracer_provider(provider)

tracer = trace.get_tracer("user-service", "1.4.2")

def get_user(user_id: str):
    with tracer.start_as_current_span("get_user") as span:
        span.set_attribute("user.id", user_id)
        span.set_attribute("service.version", "1.4.2")

        with tracer.start_as_current_span("db.query") as db_span:
            db_span.set_attribute("db.system", "postgresql")
            db_span.set_attribute("db.name", "users_db")
            # Parameterized form only — never log actual parameter values
            db_span.set_attribute("db.statement", "SELECT id, name FROM users WHERE id = $1")
            try:
                result = db.query("SELECT id, name FROM users WHERE id = $1", user_id)
                db_span.set_attribute("db.rows_returned", len(result))
                return result
            except Exception as e:
                # Marking the span ERROR surfaces it in trace search UIs
                db_span.set_status(trace.StatusCode.ERROR, str(e))
                db_span.record_exception(e)
                raise
```

**Context propagation** is the mechanism by which a trace ID travels across service boundaries. Without it, each service would start a new unconnected trace and you'd lose the end-to-end picture.

```python
from opentelemetry.propagate import inject, extract

# Outgoing HTTP call: inject trace context into request headers
headers = {}
inject(headers)  # adds W3C 'traceparent' header automatically
response = requests.get("http://user-service/users/123", headers=headers)

# Incoming request: extract trace context from incoming headers
context = extract(request.headers)
# Start the span as a child of the caller's span — not a new root span
with tracer.start_as_current_span("handle_request", context=context) as span:
    span.set_attribute("http.method", request.method)
    process(request)
```

The W3C `traceparent` header is the standard format: `{version}-{trace_id}-{parent_span_id}-{flags}`
```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

**Sampling gotcha:** recording 100% of traces is expensive at scale. Production systems use **head-based sampling** (decide at the first span whether to record the trace) or **tail-based sampling** (buffer the full trace, then decide based on outcome — errors are always kept). The OpenTelemetry Collector supports both. Never sample away errors.

### Connecting the Three Pillars

The three pillars deliver their full value only when they are correlated by a shared `trace_id`. An on-call engineer sees a metric spike → clicks through to logs filtered by `trace_id` → clicks through to the full distributed trace. This pivot takes seconds instead of the 20 minutes it takes when the data lives in three unrelated systems.

```python
import uuid
from opentelemetry import trace as otel_trace
from opentelemetry.propagate import extract

def handle_request(request):
    # Extract incoming trace context (or start a new root trace)
    ctx = extract(request.headers)

    with tracer.start_as_current_span("handle_request", context=ctx) as span:
        # Get the active trace ID as a hex string
        span_ctx = span.get_span_context()
        trace_id_hex = format(span_ctx.trace_id, '032x') if span_ctx.is_valid else str(uuid.uuid4())

        # 1. Inject trace_id into every log line for this request
        #    Now you can filter logs by trace_id in Loki/Datadog/Elasticsearch
        logger.info('Request received', extra={
            'trace_id': trace_id_hex,
            'method': request.method,
            'path': request.path,
        })

        # 2. The active span already carries the trace_id — no extra work needed
        span.set_attribute("http.method", request.method)
        span.set_attribute("http.route", request.path)

        result = process(request)

        # 3. Metrics carry env/service/endpoint/status — NOT trace_id
        #    trace_id is unbounded and would cause cardinality explosion
        REQUEST_COUNT.labels(
            method=request.method,
            endpoint=normalize_path(request.path),  # /users/123 → /users/{id}
            status=str(result.status_code),
        ).inc()

        return result
```

**Practical correlation checklist:**
- Every log line for a request includes `trace_id` and `span_id`.
- Metrics use `service`, `env`, `version`, `endpoint` labels — never `trace_id` or `user_id`.
- Traces carry rich attributes (`user.id`, `http.route`, `db.statement`) for search.
- All three use the same `service` name so dashboards link correctly.

**Datadog unified correlation:** tag metrics, logs, and traces with `service`, `env`, and `version` using Unified Service Tagging. Datadog uses these three tags to automatically connect APM traces to infrastructure metrics and logs — clicking a slow trace will surface the corresponding log lines and host CPU graph without any manual correlation.

```yaml
# docker-compose label example — applied to all three pillars automatically
labels:
  com.datadoghq.tags.service: "payment-service"
  com.datadoghq.tags.env: "production"
  com.datadoghq.tags.version: "1.4.2"
```

### OpenTelemetry and the Collector

OpenTelemetry (OTel) is the CNCF standard for instrumentation. It provides a single SDK that emits metrics, logs, and traces in a vendor-neutral format (OTLP). You instrument your application once and route data to any backend by changing collector configuration — no code changes to switch from Jaeger to Honeycomb to Datadog.

```
Application (OTel SDK)
        │  OTLP gRPC/HTTP
        ▼
OTel Collector  ──── Prometheus remote_write ──→ Thanos / Grafana Cloud
                ├─── OTLP ──────────────────────→ Jaeger / Tempo
                ├─── Datadog exporter ──────────→ Datadog
                └─── Loki exporter ─────────────→ Grafana Loki
```

The Collector is also where you apply **processing pipelines**: redact PII from logs, drop high-cardinality attributes from spans, add resource attributes (`k8s.pod.name`, `cloud.region`), and apply tail-based sampling decisions.

```yaml
# otel-collector-config.yaml — minimal production-like configuration
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
  # Drop spans shorter than 1ms from health check endpoints
  filter/drop_health:
    spans:
      exclude:
        match_type: strict
        attributes:
          - key: http.route
            value: /healthz
  resource:
    attributes:
      - key: deployment.environment
        value: production
        action: upsert

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, filter/drop_health, resource]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [prometheusremotewrite]
```

---

## Examples

### Example 1: Prometheus + Grafana alerting on error rate

This example sets up metric collection, defines an alert rule, and verifies it fires.

```yaml
# prometheus.yml — scrape config
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  - job_name: 'payment-service'
    static_configs:
      - targets: ['payment-service:8000']
    # Add env label to every metric from this job
    relabel_configs:
      - target_label: env
        replacement: production
```

```yaml
# rules/payment-service.yml — alert definitions
groups:
  - name: payment-service
    interval: 30s
    rules:
      # Alert when error rate exceeds 1% for 5 consecutive minutes
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{job="payment-service", status=~"5.."}[5m]))
          /
          sum(rate(http_requests_total{job="payment-service"}[5m])) > 0.01
        for: 5m
        labels:
          severity: page
          team: payments
        annotations:
          summary: "Error rate {{ $value | humanizePercentage }} on payment-service"
          runbook: "https://wiki.example.com/runbooks/payment-service-errors"

      # Alert when p99 latency exceeds 500ms
      - alert: HighLatencyP99
        expr: |
          histogram_quantile(0.99,
            sum by (le) (
              rate(http_request_duration_seconds_bucket{job="payment-service"}[5m])
            )
          ) > 0.5
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "p99 latency {{ $value | humanizeDuration }} on payment-service"
```

**Verify it works:**
```bash
# Trigger synthetic errors to fire the alert
for i in $(seq 1 200); do
  curl -s -o /dev/null http://localhost:8000/api/pay?fail=true
done

# Check pending/firing alerts in Prometheus
curl -s http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | {alert: .labels.alertname, state: .state}'

# Expected output:
# {"alert": "HighErrorRate", "state": "firing"}
```

### Example 2: Structured logging with correlation in Docker Compose

Full stack: application emitting JSON logs, Promtail shipping to Loki, queryable in Grafana.

```yaml
# docker-compose.yml
version: '3.8'
services:
  app:
    image: payment-service:1.4.2
    environment:
      LOG_LEVEL: info
      OTEL_SERVICE_NAME: payment-service
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
    labels:
      # Promtail uses these labels to tag log streams
      logging: "true"
      service: "payment-service"

  loki:
    image: grafana/loki:2.9.0
    ports: ["3100:3100"]
    command: -config.file=/etc/loki/local-config.yaml

  promtail:
    image: grafana/promtail:2.9.0
    volumes:
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock
      - ./promtail-config.yml:/etc/promtail/config.yml
    command: -config.file=/etc/promtail/config.yml

  grafana:
    image: grafana/grafana:10.2.0
    ports: ["3000:3000"]
```

```yaml
# promtail-config.yml
server:
  http_listen_port: 9080

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
        filters:
          - name: label
            values: ["logging=true"]   # only collect labeled containers
    pipeline_stages:
      # Parse JSON logs — all fields become queryable label values
      - json:
          expressions:
            level: level
            trace_id: trace_id
            service: service
      - labels:
          level:
          trace_id:
          service:
    relabel_configs:
      - source_labels: ['__meta_docker_container_label_service']
        target_label: service
```

**Verify it works:**
```bash
# Query Loki for all ERROR logs from the last 5 minutes
curl -G http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service="payment-service"} | json | level="ERROR"' \
  --data-urlencode 'start=-5m' \
  | jq '.data.result[].values[][1]' | jq -r fromjson

# Query by trace_id — find all log lines for a specific request
curl -G http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service="payment-service"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"'
```

### Example 3: End-to-end OpenTelemetry trace with the Collector

Instrument a two-service interaction and verify the full trace appears in Jaeger.

```bash
# docker-compose up -d with this stack:
# app (emits OTLP) → otel-collector → jaeger (stores and serves traces)

docker run -d --name jaeger \
  -p 16686:16686 \    # Jaeger UI
  -p 4317:4317 \      # OTLP gRPC receiver
  jaegertracing/all-in-one:1.52

# Run a request through the instrumented service
curl -v http://localhost:8080/api/checkout \
  -H 'Content-Type: application/json' \
  -d '{"user_id": "usr_123", "cart_id": "cart_456"}'

# Extract the trace_id from the response header
# X-Trace-Id: 4bf92f3577b34da6a3ce929d0e0e4736

# Fetch the trace from Jaeger API
curl -s "http://localhost:16686/api/traces/4bf92f3577b34da6a3ce929d0e0e4736" \
  | jq '.data[0].spans | map({operation: .operationName, duration_ms: (.duration / 1000)})'

# Expected output:
# [
#   {"operation": "handle_request", "duration_ms": 87},
#   {"operation": "verify_token",   "duration_ms": 7},
#   {"operation": "get_user",       "duration_ms": 35},
#   {"operation": "db.query",       "duration_ms": 28}
# ]
```

**What to look for:** the nested span durations should sum to the parent duration. If `db.query` duration is disproportionately large relative to `get_user`, you have found the bottleneck. This is the core value of tracing.

### Example 4: SLO burn rate alerting

Alert before the error budget is exhausted using multi-window burn rate (Google's recommended approach).

```yaml
# rules/slo-payment.yml
groups:
  - name: payment-slo
    rules:
      # Fast burn: consuming 14x the normal error rate — budget gone in 1 hour
      # Alert if this is true for 2 minutes to avoid noise
      - alert: PaymentSLOFastBurn
        expr: |
          (
            sum(rate(http_requests_total{service="payment-service", status=~"5.."}[5m]))
            / sum(rate(http_requests_total{service="payment-service"}[5m]))
          ) > (14 * 0.005)
          and
          (
            sum(rate(http_requests_total{service="payment-service", status=~"5.."}[1h]))
            / sum(rate(http_requests_total{service="payment-service"}[1h]))
          ) > (14 * 0.005)
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "Payment SLO fast burn — error budget will be exhausted in ~1h"

      # Slow burn: consuming 5x normal — budget gone in 3 days
      - alert: PaymentSLOSlowBurn
        expr: |
          (
            sum(rate(http_requests_total{service="payment-service", status=~"5.."}[30m]))
            / sum(rate(http_requests_total{service="payment-service"}[30m]))
          ) > (5 * 0.005)
          and
          (
            sum(rate(http_requests_total{service="payment-service"}[6h]))
            / sum(rate(http_requests_total{service="payment-service"}[6h]))
          ) > (5 * 0.005)
        for: 15m
        labels:
          severity: ticket
        annotations:
          summary: "Payment SLO slow burn — investigate before budget exhaustion"
```

**Verify it works:**
```bash
# Check current error budget consumption in PromQL console
curl -s 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=
    1 - (
      sum(rate(http_requests_total{service="payment-service", status=~"5.."}[30d]))
      / sum(rate(http_requests_total{service="payment-service"}[30d]))
    ) / 0.005
  ' | jq '.data.result[0].value[1]'
# Output: "0.73" means 73% of error budget remaining
```

---

## Exercises

### Exercise 1: Instrument a Flask app with Prometheus metrics

Deploy a small Flask application and add the four golden signals using `prometheus_client`. Your task is not to copy the code from the Concepts section — you need to make two non-obvious decisions:

1. Choose appropriate histogram bucket boundaries for an API that is expected to respond in 10–200ms. Explain why default Prometheus buckets (0.005s to 10s) are wrong for this range.
2. The app has URLs like `/api/orders/ORD-12345` and `/api/orders/ORD-67890`. Decide how to label the `endpoint` dimension and implement it so cardinality remains bounded.

**Verify:** run `curl http://localhost:8000/metrics` and confirm all four signal metrics are present. Write a PromQL expression that returns the current p95 latency. Explain in one sentence why `rate()` requires at least two data points separated by the scrape interval.

### Exercise 2: Debug a slow request using traces

Start the provided two-service Docker Compose stack (`api-gateway` → `user-service` → PostgreSQL). It has an intentional N+1 query bug: fetching a list of 10 users issues 11 database queries instead of 1.

Using the Jaeger UI at `http://localhost:16686`:
1. Find a trace for `GET /api/users` and identify which span is repeated 10 times.
2. Record the `db.statement` attribute on the repeated span.
3. Propose a single SQL change that would collapse the 10 queries into 1 and estimate the expected latency improvement based on the span durations you observed.

**The point:** you should be able to identify the root cause in under 2 minutes using only the trace view — without reading any application code.

### Exercise 3: Correlate a log line to a trace

Your payment service is logging errors. A log line has `trace_id: "abc123..."`. Your task:

1. Write a Loki query that returns only ERROR-level logs from `payment-service` in the last 15 minutes.
2. Modify the query to filter to a single `trace_id`. What does it tell you about the sequence of events for that request?
3. Use the same `trace_id` to look up the full trace in Jaeger. Compare the timestamps on the log lines to the span start/end times. Are they consistent? If there is a discrepancy, what could cause it (hint: think about clock skew and buffered log writes)?
4. Identify one piece of information available in the trace that is not in the logs, and one piece of information in the logs that is not in the trace. Explain why each pillar stores what it stores.

### Exercise 4: Define and validate an SLO

A new checkout service has the following raw data from the last 7 days:
- Total requests: 2,400,000
- Requests completing under 300ms: 2,352,000
- 5xx errors: 4,800

1. Calculate the availability SLI (success rate) and the latency SLI (fraction under 300ms).
2. The team wants to set a 30-day availability SLO of 99.8%. Using only the 7-day data, estimate whether the service would meet this target. Show your calculation.
3. Write a PromQL expression that computes the current 7-day availability SLI from raw `http_requests_total` counters. Test it in the Prometheus UI.
4. The team wants to alert when they have consumed 20% of their monthly error budget within a single day. Calculate the error rate threshold that triggers this condition and write the alert rule. (Hint: a 30-day budget at 99.8% SLO = 0.2% allowed errors = how many minutes of downtime?)

---

### Quick Checks

5. Count the three observability pillars. Run: `printf 'metrics\nlogs\ntraces\n' | wc -l`

```expected_output
3
```

6. Classify a metric by name convention. Run: `python3 -c "name='http_requests_total'; print('counter' if name.endswith('_total') else 'gauge')"`

```expected_output
counter
```

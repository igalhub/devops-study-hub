---
title: Observability Pillars
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, observability, metrics, logs, traces, sli, slo, datadog]
exercises: 4
---

## Overview

Observability is the ability to understand what your system is doing from its external outputs — without having to redeploy or modify the code to ask new questions. The three pillars — metrics, logs, and traces — each answer a different question about a running system. Metrics tell you *something is wrong* (a number crossed a threshold). Logs tell you *what happened* (the sequence of events at that moment). Traces tell you *where time was spent* (which service or query caused the latency). Each pillar has different cost, cardinality, and query characteristics; a mature observability setup uses all three.

The key design principle is **correlation**: the three pillars become exponentially more powerful when they share a common identifier — a trace ID — so an engineer can pivot from a metric spike on a dashboard directly to the logs and distributed trace for that specific request. Without correlation, you have three separate islands of data and you waste time manually reconstructing what happened.

In the DevOps toolchain, observability lives between deployment and incident response. After a deploy, metrics tell you immediately if error rates or latency changed. During an incident, logs and traces tell you why. After the incident, SLOs and error budgets tell you how to prioritize reliability work vs. feature work. Tools in this space include Prometheus + Grafana (open source), Datadog (SaaS, unified), Jaeger/Tempo (tracing), and the OpenTelemetry project (vendor-neutral instrumentation standard).

---

## Concepts

### Metric Types

| Type | Semantics | When to use |
|------|-----------|-------------|
| **Counter** | Monotonically increasing integer; resets to 0 on process restart | HTTP requests total, errors total, bytes sent |
| **Gauge** | Arbitrary float that can go up or down | Memory usage, active connections, queue depth |
| **Histogram** | Samples observations into configurable buckets; stores `_count`, `_sum`, and `_bucket` series | Request latency, response payload size |
| **Summary** | Pre-calculated client-side quantiles; stores `_count`, `_sum`, and quantile series | Same use cases as histogram, but computed in the app |

**Counter gotcha:** never use a counter for a value that can decrease (e.g., current active connections). Use a gauge. Counters are designed to be consumed with `rate()` in PromQL, which handles resets automatically by detecting when a value decreases.

**Histogram vs Summary:**
- **Histograms**: buckets are stored server-side, quantiles are calculated at query time in PromQL using `histogram_quantile()` — they can be aggregated across instances.
- **Summaries**: quantiles are computed client-side in the application — they *cannot* be aggregated across replicas. If you have 10 pods each reporting p99, you cannot average those to get the fleet-wide p99. **Prefer histograms in distributed systems.**

```python
from prometheus_client import Counter, Histogram, Gauge, start_http_server

# Counter: label dimensions create separate time series per combination
REQUEST_COUNT = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']   # bounded label values only
)

# Histogram: buckets tuned to expected latency range (seconds)
REQUEST_DURATION = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['endpoint'],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5]
)

# Gauge: goes up and down with the actual value
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

# Expose /metrics on port 8000
start_http_server(8000)
```

### Labels and Cardinality

Labels are key-value pairs attached to a metric. Every unique combination of label values creates a separate time series in Prometheus. Labels are what make metrics queryable and filterable.

```
http_requests_total{method="GET",  endpoint="/api/users", status="200"} 10432
http_requests_total{method="POST", endpoint="/api/users", status="201"} 312
http_requests_total{method="GET",  endpoint="/api/users", status="500"} 7
```

**Cardinality warning:** high-cardinality labels cause memory exhaustion and slow queries. Each unique label value combination is a separate time series stored in memory.

| Label | Cardinality | Safe? |
|-------|-------------|-------|
| `env` (prod/staging/dev) | ~3 | ✅ |
| `status` (200/404/500) | ~10 | ✅ |
| `method` (GET/POST/PUT) | ~5 | ✅ |
| `endpoint` (/api/users, /api/orders) | ~50 | ✅ (if bounded) |
| `user_id` | millions | ❌ |
| `request_id` | unbounded | ❌ |
| `ip_address` | unbounded | ❌ |

**Rule of thumb:** if the label value set isn't bounded and well-known at deploy time, it probably shouldn't be a label. User-specific data belongs in logs or traces, not metrics.

### The Four Golden Signals

From the Google SRE book — the minimum viable set of signals for any user-facing service:

| Signal | What it measures | Example metric |
|--------|-----------------|----------------|
| **Latency** | Time to serve a request | `http_request_duration_seconds` (p50, p95, p99) |
| **Traffic** | Demand on the system | `http_requests_total` rate per second |
| **Errors** | Rate of failed requests | `http_requests_total{status=~"5.."}` / total |
| **Saturation** | How "full" the system is | CPU%, memory%, disk%, queue depth |

**Latency gotcha:** always track error latency separately from success latency. A spike in 500s that respond immediately (fast errors) will pull your average latency *down*, masking a real problem. Use `status` labels and filter in your dashboards.

```promql
# p99 latency for successful requests only
histogram_quantile(0.99,
  rate(http_request_duration_seconds_bucket{status!~"5.."}[5m])
)

# Error rate as a percentage
sum(rate(http_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m])) * 100
```

### Structured Logging

Logs are immutable records of discrete events. Structured logs (JSON) are dramatically more queryable than plain text — every field becomes a searchable, filterable dimension in tools like Datadog Logs, Elasticsearch, or Loki.

**Plain text (hard to query):**
```
2024-01-15 10:23:41 ERROR Payment failed for user usr_12345: insufficient funds
```

**Structured JSON (queryable):**
```json
{
  "timestamp": "2024-01-15T10:23:41.123Z",
  "level": "ERROR",
  "message": "Payment failed",
  "service": "payment-service",
  "version": "1.4.2",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
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
    def format(self, record):
        log_entry = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'level': record.levelname,
            'message': record.getMessage(),
            'logger': record.name,
            'service': 'payment-service',
            'version': '1.4.2',
        }
        # Merge any extra fields passed via extra={}
        for key, value in record.__dict__.items():
            if key not in ('msg', 'args', 'levelname', 'levelno', 'pathname',
                           'filename', 'module', 'exc_info', 'exc_text',
                           'stack_info', 'lineno', 'funcName', 'created',
                           'msecs', 'relativeCreated', 'thread', 'threadName',
                           'processName', 'process', 'name', 'message'):
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

# Usage — structured fields via extra={}
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
| `DEBUG` | Verbose internals, off in production | SQL query text, variable values |
| `INFO` | Normal operational events | Request received, job started, user logged in |
| `WARNING` | Unexpected but handled | Retry attempt 2/3, cache miss fallback |
| `ERROR` | Operation failed, needs attention | DB connection failed, payment rejected |
| `CRITICAL` | System-level failure, page someone now | Can't write to disk, out of memory |

**Sampling warning:** high-traffic services can produce millions of log lines per minute. Log everything at DEBUG in staging; in production, log INFO and above for the happy path but log full DEBUG context on errors. Some platforms (Datadog, Honeycomb) support head-based and tail-based sampling to control volume.

### Distributed Tracing

A **trace** is the complete record of a single request as it flows through multiple services. Each unit of work within that trace is a **span**. Spans record: service name, operation name, start time, duration, status, and arbitrary key-value attributes.

```
Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736  (total: 87ms)
│
└── [api-gateway]       handle_request        0ms → 87ms
    ├── [auth-service]  verify_token          2ms → 9ms
    ├── [user-service]  get_user             10ms → 45ms
    │   └── [postgres]  SELECT users          12ms → 40ms   ← slow query
    └── [api-gateway]   serialize_response   46ms → 51ms
```

The trace tree immediately shows that a PostgreSQL query consumed 28ms of the 87ms total — something you'd never see from metrics or logs alone.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

# Configure once at application startup
provider = TracerProvider()
# Export to any OTLP-compatible backend (Jaeger, Tempo, Datadog, Honeycomb)
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
            db_span.set_attribute("db.statement", "SELECT id, name, email FROM users WHERE id = $1")
            try:
                result = db.query("SELECT id, name, email FROM users WHERE id = $1", user_id)
                db_span.set_attribute("db.rows_returned", len(result))
                return result
            except Exception as e:
                # Mark span as error — surfaces in trace UIs
                db_span.set_status(trace.StatusCode.ERROR, str(e))
                db_span.record_exception(e)
                raise
```

**Context propagation** is how the trace ID travels between services — typically via HTTP headers:

```python
from opentelemetry.propagate import inject, extract

# Outgoing HTTP call — inject trace context into headers
headers = {}
inject(headers)   # adds 'traceparent' header automatically
response = requests.get("http://user-service/users/123", headers=headers)

# Incoming request — extract trace context from headers
context = extract(request.headers)
with tracer.start_as_current_span("handle_request", context=context):
    ...
```

The W3C `traceparent` header format: `00-{trace_id}-{parent_span_id}-{flags}`
```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

### Connecting the Three Pillars

The three pillars deliver their real value when correlated by a shared `trace_id`. An on-call engineer sees a metric spike → clicks through to logs filtered by trace_id → clicks through to the full distributed trace. This pivot takes seconds instead of minutes.

```python
import uuid
from opentelemetry import trace as otel_trace

def handle_request(request):
    # Extract or generate trace ID
    ctx = extract(request.headers)
    trace_id = otel_trace.get_current_span().get_span_context().trace_id
    trace_id_hex = format(trace_id, '032x') if trace_id else str(uuid.uuid4())

    # 1. Include trace_id in every log line for this request
    logger.info('Request started', extra={
        'trace_id': trace_id_hex,
        'method': request.method,
        'path': request.path,
    })

    # 2. The span already carries the trace_id — no extra work needed
    with tracer.start_as_current_span("handle_request", context=ctx) as span:
        span.set_attribute("http.method", request.method)
        span.set_attribute("http.route", request.path)

    # 3. Metrics do NOT use trace_id as a label — it's high cardinality
    #    Metrics carry env, service, endpoint, status — not individual request IDs
    REQUEST_COUNT.labels(
        method=request.method,
        endpoint=request.path,   # normalized path, not raw URL
        status='200'
    ).inc()
```

**Practical correlation in Datadog:** tag metrics, logs, and traces with the same `service`, `env`, and `version` tags. Datadog
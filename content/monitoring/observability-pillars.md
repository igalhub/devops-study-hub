---
title: Observability Pillars
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, observability, metrics, logs, traces, sli, slo, datadog]
exercises: 4
---

## Overview
Observability is the ability to understand what your system is doing from its external outputs. The three pillars — metrics, logs, and traces — each answer different questions. Metrics tell you something is wrong. Logs tell you what happened. Traces tell you where time was spent across services. A mature monitoring setup uses all three, connected by a common request ID so you can pivot from a metric spike to the relevant logs and traces.

## Concepts

### The Three Pillars

#### Metrics
Metrics are numeric measurements over time — they're cheap to store and fast to query:
```
Counter      — monotonically increasing (requests_total, errors_total)
Gauge        — point-in-time value (memory_bytes, queue_depth, active_connections)
Histogram    — distribution of values (request_duration_seconds — p50, p95, p99)
Summary      — pre-calculated quantiles (client-side, less flexible than histogram)
```

```python
# Prometheus client (Python)
from prometheus_client import Counter, Histogram, Gauge, start_http_server

REQUEST_COUNT = Counter('http_requests_total', 'Total HTTP requests', ['method', 'endpoint', 'status'])
REQUEST_DURATION = Histogram('http_request_duration_seconds', 'HTTP request duration', ['endpoint'])
ACTIVE_CONNECTIONS = Gauge('active_connections', 'Current active connections')

# Instrument your code
@REQUEST_DURATION.labels(endpoint='/api/users').time()
def handle_request():
    ACTIVE_CONNECTIONS.inc()
    try:
        result = do_work()
        REQUEST_COUNT.labels(method='GET', endpoint='/api/users', status='200').inc()
        return result
    finally:
        ACTIVE_CONNECTIONS.dec()
```

**The Four Golden Signals** (Google SRE book):
1. **Latency** — time to serve a request (distinguish success vs error latency)
2. **Traffic** — requests per second (load on the system)
3. **Errors** — rate of failed requests (5xx, timeouts, wrong content)
4. **Saturation** — how "full" a resource is (CPU, memory, disk, queue depth)

#### Logs
Logs are immutable records of discrete events. Structured logs (JSON) are dramatically more useful than plain text:

```python
import logging
import json
import sys

class JSONFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            'timestamp': self.formatTime(record),
            'level': record.levelname,
            'message': record.getMessage(),
            'logger': record.name,
            'request_id': getattr(record, 'request_id', None),
        })

logger = logging.getLogger(__name__)
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JSONFormatter())
logger.addHandler(handler)

# Structured log entry
logger.info('Payment processed', extra={
    'request_id': '550e8400-e29b-41d4-a716-446655440000',
    'user_id': 'usr_12345',
    'amount': 99.99,
    'currency': 'USD'
})
```

**Log levels** — use them consistently:
```
DEBUG    — detailed diagnostic info (verbose, off in production)
INFO     — normal operational events (request received, job started)
WARNING  — unexpected but recoverable (retry attempt, fallback used)
ERROR    — operation failed, requires attention
CRITICAL — system-level failure, immediate action needed
```

#### Traces
Traces show the path of a single request across multiple services. Each operation within that path is a **span**:

```
Trace ID: abc123
├── span: api-gateway (50ms total)
│   ├── span: auth-service (5ms)
│   ├── span: user-service (20ms)
│   │   └── span: postgres query (15ms)
│   └── span: response serialization (2ms)
```

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

provider = TracerProvider()
trace.set_tracer_provider(provider)
tracer = trace.get_tracer(__name__)

def get_user(user_id: str):
    with tracer.start_as_current_span("get_user") as span:
        span.set_attribute("user.id", user_id)
        # nested span for DB call
        with tracer.start_as_current_span("db.query") as db_span:
            db_span.set_attribute("db.system", "postgresql")
            db_span.set_attribute("db.statement", "SELECT * FROM users WHERE id = ?")
            return db.query("SELECT * FROM users WHERE id = ?", user_id)
```

### Connecting the Pillars
The three pillars become most powerful when they share a correlation ID:

```python
import uuid

def handle_request(request):
    trace_id = request.headers.get('X-Trace-Id', str(uuid.uuid4()))

    # Include trace ID in logs
    logger.info('Request started', extra={'trace_id': trace_id})

    # Include trace ID in spans
    with tracer.start_as_current_span("handle_request") as span:
        span.set_attribute("trace_id", trace_id)

    # Include trace ID in metric labels (use sparingly — high cardinality)
    REQUEST_COUNT.labels(trace_id=trace_id).inc()  # DON'T do this — unbounded cardinality

    # Instead, pass trace_id only in headers for log/trace correlation
```

### SLI / SLO / SLA

```
SLI (Service Level Indicator)
  — the metric you're measuring
  — "99th percentile latency for /api/users"
  — "percentage of requests returning 2xx"

SLO (Service Level Objective)
  — your target for the SLI
  — "99th percentile latency < 200ms, measured over 30 days"
  — "99.9% of requests return 2xx (error budget: 43.8 min/month)"

SLA (Service Level Agreement)
  — a contractual commitment to the SLO, with consequences for breach
  — "We guarantee 99.9% availability; customers get credit if we breach it"
```

**Error budget** = 100% - SLO target. A 99.9% availability SLO gives you 43.8 minutes of downtime per month. Spend it deliberately on deployments and maintenance, not incidents.

```python
# Calculate error budget burn rate
availability_target = 0.999   # 99.9%
error_budget_minutes_per_month = 30 * 24 * 60 * (1 - availability_target)
# = 43.2 minutes
```

### The USE Method (for resources) and RED Method (for services)

**USE** (Utilization, Saturation, Errors) — for infrastructure resources (CPU, memory, disk):
- Utilization: what % of the resource is busy?
- Saturation: is work queuing up because the resource is full?
- Errors: are there hardware or OS-level errors?

**RED** (Rate, Errors, Duration) — for services and APIs:
- Rate: requests per second
- Errors: failed requests per second
- Duration: distribution of response times

## Examples

### Datadog Agent Tags
```yaml
# /etc/datadog-agent/datadog.yaml
api_key: <DD_API_KEY>
site: datadoghq.com

tags:
  - env:production
  - service:myapp
  - version:1.2.3
  - team:platform
```

Tags allow you to filter and correlate metrics, logs, and traces across all three pillars in Datadog.

## Exercises

1. Instrument a Python Flask or FastAPI app with Prometheus metrics: a Counter for request count (labeled by method, endpoint, status code) and a Histogram for request duration. Expose `/metrics`. Query the metrics with `curl`.
2. Add structured JSON logging to a Python app. Include: timestamp, level, message, request_id (generated per request), service name, and version. Run the app and pipe the logs to `jq` to verify the structure.
3. Define SLOs for a simple web API: (a) 99.5% availability over 30 days, (b) p95 latency < 300ms over 1 hour. Calculate the error budget for each. Write what specific metrics (SLIs) you'd measure to track each SLO.
4. Draw (on paper or as a diagram) the observability setup for a 3-service system (API gateway → user service → database). Show which metrics, logs, and traces each service emits, and how they share a trace ID for correlation.

---
title: Application Performance Monitoring (APM)
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, apm, datadog, distributed-tracing, spans, profiling, ddtrace]
exercises: 4
---

## Overview

Application Performance Monitoring (APM) gives you code-level visibility into how requests execute inside your services. Infrastructure metrics tell you a host is at 90% CPU; APM tells you *why* — a specific function, query, or downstream call is responsible. Without APM, a 2-second response time is a black box. With APM, you see the exact breakdown: 2ms in the API handler, 5ms in the auth service, and 1993ms blocked on a single unindexed database query. That specificity collapses the gap between "something is slow" and "here is the fix."

The core design principle of modern APM is **distributed tracing**: every request is assigned a trace ID that propagates across service boundaries via HTTP headers or message queue metadata. Each unit of work within a trace is a **span** — a named, timed operation with arbitrary key-value tags attached. Spans form a parent-child tree that reconstructs exactly what happened during a request, across every service it touched. Datadog APM extends this model with automatic instrumentation of popular frameworks, deep database visibility, continuous profiling, and correlation with logs and metrics.

In the DevOps toolchain, APM sits between infrastructure monitoring (dashboards, host metrics) and incident response (alerts, on-call). It answers the questions that metrics dashboards raise but cannot answer: latency is up — is it our code, our database, or a third-party API? Error rate spiked — which endpoint, which user path, which downstream dependency? APM is the evidence layer that makes postmortems conclusive and debugging fast.

---

## Concepts

### Traces, Spans, and the Propagation Model

A **trace** is the complete record of a single request's journey through your system. It is identified by a globally unique `trace_id`. A **span** is one unit of work within that trace — a function call, a database query, an HTTP request to another service. Every span has:

| Field | Description |
|---|---|
| `trace_id` | Shared across all spans in the same request |
| `span_id` | Unique ID for this specific span |
| `parent_id` | The span ID of the caller; absent on the root span |
| `resource` | What was done: route name, SQL query, gRPC method |
| `service` | Which service produced the span |
| `duration` | Wall-clock time in nanoseconds |
| `error` | Boolean; triggers error highlighting in Datadog UI |
| `tags` (meta) | Arbitrary string key-value pairs |

Spans are connected into a tree by `parent_id`. The root span (no parent) is created by the entry point — your API gateway or web server. Child spans are created automatically by instrumented libraries or manually by your code.

**Propagation** is how trace context crosses service boundaries. When service A calls service B over HTTP, the `ddtrace` client injects the trace and span IDs into request headers:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
x-datadog-trace-id: 5208512171318403895
x-datadog-parent-id: 67667974448284343
x-datadog-sampling-priority: 1
```

Service B's instrumented HTTP server reads those headers automatically and creates its spans as children of the incoming span. **If a service does not propagate headers — for example, an uninstrumented Lambda or a background worker that drops context — the trace breaks into disconnected fragments.** This is one of the most common APM debugging problems.

```python
# Manually extracting and injecting context when using a non-standard transport
from ddtrace.propagation.http import HTTPPropagator

# Injecting (producer side — e.g. publishing to SQS)
headers = {}
HTTPPropagator.inject(tracer.current_span().context, headers)
message_metadata = headers   # store in SQS message attributes

# Extracting (consumer side — e.g. SQS worker)
context = HTTPPropagator.extract(message_metadata)
with tracer.start_span("sqs.process", child_of=context) as span:
    span.set_tag("queue.name", "payments")
    process_message(body)
```

### Datadog Agent Setup

The Datadog Agent is the local process that receives traces from your application (on port `8126` by default), batches them, and forwards them to Datadog's backend. Your application never sends data directly to `datadoghq.com` — it sends to the local agent. This keeps latency low and lets the agent apply sampling decisions.

```bash
# Install Datadog Agent on Linux
DD_API_KEY=<your-api-key> DD_SITE=datadoghq.com \
  bash -c "$(curl -L https://install.datadoghq.com/scripts/install_script_agent7.sh)"

# Verify the agent is running and APM is enabled
sudo datadog-agent status | grep -A 10 "APM Agent"

# Verify the trace intake port is open
ss -tlnp | grep 8126
```

Key fields in `/etc/datadog-agent/datadog.yaml`:

```yaml
api_key: <DD_API_KEY>
site: datadoghq.com

# Unified Service Tagging — applied to every piece of telemetry from this host
env: production
service: myapp
version: 1.2.3

apm_config:
  enabled: true
  apm_non_local_traffic: true   # required when app runs in a container on the same host
  max_traces_per_second: 50     # agent-side ingestion rate limit; adjust for your volume
```

**Unified Service Tagging (UST)** — setting `env`, `service`, and `version` at the agent level means every trace, metric, and log from that host carries the same three tags. This is what enables one-click pivoting from a trace to correlated logs to a deployment marker on a latency graph.

In Kubernetes, the Agent runs as a **DaemonSet** (one pod per node). The application pod reaches the agent via the node's `hostIP`:

```yaml
# In your application container's env block
- name: DD_AGENT_HOST
  valueFrom:
    fieldRef:
      fieldPath: status.hostIP   # resolved at runtime to the node's IP
- name: DD_TRACE_AGENT_PORT
  value: "8126"
```

**Do not hardcode the agent IP.** Always use `status.hostIP`. If the pod is rescheduled to a different node, a hardcoded IP will point at the wrong agent or nothing at all.

### Python Instrumentation with ddtrace

`ddtrace` is Datadog's Python APM client. It provides both automatic and manual instrumentation.

```bash
pip install ddtrace
```

**Auto-instrumentation via `ddtrace-run`** patches supported libraries (Flask, FastAPI, Django, SQLAlchemy, Redis, Celery, psycopg2, boto3, httpx, requests, and many more) at process startup without changing a line of application code:

```bash
DD_SERVICE=myapp DD_ENV=production DD_VERSION=1.2.3 \
  ddtrace-run python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

`ddtrace-run` is a wrapper that calls `patch_all()` before your module is imported. This matters — **`patch_all()` must run before the libraries it patches are imported.** If you import Flask before calling `patch_all()`, Flask will not be instrumented.

**Manual spans** let you instrument business logic that libraries cannot see:

```python
from ddtrace import tracer
from ddtrace.ext import SpanTypes
import traceback

def process_payment(user_id: str, amount: float, currency: str):
    with tracer.trace(
        "payment.process",
        service="payment-service",
        span_type=SpanTypes.WEB,   # controls icon in Datadog UI
        resource=f"charge/{currency}"   # groups similar spans in analytics
    ) as span:
        span.set_tag("user.id", user_id)
        span.set_tag("payment.amount", amount)
        span.set_tag("payment.currency", currency)

        try:
            result = charge_card(user_id, amount)
            span.set_tag("payment.status", "success")
            span.set_tag("payment.transaction_id", result.transaction_id)
            return result
        except InsufficientFundsError as e:
            # Business error: flag it but don't mark as infrastructure error
            span.set_tag("payment.status", "insufficient_funds")
            raise
        except Exception as e:
            # Infrastructure/unexpected error: mark span as error
            span.set_tag("error", True)
            span.set_tag("error.type", type(e).__name__)
            span.set_tag("error.message", str(e))
            span.set_tag("error.stack", traceback.format_exc())
            raise
```

**`resource` vs `service`:** `service` is the application or component name (`payment-service`). `resource` is what that service *did* (`charge/USD`, `GET /users/{id}`, `SELECT users`). In Datadog APM, resources are aggregated — you see average latency and error rate for `GET /users/{id}` across all instances. Keep resources low-cardinality: parameterize routes (`/users/{id}`, not `/users/12345`).

### Span Tags and Semantic Conventions

Tags (called `meta` internally) are string key-value pairs attached to a span. They are the primary way to make traces searchable and filterable in Datadog.

```python
span.set_tag("http.method", "POST")
span.set_tag("http.url", "https://api.example.com/charge")
span.set_tag("http.status_code", 200)
span.set_tag("db.type", "postgresql")
span.set_tag("db.statement", "SELECT * FROM orders WHERE user_id = %s")
```

**Cardinality warning:** just like Prometheus labels, high-cardinality tag values create large indexes and increase costs. Good tags have bounded value sets: `env`, `service`, `version`, `status_code`, `region`, `http.method`. Bad tags: raw user IDs, request IDs as tag values, full unparameterized SQL strings.

Datadog follows **OpenTelemetry semantic conventions** for standard tags. Using the correct tag names means Datadog automatically renders them in the right UI panels (HTTP method in the request detail, DB statement in the database view, etc.). Key conventions:

| Tag | Example Value | Auto-rendered as |
|---|---|---|
| `http.method` | `GET` | HTTP method badge |
| `http.status_code` | `404` | Status code in trace list |
| `http.url` | `https://...` | Clickable URL |
| `db.type` | `postgresql` | Database icon |
| `db.statement` | `SELECT ...` | SQL syntax highlight |
| `error` | `True` | Red error indicator |
| `error.message` | `connection refused` | Error detail panel |

### Database Monitoring

SQLAlchemy, psycopg2, PyMySQL, and other database drivers are auto-instrumented by `ddtrace`. Every query becomes a child span:

```python
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

# ddtrace patches the engine at import time (if patch_all() ran first)
engine = create_engine(
    "postgresql://user:pass@db:5432/myapp",
    pool_pre_ping=True
)

with Session(engine) as session:
    # This query generates a span:
    # service: postgres
    # resource: SELECT * FROM users WHERE id = %(id)s
    # tags: db.type=postgresql, db.host=db, db.port=5432, out.host=db
    users = session.execute(
        text("SELECT * FROM users WHERE id = :id"),
        {"id": user_id}
    ).fetchall()
```

Automatically captured per span:
- Query text (parameters are masked by default: `WHERE id = ?`)
- Query duration
- Database host, port, and name
- Rows affected

**Enable full query text capture only in development** — production query text can contain PII if parameters are interpolated rather than bound. Check `DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP` and `DD_DBM_PROPAGATION_MODE` for fine-grained control.

For deeper visibility beyond per-request spans, Datadog's **Database Monitoring (DBM)** product correlates APM traces with PostgreSQL/MySQL query performance data (pg_stat_statements, EXPLAIN plans, wait events). Enable it by setting `DD_DBM_PROPAGATION_MODE=full` in your application — this injects a comment into each SQL query that links the query execution to the originating APM trace.

```bash
export DD_DBM_PROPAGATION_MODE=full   # adds /* dddb='...' */ comment to queries
```

### Connecting Logs, Metrics, and Traces

The three pillars of observability are most useful when they reference each other. Datadog's correlation model works by injecting the current `trace_id` and `span_id` into log records. When Datadog processes those logs, it recognizes the fields and creates a link between the log line and the trace.

```python
import logging
import json
import ddtrace

class DatadogJSONFormatter(logging.Formatter):
    """Emit structured JSON logs with trace context injected."""

    def format(self, record):
        log_entry = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Inject trace context if a span is active
        span = ddtrace.tracer.current_span()
        if span:
            log_entry.update({
                "dd.trace_id": str(span.trace_id),
                "dd.span_id": str(span.span_id),
                "dd.service": ddtrace.config.service,
                "dd.env": ddtrace.config.env,
                "dd.version": ddtrace.config.version,
            })

        return json.dumps(log_entry)

# Wire up the formatter
handler = logging.StreamHandler()
handler.setFormatter(DatadogJSONFormatter())
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)
```

**The field names `dd.trace_id` and `dd.span_id` are not arbitrary.** Datadog's log processing pipeline looks for exactly those keys. Use different names and the automatic correlation link will not appear in the UI.

Once traces and logs are correlated:
1. Click a slow or errored trace in APM.
2. Click "Logs" in the trace detail panel.
3. See every log line emitted during that request, from every service.

This eliminates the need to grep log files with trace IDs manually — the UI does the join automatically.

### Service Map and Dependencies

Datadog builds the service map from span data with no additional configuration. The `service` tag on each span names the producer; the `peer.service` tag (or `out.host`) names the downstream dependency. The agent reads these and constructs an edge in the dependency graph.

```
myapp-api
├── → auth-service        avg: 5ms   errors: 0.1%
├── → user-service        avg: 12ms  errors: 0.0%
│   └── → postgres        avg: 8ms
│       └── → (slow query: SELECT orders WHERE ...)
└── → redis               avg: 0.5ms
```

The service map surfaces:
- **Upstream/downstream topology** — which services call which
- **Per-edge latency and error rates** — immediately shows where degradation is concentrated
- **Deployment propagation** — version tags show which services have been updated

**If a service appears on the map with no outbound edges but you know it calls a database, `patch_all()` probably did not run before the database driver was imported.** Check startup order.

### APM Sampling

At high request volume, storing every trace is expensive. Sampling keeps a representative subset. Datadog uses **head-based sampling**: the decision is made at the start of the trace (at the root span), and all spans in that trace follow the same decision — you never get a partial trace with some spans missing.

The Data
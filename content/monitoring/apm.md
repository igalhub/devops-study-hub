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

**Span kind matters for async boundaries.** When a producer publishes to a queue, the outbound span should be tagged `span.kind=producer`. The consumer's span should be `span.kind=consumer` and linked via the extracted context. Without explicit linking, the two halves appear as separate root traces with no relationship in the UI.

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

**Unified Service Tagging (UST)** — setting `env`, `service`, and `version` at the agent level means every trace, metric, and log from that host carries the same three tags. This is what enables one-click pivoting from a trace to correlated logs to a deployment marker on a latency graph. Without UST, you lose the connective tissue between the three pillars of observability.

In Kubernetes, the Agent runs as a **DaemonSet** (one pod per node). The application pod reaches the agent via the node's `hostIP`:

```yaml
# In your application container's env block
- name: DD_AGENT_HOST
  valueFrom:
    fieldRef:
      fieldPath: status.hostIP   # resolved at runtime to the node's IP
- name: DD_TRACE_AGENT_PORT
  value: "8126"
# Unified Service Tagging via env vars (preferred in Kubernetes over datadog.yaml)
- name: DD_ENV
  value: "production"
- name: DD_SERVICE
  value: "payment-api"
- name: DD_VERSION
  value: "2.4.1"
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

`ddtrace-run` is a wrapper that calls `patch_all()` before your module is imported. This matters — **`patch_all()` must run before the libraries it patches are imported.** If you import Flask before calling `patch_all()`, Flask will not be instrumented. This is the most common reason auto-instrumentation silently produces no spans.

**Manual spans** let you instrument business logic that libraries cannot see:

```python
from ddtrace import tracer
from ddtrace.ext import SpanTypes
import traceback

def process_payment(user_id: str, amount: float, currency: str):
    with tracer.trace(
        "payment.process",
        service="payment-service",
        span_type=SpanTypes.WEB,        # controls icon in Datadog UI
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

**`resource` vs `service`:** `service` is the application or component name (`payment-service`). `resource` is what that service *did* (`charge/USD`, `GET /users/{id}`, `SELECT users`). In Datadog APM, resources are aggregated — you see average latency and error rate for `GET /users/{id}` across all instances. Keep resources low-cardinality: parameterize routes (`/users/{id}`, not `/users/12345`). A resource like `/users/12345` creates a separate time series for every user ID, exploding your metrics cardinality.

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
| `span.kind` | `server`, `client`, `producer`, `consumer` | Topology direction in service map |

**Numeric metrics on spans** use `set_metric()` rather than `set_tag()`. Metrics are stored as floats and can be used in APM Analytics for aggregation (e.g., average `payment.amount` by `currency`). Tags are strings and support only equality filtering.

```python
span.set_metric("payment.amount_usd", 49.99)
span.set_metric("cart.item_count", 3)
```

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

**N+1 query detection:** When you see dozens of near-identical `SELECT` spans in a trace — each fetching a single row — that is an N+1 problem. The ORM fetched a list of 50 orders, then issued a separate query for each order's user. The fix is eager loading (SQLAlchemy's `joinedload`). APM makes this pattern immediately visible because you see 50 child spans under the same parent instead of one batched query.

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

`ddtrace` also provides an automatic log injection helper that avoids writing the formatter manually:

```python
# Automatic injection — patches the standard logging module to add dd.* fields
from ddtrace import patch
patch(logging=True)

# After patching, %(dd.trace_id)s and %(dd.span_id)s are available in format strings
logging.basicConfig(
    format='%(asctime)s %(levelname)s [%(dd.service)s] [%(dd.trace_id)s] %(message)s'
)
```

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

Each node in the service map links to that service's APM page, which shows the **RED metrics** for that service: Rate (requests per second), Errors (error rate), Duration (latency percentiles). These are derived automatically from span data — no separate metric instrumentation required.

### APM Sampling

At high request volume, storing every trace is expensive. Sampling keeps a representative subset. Datadog uses **head-based sampling**: the decision is made at the start of the trace (at the root span), and all spans in that trace follow the same decision — you never get a partial trace with some spans missing.

| Sampling strategy | Where decision is made | Guarantees complete traces | Use case |
|---|---|---|---|
| **Head-based (default)** | Root span, at trace start | Yes | High-volume services, cost control |
| **Tail-based** | After trace completes | Yes | Keep all errors/slow traces regardless of rate |
| **100% ingestion** | N/A — all traces kept | Yes | Low-volume services, debugging |

Datadog's **Intelligent Sampling** combines both: it targets a configurable ingestion rate (default: 100% up to 50 traces/sec per agent) and automatically retains 100% of error traces and traces from rare endpoints regardless of the overall rate. This means you won't lose the one trace that shows your error even if 99% of traffic is sampled away.

Configure sampling in `ddtrace`:

```python
from ddtrace import tracer

# Force-keep a specific trace (e.g., a transaction worth investigating)
with tracer.trace("checkout.process") as span:
    span.set_tag("_dd.p.dm", "-4")   # manual sampling decision: keep
    # ... business logic

# Or via environment variable (applies globally)
# DD_TRACE_SAMPLE_RATE=0.1   — sample 10% of traces
```

**Sampling rules let you sample by service, resource, or tag:**

```python
# In ddtrace configuration — sample 100% of checkout spans, 5% of health checks
from ddtrace import config
from ddtrace.sampler import DatadogSampler, SamplingRule

sampler = DatadogSampler(rules=[
    SamplingRule(sample_rate=1.0, service="payment-service", resource="checkout"),
    SamplingRule(sample_rate=0.05, resource="GET /healthz"),
    SamplingRule(sample_rate=0.1),   # default fallback
])
tracer.configure(sampler=sampler)
```

**Sampling gotcha:** sampled-out traces still generate **metrics**. Datadog computes request rate, error rate, and latency percentiles from 100% of spans using a separate stats pipeline — even traces that are not stored contribute to your dashboards. This means your RED metrics are accurate even at 10% sampling. What you lose is the raw trace detail for the sampled-out requests.

### Continuous Profiling

APM traces tell you *which* function is slow. Continuous profiling tells you *why* — which line of code is consuming CPU, memory, or I/O, sampled continuously in production without a dedicated profiling session.

```bash
# Enable profiling alongside tracing
DD_PROFILING_ENABLED=true \
DD_SERVICE=myapp DD_ENV=production \
  ddtrace-run python -m uvicorn main:app
```

Or programmatically:

```python
import ddtrace.profiling.auto   # import triggers profiler startup
# No other configuration needed if DD_* env vars are set
```

The profiler collects:

| Profile type | What it measures |
|---|---|
| **CPU** | Time spent executing Python bytecode |
| **Wall time** | Elapsed time including I/O waits and locks |
| **Heap** | Memory allocations by call site |
| **Exceptions** | Exception raise frequency by location |
| **Lock** | Time spent waiting to acquire Python GIL or threading locks |

**Profiling overhead is roughly 2-5% CPU** in production. It samples at 100Hz, which is low enough to be always-on but high enough to catch functions called frequently. Do not confuse this with cProfile or py-spy, which have higher overhead and are typically used in isolation.

In the Datadog UI, the **Code Hotspots** feature links APM spans to profiling data. When you open a slow trace, you can click "Code Hotspots" and see which functions within that span consumed the most CPU — down to the specific line number. This is the deepest level of production visibility available without attaching a debugger.

---

## Examples

### Example 1: Flask API with Auto-Instrumentation and Manual Business Spans

**Setup:** A Flask application with SQLAlchemy, auto-instrumented, with a manual span around a pricing calculation.

```python
# app.py
# Start with: DD_SERVICE=pricing-api DD_ENV=staging DD_VERSION=1.0.0 ddtrace-run python app.py

from flask import Flask, jsonify, request
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from ddtrace import tracer
import logging
import ddtrace

# Patch logging for trace correlation
from ddtrace import patch as dd_patch
dd_patch(logging=True)

logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","trace_id":"%(dd.trace_id)s","msg":"%(message)s"}'
)
log = logging.getLogger(__name__)

app = Flask(__name__)
engine = create_engine("postgresql://user:pass@localhost:5432/shop")

@app.route("/price/<int:product_id>")
def get_price(product_id):
    log.info(f"Price request for product {product_id}")

    # Auto-instrumented: Flask route creates root span automatically
    # Auto-instrumented: SQLAlchemy query creates child span automatically
    with Session(engine) as session:
        row = session.execute(
            text("SELECT base_price, category FROM products WHERE id = :id"),
            {"id": product_id}
        ).fetchone()

    if not row:
        return jsonify({"error": "not found"}), 404

    # Manual span for business logic that auto-instrumentation cannot see
    with tracer.trace("pricing.calculate_final", resource="dynamic_pricing") as span:
        span.set_tag("product.id", product_id)
        span.set_tag("product.category", row.category)
        span.set_metric("product.base_price", float(row.base_price))

        final_price = apply_dynamic_pricing(row.base_price, row.category)

        span.set_metric("product.final_price", float(final_price))
        log.info(f"Calculated price: {final_price}")

    return jsonify({"product_id": product_id, "price": final_price})

def apply_dynamic_pricing(base_price, category):
    # Simulate a slow computation
    import time; time.sleep(0.01)
    multiplier = {"electronics": 0.95, "clothing": 0.80}.get(category, 1.0)
    return round(base_price * multiplier, 2)

if __name__ == "__main__":
    app.run(port=5000)
```

**Verify it worked:**

```bash
# Send a test request
curl http://localhost:5000/price/42

# Check the agent received traces
curl http://localhost:8126/info   # agent info endpoint
curl -s http://localhost:8126/v0.4/traces | head -c 200  # raw trace data (for debugging only)

# In Datadog UI: APM > Services > pricing-api
# You should see the Flask route span with a child SQL span and a child pricing span
```

---

### Example 2: Kubernetes Deployment with Datadog Agent DaemonSet

**Setup:** A complete Kubernetes configuration for running the Datadog Agent and a Python application with APM enabled.

```yaml
# datadog-agent-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: datadog-agent
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: datadog-agent
  template:
    metadata:
      labels:
        app: datadog-agent
    spec:
      serviceAccountName: datadog-agent
      containers:
      - name: agent
        image: gcr.io/datadoghq/agent:7
        env:
        - name: DD_API_KEY
          valueFrom:
            secretKeyRef:
              name: datadog-secret
              key: api-key
        - name: DD_SITE
          value: "datadoghq.com"
        - name: DD_APM_ENABLED
          value: "true"
        - name: DD_APM_NON_LOCAL_TRAFFIC
          value: "true"   # accept traces from other pods on the node
        - name: DD_LOGS_ENABLED
          value: "true"
        - name: DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL
          value: "true"
        ports:
        - containerPort: 8126      # APM trace intake
          hostPort: 8126
          protocol: TCP
        - containerPort: 8125      # DogStatsD metrics intake
          hostPort: 8125
          protocol: UDP
        volumeMounts:
        - name: dockersocket
          mountPath: /var/run/docker.sock
        - name: procdir
          mountPath: /host/proc
          readOnly: true
      volumes:
      - name: dockersocket
        hostPath:
          path: /var/run/docker.sock
      - name: procdir
        hostPath:
          path: /proc
---
# application-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  labels:
    tags.datadoghq.com/service: payment-api   # UST label for pod-level tagging
    tags.datadoghq.com/env: production
    tags.datadoghq.com/version: "2.1.0"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
        tags.datadoghq.com/service: payment-api
        tags.datadoghq.com/env: production
        tags.datadoghq.com/version: "2.1.0"
    spec:
      containers:
      - name: app
        image: myregistry/payment-api:2.1.0
        command: ["ddtrace-run", "python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0"]
        env:
        - name: DD_AGENT_HOST
          valueFrom:
            fieldRef:
              fieldPath: status.hostIP        # node IP — resolves correctly after rescheduling
        - name: DD_TRACE_AGENT_PORT
          value: "8126"
        - name: DD_SERVICE
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['tags.datadoghq.com/service']
        - name: DD_ENV
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['tags.datadoghq.com/env']
        - name: DD_VERSION
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['tags.datadoghq.com/version']
        - name: DD_PROFILING_ENABLED
          value: "true"
        - name: DD_LOGS_INJECTION
          value: "true"   # automatic trace ID injection into Python logging
```

**Verify:**

```bash
# Check DaemonSet pods are Running on all nodes
kubectl get pods -n monitoring -l app=datadog-agent

# Exec into an app pod and confirm agent is reachable
kubectl exec -it deployment/payment-api -- curl http://$DD_AGENT_HOST:8126/info

# Check APM in Datadog UI: APM > Services — payment-api should appear within 60s of traffic
```

---

### Example 3: Tracing Across an SQS Async Boundary

**Setup:** A FastAPI producer publishes jobs to SQS with trace context in message attributes. A worker consumes them and continues the trace.

```python
# producer.py — FastAPI endpoint that queues a job
import boto3
import json
from fastapi import FastAPI
from ddtrace import tracer
from ddtrace.propagation.http import HTTPPropagator

app = FastAPI()
sqs = boto3.client("sqs", region_name="us-east-1")
QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789/jobs"

@app.post("/jobs")
def enqueue_job(payload: dict):
    with tracer.trace("jobs.enqueue", resource="POST /jobs") as span:
        span.set_tag("job.type", payload.get("type"))

        # Inject current trace context into a dict, then store in SQS attributes
        carrier = {}
        HTTPPropagator.inject(span.context, carrier)

        sqs.send_message(
            QueueUrl=QUEUE_URL,
            MessageBody=json.dumps(payload),
            MessageAttributes={
                # SQS MessageAttributes must be string type
                key: {"StringValue": value, "DataType": "String"}
                for key, value in carrier.items()
            }
        )
        span.set_tag("job.queued", True)
    return {"status": "queued"}
```

```python
# worker.py — polls SQS and continues the trace from the producer
import boto3
import json
from ddtrace import tracer
from ddtrace.propagation.http import HTTPPropagator

sqs = boto3.client("sqs", region_name="us-east-1")
QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789/jobs"

def poll():
    while True:
        messages = sqs.receive_message(
            QueueUrl=QUEUE_URL,
            MessageAttributeNames=["All"],  # must request All to get our injected headers
            MaxNumberOfMessages=10,
            WaitTimeSeconds=20
        ).get("Messages", [])

        for msg in messages:
            # Extract attributes back into a flat dict
            attributes = {
                k: v["StringValue"]
                for k, v in msg.get("MessageAttributes", {}).items()
            }

            # Re-create the trace context from the producer's headers
            context = HTTPPropagator.extract(attributes)

            # Start a new span as a child of the producer's span
            with tracer.start_span("jobs.process", child_of=context) as span:
                span.set_tag("span.kind", "consumer")
                body = json.loads(msg["Body"])
                span.set_tag("job.type", body.get("type"))

                try:
                    process_job(body)
                    sqs.delete_message(
                        QueueUrl=QUEUE_URL,
                        ReceiptHandle=msg["ReceiptHandle"]
                    )
                except Exception as e:
                    span.set_tag("error", True)
                    span.set_tag("error.message", str(e))

if __name__ == "__main__":
    poll()
```

**Verify:** In Datadog APM, find a trace originating from `POST /jobs`. It should show the `jobs.enqueue` span with a connected `jobs.process` span from the worker — even though they ran in different processes. The flame graph will span the async boundary.

---

### Example 4: Custom Alert on APM Error Rate with Terraform

**Setup:** A Datadog monitor that pages on-call when a service's error rate exceeds 5% for 5 minutes.

```hcl
# monitors.tf
resource "datadog_monitor" "payment_api_error_rate" {
  name    = "payment-api error rate > 5%"
  type    = "metric alert"
  message = <<-EOT
    Payment API error rate is {{value}}% — exceeds 5% threshold.
    Runbook: https://wiki.example.com/runbooks/payment-api-errors
    @pagerduty-payment-oncall
  EOT

  # APM generates trace.* metrics automatically from span data
  # trace.fastapi.request.errors is the error count metric
  # trace.fastapi.request.hits is the total request count metric
  query = <<-EOQ
    sum(last_5m):
      100 * sum:trace.fastapi.request.errors{env:production,service:payment-api}.as_count()
      /
      sum:trace.fastapi.request.hits{env:production,service:payment-api}.as_count()
    > 5
  EOQ

  thresholds = {
    critical = 5    # percent
    warning  = 2
  }

  notify_no_data    = false   # don't alert if no traffic (e.g., off-hours)
  evaluation_delay  = 60      # seconds — allow metrics to arrive before evaluating
  renotify_interval = 30      # re-page every 30 min if still firing

  tags = ["service:payment-api", "env:production", "team:payments"]
}
```

```bash
# Apply and verify
terraform init && terraform apply

# Confirm the monitor was created
curl -s "https://api.datadoghq.com/api/v1/monitor?tags=service:payment-api" \
  -H "DD-API-KEY: $DD_API_KEY" \
  -H "DD-APPLICATION-KEY: $DD_APP_KEY" | jq '.[].name'
```

---

## Exercises

### Exercise 1: Instrument a Flask App and Verify Trace Structure

Start a local Flask app with `ddtrace-run`. Add a manual span around a function that calls an external API using `requests`. Verify in the Datadog UI (or by querying the agent's debug endpoint) that:
- The Flask route span is the root span
- The `requests` HTTP call appears as a child span with `http.method`, `http.url`, and `http.status_code` tags
- Your manual span appears as a sibling of the HTTP span (same parent: the Flask route)

Then deliberately break instrumentation by importing `requests` before `ddtrace-run` has a chance to patch it (move the import to the top of the file before `ddtrace` is set up). Observe that the `requests` span disappears. Explain why, and fix it.

---

### Exercise 2: Diagnose a Broken Trace Across a Service Boundary

You have two services: `frontend-api` and `backend-api`. Requests flow from frontend to backend via `httpx`. After deploying, you notice APM shows two disconnected traces instead of one connected trace.

1. Add `print(dict(response.request.headers))` in `frontend-api` to confirm whether propagation headers are present in the outbound request.
2. Add `print(dict(request.headers))` in `backend-api` to confirm whether the headers arrive.
3. Identify and fix the root cause — it is one of: (a) `patch_all()` not called before `httpx` import, (b) `DD_AGENT_HOST` pointing at the wrong address in one service, or (c) the backend not using `ddtrace-run` at all.
4. After fixing, describe what the service map should show and verify it matches.

---

### Exercise 3: Correlate a Log Line to Its Trace

Instrument a Python service to emit structured JSON logs containing `dd.trace_id` and `dd.span_id`. Then:

1. Make a request that triggers a `WARNING` log inside a traced function.
2. Find the trace in Datadog APM.
3. Open the "Logs" tab on the trace detail and confirm the warning log appears there.
4. Now rename `dd.trace_id` to `trace_id` in your formatter. Make another request. Confirm the log no longer appears under the trace. Explain what Datadog's pipeline is looking for and why the renamed field breaks correlation.

---

### Exercise 4: Write a Sampling Rule that Prioritizes Errors

Your service handles 500 req/sec. You want to:
- Sample 100% of requests where an error occurred
- Sample 100% of the `POST /checkout` resource (business-critical)
- Sample 1% of all other traffic

Configure this using `DatadogSampler` with `SamplingRule`. Then:
1. Generate traffic that includes both successful and errored requests (you can force an error by raising an exception in a route).
2. In Datadog APM, filter traces by `error:true` — confirm all errors appear (none sampled away).
3. Filter by `resource:"POST /checkout"` — confirm 100% retention.
4. Check the overall ingestion rate in Datadog's Ingestion Control page and confirm it is significantly below 100% of total traffic, demonstrating that the 1% default rule is in effect.

---

### Quick Checks

5. Extract the service name from a trace stub. Run: `printf 'service: payment-api\nversion: 2.1.0\nenv: prod\n' | awk '/^service:/{print $2}'`

```expected_output
payment-api
```

hint: Think about how you can filter and extract specific fields from structured text using a pattern-matching tool.
hint: Use awk with a regex pattern like /^service:/ to match the relevant line, then print the second field with print $2.

6. Count spans in a distributed trace. Run: `printf 'span_id: 1\nspan_id: 2\nspan_id: 3\nspan_id: 4\n' | wc -l`

```expected_output
4
```

hint: Think about how you can generate structured span data and pipe it into a line-counting utility.
hint: Use printf to produce newline-separated span_id lines and pipe the output into wc with the -l flag to count the total number of lines.

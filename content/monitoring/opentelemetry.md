---
title: OpenTelemetry
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, opentelemetry, otel, traces, metrics, collector, otlp, vendor-neutral]
exercises: 4
---

## Overview

OpenTelemetry (OTel) is the CNCF standard for observability instrumentation — a vendor-neutral API and SDK for generating the three pillars of observability: metrics, logs, and traces. The fundamental promise is instrument once, export anywhere. You write instrumentation code against the OTel API, and at runtime you configure where that telemetry goes: Datadog, Jaeger, Prometheus, Grafana Tempo, Honeycomb, or any OTLP-compatible backend. Changing backends is a configuration change, not a code change. This matters enormously in practice: vendor migrations don't require re-instrumenting your entire codebase.

OTel's design separates the API (what your application code calls) from the SDK (the implementation that does the actual work) and from the exporter (the transport layer). This layering means library authors can add OTel instrumentation using only the API package — with zero overhead if the calling application hasn't configured a SDK. Applications then wire in the SDK and choose exporters without touching library code. The project emerged from the merger of OpenCensus and OpenTracing, absorbing lessons from both, and is now the second-most active CNCF project after Kubernetes.

In the DevOps toolchain, OTel sits at the instrumentation layer — between your application code and your observability backends. It replaces vendor-specific agents and libraries that previously forced a choice between vendor lock-in and observability. Paired with the OpenTelemetry Collector (a standalone process for receiving, processing, and routing telemetry), OTel gives teams a unified pipeline they control. Whether you're running a monolith, a microservices mesh, or a mix of languages, OTel provides a consistent model for how telemetry flows from code to dashboards.

---

## Concepts

### The Three Signals: Traces, Metrics, Logs

OTel provides unified instrumentation for all three observability signals, but each serves a different purpose:

| Signal | What it answers | Cardinality | Storage cost |
|--------|----------------|-------------|--------------|
| **Traces** | Why is this request slow? What did it touch? | High (per-request) | High |
| **Metrics** | Is the system healthy right now? What are the rates? | Low (aggregate) | Low |
| **Logs** | What exactly happened at this moment? | Medium | Medium–High |

Traces are the backbone of distributed debugging. A single user request produces one **trace** made up of many **spans** — each span representing a unit of work (an HTTP call, a database query, a function call). Spans have a start time, duration, attributes, events, and a status. The parent-child relationships between spans let you reconstruct the full call graph of a request.

Metrics in OTel map to the same types you'd find in Prometheus: counters, histograms, gauges, and up-down counters. The key difference from raw Prometheus: metrics are defined in application code using the OTel metrics API, then exported via OTLP or converted to Prometheus format at the Collector.

**OTel logs are newer than traces and metrics.** Log correlation (attaching trace IDs and span IDs to log lines) is OTel's primary value for logs, not replacing your logging library. Use the OTel logging bridge API to forward existing log records — don't rewrite your logging infrastructure.

---

### Architecture and Data Flow

```
Your Application (Python, Go, Java, Node…)
  └── OTel SDK
       ├── TracerProvider  → generates spans
       ├── MeterProvider   → generates metric data points
       └── LoggerProvider  → bridges log records
            │
            │  OTLP (gRPC :4317 or HTTP :4318)
            ▼
       OTel Collector
            ├── Receivers  (OTLP, Prometheus, Jaeger, Zipkin, Kafka…)
            ├── Processors (batch, filter, transform, resource detection…)
            └── Exporters  (Datadog, Jaeger, Prometheus, OTLP, Tempo…)
                 │
                 ├── → Jaeger  (traces)
                 ├── → Datadog (traces + metrics + logs)
                 ├── → Prometheus scrape endpoint (metrics)
                 └── → Grafana Tempo (traces)
```

You can skip the Collector and export directly from the SDK to a backend. This is fine for development or simple setups. Prefer the Collector in production for three reasons:
1. **Decoupling** — your app doesn't need credentials to every backend.
2. **Processing** — filter noise, enrich with resource attributes, sample traces before they hit storage.
3. **Fan-out** — send the same telemetry to multiple backends simultaneously without changing application code.

**Ports to know:**
- `4317` — OTLP gRPC (default for SDK → Collector)
- `4318` — OTLP HTTP (alternative; useful when gRPC is blocked)
- `8889` — Prometheus metrics scrape endpoint (Collector exposes this)
- `16686` — Jaeger UI

---

### Python SDK Setup

#### Installation

```bash
pip install opentelemetry-api opentelemetry-sdk \
    opentelemetry-exporter-otlp-proto-grpc \
    opentelemetry-instrumentation-fastapi \
    opentelemetry-instrumentation-sqlalchemy \
    opentelemetry-instrumentation-requests
```

#### Bootstrapping Traces

```python
# tracing.py — call this once at application startup, before any other imports
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource, SERVICE_NAME

# Resource describes the entity producing telemetry — appears in every span
resource = Resource.create({
    SERVICE_NAME: "order-service",          # use the constant, not "service.name"
    "service.version": "1.2.3",
    "deployment.environment": "production",
})

provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint="http://otel-collector:4317")
        # grpc is the default; add insecure=True if not using TLS in dev
    )
)
trace.set_tracer_provider(provider)
```

**`BatchSpanProcessor` vs `SimpleSpanProcessor`:** `BatchSpanProcessor` buffers spans and sends them in batches — use this in production. `SimpleSpanProcessor` sends each span synchronously as it finishes — use this only when debugging instrumentation, never in production (adds latency to every span close).

#### Bootstrapping Metrics

```python
# metrics_setup.py
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint="http://otel-collector:4317"),
    export_interval_millis=60_000   # push metrics every 60 seconds
)
meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
metrics.set_meter_provider(meter_provider)
```

#### Defining and Using Metric Instruments

```python
meter = metrics.get_meter(__name__)

# Counter: only goes up — total requests, total errors
request_counter = meter.create_counter(
    "http.server.request.count",
    description="Total HTTP requests received",
    unit="1"
)

# Histogram: distribution of values — latency, response size
request_duration = meter.create_histogram(
    "http.server.request.duration",
    description="HTTP server request duration",
    unit="ms"
)

# UpDownCounter: can go up or down — active connections, queue depth
active_connections = meter.create_up_down_counter(
    "http.server.active_connections",
    description="Number of active HTTP connections",
    unit="1"
)

# Usage — pass attributes (labels) at record time, not at creation time
request_counter.add(1, {"http.method": "GET", "http.status_code": 200})
request_duration.record(142.3, {"http.method": "GET", "http.route": "/orders"})
active_connections.add(1)   # connection opened
active_connections.add(-1)  # connection closed
```

**Attribute cardinality warning:** the same rule applies as in Prometheus. Attributes with unbounded value sets (user IDs, request IDs, IP addresses) will cause memory exhaustion. Good attributes: `http.method`, `http.status_code`, `http.route`, `db.system`. Bad attributes: `user.id`, `request.id`, `http.url` (full URL with query params).

---

### Auto-Instrumentation vs Manual Instrumentation

Auto-instrumentation hooks into framework internals using monkey-patching. It requires no changes to business logic and covers the most common spans (incoming HTTP, outgoing HTTP, database queries).

```python
# main.py — wire up auto-instrumentation before your app starts handling requests
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

app = FastAPI()

FastAPIInstrumentor.instrument_app(app)          # all routes auto-traced
SQLAlchemyInstrumentor().instrument(engine=engine)  # all queries auto-traced
RequestsInstrumentor().instrument()              # all outgoing HTTP auto-traced
```

Manual instrumentation adds spans and attributes around business logic that auto-instrumentation can't see — internal function calls, background jobs, custom logic.

```python
from opentelemetry import trace
from opentelemetry.trace import SpanKind

tracer = trace.get_tracer(__name__)

def process_order(order_id: str, items: list):
    with tracer.start_as_current_span(
        "process_order",
        kind=SpanKind.INTERNAL   # INTERNAL, SERVER, CLIENT, PRODUCER, CONSUMER
    ) as span:
        span.set_attribute("order.id", order_id)
        span.set_attribute("order.item_count", len(items))

        # Nested span — automatically becomes a child of process_order
        with tracer.start_as_current_span("validate_inventory") as child:
            child.set_attribute("inventory.items_requested", len(items))
            validate_inventory(items)

        # Span event: a timestamped annotation on the span (not a new span)
        span.add_event("inventory_validated", {"items_available": True})

        result = submit_order(order_id, items)
        span.set_attribute("order.status", result.status)
        return result
```

**When to use span events vs child spans:** use a span event for a point-in-time occurrence within the parent operation (e.g., "cache miss detected", "retry attempt 2"). Use a child span when you want to measure the duration of a sub-operation separately.

#### Span Status and Error Recording

```python
from opentelemetry.trace import Status, StatusCode

with tracer.start_as_current_span("payment_charge") as span:
    try:
        result = charge_card(amount, card_token)
        span.set_status(Status(StatusCode.OK))
        return result
    except PaymentDeclinedException as e:
        span.set_status(Status(StatusCode.ERROR, "Payment declined"))
        span.record_exception(e)   # captures type, message, full stack trace as span attributes
        raise
```

**`record_exception` does not set the span status to ERROR.** You must call `set_status(Status(StatusCode.ERROR, ...))` explicitly. Forgetting this means the span shows as "OK" in your tracing backend even though it recorded an exception — a common source of missed alerts.

---

### Semantic Conventions

Semantic conventions are OTel's standardized attribute names. Using them ensures your telemetry is correctly interpreted by backends — Datadog maps `http.status_code` to its HTTP error rate, Jaeger uses `db.statement` for query visualization, etc.

```python
from opentelemetry.semconv.trace import SpanAttributes

# HTTP
span.set_attribute(SpanAttributes.HTTP_METHOD, "POST")
span.set_attribute(SpanAttributes.HTTP_URL, "https://api.payments.com/charge")
span.set_attribute(SpanAttributes.HTTP_STATUS_CODE, 402)

# Database
span.set_attribute(SpanAttributes.DB_SYSTEM, "postgresql")
span.set_attribute(SpanAttributes.DB_NAME, "orders")
span.set_attribute(SpanAttributes.DB_STATEMENT, "SELECT * FROM orders WHERE id = $1")
span.set_attribute(SpanAttributes.DB_OPERATION, "SELECT")

# Network
span.set_attribute(SpanAttributes.NET_PEER_NAME, "db.internal")
span.set_attribute(SpanAttributes.NET_PEER_PORT, 5432)

# Messaging
span.set_attribute(SpanAttributes.MESSAGING_SYSTEM, "kafka")
span.set_attribute(SpanAttributes.MESSAGING_DESTINATION, "order-events")
span.set_attribute(SpanAttributes.MESSAGING_OPERATION, "publish")
```

**Avoid inventing attribute names for things semconv already covers.** If you use `db.query` instead of `db.statement`, Jaeger won't render it in the query viewer and Datadog won't parse it for APM. Check [opentelemetry.io/docs/specs/semconv](https://opentelemetry.io/docs/specs/semconv/) before naming custom attributes.

---

### OpenTelemetry Collector

The Collector is a standalone binary (or Docker container) that decouples your application from your backends. Its config has four sections: receivers, processors, exporters, and service (which wires them into pipelines).

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  # Batch before exporting — reduces network calls and backend write pressure
  batch:
    timeout: 10s
    send_batch_size: 1000

  # Add or overwrite resource attributes on every span/metric
  resource:
    attributes:
      - key: deployment.environment
        value: "production"
        action: upsert

  # Drop health check and readiness probe traces — they add noise with zero value
  filter/drop_health:
    error_mode: ignore
    traces:
      span:
        - 'attributes["http.route"] == "/health"'
        - 'attributes["http.route"] == "/ready"'
        - 'attributes["http.route"] == "/metrics"'

  # Tail-based sampling: keep 100% of error traces, 10% of success traces
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: probabilistic-policy
        type: probabilistic
        probabilistic: {sampling_percentage: 10}

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

  prometheus:
    endpoint: "0.0.0.0:8889"   # Prometheus scrapes this endpoint

  datadog:
    api:
      key: ${env:DD_API_KEY}
      site: datadoghq.com

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, filter/drop_health, tail_sampling]
      exporters: [otlp/jaeger, datadog]
    metrics:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [prometheus, datadog]
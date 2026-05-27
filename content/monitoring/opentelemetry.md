---
title: OpenTelemetry
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, opentelemetry, otel, traces, metrics, collector, otlp, vendor-neutral]
exercises: 4
---

## Overview

OpenTelemetry (OTel) is the CNCF standard for observability instrumentation — a vendor-neutral API and SDK for generating the three pillars of observability: metrics, logs, and traces. The fundamental promise is *instrument once, export anywhere*. You write instrumentation code against the OTel API, and at runtime you configure where that telemetry goes: Datadog, Jaeger, Prometheus, Grafana Tempo, Honeycomb, or any OTLP-compatible backend. Changing backends is a configuration change, not a code change. This matters enormously in practice: vendor migrations don't require re-instrumenting your entire codebase.

OTel's design separates the API (what your application code calls) from the SDK (the implementation that does the actual work) and from the exporter (the transport layer). This layering means library authors can add OTel instrumentation using only the API package — with zero overhead if the calling application hasn't configured an SDK. Applications then wire in the SDK and choose exporters without touching library code. The project emerged from the merger of OpenCensus and OpenTracing, absorbing lessons from both, and is now the second-most active CNCF project after Kubernetes.

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

Traces are the backbone of distributed debugging. A single user request produces one **trace** made up of many **spans** — each span representing a unit of work (an HTTP call, a database query, a function call). Spans carry a start time, duration, attributes, events, and a status code. The parent-child relationships between spans let you reconstruct the full call graph of a request across every service it touched.

Metrics in OTel map to the same types you'd find in Prometheus: counters, histograms, gauges, and up-down counters. The key difference from raw Prometheus: metrics are defined in application code using the OTel metrics API, then exported via OTLP or converted to Prometheus format at the Collector. This means you define your metric instrumentation once and the export format is a runtime concern.

**OTel logs are newer than traces and metrics.** Log correlation — attaching trace IDs and span IDs to log lines — is OTel's primary value for logs, not replacing your logging library. Use the OTel logging bridge API to forward existing log records into the OTel pipeline. Don't rewrite your logging infrastructure; bridge it.

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

You can skip the Collector and export directly from the SDK to a backend. This is acceptable for development or simple setups. Prefer the Collector in production for three reasons:

1. **Decoupling** — your app doesn't need credentials to every backend; only the Collector does.
2. **Processing** — filter noise, enrich with resource attributes, sample traces before they hit storage.
3. **Fan-out** — send the same telemetry to multiple backends simultaneously without changing application code.

**Ports to know:**

| Port | Protocol | Purpose |
|------|----------|---------|
| `4317` | gRPC | OTLP — default SDK → Collector |
| `4318` | HTTP/protobuf | OTLP — use when gRPC is blocked |
| `8889` | HTTP | Prometheus scrape endpoint on Collector |
| `16686` | HTTP | Jaeger UI |
| `55679` | HTTP | zPages — Collector's built-in debug endpoint |

**The Collector comes in two distributions.** The `otelcol` binary is the "core" distribution with stable components only. The `otelcol-contrib` binary includes community-contributed receivers, processors, and exporters (Datadog, Kafka, AWS, etc.). In production, almost everyone uses `otelcol-contrib`. If a component you need isn't found, you're likely running `otelcol` by mistake.

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

# Resource describes the entity producing telemetry — appears in every span.
# Use the SERVICE_NAME constant rather than the raw string "service.name".
resource = Resource.create({
    SERVICE_NAME: "order-service",
    "service.version": "1.2.3",
    "deployment.environment": "production",
})

provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint="http://otel-collector:4317")
        # Add insecure=True if not using TLS in dev/local environments
    )
)
trace.set_tracer_provider(provider)
```

**`BatchSpanProcessor` vs `SimpleSpanProcessor`:** `BatchSpanProcessor` buffers spans and sends them in batches — use this in production. `SimpleSpanProcessor` sends each span synchronously as it finishes — use this only when debugging instrumentation, never in production. It adds latency to every request proportional to the export round-trip time.

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

OTel metrics map to a set of instruments. Choose the right one based on what you're measuring:

| Instrument | Direction | Aggregation | Use case |
|------------|-----------|-------------|----------|
| `Counter` | up only | sum | HTTP requests, errors |
| `UpDownCounter` | up and down | sum | Active connections, queue depth |
| `Histogram` | observations | bucket distribution | Latency, response size |
| `Gauge` (observable) | snapshot | last value | CPU usage, memory |

```python
meter = metrics.get_meter(__name__)

# Counter: monotonically increasing
request_counter = meter.create_counter(
    "http.server.request.count",
    description="Total HTTP requests received",
    unit="1"
)

# Histogram: samples distribution of values
request_duration = meter.create_histogram(
    "http.server.request.duration",
    description="HTTP server request duration",
    unit="ms"
)

# UpDownCounter: can increase or decrease
active_connections = meter.create_up_down_counter(
    "http.server.active_connections",
    description="Number of active HTTP connections",
    unit="1"
)

# Observable gauge: value polled on export interval, not pushed
# Use for values you read from external sources (e.g., system stats)
def get_queue_depth(options):
    yield metrics.Observation(queue.depth(), {"queue.name": "orders"})

meter.create_observable_gauge(
    "messaging.queue.depth",
    callbacks=[get_queue_depth],
    description="Current queue depth",
    unit="1"
)

# Attributes (labels) are passed at record time, not at instrument creation
request_counter.add(1, {"http.method": "GET", "http.status_code": 200})
request_duration.record(142.3, {"http.method": "GET", "http.route": "/orders"})
active_connections.add(1)    # connection opened
active_connections.add(-1)   # connection closed
```

**Attribute cardinality warning:** the same rule applies as in Prometheus. Attributes with unbounded value sets will cause memory exhaustion in the SDK and in your backend. Good attributes: `http.method`, `http.status_code`, `http.route`, `db.system`. Bad attributes: `user.id`, `request.id`, `http.url` (full URL with query params). If a URL like `/orders/123` is your route, normalize it to `/orders/{id}` before recording.

---

### Auto-Instrumentation vs Manual Instrumentation

Auto-instrumentation hooks into framework internals using monkey-patching or bytecode injection. It requires no changes to business logic and covers the most common spans automatically: incoming HTTP, outgoing HTTP, and database queries.

```python
# main.py — wire up auto-instrumentation before your app starts handling requests
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

app = FastAPI()

FastAPIInstrumentor.instrument_app(app)             # all routes auto-traced
SQLAlchemyInstrumentor().instrument(engine=engine)  # all queries auto-traced
RequestsInstrumentor().instrument()                 # all outgoing HTTP auto-traced
```

Manual instrumentation adds spans and attributes around business logic that auto-instrumentation can't see — internal function calls, background jobs, custom domain logic.

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
        # because start_as_current_span sets it as the active context span
        with tracer.start_as_current_span("validate_inventory") as child:
            child.set_attribute("inventory.items_requested", len(items))
            validate_inventory(items)

        # Span event: a timestamped annotation on the span, not a separate span.
        # Use for point-in-time occurrences, not sub-operations with duration.
        span.add_event("inventory_validated", {"items_available": True})

        result = submit_order(order_id, items)
        span.set_attribute("order.status", result.status)
        return result
```

**When to use span events vs child spans:** use a span event for a point-in-time occurrence within the parent operation (e.g., "cache miss detected", "retry attempt 2"). Use a child span when you want to measure the duration of a sub-operation separately — events have no duration, only a timestamp.

#### Span Status and Error Recording

```python
from opentelemetry.trace import Status, StatusCode

with tracer.start_as_current_span("payment_charge") as span:
    try:
        result = charge_card(amount, card_token)
        span.set_status(Status(StatusCode.OK))
        return result
    except PaymentDeclinedException as e:
        # record_exception captures: exception type, message, full stack trace
        span.record_exception(e)
        # set_status must be called separately — record_exception does NOT do this
        span.set_status(Status(StatusCode.ERROR, "Payment declined"))
        raise
```

**`record_exception` does not set the span status to ERROR.** You must call `set_status(Status(StatusCode.ERROR, ...))` explicitly. Forgetting this means the span shows as "OK" in your tracing backend even though it recorded an exception — a common source of missed alerts on error rate dashboards.

---

### Context Propagation

Context propagation is how trace context (the trace ID and span ID) crosses process boundaries — HTTP calls, message queues, gRPC. Without it, each service would start a new disconnected trace and you'd lose the full request call graph.

OTel uses **propagators** to inject context into outgoing requests and extract it from incoming ones. The default propagator is W3C TraceContext (`traceparent` header), which is the HTTP standard. B3 propagation (used by Zipkin and older Jaeger setups) is also available.

```python
# For HTTP, auto-instrumentation handles this automatically.
# For manual HTTP calls with the `requests` library:
from opentelemetry.propagate import inject, extract
import requests as http_client

def call_downstream_service(url: str):
    headers = {}
    inject(headers)   # adds traceparent and tracestate headers
    response = http_client.get(url, headers=headers)
    return response

# On the receiving side (e.g., a raw WSGI app not using auto-instrumentation):
def my_wsgi_app(environ, start_response):
    carrier = {k: v for k, v in environ.items() if k.startswith("HTTP_")}
    ctx = extract(carrier)   # restores the remote span as the parent context
    with tracer.start_as_current_span("handle_request", context=ctx) as span:
        ...
```

**Propagation for message queues requires manual work.** When publishing to Kafka or SQS, inject the context into message headers. When consuming, extract it before starting your processing span. Auto-instrumentation libraries for Kafka (e.g., `opentelemetry-instrumentation-confluent-kafka`) do this automatically — check whether one exists for your client before writing it manually.

The `traceparent` header format:
```
traceparent: 00-{trace-id-32hex}-{parent-span-id-16hex}-{flags}
# Example:
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
#               ^^ version  ^^^^^^^^^^^ trace ID ^^^^^^^^^^^  ^^ span ID ^^  ^^ sampled flag
```

---

### Semantic Conventions

Semantic conventions are OTel's standardized attribute names. Using them ensures your telemetry is correctly interpreted by backends — Datadog maps `http.status_code` to its HTTP error rate widget, Jaeger uses `db.statement` for query visualization, and SLO tools know which attributes to aggregate on.

```python
from opentelemetry.semconv.trace import SpanAttributes

# HTTP server span
span.set_attribute(SpanAttributes.HTTP_METHOD, "POST")
span.set_attribute(SpanAttributes.HTTP_ROUTE, "/orders/{order_id}")
span.set_attribute(SpanAttributes.HTTP_STATUS_CODE, 402)
span.set_attribute(SpanAttributes.HTTP_REQUEST_CONTENT_LENGTH, 512)

# Database span
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

**Avoid inventing attribute names for things semconv already covers.** If you use `db.query` instead of `db.statement`, Jaeger won't render it in the query viewer and Datadog won't parse it for APM. Check [opentelemetry.io/docs/specs/semconv](https://opentelemetry.io/docs/specs/semconv/) before naming custom attributes. Custom attributes are fine — just prefix them with your org or domain: `myapp.order.priority`, not `order_priority`.

**Semconv stability levels matter.** Attributes marked `Experimental` may be renamed before becoming stable. In production instrumentation, prefer `Stable` attributes for anything you alert on or build dashboards around. Experimental attributes are safe for exploratory use.

---

### OpenTelemetry Collector

The Collector is a standalone binary (or Docker container) that decouples your application from your backends. Its configuration has four sections: `receivers`, `processors`, `exporters`, and `service` (which wires them into named pipelines).

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

  # Scrape Prometheus metrics from other services and forward via OTLP
  prometheus:
    config:
      scrape_configs:
        - job_name: "node-exporter"
          static_configs:
            - targets: ["node-exporter:9100"]

processors:
  # Batch before exporting — reduces network calls and backend write pressure.
  # Always include this in production pipelines.
  batch:
    timeout: 10s
    send_batch_size: 1000

  # Add or overwrite resource attributes on every span/metric/log
  resource:
    attributes:
      - key: deployment.environment
        value: "production"
        action: upsert   # insert if missing, update if present

  # Drop health check and readiness probe traces — they add noise with zero value.
  # Uses OTTL (OTel Transformation Language) expressions.
  filter/drop_health:
    error_mode: ignore
    traces:
      span:
        - 'attributes["http.route"] == "/health"'
        - 'attributes["http.route"] == "/ready"'
        - 'attributes["http.route"] == "/metrics"'

  # Memory limiter: prevents OOM if telemetry volume spikes.
  # Put this first in every pipeline — before batch.
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

  # Tail-based sampling: makes sampling decisions after the full trace arrives.
  # Head-based sampling (in the SDK) is simpler but can't keep 100% of error traces.
  tail_sampling:
    decision_wait: 10s    # wait up to 10s for all spans in a trace to arrive
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
      insecure: true   # remove in production; use TLS

  prometheus:
    endpoint: "0.0.0.0:8889"   # Prometheus scrapes this endpoint for metrics

  datadog:
    api:
      key: ${env:DD_API_KEY}   # never hardcode; use env var substitution
      site: datadoghq.com

  # Debug exporter: prints telemetry to stdout — invaluable when troubleshooting
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      # memory_limiter must come before batch to shed load before buffering
      processors: [memory_limiter, batch, filter/drop_health, tail_sampling]
      exporters: [otlp/jaeger, datadog]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, batch, resource]
      exporters: [prometheus, datadog]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [datadog]

  # zPages provide a built-in web UI for inspecting the Collector's own health
  extensions: [zpages]

extensions:
  zpages:
    endpoint: 0.0.0.0:55679
```

**`tail_sampling` requires the `otelcol-contrib` distribution** — it's not in the core binary. It also means all spans for a trace must reach the same Collector instance for the sampling decision to be made correctly. In a multi-Collector deployment, use a load balancer exporter (`loadbalancing`) to route spans from the same trace to the same Collector node before the tail sampler.

**Head-based vs tail-based sampling:**

| | Head-based | Tail-based |
|--|-----------|-----------|
| Decision made | At trace start | After trace completes |
| Can keep 100% of errors | No | Yes |
| Implementation complexity | Low (SDK config) | High (Collector required) |
| Latency impact | None | Adds `decision_wait` delay |
| Multi-collector complexity | None | Requires sticky routing |

---

### Environment Variable Configuration

OTel SDKs support configuration via environment variables, which means you can change exporter endpoints, sampling rates, and service names without code changes. This is the preferred approach for containerized deployments.

```bash
# Service identity — overrides what's set in code via Resource.create()
export OTEL_SERVICE_NAME="order-service"
export OTEL_RESOURCE_ATTRIBUTES="service.version=1.2.3,deployment.environment=staging"

# Exporter endpoint — SDK will send OTLP to this address
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"   # or "http/protobuf"

# Traces: head-based sampling rate (0.0–1.0)
export OTEL_TRACES_SAMPLER="traceidratio"
export OTEL_TRACES_SAMPLER_ARG="0.1"   # sample 10% of traces

# Disable a signal entirely (e.g., if you're not ready to use OTel logs yet)
export OTEL_LOGS_EXPORTER="none"

# Increase batch timeout if you're seeing dropped spans under high load
export OTEL_BSP_EXPORT_TIMEOUT=30000   # milliseconds
export OTEL_BSP_MAX_EXPORT_BATCH_SIZE=512
```

**Environment variables take precedence over SDK code configuration in most languages.** If you set `OTEL_EXPORTER_OTLP_ENDPOINT` in the environment, it overrides the `endpoint` argument you passed to `OTLPSpanExporter(endpoint=...)`. This is a common source of confusion when debugging why telemetry is going to the wrong place.

---

## Examples

### Example 1: FastAPI Service with Full OTel Stack (Docker Compose)

This example sets up a FastAPI app with trace and metric instrumentation, an OTel Collector, Jaeger for trace visualization, and Prometheus for metrics.

```yaml
# docker-compose.yaml
version: "3.8"
services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      OTEL_SERVICE_NAME: "order-service"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317"
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc"
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=dev"
    depends_on:
      - collector

  collector:
    image: otel/opentelemetry-collector-contrib:0.97.0
    command: ["--config=/etc/otel/config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otel/config.yaml
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "8889:8889"   # Prometheus scrape
      - "55679:55679" # zPages debug

  jaeger:
    image: jaegertracing/all-in-one:1.56
    ports:
      - "16686:16686"  # Jaeger UI
      - "4317"         # internal — Collector → Jaeger

  prometheus:
    image: prom/prometheus:v2.51.0
    volumes:
      - ./prometheus.yaml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
```

```python
# app.py — complete FastAPI application with OTel instrumentation
from fastapi import FastAPI, HTTPException
from opentelemetry import trace, metrics
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.trace import Status, StatusCode
import os

# --- OTel bootstrap ---
resource = Resource.create({
    SERVICE_NAME: os.getenv("OTEL_SERVICE_NAME", "order-service"),
})

# Traces
trace_provider = TracerProvider(resource=resource)
trace_provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter())  # endpoint from OTEL_EXPORTER_OTLP_ENDPOINT
)
trace.set_tracer_provider(trace_provider)

# Metrics
metric_reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(),
    export_interval_millis=30_000
)
meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
metrics.set_meter_provider(meter_provider)

tracer = trace.get_tracer(__name__)
meter = metrics.get_meter(__name__)

order_counter = meter.create_counter("orders.created", unit="1")
order_duration = meter.create_histogram("orders.processing_duration", unit="ms")

# --- App ---
app = FastAPI()
FastAPIInstrumentor.instrument_app(app)  # auto-traces all routes

@app.post("/orders")
def create_order(item_id: str, quantity: int):
    import time
    start = time.time()

    with tracer.start_as_current_span("create_order") as span:
        span.set_attribute("order.item_id", item_id)
        span.set_attribute("order.quantity", quantity)

        if quantity <= 0:
            span.set_status(Status(StatusCode.ERROR, "Invalid quantity"))
            raise HTTPException(status_code=400, detail="Quantity must be positive")

        # Simulate processing
        order_id = f"ord-{item_id}-{quantity}"
        span.set_attribute("order.id", order_id)

        elapsed_ms = (time.time() - start) * 1000
        order_counter.add(1, {"item_id": item_id})
        order_duration.record(elapsed_ms, {"item_id": item_id})

        return {"order_id": order_id}
```

**Verify it works:**
```bash
# Start the stack
docker-compose up -d

# Send a request
curl -X POST "http://localhost:8000/orders?item_id=widget&quantity=3"

# Check Jaeger for the trace
open http://localhost:16686
# Search for service "order-service", operation "POST /orders"

# Check Prometheus for metrics
curl http://localhost:8889/metrics | grep orders_created
```

---

### Example 2: Collector Pipeline That Filters Noise and Fans Out

This example configures a Collector that drops health check spans, enriches all telemetry with a cluster name, and sends traces to both Jaeger and an OTLP-compatible cloud backend simultaneously.

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 400

  batch:
    timeout: 10s
    send_batch_size: 500

  resource:
    attributes:
      - key: k8s.cluster.name
        value: "prod-us-east-1"
        action: insert   # insert only if not already present

  filter/drop_noise:
    error_mode: ignore
    traces:
      span:
        - 'attributes["http.route"] == "/health"'
        - 'attributes["http.route"] == "/ready"'
        - 'attributes["http.route"] == "/livez"'
        - 'attributes["http.target"] == "/metrics"'

  # Transform: normalize the http.route attribute to strip query params
  # Uses OTTL — OTel Transformation Language
  transform/normalize:
    error_mode: ignore
    trace_statements:
      - context: span
        statements:
          - set(attributes["http.route"], attributes["http.route"]) where attributes["http.route"] != nil

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

  otlp/cloud:
    endpoint: ${env:CLOUD_OTLP_ENDPOINT}
    headers:
      "x-api-key": ${env:CLOUD_API_KEY}

  # Prometheus for metrics only — traces and logs don't go here
  prometheus:
    endpoint: "0.0.0.0:8889"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, filter/drop_noise, resource]
      exporters: [otlp/jaeger, otlp/cloud]   # fan-out to both backends
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [prometheus, otlp/cloud]
```

**Verify the filter is working:**
```bash
# Send a health check request to your app, then check Jaeger
curl http://localhost:8000/health

# This trace should NOT appear in Jaeger — if it does, check your filter OTTL expression.
# Use zPages to inspect what the Collector is receiving and dropping:
open http://localhost:55679/debug/tracez
```

---

### Example 3: Kubernetes Deployment with OTel Collector as DaemonSet

In Kubernetes, running the Collector as a DaemonSet (one pod per node) lets all apps on a node send to a local Collector over localhost — no DNS resolution, low latency, no single point of failure.

```yaml
# k8s/otel-collector-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.97.0
          args: ["--config=/etc/otel/config.yaml"]
          ports:
            - containerPort: 4317   # OTLP gRPC
            - containerPort: 4318   # OTLP HTTP
            - containerPort: 8889   # Prometheus metrics
          resources:
            limits:
              memory: "512Mi"
              cpu: "500m"
            requests:
              memory: "256Mi"
              cpu: "100m"
          volumeMounts:
            - name: config
              mountPath: /etc/otel
          env:
            - name: DD_API_KEY
              valueFrom:
                secretKeyRef:
                  name: datadog-secret
                  key: api-key
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
---
# Apps send to the node-local Collector using the node's IP
# Inject this via the Downward API:
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      env:
        - name: NODE_IP
          valueFrom:
            fieldRef:
              fieldPath: status.hostIP
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "http://$(NODE_IP):4317"
```

**Verify spans are reaching the Collector from a pod:**
```bash
# Exec into an app pod and check connectivity
kubectl exec -it <app-pod> -n default -- \
  curl -v http://$NODE_IP:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{}'
# Expect a 200 or 400 (bad request body) — either means the Collector is reachable.
# A connection refused means the DaemonSet pod on that node isn't running.

# Check Collector logs on the node for the pod
kubectl logs -n monitoring daemonset/otel-collector --tail=50
```

---

## Exercises

### Exercise 1: Instrument a Python Function with Manual Spans and Verify in Jaeger

**Goal:** practice manual span creation, attribute setting, error recording, and trace visualization.

1. Start the Docker Compose stack from Example 1.
2. Add a new endpoint `/inventory/{item_id}` that:
   - Creates a parent span `check_inventory`
   - Creates a child span `query_database` with attributes `db.system = "postgresql"` and `db.operation = "SELECT"`
   - Simulates a 50% chance of raising an `ItemNotFoundError`
   - Records the exception and sets span status to ERROR when it occurs
3. Send 10 requests to the endpoint: `for i in {1..10}; do curl -s http://localhost:8000/inventory/widget; done`
4. Open Jaeger at `http://localhost:16686`, search for the `check_inventory` operation, and confirm:
   - Successful traces show two spans with a parent-child relationship
   - Error traces show the span status as ERROR with the exception recorded
   - `db.system` and `db.operation` attributes are visible on the child span

**Challenge:** add a span event `"cache_miss"` that fires before the `query_database` span when a (simulated) cache lookup fails.

---

### Exercise 2: Write a Collector Config That Samples Selectively

**Goal:** understand tail-based sampling and Collector pipeline configuration.

1. Write an `otel-collector-config.yaml` from scratch (no copying from the lesson) that:
   - Receives OTLP on gRPC port 4317
   - Keeps 100% of traces where any span has `http.status_code` >= 500
   - Keeps 5% of all other traces
   - Drops all spans where `http.route` equals `/healthz`
   - Exports traces to Jaeger at `jaeger:4317`
   - Exports metrics to a Prometheus scrape endpoint on port `8889`
2. Start the Collector with your config: `docker run -v $(pwd)/otel-collector-config.yaml:/etc/otel/config.yaml -p 4317:4317 -p 8889:8889 otel/opentelemetry-collector-contrib:0.97.0 --config=/etc/otel/config.yaml`
3. Verify the Collector starts without errors by checking its logs.
4. Send traces from a test app and confirm in Jaeger that health check traces do not appear.

**Answer these questions without running the Collector:**
- What happens if you put `batch` before `memory_limiter` in the processor chain?
- Why does `tail_sampling` require `decision_wait` and what happens if it's set too low?

---

### Exercise 3: Add a Custom Metric and Query It in Prometheus

**Goal:** practice metric instrument selection, attribute design, and Prometheus querying.

1. In the FastAPI app from Example 1, add a histogram called `order.item.quantity` that records the quantity from each `POST /orders` request. Use `http.method` and `order.status` as attributes.
2. Add a counter called `order.validation.errors` that increments when quantity is <= 0. Use `error.type` as an attribute with value `"invalid_quantity"`.
3. Start the stack and send a mix of valid and invalid requests:
   ```bash
   for qty in 3 -1 5 0 2 -2 10; do
     curl -s -X POST "http://localhost:8000/orders?item_id=widget&quantity=$qty"
   done
   ```
4. Open Prometheus at `http://localhost:9090` and write PromQL queries to answer:
   - What is the p95 request quantity across all orders?
   - What is the rate of validation errors per minute over the last 5 minutes?
   - How many total orders have been created successfully?

**Expected attribute cardinality check:** how many unique time series does `order.item.quantity` produce if you have 3 possible `order.status` values? What would happen if you used `order.id` as an attribute instead?

---

### Exercise 4: Trace Context Propagation Across Two Services

**Goal:** understand how distributed traces span multiple services.

1. Create two minimal FastAPI apps: `service-a` (port 8001) and `service-b` (port 8002). Both should have OTel configured pointing to the same Collector.
2. `service-a` should expose `GET /call-b` which:
   - Starts a manual span `service_a.handler`
   - Makes an HTTP request to `http://localhost:8002/process` using the `requests` library
   - Returns the response from service-b
3. `service-b` should expose `GET /process` which:
   - Starts a manual span `service_b.handler`
   - Returns `{"status": "processed"}`
4. Use `RequestsInstrumentor` and `FastAPIInstrumentor` in both services.
5. Send a request to service-a: `curl http://localhost:8001/call-b`
6. Open Jaeger and find the trace. Confirm:
   - The trace contains spans from **both** services under one trace ID
   - The `service_b.handler` span is a child of the HTTP CLIENT span from service-a
   - Both spans share the same `traceId`

**Debugging step:** if the spans appear as two separate traces instead of one, add `print` statements to log the `traceparent` header that service-a sends and verify service-b is receiving it. This is the most common failure mode when setting up cross-service tracing.
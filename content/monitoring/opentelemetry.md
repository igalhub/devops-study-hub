---
title: OpenTelemetry
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, opentelemetry, otel, traces, metrics, collector, otlp, vendor-neutral]
exercises: 4
---

## Overview
OpenTelemetry (OTel) is the CNCF standard for telemetry instrumentation — a vendor-neutral API and SDK for generating metrics, logs, and traces. Instrument your code once with OTel; export to Datadog, Jaeger, Prometheus, Grafana Tempo, or any OTLP-compatible backend by changing configuration. This is why OTel matters: you're no longer locked into a vendor's instrumentation library.

## Concepts

### Architecture
```
Your Application
  └── OTel SDK (tracer, meter, logger)
       └── OTel Collector (receives, processes, exports)
            ├── → Datadog
            ├── → Jaeger (traces)
            ├── → Prometheus (metrics)
            └── → any OTLP backend
```

You can also skip the Collector and export directly from the SDK to a backend (simpler, but less flexible).

### Python SDK Setup

#### Traces
```bash
pip install opentelemetry-api opentelemetry-sdk \
    opentelemetry-exporter-otlp-proto-grpc \
    opentelemetry-instrumentation-fastapi \
    opentelemetry-instrumentation-sqlalchemy \
    opentelemetry-instrumentation-requests
```

```python
# tracing.py
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource, SERVICE_NAME

resource = Resource.create({
    SERVICE_NAME: "myapp",                      # use the constant, not the raw string
    "service.version": "1.2.3",
    "deployment.environment": "production",
})

provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint="http://otel-collector:4317")
    )
)
trace.set_tracer_provider(provider)
tracer = trace.get_tracer(__name__)
```

#### Metrics
```python
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint="http://otel-collector:4317"),
    export_interval_millis=60_000  # export every 60s
)
meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
metrics.set_meter_provider(meter_provider)

meter = metrics.get_meter(__name__)

# Define instruments
request_counter = meter.create_counter(
    "http.requests",
    description="Number of HTTP requests",
    unit="1"
)

request_duration = meter.create_histogram(
    "http.request.duration",
    description="HTTP request duration",
    unit="ms"
)
```

#### Auto-Instrumentation
```python
# FastAPI — auto-instruments all routes
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
FastAPIInstrumentor.instrument_app(app)

# SQLAlchemy — auto-instruments all queries
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
SQLAlchemyInstrumentor().instrument(engine=engine)

# requests library
from opentelemetry.instrumentation.requests import RequestsInstrumentor
RequestsInstrumentor().instrument()
```

#### Manual Spans and Attributes
```python
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from opentelemetry.semconv.trace import SpanAttributes

tracer = trace.get_tracer(__name__)

def process_order(order_id: str, items: list):
    with tracer.start_as_current_span(
        "process_order",
        kind=SpanKind.INTERNAL
    ) as span:
        span.set_attribute("order.id", order_id)
        span.set_attribute("order.item_count", len(items))

        # Nested span
        with tracer.start_as_current_span("validate_inventory") as child:
            child.set_attribute("inventory.checked", True)
            validate_inventory(items)

        # Record an event (point-in-time annotation on the span)
        span.add_event("inventory_validated", {"items_available": True})

        result = submit_order(order_id, items)
        span.set_attribute("order.status", result.status)
        return result
```

#### Span Status and Errors
```python
from opentelemetry.trace import Status, StatusCode

with tracer.start_as_current_span("risky_operation") as span:
    try:
        do_work()
        span.set_status(Status(StatusCode.OK))
    except Exception as e:
        span.set_status(Status(StatusCode.ERROR, str(e)))
        span.record_exception(e)   # captures exception type, message, and stack trace
        raise
```

### Semantic Conventions
OTel defines standard attribute names to ensure consistency across tools:
```python
from opentelemetry.semconv.trace import SpanAttributes

span.set_attribute(SpanAttributes.HTTP_METHOD, "GET")
span.set_attribute(SpanAttributes.HTTP_URL, "https://api.example.com/users")
span.set_attribute(SpanAttributes.HTTP_STATUS_CODE, 200)
span.set_attribute(SpanAttributes.DB_SYSTEM, "postgresql")
span.set_attribute(SpanAttributes.DB_STATEMENT, "SELECT * FROM users WHERE id = ?")
span.set_attribute(SpanAttributes.NET_PEER_NAME, "db.internal")
```

Using semconv attributes ensures your traces work correctly in any backend — Datadog, Jaeger, Tempo, etc.

### OpenTelemetry Collector
The Collector receives telemetry from your services, processes it, and exports to one or more backends:

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
  batch:
    timeout: 10s
    send_batch_size: 1000

  resource:
    attributes:
      - key: host.name
        from_attribute: net.host.name
        action: upsert

  filter/drop_health:
    traces:
      span:
        - 'attributes["http.route"] == "/health"'   # drop health check traces

exporters:
  datadog:
    api:
      key: ${DD_API_KEY}
      site: datadoghq.com
  
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

  prometheus:
    endpoint: "0.0.0.0:8889"   # scrape this port for metrics

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, filter/drop_health]
      exporters: [datadog, otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [datadog, prometheus]
```

```bash
# Run the Collector
docker run -p 4317:4317 -p 4318:4318 -p 8889:8889 \
  -v $(pwd)/otel-collector-config.yaml:/etc/otelcol/config.yaml \
  otel/opentelemetry-collector-contrib:latest
```

### Context Propagation
OTel propagates trace context across service boundaries via HTTP headers:

```python
# Sending a request — inject trace context into headers
import requests
from opentelemetry.propagate import inject

headers = {}
inject(headers)   # adds traceparent and tracestate headers
response = requests.get("http://downstream-service/api", headers=headers)

# Receiving a request — extract trace context from headers
from opentelemetry.propagate import extract

context = extract(request.headers)
with tracer.start_as_current_span("handle_request", context=context) as span:
    # This span is now part of the upstream trace
    pass
```

FastAPI, Flask, and Django auto-instrumentation handles propagation automatically.

### OTel vs Vendor Agents (ddtrace)

| | OpenTelemetry | ddtrace / vendor SDKs |
|---|---|---|
| Vendor lock-in | None — swap backends via config | Locked to Datadog |
| Instrumentation coverage | Growing, most major frameworks | Comprehensive for Datadog stack |
| Semantic conventions | Standardized (OTEL semconv) | Datadog-specific conventions |
| Overhead | Slightly higher (more abstraction) | Lower (direct integration) |
| Multi-backend export | Native | Requires OTel compatibility layer |

**Recommendation:** Use OTel for new projects or if you want backend flexibility. Use ddtrace if you're all-in on Datadog and want maximum feature coverage.

## Exercises

1. Instrument a Python FastAPI app with OpenTelemetry. Use auto-instrumentation for FastAPI and `requests`. Export traces to Jaeger (run locally with `docker run -p 16686:16686 -p 4317:4317 jaegertracing/all-in-one`). Verify traces appear in the Jaeger UI at `localhost:16686`.
2. Add manual spans to a function that processes a list of items. Add span attributes for item count, processing time per item, and a span event for each processed item. Verify the span hierarchy appears correctly in Jaeger.
3. Deploy an OpenTelemetry Collector with a config that receives OTLP, filters out health check spans, and exports to two backends simultaneously (e.g. Jaeger + a Prometheus metrics endpoint).
4. Implement context propagation between two Python services. Service A makes an HTTP call to Service B. Verify in the tracing backend that both spans appear as part of the same trace with a parent-child relationship.

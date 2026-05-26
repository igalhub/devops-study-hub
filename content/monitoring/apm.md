---
title: Application Performance Monitoring (APM)
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, apm, datadog, distributed-tracing, spans, profiling, ddtrace]
exercises: 4
---

## Overview
APM provides visibility into how code executes inside your services. Distributed tracing shows the path of a request across services and where time is spent. Without APM you know a request took 2 seconds; with APM you know it took 2ms in your API, 5ms in the auth service, and 1993ms waiting for a slow database query. This lesson focuses on Datadog APM with Python, including instrumentation, span attributes, and database monitoring.

## Concepts

### Datadog Agent Setup
```bash
# Install Datadog Agent (Linux)
DD_API_KEY=<your-api-key> DD_SITE=datadoghq.com \
  bash -c "$(curl -L https://install.datadoghq.com/scripts/install_script_agent7.sh)"

# Verify agent is running
sudo datadog-agent status

# Key agent config (/etc/datadog-agent/datadog.yaml)
api_key: <DD_API_KEY>
site: datadoghq.com
env: production
service: myapp
version: 1.2.3
apm_config:
  enabled: true
  apm_non_local_traffic: true   # accept traces from containers
```

In Kubernetes, run the Datadog Agent as a DaemonSet (one agent per node). The official Helm chart is the recommended install.

### Python Instrumentation (ddtrace)
```bash
pip install ddtrace
```

**Auto-instrumentation** (instruments Flask/Django/FastAPI/SQLAlchemy/Redis/etc. automatically):
```bash
# Wrap your app startup with ddtrace-run
DD_SERVICE=myapp DD_ENV=production DD_VERSION=1.2.3 \
  ddtrace-run python -m uvicorn main:app
```

**Manual instrumentation** (add custom spans and tags):
```python
from ddtrace import tracer, patch_all

patch_all()   # auto-instrument supported libraries

from ddtrace.ext import SpanTypes

def process_payment(user_id: str, amount: float, currency: str):
    with tracer.trace("payment.process", service="payment-service", span_type=SpanTypes.WEB) as span:
        span.set_tag("user.id", user_id)
        span.set_tag("payment.amount", amount)
        span.set_tag("payment.currency", currency)

        try:
            result = charge_card(user_id, amount)
            span.set_tag("payment.status", "success")
            span.set_tag("payment.transaction_id", result.transaction_id)
            return result
        except InsufficientFundsError as e:
            span.set_tag("payment.status", "insufficient_funds")
            span.set_tag("error", True)
            span.set_tag("error.message", str(e))
            raise
        except Exception as e:
            span.set_tag("error", True)
            span.set_tag("error.type", type(e).__name__)
            span.set_tag("error.message", str(e))
            tracer.set_tags({"error.stack": traceback.format_exc()})
            raise
```

### FastAPI Auto-Instrumentation
```python
# main.py
from ddtrace import patch_all
patch_all()   # call before importing fastapi

from fastapi import FastAPI, Request
import ddtrace

app = FastAPI()

@app.middleware("http")
async def add_trace_context(request: Request, call_next):
    # Add trace ID to response headers for debugging
    response = await call_next(request)
    span = ddtrace.tracer.current_span()
    if span:
        response.headers["X-Trace-Id"] = str(span.trace_id)
    return response
```

### Database Monitoring
```python
# SQLAlchemy is auto-instrumented — each query becomes a span
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

engine = create_engine("postgresql://user:pass@db:5432/myapp")

# Each query shows up as a span in Datadog APM:
# → db.query: SELECT * FROM users WHERE id = %s
# → duration, table, query text, number of rows
```

Datadog APM automatically captures:
- Query text (with parameters masked)
- Query duration
- Database host and port
- Rows returned/affected

For deeper database monitoring, enable **Database Monitoring** in Datadog — it provides query-level performance data, explain plans, and wait event analysis.

### Connecting Logs, Metrics, and Traces
```python
import logging
import ddtrace

class DatadogLogFormatter(logging.Formatter):
    def format(self, record):
        span = ddtrace.tracer.current_span()
        if span:
            # Inject trace context so logs link to traces in Datadog
            record.dd_trace_id = str(span.trace_id)
            record.dd_span_id = str(span.span_id)
            record.dd_service = span.service
            record.dd_env = ddtrace.config.env
            record.dd_version = ddtrace.config.version
        return super().format(record)
```

When trace ID is in logs, Datadog automatically links log entries to their trace — one click from a trace to related logs.

### Service Map and Dependencies
Datadog builds a service map automatically from trace data:
```
myapp-api
├── → auth-service (5ms avg, 0.1% error)
├── → user-service (12ms avg, 0.0% error)
│   └── → postgres (8ms avg)
└── → redis (0.5ms avg)
```

No configuration needed — the map is built from the `service` and `peer.service` span tags.

### Profiling
```bash
# Install profiling
pip install ddtrace[profiling]

# Enable via env var
DD_PROFILING_ENABLED=true ddtrace-run python -m uvicorn main:app
```

Continuous profiling captures CPU and memory usage at function-level resolution. You can see which function is consuming CPU in production without a separate profiling session.

### Kubernetes Integration
```yaml
# Add Datadog labels to your pods for auto-discovery
spec:
  template:
    metadata:
      labels:
        tags.datadoghq.com/env: production
        tags.datadoghq.com/service: myapp
        tags.datadoghq.com/version: "1.2.3"
      annotations:
        # Tell Datadog how to collect logs for this container
        ad.datadoghq.com/myapp.logs: '[{"source": "python", "service": "myapp"}]'
    spec:
      containers:
        - name: myapp
          env:
            - name: DD_AGENT_HOST
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP   # agent is on the same node
            - name: DD_ENV
              value: production
            - name: DD_SERVICE
              value: myapp
            - name: DD_VERSION
              value: "1.2.3"
```

### APM Sampling
```python
# Default: Datadog head-based sampling (agent decides based on rules)
# Keep all traces for errors and slow requests:

from ddtrace.sampler import DatadogSampler, SamplingRule

sampler = DatadogSampler(rules=[
    SamplingRule(sample_rate=1.0, service="myapp", resource="/health"),  # always sample errors
    SamplingRule(sample_rate=0.1),   # 10% sample rate for everything else
])
tracer.configure(sampler=sampler)
```

## Examples

### Custom Span for External API Call
```python
import requests
from ddtrace import tracer

def fetch_weather(city: str) -> dict:
    with tracer.trace("weather.fetch", service="weather-client") as span:
        span.set_tag("weather.city", city)
        span.set_tag("http.url", f"https://api.weather.com/v1/{city}")

        resp = requests.get(f"https://api.weather.com/v1/{city}")
        span.set_tag("http.status_code", resp.status_code)

        if resp.status_code != 200:
            span.set_tag("error", True)
        
        return resp.json()
```

## Exercises

1. Install `ddtrace` and wrap a FastAPI app with `ddtrace-run`. Make several requests and verify traces appear in Datadog APM under the service name. Confirm the service map shows your API and its database dependency.
2. Add a custom span to a function that calls an external API. Set span tags for the URL, HTTP method, response status code, and response time. Mark the span as error if the status code is >= 400.
3. Inject trace IDs into your application logs using the `dd_trace_id` and `dd_span_id` fields. Verify that clicking a trace in Datadog APM shows a button to jump to the correlated logs.
4. Enable Datadog profiling (`DD_PROFILING_ENABLED=true`). Run a load test (e.g. `ab -n 1000 -c 10`). Find the top 3 CPU-consuming functions in the Datadog profiler UI.

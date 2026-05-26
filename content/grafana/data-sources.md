---
title: Data Sources & Plugins
module: grafana
duration_min: 15
difficulty: intermediate
tags: [grafana, data-sources, prometheus, loki, plugins, transformations]
exercises: 3
---

## Overview
A data source in Grafana is a connection to a backend system that can answer queries. Every panel on a dashboard is backed by exactly one data source — or a mixed-source configuration. DevOps engineers configure and troubleshoot data sources constantly: adding a new Prometheus cluster, hooking up Loki for logs, pulling CloudWatch metrics for AWS cost dashboards. Understanding how data sources work, how to configure them securely, and how to manipulate their output with transformations is essential to building reliable observability infrastructure.

## Concepts

### Built-in Data Sources
Grafana ships first-party support for the most common observability backends. These require no additional plugin installation.

| Data Source | Protocol | Typical Use |
|-------------|----------|-------------|
| Prometheus | HTTP / PromQL | Infrastructure and application metrics |
| Loki | HTTP / LogQL | Log aggregation (pairs with Prometheus) |
| Elasticsearch | HTTP / Lucene | Log search, APM, structured events |
| Jaeger / Tempo | HTTP | Distributed tracing |
| CloudWatch | AWS API | AWS service metrics and logs |
| Azure Monitor | Azure API | Azure infrastructure metrics |
| InfluxDB | HTTP / Flux or InfluxQL | IoT, high-frequency time series |
| PostgreSQL / MySQL | SQL | Application databases, custom metrics |
| Alertmanager | HTTP | Visualize active Alertmanager alerts |

### Configuring a Data Source
Data sources are configured under **Configuration → Data Sources → Add data source**. Each type exposes relevant fields.

**Prometheus configuration:**
```yaml
# Provisioning file: /etc/grafana/provisioning/datasources/prometheus.yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus-server:9090
    access: proxy          # Grafana backend proxies the request (preferred)
    isDefault: true
    jsonData:
      httpMethod: POST
      timeInterval: "15s"  # Matches your Prometheus scrape_interval
    secureJsonData: {}
```

**Key access modes:**
- `proxy` — Grafana server makes the request. Browser never hits the data source directly. Required when the backend is on an internal network.
- `direct` (browser) — the user's browser makes the request. Only works when the backend is publicly reachable. Not recommended.

**Loki configuration:**
```yaml
  - name: Loki
    type: loki
    url: http://loki-gateway:3100
    jsonData:
      derivedFields:
        - datasourceUid: tempo-uid
          matcherRegex: "traceID=(\\w+)"
          name: TraceID
          url: "$${__value.raw}"
```

`derivedFields` parse a regex from log lines and turn matches into clickable links — in this case, linking a `traceID` in a log line directly to the Tempo trace view.

**CloudWatch configuration:**
```yaml
  - name: CloudWatch
    type: cloudwatch
    jsonData:
      authType: default          # Uses EC2 instance role or ECS task role
      defaultRegion: us-east-1
      customMetricsNamespaces: "MyApp/Backend"
```

For local development, use `authType: keys` and supply `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` via environment variables or `secureJsonData`.

### Mixed Data Sources in One Panel
Grafana supports querying multiple data sources in a single panel using the **Mixed** data source. Each query target independently selects its data source.

**When to use mixed:**
- Overlay application metrics (Prometheus) with deployment events (from a SQL annotations query).
- Correlate AWS CloudWatch billing metrics with internal Prometheus SLO metrics on the same time axis.
- Show log volume (Loki) and error rate (Prometheus) as separate series in one time series panel.

To enable: set the panel data source to `-- Mixed --`, then select a data source per query target (A, B, C…).

### Grafana Plugin Ecosystem
Plugins extend Grafana beyond built-in capabilities. They are installed via the CLI or the UI.

**Plugin categories:**
- **Data source plugins** — add backends not natively supported (e.g., Datadog, Splunk, MongoDB, Clickhouse)
- **Panel plugins** — new visualization types (e.g., Worldmap, Sankey, Candlestick, Flowchart/Diagram)
- **App plugins** — bundled data source + panels + dashboards for a full product experience (e.g., Grafana OnCall, k8s app)

**Installing a plugin:**
```bash
# CLI install (Grafana running locally)
grafana-cli plugins install grafana-worldmap-panel
systemctl restart grafana-server

# Via environment variable (Docker/Kubernetes)
GF_INSTALL_PLUGINS=grafana-worldmap-panel,grafana-piechart-panel

# Helm values
grafana:
  plugins:
    - grafana-worldmap-panel
    - grafana-clock-panel
```

Plugins must be signed for use in production Grafana installations. Unsigned plugins require `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=plugin-name` in config.

### Transformations
Transformations process query results before rendering. They run client-side in the browser and can reshape data without touching the data source.

**Common transformations:**

| Transformation | What It Does |
|----------------|-------------|
| Filter by name | Show/hide specific series or columns |
| Organize fields | Rename columns, reorder, hide |
| Merge | Join multiple query results into one table |
| Group by | Aggregate rows by a field (sum, mean, count) |
| Calculate field | Add a computed column (e.g., error rate = errors / total) |
| Reduce | Collapse a time series to a single value (last, mean, max) |
| Sort by | Order rows in a table panel |
| Rename by regex | Rename series using capture groups |

**Calculated field example — deriving error rate from two queries:**
```
Query A: sum(rate(http_requests_total{status=~"5.."}[5m]))  → field: errors
Query B: sum(rate(http_requests_total[5m]))                 → field: total

Transformation: Calculate field
  Mode: Reduce row
  Expression: errors / total * 100
  Alias: Error Rate %
```

This avoids writing the division in PromQL and keeps the two raw series available for other uses.

## Examples

**Add a Prometheus data source via API (useful in automation):**
```bash
curl -X POST http://admin:admin@localhost:3000/api/datasources \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Prometheus-Prod",
    "type": "prometheus",
    "url": "http://prometheus:9090",
    "access": "proxy",
    "isDefault": true,
    "jsonData": { "timeInterval": "15s" }
  }'
```

**Test a data source connection:**
```bash
curl -s http://admin:admin@localhost:3000/api/datasources/name/Prometheus-Prod | jq .
# Check "message" field — should be "Data source is working"
curl -s http://admin:admin@localhost:3000/api/datasources/1/health | jq .
```

**Mixed data source panel — correlate Prometheus + CloudWatch:**
Set panel data source to `-- Mixed --`:
- Query A (Prometheus): `rate(app_requests_total[5m])` — series label: "App RPS"
- Query B (CloudWatch): Namespace `AWS/ApplicationELB`, Metric `RequestCount` — series label: "ALB RPS"

Both series plot on the same time axis. Add a threshold line at your SLO target using the **Thresholds** panel option.

## Exercises

1. Provision a Loki data source via a YAML file under `/etc/grafana/provisioning/datasources/`. Add a derived field that parses `trace_id=(\w+)` from log lines and links to a Tempo data source. Verify the link appears in the Logs panel.
2. Create a panel using the **Mixed** data source that overlays Prometheus CPU metrics with a PostgreSQL query returning deployment timestamps as annotations. Confirm both series appear on the same graph.
3. Build a Table panel that queries two Prometheus metrics (request count and error count), applies a **Calculate field** transformation to derive error rate percentage, and sorts the table by error rate descending.

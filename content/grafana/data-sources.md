---
title: Data Sources & Plugins
module: grafana
duration_min: 25
difficulty: intermediate
tags: [grafana, data-sources, prometheus, loki, plugins, transformations, annotations, mixed]
exercises: 3
---

## Overview

A data source in Grafana is a connection to a backend system that can answer queries. Every panel on a dashboard is backed by exactly one data source — or a mixed-source configuration. DevOps engineers configure and troubleshoot data sources constantly: adding a new Prometheus cluster, hooking up Loki for logs, pulling CloudWatch metrics for AWS cost dashboards.

Data sources are the boundary between Grafana's visualization layer and the observability backends it queries. Understanding how they work — how to configure them correctly, how to provision them as code so they're reproducible, how to combine multiple sources in one view, and how to reshape output with transformations — is essential for building reliable observability infrastructure. In interviews, questions about data sources often appear in the form of troubleshooting scenarios: "The panel shows 'No data' — what do you check?" or "How do you correlate Prometheus metrics with log events in the same view?"

Data source configuration errors are among the most common issues in new Grafana deployments. The access mode (proxy vs. direct), the URL, authentication method, and TLS settings all interact. Provisioning data sources as code — rather than configuring them in the UI once and hoping they persist — is the production-grade approach.

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
| PostgreSQL / MySQL | SQL | Application databases, custom metrics, annotations |
| Alertmanager | HTTP | Visualize active Alertmanager alerts |
| TestData | Built-in | Generate fake data for dashboard development |

### Configuring a Data Source — UI Method

**Administration → Data sources → Add new data source**

Select the data source type, then fill in:
- **Name** — unique identifier used in panel queries and provisioning. Convention: include the environment, e.g., `Prometheus-Prod`.
- **URL** — the base URL of the backend (e.g., `http://prometheus-server:9090`).
- **Access mode** — see below.
- **Auth** — Basic auth, API key, TLS certificates, or custom headers depending on the backend.
- **Default** — marks this as the default data source pre-selected in new panels.

Click **Save & test** — Grafana sends a test request and reports whether the connection succeeded.

### Access Modes: Proxy vs. Direct

This is the most commonly misunderstood data source setting.

| Mode | Who makes the request | When to use |
|------|----------------------|-------------|
| `proxy` | Grafana server | Backend is on an internal network unreachable by browsers. Credentials stay server-side. **Preferred.** |
| `direct` (browser) | User's browser | Backend is publicly reachable with no auth. Rare and not recommended. |

In `proxy` mode, the browser sends queries to Grafana's backend (`/api/datasources/proxy/...`), and Grafana forwards them to the data source. This means Grafana needs network access to the backend, not the user's browser.

If you get "Bad Gateway" or "Connection refused" errors with `proxy` mode, the problem is that the Grafana server process can't reach the URL you entered — not the browser. Check DNS resolution and network policies from the Grafana container/VM, not from your laptop.

### Provisioning Data Sources as Code

Instead of configuring data sources in the UI, write YAML files that Grafana reads at startup. This makes data sources reproducible, auditable, and deployable via CI.

**Provisioning file location:** `/etc/grafana/provisioning/datasources/`

Grafana reads all `.yaml` files in this directory at startup and when files change (no restart required, but a reload may take a few seconds).

**Prometheus configuration:**
```yaml
# /etc/grafana/provisioning/datasources/prometheus.yaml
apiVersion: 1

datasources:
  - name: Prometheus-Prod
    type: prometheus
    uid: prometheus-prod-uid      # Stable identifier used in dashboard JSON
    url: http://prometheus-server:9090
    access: proxy
    isDefault: true
    jsonData:
      httpMethod: POST            # POST is more reliable for long PromQL queries
      timeInterval: "15s"         # Must match your Prometheus scrape_interval
      exemplarTraceIdDestinations:
        - name: traceID
          datasourceUid: tempo-uid   # Links exemplars to Tempo traces
    secureJsonData: {}
```

**Why `httpMethod: POST`?** Long PromQL expressions can exceed URL length limits when sent as GET query parameters. POST avoids this — always set it.

**Loki configuration:**
```yaml
# /etc/grafana/provisioning/datasources/loki.yaml
apiVersion: 1

datasources:
  - name: Loki
    type: loki
    uid: loki-uid
    url: http://loki-gateway:3100
    access: proxy
    jsonData:
      maxLines: 1000
      derivedFields:
        - datasourceUid: tempo-uid
          matcherRegex: "traceID=(\\w+)"    # Regex to extract trace ID from log lines
          name: TraceID
          url: "$${__value.raw}"            # Links the matched value to Tempo
```

`derivedFields` parse a regex from log lines and turn matches into clickable links. In this example, any log line containing `traceID=abc123` will show a clickable link that opens Tempo at that exact trace. This is the standard Grafana/Loki/Tempo correlation workflow.

**Testing derived fields:** In a Logs panel, expand a log line. At the bottom, you should see a section called "Derived fields" with the parsed link. If the section doesn't appear, the regex didn't match — test the regex pattern against a sample log line using a tool like `grep` or `python3 -c "import re; print(re.search('traceID=(\\w+)', 'your log line here'))"`.

**CloudWatch configuration:**
```yaml
  - name: CloudWatch
    type: cloudwatch
    uid: cloudwatch-uid
    jsonData:
      authType: default          # Uses EC2 instance role or ECS task role
      defaultRegion: us-east-1
      customMetricsNamespaces: "MyApp/Backend"
```

For local development (no instance role available), use:
```yaml
    jsonData:
      authType: keys
      defaultRegion: us-east-1
    secureJsonData:
      accessKey: "AKIAIOSFODNN7EXAMPLE"
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
```

Never hardcode keys in YAML committed to Git. Use environment variable substitution or Kubernetes secrets mounted as env vars.

**PostgreSQL data source (used for annotations and custom metrics):**
```yaml
  - name: PostgreSQL-App
    type: postgres
    uid: postgres-app-uid
    url: postgres-host:5432
    user: grafana_ro
    database: app_production
    secureJsonData:
      password: "readonly-password"
    jsonData:
      sslmode: require
      postgresVersion: 1400      # 14.0 — affects available SQL features
      timescaledb: false
```

The PostgreSQL data source accepts raw SQL queries in panels. This is commonly used for annotation queries (deployment events, incident records) and business dashboards (counts, revenue metrics).

### Adding a Data Source via the Grafana API

Useful in scripts, Ansible playbooks, or CI pipelines:

```bash
curl -X POST http://admin:admin@localhost:3000/api/datasources \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Prometheus-Prod",
    "type": "prometheus",
    "uid": "prometheus-prod-uid",
    "url": "http://prometheus:9090",
    "access": "proxy",
    "isDefault": true,
    "jsonData": {
      "httpMethod": "POST",
      "timeInterval": "15s"
    }
  }'
```

**Test a data source connection via API:**
```bash
# Get data source by name and inspect its health
curl -s http://admin:admin@localhost:3000/api/datasources/name/Prometheus-Prod | jq .

# Health check (returns "Data source is working" on success)
curl -s http://admin:admin@localhost:3000/api/datasources/uid/prometheus-prod-uid/health | jq .
```

### Query-Based Dashboard Annotations

Annotations overlay events on time-series panels as vertical lines. They're used to correlate metrics with deployments, configuration changes, or incidents.

**Setting up a PostgreSQL annotation query:**
1. Open **Dashboard settings** (gear icon) → **Annotations** → **Add annotation query**.
2. Set:
   - **Data source**: PostgreSQL-App
   - **Query**:
     ```sql
     SELECT
       EXTRACT(EPOCH FROM deployed_at) * 1000 AS time,
       service_name AS text,
       version AS tags
     FROM deployments
     WHERE $__timeFilter(deployed_at)
     ORDER BY deployed_at ASC
     ```
   - **Time field**: `time` (the column holding the epoch-millisecond timestamp)
   - **Text field**: `text` (shown in the annotation tooltip)
   - **Tags field**: `tags`
3. Grafana renders a vertical dashed line at each deployment timestamp across all time-series panels.

`$__timeFilter(deployed_at)` is a Grafana macro that expands to a SQL `WHERE` clause matching the current dashboard time range. This prevents the query from scanning the entire table.

**Annotation via Prometheus (for event-like signals):**
```promql
changes(kube_deployment_status_observed_generation{deployment="my-app"}[1m]) > 0
```
This returns a 1 when a deployment updates, 0 otherwise. Grafana plots a line where value > 0.

### Mixed Data Sources in One Panel

The **Mixed** data source lets a single panel query multiple backends. Each query target independently selects its data source.

**How to use:**
1. In the panel editor, set the data source dropdown to `-- Mixed --`.
2. For each query target (A, B, C...), a separate data source dropdown appears. Select the appropriate source per target.

**When to use mixed:**
- Overlay application metrics (Prometheus) with deployment events (PostgreSQL annotations query as a series).
- Correlate AWS CloudWatch billing metrics with internal Prometheus SLO metrics on the same time axis.
- Show log volume (Loki: `count_over_time({app="myapp"}[5m])`) and error rate (Prometheus) as separate series.

**Mixed panel example — Prometheus + PostgreSQL:**
```
Query A (Prometheus — data source: Prometheus-Prod):
  expr: rate(http_requests_total[5m])
  legendFormat: "RPS"

Query B (PostgreSQL — data source: PostgreSQL-App):
  SELECT
    EXTRACT(EPOCH FROM deployed_at) * 1000 AS time,
    1 AS value,
    'deploy: ' || version AS metric
  FROM deployments
  WHERE $__timeFilter(deployed_at)
```

Query B returns a value of 1 at each deployment timestamp, plotting as a point series on the same time axis as the RPS line. Combined with a threshold line at your SLO target (set under **Thresholds** in the panel options), this immediately shows whether deployments correlate with SLO breaches.

### Grafana Plugin Ecosystem

Plugins extend Grafana beyond built-in capabilities.

**Plugin categories:**
- **Data source plugins** — add backends not natively supported (e.g., Datadog, Splunk, MongoDB, Clickhouse)
- **Panel plugins** — new visualization types (e.g., Worldmap, Sankey, Candlestick, Flowchart)
- **App plugins** — bundled data source + panels + dashboards (e.g., Grafana OnCall, k8s app)

**Installing a plugin:**
```bash
# CLI install (Grafana running locally or in a container)
grafana-cli plugins install grafana-worldmap-panel
systemctl restart grafana-server

# Via environment variable (Docker / Kubernetes)
GF_INSTALL_PLUGINS=grafana-worldmap-panel,grafana-piechart-panel

# Helm values (kube-prometheus-stack or grafana chart)
grafana:
  plugins:
    - grafana-worldmap-panel
    - grafana-clock-panel
```

**Listing installed plugins:**
```bash
grafana-cli plugins ls
# Or via API:
curl -s http://admin:admin@localhost:3000/api/plugins | jq '.[].id'
```

Plugins must be signed for use in production Grafana installations. Unsigned plugins require:
```ini
# /etc/grafana/grafana.ini
[plugins]
allow_loading_unsigned_plugins = plugin-name-here
```

Or as env var: `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=plugin-name`.

### Transformations

Transformations process query results before rendering. They run client-side in the browser and can reshape data without touching the data source.

**Adding a transformation:**
1. In the panel editor, click the **Transform** tab (between Query and Alert).
2. Click **Add transformation** and select the type.
3. Transformations are applied in order — the output of one feeds into the next.

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
| Filter data by values | Drop rows where a field meets a condition |
| Outer join | Join two time series on timestamp (like SQL JOIN) |

**Calculated field example — deriving error rate from two queries:**

```
Query A:
  expr: sum(rate(http_requests_total{status=~"5.."}[5m]))
  legendFormat: errors

Query B:
  expr: sum(rate(http_requests_total[5m]))
  legendFormat: total
```

In the Transform tab:
```
Add transformation: Reduce
  Mode: All values          ← collapses each time series to a single latest value

Add transformation: Calculate field
  Mode: Reduce row
  Expression: errors / total * 100
  Alias: Error Rate %

Add transformation: Sort by
  Field: Error Rate %
  Order: Descending
```

This produces a Table panel with one row per service showing the current error rate percentage, sorted highest-first.

**Rename by regex — clean up PromQL legend labels:**
```
Transformation: Rename by regex
  Match: (.+)\{.*job="([^"]+)".*\}
  Replace: $2
```
This strips the full metric name and curly braces, keeping only the `job` label value as the series name.

### Troubleshooting Data Sources

Common issues and how to diagnose them:

**"No data" in a panel:**
1. Check the time range — is there data in that window? Try widening to `Last 7d`.
2. Click **Inspect → Query** in the panel to see the exact query sent and response received.
3. Go to **Data sources → (source) → Save & test** — confirms basic connectivity.
4. Try the query directly against the backend: `curl http://prometheus:9090/api/v1/query?query=up`.

**"Bad Gateway" error:**
- The Grafana server can't reach the data source URL. Check network connectivity from Grafana, not from your browser. In Kubernetes: `kubectl exec -n monitoring <grafana-pod> -- curl http://prometheus-server:9090/-/healthy`.

**"No data" after provisioning a new data source:**
- The `uid` in the provisioning YAML must match the `uid` used in dashboard JSON. A mismatch causes panels to show "Data source not found".

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
    "jsonData": { "httpMethod": "POST", "timeInterval": "15s" }
  }'
```

**Provision both Prometheus and Loki in one file:**
```yaml
apiVersion: 1
datasources:
  - name: Prometheus-Prod
    type: prometheus
    uid: prometheus-prod-uid
    url: http://prometheus:9090
    access: proxy
    isDefault: true
    jsonData:
      httpMethod: POST
      timeInterval: "15s"

  - name: Loki
    type: loki
    uid: loki-uid
    url: http://loki:3100
    access: proxy
    jsonData:
      derivedFields:
        - datasourceUid: tempo-uid
          matcherRegex: "trace_id=(\\w+)"
          name: TraceID
          url: "$${__value.raw}"
```

Place this file at `/etc/grafana/provisioning/datasources/observability-stack.yaml`. Restart Grafana. Both data sources appear in the UI and in dashboards that reference their UIDs.

**Mixed data source panel — Prometheus + CloudWatch on the same time axis:**
```
Panel data source: -- Mixed --

Query A (data source: Prometheus-Prod):
  expr: rate(app_requests_total[5m])
  legendFormat: "App RPS (internal)"

Query B (data source: CloudWatch):
  Namespace: AWS/ApplicationELB
  Metric: RequestCount
  Dimensions: LoadBalancer=<your-alb-name>
  Statistics: Sum
  legendFormat: "ALB RPS (edge)"
```

Both series plot on the same time axis. Add a threshold line at your SLO target using **Thresholds** in the panel options. A gap between App RPS and ALB RPS indicates traffic is reaching the load balancer but not the application — useful for diagnosing connection pool exhaustion or pod scheduling delays.

## Exercises

1. Provision a Loki data source via a YAML file under `/etc/grafana/provisioning/datasources/`. Include a `derivedFields` entry that parses `trace_id=(\w+)` from log lines and links to a Tempo data source using the matched value. Restart Grafana, open a Logs panel backed by Loki, expand a log line that contains `trace_id=`, and confirm the **Derived fields** section shows a clickable TraceID link. If the link is absent, test your regex with `grep -oP 'trace_id=\K\w+' <<< "your sample log line"` to confirm it matches before troubleshooting Grafana config.

2. Create a panel using the **Mixed** data source that overlays Prometheus CPU metrics (Query A) with a PostgreSQL annotation series (Query B) returning deployment timestamps as points. In the PostgreSQL query, use `$__timeFilter(deployed_at)` to scope results to the dashboard time range. Add a threshold line at your SLO CPU limit. Confirm both series appear on the same graph by running the query and inspecting output under **Inspect → Data**.

3. Build a Table panel that queries two Prometheus metrics (request count as Query A, error count as Query B). In the **Transform** tab, add a **Reduce** transformation (mode: Last, applied to both series), then a **Calculate field** transformation (expression: `errors / requests * 100`, alias: `Error Rate %`), then a **Sort by** transformation (field: `Error Rate %`, descending). Confirm the table shows a single row per service with the computed error rate sorted highest-first.


---

### Quick Checks

4. Extract the data source type from a provisioning stub. Run: `printf 'name: Prometheus\ntype: prometheus\nurl: http://prometheus:9090\n' | awk '/^type:/{print $2}'`

```expected_output
prometheus
```

hint: Think about how awk can match lines by a pattern and then print a specific field from those lines.
hint: Use awk with a regex pattern like '/^type:/' to match the line, then reference the second whitespace-separated field with '$2'.

5. Count configured data sources in a provisioning stub. Run: `printf 'datasources:\n- name: Prometheus\n  type: prometheus\n- name: Loki\n  type: loki\n- name: Tempo\n  type: tempo\n' | grep -c '^- name:'`

```expected_output
3
```

hint: Think about how you can filter lines that mark the start of a new data source entry and count how many matches exist.
hint: Use grep with the -c flag to count lines matching the pattern '^- name:' from the piped YAML content.

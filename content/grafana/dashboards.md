---
title: Dashboards & Visualizations
module: grafana
duration_min: 30
difficulty: beginner
tags: [grafana, dashboards, visualization, panels, provisioning, thresholds, annotations]
exercises: 3
---

## Overview

Grafana dashboards are the primary interface for visualizing time-series and structured data from monitoring systems. A dashboard is a collection of panels, each bound to a data source query. The output of monitoring work — whether that's Prometheus metrics, Loki logs, or CloudWatch data — only becomes actionable when it's presented in a way that allows engineers to make fast decisions. A raw metric like `node_cpu_seconds_total` is useless to an on-call engineer at 3am; a time-series panel showing CPU utilization with a red threshold line and a linked runbook is not.

For a DevOps engineer, mastering dashboards means translating raw metrics — CPU, latency, error rates, deploy events — into visual context teams can act on without digging into CLI output. It also means building dashboards that survive team turnover: dashboards as code, stored in Git, deployed by CI, not hand-crafted in the UI and forgotten. The two concerns (visual design + operational reproducibility) both matter in production and in interviews.

Grafana's dashboard model is built around a 24-column grid. Every panel occupies a rectangular region of the grid (`gridPos`). Understanding this model lets you build dashboards programmatically — as JSON — and version them alongside the infrastructure they monitor.

## Concepts

### Panel Types

Grafana ships several panel types out of the box. Choosing the right one determines whether data is legible or misleading.

| Panel Type | Best For | Notes |
|------------|----------|-------|
| Time series | Metrics over time (CPU, RPS, latency) | Default for Prometheus queries |
| Stat | Single current value with threshold color | Good for SLO/SLA scorecards |
| Gauge | Current value relative to min/max range | Battery-style — shows headroom |
| Bar chart | Categorical comparisons | Non-time-series distributions |
| Table | Multi-column structured output | Log counts, pod listings |
| Heatmap | Distribution over time (latency percentiles) | p50/p95/p99 bucket visualization |
| Logs | Raw log lines from Loki/Elasticsearch | Tail logs in context of metrics |
| Pie chart | Proportional breakdown | Request mix by status code |
| State timeline | State changes over time | Alert history, deployment states |

### Creating a Panel — Step by Step

Starting from a new or existing dashboard:

1. Click **+ Add panel** (top toolbar) → **Add a new panel**.
2. The **panel editor** opens. It has three regions:
   - **Left**: query editor and transformations.
   - **Center**: live preview of the panel.
   - **Right**: panel options sidebar (type, title, thresholds, legends, axes).
3. In the query editor (bottom left), select your data source and write the query.
4. In the right sidebar, select the panel type from the dropdown at the top (e.g., "Time series", "Stat").
5. Set the **Title** field in the right sidebar.
6. Click **Apply** (top right) to save the panel to the dashboard. Then **Save dashboard** (floppy disk icon, top right).

### Configuring Thresholds on a Stat Panel

Thresholds control the color a panel displays based on the current value. For a Stat panel showing error rate:

1. Create a Stat panel with a query that returns the current error rate (e.g., `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) * 100`).
2. In the right sidebar, scroll to **Thresholds**.
3. The default has one threshold at value `80` (red). Click the red dot to delete it or change the value.
4. Add thresholds:
   - Base color (green) — this is the default/lowest band.
   - Click **+ Add threshold** → set value `5` → set color to **red**.
5. In **Thresholds mode**, choose **Absolute** (value-based) or **Percentage** (relative to min/max).
6. The Stat panel now renders green below 5% and red at or above 5%.

For percentage-based thresholds (e.g., disk usage where 0–70% is fine, 70–90% is warning, 90%+ is critical):
- Base: green
- Add threshold at `70` → yellow
- Add threshold at `90` → red

### Configuring a Time Series Panel

After creating a Time series panel:

**Legend:** In the right sidebar under **Legend**, set mode to **Table** to show min/mean/max/last values alongside the series names. This is useful for CPU dashboards where you want current and peak side-by-side.

**Axes:** Under **Standard options → Unit**, set the unit to match the metric: `Percent (0-100)`, `bytes/sec`, `requests/sec`, etc. Grafana auto-scales and labels the axis correctly.

**Override thresholds on a time series:** Under **Thresholds**, add threshold lines that appear as horizontal reference lines across the graph. These are visual guides, not color-fills (unlike Stat/Gauge panels).

### Side-by-Side Layout — Stat + Time Series

To place a Stat panel and a Time series panel side-by-side for the same metric:

1. Add the Time series panel first. Set its `gridPos` width to 12 (half the grid): drag the right edge to the midpoint of the dashboard.
2. Add the Stat panel. Grafana places it to the right automatically. Set its width to 12.
3. Both panels share the same dashboard time range. The Stat shows the *current* value (using the `last` reducer in **Value options → Reduce → Last**); the Time series shows history.
4. To show a different time window on just the Stat panel: in **Panel options → Time range**, override with a relative range like `now-5m to now`.

**Using the same query for both panels without duplicating logic:**
- Write the query once. To reuse it, copy the panel (`...` menu → Duplicate), then change the panel type on the copy.

### Dashboard Variables and Templates

Variables make a dashboard reusable across environments, clusters, or services. They appear as dropdowns at the top of the dashboard and are interpolated into panel queries.

**Adding a variable:**
1. Go to **Dashboard settings** (gear icon, top right) → **Variables** → **Add variable**.
2. Set:
   - **Type**: Query, Custom, Constant, Textbox, Interval, or Data source.
   - **Name**: Used in queries as `$varname` or `${varname}`.
   - **Label**: What the user sees on the dropdown (optional, defaults to name).

**Types of variables:**
- **Query** — runs a data source query to populate values (e.g., all pod names from Prometheus)
- **Custom** — static list you define (e.g., `prod,staging,dev`)
- **Constant** — a fixed value used across panels (e.g., a common label prefix)
- **Textbox** — free-text input from the user
- **Interval** — time bucket sizes like `1m,5m,1h`
- **Data source** — lets the user switch the data source driving the whole dashboard

**Defining a query variable (Prometheus example):**
```
Variable name: namespace
Type: Query
Data source: Prometheus
Query: label_values(kube_pod_info, namespace)
Refresh: On time range change
Multi-value: enabled
Include All option: enabled (All value: .*)
```

**Using a variable in a panel query:**
```promql
rate(http_requests_total{namespace=~"$namespace", job="$job"}[5m])
```

When `Multi-value` is enabled, `$namespace` expands to a regex alternation: `namespace=~"prod|staging"`. That is why the operator must be `=~` (regex match), not `=`.

**Custom variable for environment:**
```
Name: env
Type: Custom
Values: prod,staging,dev
Default: prod
```

Use in queries: `{env="$env"}`.

### Time Range Controls

The time picker (top-right corner) controls what data all panels display.

- **Relative ranges** (`Last 1h`, `Last 24h`) auto-refresh as time advances.
- **Absolute ranges** pin start/end timestamps — useful for sharing a dashboard permalink after an incident. Copy the URL after selecting a specific range; the timestamps are encoded in the URL query string.
- **Refresh interval** is set independently (e.g., refresh every 30s while viewing a live range). Set via the dropdown next to the time picker.
- Individual panels can **override** the dashboard time range under **Panel options → Time range**. This is useful for showing a longer baseline (last 7d) alongside a zoomed incident view (last 1h).

### Annotations

Annotations mark events on time-series panels as vertical lines or highlighted regions. They are used to correlate metrics with deployments, configuration changes, or incidents.

**Adding a native Grafana annotation (manual):**
- Click on a time-series panel at a specific timestamp while holding `Ctrl` (or `Cmd` on Mac).
- A dialog opens to write a description and add tags.
- The annotation appears as a dashed vertical line across all panels that have annotations enabled.

**Query-based annotations (automatic):**
1. Go to **Dashboard settings → Annotations → Add annotation query**.
2. Set the data source (e.g., Prometheus or a SQL database).
3. Write a query that returns timestamps. Example using Prometheus:
   ```promql
   changes(kube_deployment_status_observed_generation{deployment="my-app"}[1m]) > 0
   ```
4. Set **Step** and **Time field** mapping so Grafana knows which field is the timestamp.

Annotations from Prometheus are limited since Prometheus doesn't store free-text events well. More commonly, annotations come from a SQL database (e.g., a `deployments` table) or from Grafana's own annotation store.

### Panel Links and Dashboard Links

Panels can link to other dashboards or external URLs, enabling drill-down workflows: click a spike in a service overview → land on that service's detail dashboard.

**Adding a panel link:**
1. In the panel editor, right sidebar: **Panel links → Add link**.
2. Set **Title** and **URL**. Use data link variables to pass context:
   - `${__field.labels.service}` — the label value from the hovered series
   - `${__value.numeric}` — the numeric value at the clicked point
   - `${__from}` / `${__to}` — current dashboard time range in epoch ms

**Panel link config (JSON excerpt):**
```json
"links": [
  {
    "title": "Service Detail",
    "url": "/d/abc123/service-detail?var-service=${__field.labels.service}&from=${__from}&to=${__to}",
    "targetBlank": false
  }
]
```

This passes the series label and time range to the target dashboard, so it opens pre-filtered to the exact service and time window.

### Dashboard JSON Model

Every Grafana dashboard is stored as a JSON document. Understanding the model lets you diff dashboards, review changes in Git, and automate creation.

**To view or export the JSON for any dashboard:**
- **Dashboard settings** (gear icon) → **JSON Model** tab — shows the full document.
- Or: **Share** button (top toolbar) → **Export** → **Save to file** — downloads the JSON.

**Abbreviated structure:**
```json
{
  "title": "Service Overview",
  "uid": "service-overview-v1",
  "schemaVersion": 38,
  "time": { "from": "now-1h", "to": "now" },
  "refresh": "30s",
  "templating": {
    "list": [
      {
        "name": "namespace",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "prometheus-uid" },
        "query": "label_values(kube_pod_info, namespace)",
        "multi": true,
        "includeAll": true
      }
    ]
  },
  "panels": [
    {
      "type": "timeseries",
      "title": "Request Rate",
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus-uid" },
      "targets": [
        {
          "expr": "rate(http_requests_total{namespace=~\"$namespace\"}[5m])",
          "legendFormat": "{{job}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 100 },
              { "color": "red", "value": 500 }
            ]
          }
        }
      }
    },
    {
      "type": "stat",
      "title": "Current Error Rate",
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus-uid" },
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m])) * 100",
          "legendFormat": "Error Rate %"
        }
      ],
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"] },
        "orientation": "auto",
        "colorMode": "background"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "red", "value": 5 }
            ]
          }
        }
      }
    }
  ]
}
```

Key fields:
- `uid` — stable identifier used in provisioning and URLs. Must be unique within the Grafana instance.
- `gridPos` — positions panels on the 24-column grid. `w: 12` is half-width; `w: 24` is full-width.
- `fieldConfig.defaults.thresholds` — defines the threshold coloring for Stat/Gauge panels.
- `options.reduceOptions.calcs` — controls which aggregation Stat panels use (`lastNotNull`, `mean`, `max`, etc.).

### Provisioning Dashboards as Code

Grafana can load dashboards from files on disk, bypassing the UI. This is the GitOps approach — store JSON in a repo, deploy via Helm/Ansible/CI.

**Step 1: Write the provisioning config**

File: `/etc/grafana/provisioning/dashboards/default.yaml`

```yaml
apiVersion: 1

providers:
  - name: default
    folder: DevOps
    type: file
    disableDeletion: true        # UI deletes are blocked; must remove from filesystem
    updateIntervalSeconds: 60    # How often Grafana polls for changes
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: true   # Subdirectories become Grafana folders
```

**Step 2: Place dashboard JSON files in the watched directory**

```
/var/lib/grafana/dashboards/
├── service-overview.json
└── infra/
    └── node-exporter.json     # → appears in "infra" Grafana folder
```

**Step 3: Restart Grafana (or wait for the poll interval)**

```bash
systemctl restart grafana-server
# Watch the log for provisioning messages:
journalctl -u grafana-server -f | grep -i provision
```

**Step 4: Verify via API**

```bash
# List all dashboards — confirm provisioned ones appear
curl -s http://admin:admin@localhost:3000/api/search?query= | jq '.[].title'

# Get a specific dashboard by UID
curl -s http://admin:admin@localhost:3000/api/dashboards/uid/service-overview-v1 | jq .dashboard.title
```

**Provisioning with Helm (Grafana chart):**
```yaml
# values.yaml
dashboardProviders:
  dashboardproviders.yaml:
    apiVersion: 1
    providers:
      - name: default
        folder: DevOps
        type: file
        disableDeletion: true
        options:
          path: /var/lib/grafana/dashboards/default

dashboards:
  default:
    service-overview:
      json: |
        { ... full dashboard JSON ... }
```

Or reference a ConfigMap that contains the JSON:
```yaml
dashboardsConfigMaps:
  default: grafana-dashboards-configmap
```

The ConfigMap is created with:
```bash
kubectl create configmap grafana-dashboards \
  --from-file=service-overview.json=./dashboards/service-overview.json \
  -n monitoring
```

### Exporting a Dashboard for GitOps

**From the UI:**
1. Open the dashboard you want to export.
2. Click the **Share** button (top toolbar) → **Export** tab.
3. Enable **Export for sharing externally** — this replaces data source UIDs with template variables so the JSON is portable across Grafana instances.
4. Click **Save to file**. The JSON downloads.
5. Commit the file to your repo: `git add grafana/dashboards/service-overview.json && git commit -m "add service overview dashboard"`.

**From the API (useful for scripting):**
```bash
# Get dashboard JSON by UID
curl -s http://admin:admin@localhost:3000/api/dashboards/uid/service-overview-v1 \
  | jq .dashboard > service-overview.json

# Strip the internal metadata Grafana adds (version, id) before committing:
jq 'del(.version, .id)' service-overview.json > service-overview-clean.json
```

## Examples

**Full workflow — create a CPU dashboard provisioned via file:**

1. Export an existing dashboard from the Grafana UI: **Share → Export → Save to file**.
2. Commit the JSON to your repo under `grafana/dashboards/cpu-overview.json`.
3. Mount it into the Grafana pod via a ConfigMap:
```bash
kubectl create configmap grafana-dashboards \
  --from-file=cpu-overview.json=grafana/dashboards/cpu-overview.json \
  -n monitoring
```
4. Reference the ConfigMap in the Grafana Helm values and redeploy.
5. Grafana loads the dashboard on the next poll cycle — visible under the `DevOps` folder.

**Verify provisioned dashboards are loaded:**
```bash
curl -s http://admin:admin@localhost:3000/api/dashboards/home | jq .
curl -s http://admin:admin@localhost:3000/api/search?query= | jq '.[].title'
```

**Complete minimal stat + time-series JSON you can paste and provision immediately:**
```json
{
  "title": "Error Rate Monitor",
  "uid": "error-rate-v1",
  "schemaVersion": 38,
  "time": { "from": "now-1h", "to": "now" },
  "refresh": "30s",
  "panels": [
    {
      "type": "stat",
      "title": "Current Error Rate",
      "gridPos": { "x": 0, "y": 0, "w": 8, "h": 6 },
      "datasource": { "type": "prometheus", "uid": "${datasource}" },
      "targets": [{
        "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m])) * 100",
        "legendFormat": "Error %"
      }],
      "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background" },
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "red", "value": 5 }
            ]
          }
        }
      }
    },
    {
      "type": "timeseries",
      "title": "Error Rate — Last 24h",
      "gridPos": { "x": 8, "y": 0, "w": 16, "h": 6 },
      "datasource": { "type": "prometheus", "uid": "${datasource}" },
      "targets": [{
        "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m])) * 100",
        "legendFormat": "Error %"
      }],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "red", "value": 5 }
            ]
          }
        }
      }
    }
  ]
}
```

The `${datasource}` placeholder works with the `Export for sharing externally` flag — Grafana prompts for the data source when importing.

## Exercises

1. Create a dashboard with a **Stat** panel showing the current error rate for a service, and a **Time series** panel showing the last 24h of that same metric side-by-side. Set the Stat panel to turn red when the error rate exceeds 5% using the **Thresholds** sidebar option (base color green, add threshold at value 5 with color red). Set the Time series panel to show a red threshold reference line at y=5. Confirm that duplicating one panel and changing its type is faster than creating both from scratch.

2. Add a **namespace** query variable populated from `label_values(kube_pod_info, namespace)`. Enable **Multi-value** and **Include All**. Wire the variable into both panel queries using `namespace=~"$namespace"`. Verify the dropdown filters data correctly by switching namespaces and confirming both panels update. Explain why `=~` is required instead of `=` when the variable is multi-value.

3. Export your dashboard as JSON using **Share → Export → Export for sharing externally → Save to file**. Commit it to a Git repo. Write a Grafana provisioning YAML config (`/etc/grafana/provisioning/dashboards/default.yaml`) that watches `/var/lib/grafana/dashboards`. Copy the exported JSON to that directory, restart Grafana, and confirm the dashboard appears in the UI by querying the API: `curl -s http://admin:admin@localhost:3000/api/search?query= | jq '.[].title'`.

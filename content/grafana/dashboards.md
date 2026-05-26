---
title: Dashboards & Visualizations
module: grafana
duration_min: 20
difficulty: beginner
tags: [grafana, dashboards, visualization, panels, provisioning]
exercises: 3
---

## Overview
Grafana dashboards are the primary interface for visualizing time-series and structured data from monitoring systems. A dashboard is a collection of panels, each bound to a data source query. For a DevOps engineer, mastering dashboards means being able to translate raw metrics — CPU, latency, error rates, deploy events — into actionable visual context that teams can act on without digging into raw logs or CLI output.

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

### Dashboard Variables and Templates
Variables make a dashboard reusable across environments, clusters, or services. They appear as dropdowns at the top of the dashboard and are interpolated into panel queries.

**Types of variables:**
- **Query** — runs a data source query to populate values (e.g., all pod names from Prometheus)
- **Custom** — static list you define (e.g., `prod,staging,dev`)
- **Constant** — a fixed value used across panels (e.g., a common label)
- **Textbox** — free-text input from the user
- **Interval** — time bucket sizes like `1m,5m,1h`

**Defining a query variable (Prometheus example):**
```
Variable name: namespace
Query: label_values(kube_pod_info, namespace)
Refresh: On time range change
Multi-value: enabled
Include All option: enabled
```

**Using a variable in a panel query:**
```promql
rate(http_requests_total{namespace="$namespace", job="$job"}[5m])
```

Variables support `$varname` or `${varname}` syntax. Multi-value selections automatically expand to regex: `namespace=~"$namespace"`.

### Time Range Controls
The time picker in the top-right corner controls what data all panels display. Key behaviors:
- **Relative ranges** (`Last 1h`, `Last 24h`) auto-refresh as time advances.
- **Absolute ranges** pin start/end timestamps — useful when sharing a dashboard permalink after an incident.
- **Refresh interval** can be set independently (e.g., refresh every 30s while viewing a live range).
- Individual panels can override the dashboard time range using the panel's **Time range** option — useful for showing a longer baseline alongside a zoomed-in view.

### Panel Links and Dashboard Links
Panels can link to other dashboards or external URLs. This enables drill-down workflows: click a spike in a service overview → land on that service's detail dashboard.

**Panel link config (JSON excerpt):**
```json
"links": [
  {
    "title": "Service Detail",
    "url": "/d/abc123/service-detail?var-service=${__field.labels.service}",
    "targetBlank": false
  }
]
```

`${__field.labels.service}` uses Grafana's data link variables to pass the series label into the target URL.

### Dashboard JSON Model
Every Grafana dashboard is stored as a JSON document. Understanding the model lets you diff dashboards, review changes in Git, and automate creation.

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
        "query": "label_values(kube_pod_info, namespace)"
      }
    ]
  },
  "panels": [
    {
      "type": "timeseries",
      "title": "Request Rate",
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "targets": [
        {
          "expr": "rate(http_requests_total[5m])",
          "legendFormat": "{{job}}"
        }
      ]
    }
  ]
}
```

Key fields: `uid` is the stable identifier used in provisioning and URLs. `gridPos` positions panels on a 24-column grid.

### Provisioning Dashboards as Code
Grafana supports loading dashboards from files on disk, bypassing the UI. This is how dashboards are managed in GitOps workflows — store JSON in a repo, apply via Helm/Ansible/CI.

**Provisioning config** (`/etc/grafana/provisioning/dashboards/default.yaml`):
```yaml
apiVersion: 1

providers:
  - name: default
    folder: DevOps
    type: file
    disableDeletion: true
    updateIntervalSeconds: 60
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: true
```

Place dashboard JSON files under `/var/lib/grafana/dashboards/`. Grafana polls the directory every `updateIntervalSeconds`. `disableDeletion: true` prevents UI-side deletes from removing provisioned dashboards — changes must go through the file system.

**Provisioning with Helm (Grafana chart):**
```yaml
# values.yaml
dashboards:
  default:
    service-overview:
      json: |
        { ... dashboard JSON ... }
```

Or reference a ConfigMap:
```yaml
dashboardsConfigMaps:
  default: grafana-dashboards-configmap
```

## Examples

**Full workflow — create a CPU dashboard provisioned via file:**

1. Export an existing dashboard from the Grafana UI: `Share → Export → Save to file`.
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

## Exercises

1. Create a dashboard with a **Stat** panel showing the current error rate for a service, and a **Time series** panel showing the last 24h of that same metric side-by-side. Set the Stat panel to turn red when the error rate exceeds 5%.
2. Add a **namespace** query variable populated from `label_values(kube_pod_info, namespace)` and wire it into both panel queries. Verify the dropdown filters data correctly when switching namespaces.
3. Export your dashboard as JSON, commit it to a Git repo, write a Grafana provisioning YAML config to load it from disk, and confirm Grafana picks it up without a UI save.

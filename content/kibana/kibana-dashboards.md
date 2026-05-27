---
title: Dashboards & Visualizations
module: kibana
duration_min: 20
difficulty: intermediate
tags: [kibana, dashboards, lens, visualizations, elk]
exercises: 3
---

## Overview

Kibana dashboards are the operational display layer for your ELK stack — the place your team watches during deploys, incidents, and capacity reviews. A dashboard that surfaces the right signal in the right format during a 3am incident is genuinely valuable; one that looks polished but uses misleading aggregations or wrong visualization types will get ignored or, worse, cause wrong decisions. This lesson treats dashboards as engineering artifacts: they have correct and incorrect designs, and the difference matters in production.

Kibana's visualization system is built directly on top of Elasticsearch aggregations. Every panel on a dashboard is a query. When you drag a field onto the Lens canvas, you are configuring a bucket or metric aggregation that runs against your Elasticsearch index. Understanding this connection is what separates engineers who build accurate dashboards from those who accidentally display meaningless numbers — like averaging percentiles, or using a Terms aggregation when a Date histogram is needed.

In the broader DevOps toolchain, Kibana dashboards sit at the observability presentation layer alongside Grafana (which typically fronts Prometheus/Loki). Kibana's strength is log-centric workflows: correlating structured log fields, drilling from a high-level error rate chart into the raw log events that caused it, and filtering by arbitrary field combinations without writing queries manually. It complements but does not replace a metrics-focused tool like Grafana. Many teams run both.

---

## Concepts

### Lens Editor

Lens is Kibana's primary visualization builder, replacing the older Visualize editor (still present but deprecated in most distributions). Lens uses a drag-and-drop interface and infers appropriate visualization types as you add fields, reducing configuration friction while still exposing full aggregation control when you need it.

**Opening Lens:**
- From a dashboard: **Edit mode → Create visualization**
- Standalone: **Visualize Library → Create visualization → Lens**

**Core Lens interface elements:**

| Element | What it does |
|---|---|
| **Data view selector** | Chooses the index pattern (e.g., `logs-*`, `metrics-*`) for the current layer |
| **Horizontal / Vertical axis** | Drag fields here to set bucket (X) and metric (Y) aggregations |
| **Breakdown** | Splits a series — adds a Terms aggregation coloring lines or bars by field value |
| **Layer panel** | Each layer is an independent query; multiple layers share one chart canvas |
| **Formula bar** | Arbitrary math over aggregations: `count()`, `sum(bytes)`, `percentile(latency, percentile=95)` |
| **Suggestions strip** | Lens auto-proposes alternative chart types; click to switch without losing config |

**Layers in practice:** Add a second layer to overlay two metrics — for example, one layer showing total request count as a bar, a second layer showing p95 latency as a line with its own Y axis on the right. Each layer can use a different data view, enabling cross-index comparisons on one panel.

**Formula examples:**

```
# Error rate as a percentage
count(kql='http.response.status_code >= 500') / count() * 100

# Rolling 5-period moving average of request count
moving_average(count(), window=5)

# Cumulative sum of bytes transferred
cumulative_sum(sum(http.response.body.bytes))

# Difference between current and previous interval (delta)
differences(sum(bytes))
```

**Gotcha:** The formula `average(percentile(response_time_ms, percentile=95))` is mathematically invalid — you cannot average percentiles across buckets and get a meaningful result. Use `percentile(response_time_ms, percentile=95)` as a metric aggregation directly on the date histogram bucket, which computes p95 within each time interval correctly.

---

### Visualization Types

Choosing the wrong chart type for the data shape is a common mistake. Use this reference when building panels.

| Type | Best for | Avoid when |
|---|---|---|
| **Line** | Time series trends: rates, latencies, error counts over time | Comparing across categories with no time axis |
| **Bar (vertical)** | Comparing values across a small number of categories | More than ~15 categories (use Data Table instead) |
| **Horizontal Bar** | Same as bar but with long category labels that would overlap | — |
| **Area** | Stacked composition over time (e.g., traffic by service summing to total) | Overlapping non-stacked series (becomes unreadable) |
| **Pie / Donut** | Proportional breakdown, ≤ 6 slices | More than 6–7 categories; time series data |
| **Metric** | Single KPI number with optional color threshold | When trend context matters — use a line instead |
| **Data Table** | Multi-metric breakdown per category (top-N analysis) | When a chart would communicate the pattern faster |
| **Heatmap** | Frequency over two dimensions (hour of day vs. day of week) | Sparse data — empty cells dominate |
| **Maps** | Geographic distribution of IPs, latency by region | Non-geographic categorical data |
| **TSVB** | Legacy time-series builder; use Lens instead for new panels | — |

**Pie chart warning:** Pie charts are visually compelling but cognitively difficult — humans cannot accurately compare angles. For operational dashboards, a horizontal bar chart almost always communicates proportions more accurately. Reserve pie/donut for executive summaries or when the proportional relationship (e.g., 95% success vs. 5% error) is the entire story.

---

### Aggregations in Visualizations

Every Kibana visualization runs one or more Elasticsearch aggregations. Knowing which aggregation maps to which analytical question makes you faster and more accurate.

**Metric aggregations** compute a single value per bucket (used on the Y axis / value field):

| Aggregation | ES equivalent | Use case | Gotcha |
|---|---|---|---|
| Count | `value_count` | Event volume, request rate | Counts documents, not field occurrences |
| Sum | `sum` | Total bytes, total errors | Field must be numeric |
| Average | `avg` | Mean response time | Sensitive to outliers; prefer percentiles for latency |
| Median | `percentile` at p50 | Central tendency, robust to outliers | — |
| Percentile (p95, p99) | `percentiles` | Latency SLOs, tail behavior | Not aggregatable across sub-buckets — compute at the correct level |
| Max / Min | `max` / `min` | Peak CPU, minimum availability | — |
| Unique count | `cardinality` | Distinct users, unique error types | Approximate (HyperLogLog) — has error rate at high cardinality |
| Rate | `rate` | Per-second/per-minute rate from counters | Only works on `aggregate_metric_double` or inside TSVB |

**Bucket aggregations** divide documents into groups (used on X axis / breakdown):

| Aggregation | Use case | Key setting |
|---|---|---|
| Date histogram | Time series — always use this for time-based X axis | Interval: auto, 1m, 5m, 1h, 1d |
| Terms | Top N values of a keyword field | Size (default 10), order by metric |
| Filters | Arbitrary KQL buckets (e.g., INFO vs WARN vs ERROR) | Define each bucket with a KQL expression |
| Range | Fixed numeric buckets (0–100ms, 100–500ms, 500ms+) | Define ranges manually |
| Histogram | Auto-binned numeric distribution | Interval (e.g., every 50ms) |
| Date range | Compare two explicit time windows | Define each window as a date expression |

**Gotcha — Terms aggregation and "Other":** When using Terms with size=10, Elasticsearch returns only the top 10 values. If you sum a metric across these, the total will not match the actual total — the remaining values are excluded or shown as "Other." This is especially misleading for error rate calculations. Use a Filters aggregation with explicit known values when completeness matters.

**Gotcha — Date histogram interval and data sparsity:** Setting a 1-minute interval on a 30-day time range generates 43,200 buckets. Kibana will render this but it will be slow and visually useless. Let Kibana's `auto` interval choose, or set an interval proportional to the time window: 1m for last hour, 5m for last 6h, 1h for last 7d.

---

### Dashboard Filters and Drilldowns

Filters are what transform a static chart into an interactive investigative tool. Every filter applied to a dashboard is appended as an additional `must` clause to the Elasticsearch query for every panel.

#### Global Filter Bar

The filter bar sits above all panels. Filters here apply to the entire dashboard:

```
# KQL filter examples in the filter bar
http.response.status_code: 500          # exact value
response_time_ms > 1000                 # range
service.name: checkout AND level: ERROR # compound
NOT kubernetes.namespace: monitoring    # negation
```

**Clicking chart elements adds filters automatically.** Click a bar segment, a pie slice, or a point in a scatter plot — Kibana adds the corresponding filter chip. This is the primary investigative workflow: start with a high-level error spike, click the service responsible, all panels scope to that service, then click the endpoint with the highest error rate, and so on until you're looking at raw log lines.

**Filter actions:**

| Action | How |
|---|---|
| Pin filter | Click pin icon — persists across dashboard navigation |
| Negate | Click the NOT toggle — inverts the filter condition |
| Temporarily disable | Click the toggle — removes from query without deleting |
| Edit | Click filter chip → edit — modify KQL or field/value |

#### Time Range

The global time picker is itself a filter. All panels share it. Override it per-panel via **Panel menu → Customize time range** — useful for a "previous period" comparison panel on the same dashboard.

#### Drilldowns

Drilldowns configure navigation that fires when a user clicks a chart element, passing context as filters to the destination.

**Dashboard-to-dashboard drilldown:**

```
Setup path:
Edit mode → click panel → panel menu (⋮) → Create drilldown →
"Go to dashboard" → select target dashboard →
configure field mappings (which fields carry through as filters)
```

Example: "Errors by Service" panel → drilldown → "Service Detail" dashboard, with `service.name` passed as a filter. The engineer clicking a bar for `checkout-service` lands on the Service Detail dashboard already filtered to checkout-service.

**URL drilldown:**

```
Template syntax:
https://jira.company.com/issues?jql=project={{kibana context.panel.filters.[service.name]}}

https://runbooks.internal/services/{{kibana context.panel.filters.[service.name]}}/incidents
```

**Gotcha:** Drilldowns are stored inside the dashboard saved object. When you export a dashboard, drilldowns export with it, but the target dashboard ID is hardcoded. If you import into a different Kibana instance where the target dashboard has a different ID, drilldowns break silently — the click does nothing. Verify drilldowns after cross-environment imports.

---

### Controls: Dropdown and Range Slider

Controls add user-facing widgets above the dashboard panels without requiring the user to understand KQL. They are appropriate for dashboards shared with non-engineering stakeholders or on-call engineers who need fast filtering.

| Control type | Field type | Use case |
|---|---|---|
| **Options list** | `keyword` | Environment (prod/staging/dev), service name, region, log level |
| **Range slider** | `integer` / `float` | Response time range, HTTP status code range, error count threshold |

**Adding controls:**
```
Dashboard edit mode → Controls (toolbar) → Add control →
select field → configure label and defaults → Save and close
```

**Multi-select:** Options list supports selecting multiple values simultaneously (e.g., show both `production` AND `canary` environments). The resulting filter uses an `OR` condition across selected values.

**Chained controls:** Controls can be chained so that selecting a value in one control filters the options available in the next. Example: selecting `region: us-east-1` in the first control causes the service dropdown to show only services deployed in us-east-1. Enable this in the control settings panel.

**Gotcha:** Controls use `terms` aggregations against Elasticsearch to populate their option lists. If your index has millions of documents but only 5 distinct values for `environment`, this is fast. If you accidentally add a control on a high-cardinality field like `user.id`, the dropdown will time out or return incomplete results. Controls are only appropriate for low-cardinality keyword fields.

---

### Dashboard Layout and Design Principles

Panel layout is controlled by drag-and-drop resize handles in edit mode. Panels snap to a grid. Effective layout follows a visual hierarchy matching the engineer's investigative flow.

**Recommended layout pattern for service dashboards:**

```
Row 1 — KPIs (Metric panels, small, side by side)
  [Total Requests / 1h]  [Error Rate %]  [p95 Latency ms]  [Apdex Score]

Row 2 — Time series (Line panels, full width or split)
  [Request Rate over time — by service]  |  [Error Rate over time — by service]

Row 3 — Breakdown (Bar + Data Table)
  [Top 10 Endpoints by Error Count]  |  [Status Code Distribution by Service]

Row 4 — Raw evidence
  [Discover panel: recent ERROR events — timestamp, service, url, message]
```

**Text/Markdown panels:** Add context panels with `# Row Header` or operational notes inline. Use Dashboard edit mode → Add panel → Text.

**Panel titles:** Always set a descriptive title including the metric name, aggregation, and scope. "Count" is a bad title. "HTTP 5xx Count by Service — Last 1h" is correct.

---

### Dashboard Export / Import and GitOps

Dashboards, visualizations, index patterns (data views), and controls are stored as **saved objects** in Kibana's `.kibana` system index in Elasticsearch. Export/import handles the full object graph including dependencies.

**Manual export via UI:**
```
Stack Management → Saved Objects → filter Type: Dashboard →
select target dashboards → Export → download NDJSON file
```

The `includeReferencesDeep: true` flag (set automatically in UI export) pulls in all referenced visualizations, data views, and lens panels. The result is a single `.ndjson` file that is fully self-contained.

**Import via UI:**
```
Stack Management → Saved Objects → Import →
upload NDJSON → choose conflict resolution:
  - "Overwrite" — replaces existing objects with same ID
  - "Create new copies" — generates new IDs (breaks drilldown links)
```

**API-based import for CI/CD pipelines:**

```bash
# Import with overwrite — idempotent, safe to re-run in pipelines
curl -X POST "http://kibana:5601/api/saved_objects/_import?overwrite=true" \
  -H "kbn-xsrf: true" \
  -H "Content-Type: multipart/form-data" \
  --form file=@dashboards/service-overview.ndjson

# Export all dashboards programmatically
curl -X POST "http://kibana:5601/api/saved_objects/_export" \
  -H "kbn-xsrf: true" \
  -H "Content-Type: application/json" \
  -d '{
    "type": ["dashboard"],
    "includeReferencesDeep": true,
    "excludeExportDetails": false
  }' \
  -o all-dashboards.ndjson

# Find IDs of all dashboards (for selective export)
curl -s "http://kibana:5601/api/saved_objects/_find?type=dashboard&per_page=100" \
  -H "kbn-xsrf: true" \
  | jq -r '.saved_objects[] | "\(.id)\t\(.attributes.title)"'
```

**GitOps workflow:**

```bash
# In your infrastructure repository
dashboards/
  nginx-overview.ndjson
  service-detail.ndjson
  kubernetes-cluster.ndjson
  Makefile

# Makefile target for promotion
deploy-dashboards:
  curl -X POST "$(KIBANA_URL)/api/saved_objects/_import?overwrite=true" \
    -H "kbn-xsrf: true" \
    -H "Content-Type: multipart/form-data" \
    --form file=@dashboards/$(DASHBOARD).ndjson \
    -u "$(KIBANA_USER):$(KIBANA_PASS)"
```

**Data
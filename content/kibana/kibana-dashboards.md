---
title: Dashboards & Visualizations
module: kibana
duration_min: 20
difficulty: intermediate
tags: [kibana, dashboards, lens, visualizations, elk]
exercises: 3
---

## Overview
Kibana dashboards are the operational display layer for your ELK stack — the place your team watches during deploys, incidents, and capacity reviews. Knowing how to build them correctly means building dashboards that are actually useful rather than pretty but misleading. This lesson covers the Lens editor, the visualization types that matter in DevOps, how aggregations work, and how to wire up dashboards with filters and drilldowns for real investigative workflows.

## Concepts

### Lens Editor
Lens is Kibana's primary visualization builder (replacing the older Visualize editor). It uses a drag-and-drop interface and auto-suggests visualization types based on the fields you add.

Opening Lens: **Dashboards → Create dashboard → Create visualization** OR **Visualize Library → Create visualization → Lens**

Key Lens concepts:
- **Horizontal axis / Vertical axis / Breakdown**: the three positions you assign fields or metrics to.
- **Layer**: a single data series. Lens supports multiple layers on the same chart (e.g., two metrics on one line chart).
- **Formula bar**: for computed metrics like `count() / count(kql='level: ERROR')` or `moving_average(count(), window=5)`.
- **Data view**: each layer uses one data view.

### Visualization Types

#### Bar / Horizontal Bar
Best for: comparing values across categories (error counts by service, requests by HTTP method).

```
X axis: service.name (top 10 by count, keyword field)
Y axis: Count of records
Breakdown: http.response.status_code (top 5)
```

#### Line
Best for: time series trends (request rate, error rate, response time p95 over time).

```
X axis: @timestamp (date histogram, interval: auto)
Y axis: Median of response_time_ms
```

#### Pie / Donut
Best for: proportional breakdown with few categories (log level distribution, HTTP method split). Avoid for > 6–7 slices.

#### Metric
Best for: single key number on a dashboard (total errors in 24h, current p99 latency, uptime %). Supports conditional colouring (green < 200 ms, red > 500 ms).

#### Data Table
Best for: detailed breakdown with multiple metrics per row. Ideal for top-N analysis:

| service.name | Count | Error rate | Avg response ms |
|---|---|---|---|
| checkout | 45,312 | 2.1% | 142 |
| auth | 18,904 | 0.3% | 38 |

#### Maps
Best for: geographic data — source IPs on a world map, regional latency heatmap. Requires `geo_point` typed fields in Elasticsearch.

### Aggregations in Visualizations
Kibana visualizations are built on Elasticsearch aggregations. Knowing the aggregation types makes you faster at building correct charts.

**Metric aggregations (Y axis / value):**

| Aggregation | Use case |
|---|---|
| Count | Event volume |
| Sum | Total bytes transferred, total error count |
| Average / Median | Response time, latency |
| Max / Min | Peak CPU, minimum uptime |
| Percentile (p50, p95, p99) | Latency distribution |
| Unique count (cardinality) | Distinct users, unique IPs |

**Bucket aggregations (X axis / breakdown):**

| Aggregation | Use case |
|---|---|
| Date histogram | Time series (always use for time-based X axis) |
| Terms | Top N values of a keyword field |
| Filters | Bucket events matching KQL expressions |
| Range | Numeric ranges (0–100 ms, 100–500 ms, 500+ ms) |
| Histogram | Numeric distribution with fixed interval |

### Dashboard Filters and Drilldowns

#### Filter bar
Every dashboard has a persistent filter bar. Clicking a value in any panel adds a filter chip that applies across all panels on the dashboard. This is what makes dashboards interactive — you can click a service name in one chart and all other charts instantly scope to that service.

Filter types:
- **KQL filter**: `service.name: checkout-service`
- **Time range**: refined from the global time picker
- **Panel filter**: applied to a single panel via its panel menu

Pin a filter to keep it across navigation. Negate a filter (the NOT toggle) to exclude a value.

#### Drilldowns
**Drilldowns** let you navigate from one dashboard to another, or to Discover, when clicking a chart element.

**Dashboard-to-dashboard drilldown**: clicking a bar in "Errors by service" opens the "Service Detail" dashboard, pre-filtered to that service.

Configure: Edit mode → click panel → panel menu → **Create drilldown → Go to dashboard**. Map which filter fields pass through.

**URL drilldown**: navigate to an external URL, interpolating field values. Useful for linking to your service's runbook or Jira project.

### Controls: Dropdown and Range Slider
**Controls** (formerly known as Input Controls) add interactive widgets to dashboards that users can change without editing the dashboard:

- **Options list (dropdown)**: select one or more values from a keyword field (e.g., select environment: production/staging).
- **Range slider**: numeric range selector (e.g., filter response_time_ms between 0 and 5000).

Add controls: **Dashboard edit mode → Controls → Add control**

Controls integrate with the filter bar — selecting a value adds the equivalent filter to all panels.

### Dashboard Export / Import
Dashboards, their visualizations, and data views are stored as saved objects. Export/import is used for:
- Promoting dashboards from dev → staging → production environments.
- Sharing dashboards with teams on other Kibana instances.
- Version controlling dashboards as JSON files.

**Export**: Stack Management → Saved Objects → filter to Dashboards → select → Export (includes all dependencies).

**Import**: Stack Management → Saved Objects → Import → upload NDJSON file → choose conflict resolution (overwrite or create new).

For GitOps workflows, export dashboards as JSON and commit them to a repository. Use the Kibana API for automated import:

```bash
curl -X POST "http://kibana:5601/api/saved_objects/_import?overwrite=true" \
  -H "kbn-xsrf: true" \
  -H "Content-Type: multipart/form-data" \
  --form file=@dashboards/nginx-overview.ndjson
```

## Examples

### Building an HTTP error rate dashboard panel (Lens)

Goal: line chart showing error rate (5xx / total) over time for each service.

1. Open Lens, select data view `logs-*`.
2. Set chart type: **Line**.
3. Horizontal axis: `@timestamp` → Date histogram, interval: 5 minutes.
4. Vertical axis: Click **+ Add layer** → formula:
   ```
   count(kql='http.response.status_code >= 500') / count() * 100
   ```
5. Breakdown: `service.name` → Terms, top 5.
6. Set Y axis label: "5xx Error Rate (%)".
7. Save to library as "HTTP 5xx Error Rate by Service".

### Dashboard layout for a web service

```
Row 1: [Metric: Total Requests] [Metric: Error Rate] [Metric: p95 Latency]
Row 2: [Line: Request Rate over time] [Line: Error Rate over time]
Row 3: [Bar: Top 10 Endpoints by Request Count] [Data Table: Status Code Breakdown by Service]
Row 4: [Discover panel: Recent 5xx events with timestamp, service, url, error_message]
```

Controls at top: Environment dropdown (production/staging), Service dropdown.

### Exporting all dashboards via API

```bash
# List all dashboard saved object IDs
curl -s "http://kibana:5601/api/saved_objects/_find?type=dashboard&per_page=100" \
  -H "kbn-xsrf: true" | jq '.saved_objects[].id'

# Export a specific dashboard with all dependencies
curl -s "http://kibana:5601/api/saved_objects/_export" \
  -H "kbn-xsrf: true" \
  -H "Content-Type: application/json" \
  -d '{"type": "dashboard", "includeReferencesDeep": true}' \
  > all-dashboards.ndjson
```

## Exercises

1. Design a Kibana dashboard for an on-call engineer monitoring an e-commerce API. Specify: (a) at least 5 panels with their visualization type, field, and aggregation; (b) two controls (dropdown or range slider) that filter the whole dashboard; (c) one drilldown and where it navigates to.

2. You have response time data in Elasticsearch with a field `response_time_ms` (integer). Write the Lens formula and aggregation configuration to show a line chart with three series on one chart: p50, p95, and p99 response time over time broken down by `service.name`. Explain why percentile aggregations are more useful than averages for latency monitoring.

3. Your team wants to promote a set of dashboards from a staging Kibana instance to production. Describe the full process using Kibana Saved Objects, including how you would handle a case where a data view name differs between environments (staging uses `logs-staging-*`, production uses `logs-prod-*`).

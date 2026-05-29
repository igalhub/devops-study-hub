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

**Gotcha:** Lens saves to the **Visualize Library** only if you explicitly click "Save to library." If you just click "Save and return" from within a dashboard, the panel is embedded directly in the dashboard as an inline panel and is not reusable across other dashboards. Use library saves for any panel you expect to reuse.

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
| **TSVB** | Legacy time-series builder; use Lens instead for new panels | All new dashboards |
| **Gauge / Goal** | Single value shown against a target or threshold | When exact value matters more than proximity to target |

**Pie chart warning:** Pie charts are visually compelling but cognitively difficult — humans cannot accurately compare angles. For operational dashboards, a horizontal bar chart almost always communicates proportions more accurately. Reserve pie/donut for executive summaries or when the proportional relationship (e.g., 95% success vs. 5% error) is the entire story.

**Metric panel thresholds:** Metric panels support color bands. Configure them to turn red at >1% error rate or >500ms p95 latency. This makes the panel act as a status indicator — a glance at row 1 tells the on-call engineer whether anything needs attention before reading charts.

```
Lens Metric panel → Appearance → Color by value:
  Green:  0 – 0.5
  Yellow: 0.5 – 1.0
  Red:    1.0 – ∞
```

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
| Unique count | `cardinality` | Distinct users, unique error types | Approximate (HyperLogLog) — error rate increases at high cardinality |
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

**Gotcha — Terms aggregation and "Other":** When using Terms with size=10, Elasticsearch returns only the top 10 values. If you sum a metric across these, the total will not match the actual total — the remaining values are excluded or shown as "Other." This is especially misleading for error rate calculations. Use a Filters aggregation with explicit known values when completeness matters, or increase the Terms size and accept the performance cost.

**Gotcha — Date histogram interval and data sparsity:** Setting a 1-minute interval on a 30-day time range generates 43,200 buckets. Kibana will render this but it will be slow and visually useless. Let Kibana's `auto` interval choose, or set an interval proportional to the time window: 1m for last hour, 5m for last 6h, 1h for last 7d.

**Gotcha — Cardinality approximation:** `Unique count` uses the HyperLogLog++ algorithm. It is accurate to within ~0.8% for most cardinalities, but if you are using unique counts for billing or compliance reporting, document this approximation. For exact counts you need a scripted `terms` aggregation with small size or a pre-aggregated approach, both of which are significantly more expensive.

---

### Dashboard Filters and Drilldowns

Filters transform a static chart into an interactive investigative tool. Every filter applied to a dashboard is appended as an additional `must` clause to the Elasticsearch query for every panel on that dashboard.

#### Global Filter Bar

The filter bar sits above all panels. Filters here apply to the entire dashboard:

```
# KQL filter examples in the filter bar
http.response.status_code: 500            # exact value
response_time_ms > 1000                   # range
service.name: checkout AND level: ERROR   # compound
NOT kubernetes.namespace: monitoring      # negation
service.name: (checkout OR payment)       # multi-value OR
```

**Clicking chart elements adds filters automatically.** Click a bar segment, a pie slice, or a point in a scatter plot — Kibana adds the corresponding filter chip. This is the primary investigative workflow: start with a high-level error spike → click the service responsible → all panels scope to that service → click the endpoint with the highest error rate → drill into raw log lines. This workflow requires no KQL knowledge from the on-call engineer.

**Filter actions:**

| Action | How |
|---|---|
| Pin filter | Click pin icon — persists across dashboard navigation |
| Negate | Click the NOT toggle — inverts the filter condition |
| Temporarily disable | Click the toggle — removes from query without deleting |
| Edit | Click filter chip → edit — modify KQL or field/value |

#### Time Range

The global time picker is itself a filter. All panels share it. Override it per-panel via **Panel menu → Customize time range** — useful for a "previous period" comparison panel on the same dashboard. A common pattern is placing two identical error-rate line charts side by side: one showing the current window, one with a custom 24h-earlier window, so the on-call engineer can compare today's traffic shape to yesterday's at a glance.

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
# Open Jira filtered to the affected service
https://jira.company.com/issues?jql=project={{kibana context.panel.filters.[service.name]}}

# Open internal runbook for the service
https://runbooks.internal/services/{{kibana context.panel.filters.[service.name]}}/incidents

# Open Grafana with matching time range
https://grafana.internal/d/abc123?var-service={{kibana context.panel.filters.[service.name]}}&from={{kibana context.rangeFrom}}&to={{kibana context.rangeTo}}
```

**Gotcha:** Drilldowns are stored inside the dashboard saved object. When you export a dashboard, drilldowns export with it, but the target dashboard ID is hardcoded. If you import into a different Kibana instance where the target dashboard has a different ID, drilldowns break silently — the click does nothing. Verify drilldowns after cross-environment imports, and consider using URL drilldowns to external systems where possible since URLs are portable.

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

**Chained controls:** Controls can be chained so that selecting a value in one control filters the options available in the next. Example: selecting `region: us-east-1` in the first control causes the service dropdown to show only services deployed in us-east-1. Enable chaining in the control settings panel under **Chaining**.

**Gotcha:** Controls use `terms` aggregations against Elasticsearch to populate their option lists. If your index has millions of documents but only 5 distinct values for `environment`, this is fast. If you accidentally add a control on a high-cardinality field like `user.id`, the dropdown will time out or return incomplete results. Controls are only appropriate for low-cardinality keyword fields (rule of thumb: fewer than ~1,000 distinct values).

---

### Dashboard Layout and Design Principles

Panel layout is controlled by drag-and-drop resize handles in edit mode. Panels snap to a grid. Effective layout follows a visual hierarchy matching the engineer's investigative flow — from summary to detail, top to bottom.

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

This layout encodes the incident investigation workflow: Row 1 tells you *whether* something is wrong; Row 2 tells you *when* it started; Row 3 tells you *what* is affected; Row 4 gives you evidence to diagnose *why*.

**Text and Markdown panels:** Add section headers and operational notes inline. In edit mode: **Add panel → Text**. Supports Markdown.

```markdown
## Service Health — Production
_Last updated: auto-refreshes every 30s_

**On-call runbook:** https://runbooks.internal/sre/incident-response
**Alert routing:** PagerDuty → #ops-alerts → on-call engineer
```

**Panel titles:** Always set a descriptive title including the metric name, aggregation, and scope. "Count" is a bad title. "HTTP 5xx Count by Service — Last 1h" is correct. Titles render in exported PDFs and appear in drilldown breadcrumbs.

**Auto-refresh:** Set via the time picker → **Refresh every**. For NOC/TV dashboards, 30s is typical. For interactive investigation, leave off (manual refresh avoids losing your filter state mid-investigation).

**Gotcha — Panel query load:** Every panel on a dashboard fires an independent Elasticsearch query when the dashboard loads or refreshes. A dashboard with 20 panels at 30s auto-refresh generates 20 queries every 30 seconds. On busy clusters, large dashboards with many high-cardinality breakdowns can cause noticeable query pressure. Audit slow panels via **Inspect → Request** on each panel to see the raw ES query and response time.

---

### Dashboard Export / Import and GitOps

Dashboards, visualizations, index patterns (data views), and controls are stored as **saved objects** in Kibana's `.kibana` system index in Elasticsearch. Export/import handles the full object graph including dependencies.

**Manual export via UI:**
```
Stack Management → Saved Objects → filter Type: Dashboard →
select target dashboards → Export → download NDJSON file
```

The `includeReferencesDeep: true` flag (set automatically in UI export) pulls in all referenced visualizations, data views, and lens panels. The result is a single `.ndjson` file that is fully self-contained and importable into any compatible Kibana instance.

**Import via UI:**
```
Stack Management → Saved Objects → Import →
upload NDJSON → choose conflict resolution:
  - "Overwrite" — replaces existing objects with same ID (idempotent)
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

# Find IDs and titles of all dashboards (for selective export)
curl -s "http://kibana:5601/api/saved_objects/_find?type=dashboard&per_page=100" \
  -H "kbn-xsrf: true" \
  | jq -r '.saved_objects[] | "\(.id)\t\(.attributes.title)"'

# Export a single dashboard by ID
curl -X POST "http://kibana:5601/api/saved_objects/_export" \
  -H "kbn-xsrf: true" \
  -H "Content-Type: application/json" \
  -d '{
    "objects": [{"type": "dashboard", "id": "abc-123-def"}],
    "includeReferencesDeep": true
  }' \
  -o dashboards/service-overview.ndjson
```

**GitOps workflow:**

```
infrastructure-repo/
  kibana/
    dashboards/
      nginx-overview.ndjson
      service-detail.ndjson
      kubernetes-cluster.ndjson
    Makefile
    .github/
      workflows/
        deploy-dashboards.yml
```

```makefile
# Makefile
KIBANA_URL ?= http://kibana:5601

deploy-dashboards:
	@for f in kibana/dashboards/*.ndjson; do \
	  echo "Deploying $$f ..."; \
	  curl -sf -X POST "$(KIBANA_URL)/api/saved_objects/_import?overwrite=true" \
	    -H "kbn-xsrf: true" \
	    -H "Content-Type: multipart/form-data" \
	    --form file=@$$f \
	    -u "$(KIBANA_USER):$(KIBANA_PASS)" \
	    | jq '.success'; \
	done

export-dashboards:
	curl -sf -X POST "$(KIBANA_URL)/api/saved_objects/_export" \
	  -H "kbn-xsrf: true" \
	  -H "Content-Type: application/json" \
	  -d '{"type":["dashboard"],"includeReferencesDeep":true}' \
	  -u "$(KIBANA_USER):$(KIBANA_PASS)" \
	  -o kibana/dashboards/all-dashboards.ndjson
```

```yaml
# .github/workflows/deploy-dashboards.yml
name: Deploy Kibana Dashboards

on:
  push:
    branches: [main]
    paths:
      - 'kibana/dashboards/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy dashboards to production Kibana
        env:
          KIBANA_URL: ${{ secrets.KIBANA_PROD_URL }}
          KIBANA_USER: ${{ secrets.KIBANA_USER }}
          KIBANA_PASS: ${{ secrets.KIBANA_PASS }}
        run: make deploy-dashboards
```

**Gotcha:** NDJSON files exported from Kibana 8.x are not directly importable into Kibana 7.x. The saved object format changed significantly at the 8.0 boundary. Pin your Kibana version in CI to avoid discovering this during an incident-driven restore.

**Gotcha:** If your dashboard references an index pattern (data view) that does not exist on the target cluster, the import will succeed but all panels will render empty with a "Could not find data view" error. Always ensure the data view (e.g., `logs-*`) is created on the target before importing dashboards. You can include the data view in the same NDJSON by exporting it via Saved Objects alongside the dashboard.

---

## Examples

### Example 1: HTTP Error Rate Dashboard Panel

**Scenario:** Build a line chart showing HTTP 5xx error rate (as a percentage of total requests) broken down by `service.name`, for the last 6 hours, updating every 30 seconds.

**Setup — ensure your index has the required fields:**
```
Index: logs-*
Required fields:
  @timestamp           (date)
  http.response.status_code  (integer or keyword)
  service.name         (keyword)
```

**Action — Lens configuration:**
```
1. Open dashboard → Edit → Create visualization → Lens

2. Data view: logs-*

3. Chart type: Line

4. X axis: @timestamp
   - Aggregation: Date histogram
   - Interval: Auto (or 5m for 6h window)

5. Y axis: Formula
   count(kql='http.response.status_code >= 500') / count() * 100
   - Label: "Error Rate %"
   - Format: Percentage, 2 decimal places

6. Breakdown: service.name
   - Aggregation: Top values
   - Size: 10
   - Order by: Error Rate % (the Y metric)

7. Panel title: "HTTP 5xx Error Rate by Service — %"

8. Save to library as "http-5xx-error-rate-by-service"
```

**Verify it worked:**
```bash
# Check the underlying ES query via Kibana Inspect
# Panel menu (⋮) → Inspect → Request tab
# You should see a multi-bucket aggregation:
# aggs.breakdown (terms on service.name)
#   → aggs.time (date_histogram on @timestamp)
#     → aggs.error_count (filter: status >= 500) + aggs.total_count

# Manually verify against raw data
curl -s "http://elasticsearch:9200/logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "size": 0,
    "query": {
      "range": {"@timestamp": {"gte": "now-6h"}}
    },
    "aggs": {
      "by_service": {
        "terms": {"field": "service.name", "size": 10},
        "aggs": {
          "errors": {"filter": {"range": {"http.response.status_code": {"gte": 500}}}},
          "total": {"value_count": {"field": "@timestamp"}}
        }
      }
    }
  }' | jq '.aggregations.by_service.buckets[] | {service: .key, error_rate: (.errors.doc_count / .doc_count * 100)}'
```

---

### Example 2: Latency Distribution Heatmap

**Scenario:** Build a heatmap showing request latency distribution across hours of the day vs. day of week, to identify when tail latency is worst (capacity planning use case).

**Setup:**
```
Index: logs-*
Required fields:
  @timestamp              (date)
  http.response_time_ms   (integer)
```

**Action — Lens configuration:**
```
1. Chart type: Heatmap

2. X axis: @timestamp
   - Aggregation: Date histogram
   - Minimum interval: 1 hour
   - (Over a 4-week time range, this gives 24×7 = 168 buckets — readable on a heatmap)

3. Y axis: @timestamp
   - Aggregation: Terms on script field "hour_of_day"
   OR
   - Use runtime field in data view:
     Name: hour_of_day
     Script: emit(doc['@timestamp'].value.getHour())

4. Cell value: percentile(http.response_time_ms, percentile=95)
   - This gives p95 latency per hour-of-day cell

5. Color palette: Temperature (blue=low, red=high)
   - Reverse: off
   - Number of steps: 8

6. Panel title: "p95 Request Latency Heatmap — Hour of Day vs Date"
```

**Action — Create the runtime field via API (if not yet defined):**
```bash
curl -X PUT "http://kibana:5601/api/data_views/data_view/your-data-view-id/runtime_field" \
  -H "kbn-xsrf: true" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hour_of_day",
    "runtimeField": {
      "type": "long",
      "script": {
        "source": "emit(doc['\''@timestamp'\''].value.getHour())"
      }
    }
  }'
```

**Verify:**
```bash
# Check that runtime field is returning expected values
curl -s "http://elasticsearch:9200/logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "size": 3,
    "fields": ["@timestamp", "hour_of_day"],
    "runtime_mappings": {
      "hour_of_day": {
        "type": "long",
        "script": "emit(doc['\''@timestamp'\''].value.getHour())"
      }
    }
  }' | jq '.hits.hits[]._source["@timestamp"], .hits.hits[].fields.hour_of_day'
```

---

### Example 3: GitOps Dashboard Deployment Pipeline

**Scenario:** Export a dashboard from a staging Kibana instance, commit it to Git, and promote it to production via CI.

**Step 1 — Export from staging:**
```bash
# Get dashboard ID
DASH_ID=$(curl -s "http://kibana-staging:5601/api/saved_objects/_find?type=dashboard&search=Service+Overview" \
  -H "kbn-xsrf: true" \
  -u "$KIBANA_USER:$KIBANA_PASS" \
  | jq -r '.saved_objects[0].id')

echo "Dashboard ID: $DASH_ID"

# Export with all dependencies
curl -s -X POST "http://kibana-staging:5601/api/saved_objects/_export" \
  -H "kbn-xsrf: true" \
  -H "Content-Type: application/json" \
  -u "$KIBANA_USER:$KIBANA_PASS" \
  -d "{
    \"objects\": [{\"type\": \"dashboard\", \"id\": \"$DASH_ID\"}],
    \"includeReferencesDeep\": true,
    \"excludeExportDetails\": true
  }" \
  -o kibana/dashboards/service-overview.ndjson

# excludeExportDetails: true removes the trailing export summary line
# which would otherwise cause parse errors on import in some versions
```

**Step 2 — Commit to Git:**
```bash
git add kibana/dashboards/service-overview.ndjson
git diff --cached --stat  # confirm only the expected file changed
git commit -m "feat(dashboards): update service-overview — add p99 latency panel"
git push origin feature/dashboard-update
# Open PR → review → merge to main triggers CI
```

**Step 3 — CI deploys to production (GitHub Actions):**
```yaml
# Triggered on merge to main when dashboards/ changes
- name: Import dashboard to production
  run: |
    RESPONSE=$(curl -sf -X POST "$KIBANA_PROD_URL/api/saved_objects/_import?overwrite=true" \
      -H "kbn-xsrf: true" \
      -H "Content-Type: multipart/form-data" \
      --form file=@kibana/dashboards/service-overview.ndjson \
      -u "$KIBANA_USER:$KIBANA_PASS")

    echo "$RESPONSE" | jq .

    # Fail the pipeline if import was not successful
    echo "$RESPONSE" | jq -e '.success == true'
```

**Verify the deployment:**
```bash
# Confirm the dashboard exists in production with the expected title
curl -s "http://kibana-prod:5601/api/saved_objects/_find?type=dashboard&search=Service+Overview" \
  -H "kbn-xsrf: true" \
  -u "$KIBANA_USER:$KIBANA_PASS" \
  | jq '.saved_objects[] | {id: .id, title: .attributes.title, updated: .updated_at}'
```

---

### Example 4: Controls-Driven Multi-Environment Dashboard

**Scenario:** Build a dashboard with an environment selector (prod/staging/dev) and a service selector that is chained to the environment, so the service list updates based on which environment is selected.

**Setup — add controls via API:**
```bash
# Controls are stored inside the dashboard saved object.
# The fastest path is through the UI, but here is what the control
# configuration looks like inside the NDJSON for reference/automation:

# In the dashboard's panels array, a controls panel looks like:
{
  "type": "controls",
  "panelConfig": {
    "controls": [
      {
        "type": "optionsList",
        "fieldName": "environment",
        "dataViewId": "logs-*-id",
        "title": "Environment",
        "grow": false,
        "width": "small",
        "order": 0
      },
      {
        "type": "optionsList",
        "fieldName": "service.name",
        "dataViewId": "logs-*-id",
        "title": "Service",
        "grow": true,
        "width": "medium",
        "order": 1,
        "chaining": true   # this control filters based on the previous selection
      }
    ],
    "ignoreParentSettings": {
      "ignoreFilters": false,
      "ignoreQuery": false,
      "ignoreTimerange": false
    }
  }
}
```

**UI walkthrough:**
```
1. Dashboard → Edit → Controls → Add control
   - Field: environment (keyword)
   - Label: Environment
   - Multi-select: off (one environment at a time)
   - Default: production

2. Controls → Add control
   - Field: service.name (keyword)
   - Label: Service
   - Enable chaining: ON
   - Multi-select: ON (allow comparing multiple services)

3. Save dashboard

4. Verify: select "staging" in Environment →
   Service dropdown should now show only services
   that appear in logs with environment: staging
```

---

## Exercises

### Exercise 1: Build an Error Rate Panel with Correct Aggregation

Your team uses an ELK stack with logs in `logs-*`. The `http.response.status_code` field is a keyword (not integer) in this environment.

1. In Kibana Lens, build a line chart showing error rate (4xx + 5xx as percentage of total) over time for the last 24 hours broken down by `service.name`. Use the Filters aggregation instead of a range filter to handle the keyword type.
2. Add a second layer showing total request volume as a bar using the right Y axis.
3. Set the Y axis for the error rate line to show 0–100% range with a fixed scale (do not let Kibana auto-scale from the data minimum).
4. Use **Panel menu → Inspect → Request** to view the raw Elasticsearch query. Identify which part of the query corresponds to your error filter and which corresponds to the breakdown.

**What to verify:** The error rate should be a number between 0 and 100. If it shows values above 100 or below 0, your formula has a division error. If all services show identical rates, your breakdown is not being applied.

---

### Exercise 2: Set Up a Dashboard Drilldown Chain

You have two dashboards: "Services Overview" and "Service Detail." The Services Overview has a bar chart showing error count by `service.name`.

1. Add a dashboard-to-dashboard drilldown on the error count bar chart so that clicking a service name navigates to "Service Detail" with `service.name` pre-filtered.
2. On the Service Detail dashboard, add a URL drilldown on the top-errors-by-endpoint panel that opens `https://runbooks.internal/{{context.panel.filters.[service.name]}}/{{context.panel.filters.[http.url.path]}}` in a new tab.
3. Export the Services Overview dashboard as an NDJSON file. Open the file in a text editor and locate the drilldown configuration within the JSON. Identify the hardcoded target dashboard ID.
4. Simulate what happens when this dashboard is imported to a new environment: change the target dashboard ID in the NDJSON to a fake UUID, re-import it, and observe that the drilldown click now silently fails. Document what you would do to fix this in a real multi-environment setup.

**What to verify:** After step 1, clicking a bar should navigate to the detail dashboard with the filter chip for `service.name` already active in the filter bar.

---

### Exercise 3: Export, Modify, and Re-import a Dashboard via API

This exercise simulates a GitOps promotion workflow.

1. Using the Kibana Saved Objects API, find the ID of any dashboard in your environment and export it to a file called `my-dashboard.ndjson`.
2. Open the NDJSON in a text editor or with `jq`. Find the panel with the title containing "Error" (or any panel of your choice). Change its title by editing the `title` field in the JSON directly.
3. Re-import the modified NDJSON using the API with `?overwrite=true`. Confirm the import response shows `"success": true`.
4. Reload the dashboard in the browser and verify the panel title reflects your change.
5. Write a one-line bash command using `jq` that prints the titles of all panels in the exported NDJSON.

```bash
# Hint for step 5 — structure of panels in a dashboard saved object:
jq -r '.attributes.panelsJSON | fromjson[] | .title // "untitled"' my-dashboard.ndjson
# Note: panelsJSON is a JSON-encoded string inside the NDJSON — hence the fromjson pipe
```

**What to verify:** The API import response body should contain `"success": true` and a `successCount` equal to the number of objects in the file. If you see `"errors"`, inspect the `error` field for each failed object — common causes are missing data view references or version incompatibility.

---

### Exercise 4: Audit and Fix a Slow Dashboard

You have been handed a dashboard that "takes forever to load." It has 15 panels and a 30-second auto-refresh.

1. Disable auto-refresh temporarily (time picker → stop auto-refresh). Reload the dashboard and use your browser's Network tab (filter by `_msearch` or `_search`) to identify which panel generates the largest response payload or longest response time.
2. For the slowest panel, open **Panel menu → Inspect → Request** and examine the raw Elasticsearch query. Identify: (a) the aggregation type, (b) the bucket size, and (c) whether the date histogram interval is set to a reasonable value for the current time range.
3. If the panel uses a Terms aggregation with size > 50, reduce it to 10 and measure the response time improvement.
4. If the time range is "Last 90 days" with a "1 minute" date histogram interval, calculate how many buckets that generates. Change the interval to `1d` and verify the panel still conveys the intended trend.
5. Document your findings: which panel was slow, what the root cause was, and what you changed. This is the format of a real performance review you would present to a team.

**What to verify:** After optimization, the dashboard's total load time (observable in the Network tab as the time from first request to last response) should be meaningfully reduced. If it is not, there may be an Elasticsearch cluster resource issue rather than a query design issue — note that distinction.

---

### Quick Checks

6. Count panels in a Kibana dashboard stub. Run: `printf 'panels:\n- title: Requests\n- title: Errors\n- title: Latency\n- title: CPU\n' | grep -c '^- title:'`

```expected_output
4
```

hint: Think about how to count the number of lines that match a specific pattern in the piped output.
hint: Use grep with the -c flag and the pattern '^- title:' to count only lines that start with '- title:'.

7. Extract the auto-refresh interval value from a dashboard config. Run: `printf 'refreshInterval:\n  display: 30 seconds\n  value: 30\n' | awk '/  value:/{print $2}'`

```expected_output
30
```

hint: Think about how you can filter lines in a stream and extract a specific field from matching lines.
hint: Use awk with a pattern like /  value:/ to match the indented value line, then print the second field with print $2.

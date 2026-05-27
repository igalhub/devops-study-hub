---
title: Discover & Search
module: kibana
duration_min: 15
difficulty: beginner
tags: [kibana, discover, kql, search, elk]
exercises: 3
---

## Overview

Kibana Discover is the primary interface for ad-hoc log investigation and exploratory data analysis against Elasticsearch. In a DevOps context it is where you go first during an incident — searching logs, inspecting individual events, and understanding data shape before building dashboards or writing alerts. The difference between an engineer who can triage in 5 minutes and one who takes 30 often comes down to fluency with KQL and comfort navigating Discover's layout. Every second spent hunting for the right query syntax during a production outage is a second your users are experiencing downtime.

Discover is built around two core design principles. First, it is intentionally query-first: every action — filtering by field value, zooming the histogram, clicking a top value in the sidebar — translates into an explicit, visible query or filter chip that you can audit, copy, and share. Nothing is hidden in opaque UI state. Second, it is non-destructive and read-only against your data: all filtering is client-side scoped, so you cannot accidentally modify documents while investigating. This makes Discover safe to use under pressure.

In the broader ELK/Elastic Stack toolchain, Discover sits between data ingestion (Beats, Logstash, Elastic Agent) and visualization (Dashboards, Lens). You use Discover to validate that logs are being ingested correctly, to explore a new data source before you know what fields exist, and to investigate specific incidents by drilling down from a dashboard alert into the raw events. Saved searches from Discover can be embedded directly in dashboards, so the work you do in Discover is reusable.

---

## Concepts

### The Discover Interface

Understanding what each zone of the UI does prevents wasted clicks during an incident.

| Zone | Location | Purpose |
|------|----------|---------|
| Data view selector | Top left | Choose which index pattern / data view to query |
| Search bar | Top centre | KQL or Lucene query input; filter chips appear here |
| Time picker | Top right | Absolute or relative time range; auto-refresh toggle |
| Field list | Left sidebar | All fields in the data view; click to add columns or filter |
| Histogram | Above the table | Event count over time; click-drag to zoom into a sub-range |
| Document table | Centre | Matching events, expandable rows, sortable columns |
| Field statistics tab | Above the table | Per-field breakdown: cardinality, top values, doc coverage |

**Non-obvious behaviour:** the histogram and the document table are always in sync — zooming the histogram by click-dragging updates the time picker and re-runs the query. Conversely, changing the time picker re-renders the histogram. They represent the same query result, not two separate queries.

**Column order matters:** when you add columns from the field list, they appear in the order you added them. During an incident, add `@timestamp` first, then the most discriminating field (e.g., `service.name`), then `level`, then `message`. This gives you the most readable table without horizontal scrolling.

---

### Data Views (Index Patterns)

A **data view** is a Kibana abstraction that maps to one or more Elasticsearch indices via a glob pattern. It tells Kibana which indices to query and which field to treat as the timestamp.

**Creating a data view:**
Navigate to **Stack Management → Kibana → Data Views → Create data view**

| Setting | Example | Notes |
|---------|---------|-------|
| Index pattern | `logs-app-*` | Matches all indices whose name starts with `logs-app-` |
| Timestamp field | `@timestamp` | Must be a `date` type field in the mapping |
| Name | `Application Logs` | Human-readable; shown in the selector dropdown |

```
# Verify which indices a glob matches using the Elasticsearch _cat API
GET /_cat/indices/logs-app-*?v&h=index,docs.count,store.size

# Check that @timestamp is mapped as date type
GET /logs-app-2024.03.15/_mapping/field/@timestamp
```

**Important:** if your index has multiple date fields (e.g., `@timestamp`, `event.created`, `ingest_timestamp`), the one you choose as the timestamp field controls the time picker. Choosing the wrong field means the time filter selects the wrong window — a common source of "I can't find the logs" confusion during incidents.

**Data view scope:** a single data view can span multiple indices via wildcards (`filebeat-*` matches `filebeat-7.17.0-2024.03.15`, `filebeat-8.0.0-2024.03.16`, etc.). This is intentional — you typically want to search across all dates in one query rather than selecting indices manually.

---

### KQL — Kibana Query Language

KQL is the default query language — simpler than Lucene, purpose-built for Kibana field-based queries. It was introduced in Kibana 7.3 and is preferred for daily use. Always use KQL unless you need a Lucene-specific feature.

**Free text search** (searches the `_all` / default text field across all indexed fields):

```kql
failed login
```

**Field match** (exact value match on keyword fields, full-text match on text fields):

```kql
status_code: 500
level: ERROR
http.method: POST
kubernetes.namespace: production
```

**Wildcards** (only on `keyword` type fields, not `text`):

```kql
service.name: auth*
url.path: /api/v*/users
kubernetes.pod.name: payment-*-canary
```

**Range queries:**

```kql
http.response.bytes > 10000
response_time_ms >= 500 and response_time_ms <= 2000
@timestamp >= "2024-03-15T00:00:00" and @timestamp <= "2024-03-15T06:00:00"
```

**Boolean operators** (`and`, `or`, `not` — all lowercase):

```kql
level: ERROR and service.name: payment-service
level: (ERROR or WARN) and not url.path: /healthz
(service.name: checkout or service.name: cart) and http.response.status_code: 500
```

**Phrase match** (the exact string, in order, within a `text` field):

```kql
message: "connection refused"
message: "out of memory"
message: "upstream connect error or disconnect/reset before headers"
```

**Existence check:**

```kql
error.message: *          # field exists and has a non-null value
not kubernetes.pod.name: * # field is absent from the document
```

**Nested field queries** (Elasticsearch nested objects, not just dot-notation):

```kql
user.roles: admin
tags: production
```

**KQL gotcha — text vs keyword fields:** wildcards work on `keyword` fields only. If `url.path` is mapped as `text`, `url.path: /api/*` will not work as expected. Check the field type in the sidebar (the coloured icon) before writing wildcard queries. Most ECS-compliant schemas expose both `url.path` (text) and `url.path.keyword` (keyword) — use the `.keyword` suffix for wildcards and exact matches.

**KQL gotcha — case sensitivity:** KQL field value matches on `keyword` fields are case-sensitive. `level: error` will not match documents where the field value is `ERROR`. On `text` fields, the analyser (usually lowercase) means case doesn't matter.

---

### KQL vs Lucene

| Feature | KQL | Lucene |
|---------|-----|--------|
| Syntax | Simple, forgiving | Strict, verbose |
| Default since | Kibana 7.3 | Pre-7.3 legacy |
| Wildcards in field names | No | Yes (`http.*: 500`) |
| Fuzzy search | No | `message:errror~1` |
| Proximity search | No | `"error timeout"~5` |
| Boosting | No | `level:ERROR^2` |
| Nested object queries | Yes | Limited |
| URL encoding required | No | Sometimes |

Switch to Lucene via the search bar KQL badge → **Switch to Lucene query language**.

**When to use Lucene:**
- You need wildcard field names: `kubernetes.*: crashloopbackoff` (matches any field under the `kubernetes` object).
- You need fuzzy matching for typo-tolerant searching: `message:recieve~1` matches `receive`.
- You're copying a query from Elasticsearch documentation (Lucene syntax maps directly to the `query_string` query DSL).

**Prefer KQL for everything else.** KQL queries are compiled to the Elasticsearch `bool` query DSL, which is efficient and predictable. Lucene query strings are compiled via the `query_string` query, which has edge cases around special characters that can cause parse errors.

---

### Field Filtering and Column Management

The left sidebar is one of the most powerful parts of Discover when used correctly.

**Sidebar interactions:**

| Action | How | Result |
|--------|-----|--------|
| See top values | Hover over a field name | Shows top 5 values with doc count percentages |
| Add as column | Click the `+` icon on hover | Adds field as a column in the document table |
| Filter for value | Click a value in top values | Adds `field: value` filter chip |
| Filter out value | Click the `-` icon on a value | Adds `not field: value` filter chip |
| View field stats | Click the field name | Opens cardinality, min/max, top values panel |

**Filter chips** appear below the search bar and are independent of the KQL query. They are ANDed with your KQL query. You can temporarily disable a chip (click the toggle) without deleting it — useful when you want to compare results with and without a filter.

**Adding columns transforms the view:** by default, the document table shows `@timestamp` and the raw `_source` JSON blob. Once you add specific columns, `_source` is replaced with only those fields. For incident triage, a good default column set is:

```
@timestamp | service.name | level | http.response.status_code | message
```

**Removing a column:** hover over the column header → click the `×`. Or remove it from the sidebar by clicking the `×` next to the field name in the "Selected fields" section.

**Sorting:** click any column header to sort ascending/descending. You can sort by `@timestamp` descending (newest first) or ascending (oldest first, useful for reading a sequence of events in order).

---

### Time Picker

The time picker controls the query's time window. Getting this right is critical — using a rolling relative window during postmortem analysis causes the results to change as time passes.

| Mode | Syntax example | When to use |
|------|---------------|-------------|
| Quick select | "Last 15 minutes" | Live monitoring, quick checks |
| Relative | "From 2 hours ago to now" | Investigations where "now" should stay current |
| Absolute | `2024-03-15 02:00 → 2024-03-15 04:00` | Incident postmortems, reproducible views |
| Auto-refresh | Every 10s / 30s / 1m | Live log tailing during a deploy |

**Absolute time during incidents:** always switch to absolute time when you have identified the incident window. A relative "last 2 hours" query will silently drift as you work, potentially including or excluding events. An absolute window is stable, reproducible, and can be shared via URL.

**Histogram zoom shortcut:** click and drag across the histogram to zoom into that exact time window. This updates the time picker to absolute mode automatically — faster than typing timestamps manually.

**The URL encodes the full state:** the Discover URL contains the query, filters, time range, and selected columns. You can copy the URL and share it with a colleague to give them an identical view. This is the fastest way to hand off an investigation.

---

### Saving Searches

A saved search captures: the KQL query, all active filter chips, the selected data view, the time range (if absolute), and the column configuration.

**To save:** click the floppy disk / **Save** button → enter a name → optionally check "Store time with saved search" → **Save**.

**Store time with saved search:** if checked, opening the saved search will restore the exact time window. Use this for incident postmortems. Leave unchecked for operational saved searches (e.g., "All production errors") where you always want the latest data.

**Using saved searches:**
- **Reopen:** Discover → **Open** (folder icon) → select from list.
- **Embed in dashboard:** when editing a dashboard → **Add panel** → **Saved search** → select by name. The search renders as a live-updating log table panel.
- **Reference in alerts:** Watcher and Kibana alerting rules can reference saved searches as their data source.

**Saved search vs dashboard:** saved searches are raw tabular views; dashboards aggregate and visualize. Use saved searches when you need the actual log lines. Use dashboards when you need counts, trends, and aggregations.

---

### Field Statistics View

Click the **Field statistics** tab (next to the **Documents** tab) to get a statistical profile of your current query result.

For each field you see:
- **Document count**: how many documents contain this field.
- **% coverage**: what percentage of matching documents have this field (helps identify sparse vs. dense fields).
- **Cardinality**: number of unique values (useful for deciding whether to add a field as a dashboard aggregation).
- **Top values**: distribution of the most common values.

**Use case — understanding a new data source:** before writing dashboards or alerts against a new index, run Field Statistics on a broad query (e.g., last 7 days, no filters). This tells you which fields are populated, what the cardinality looks like, and which fields are worth querying.

**Use case — incident scoping:** run Field Statistics on your error query. If `kubernetes.node.name` shows 95% of errors concentrated on one node, you have a strong signal. If `service.name` cardinality is 1, the problem is isolated to a single service.

---

### Document Expansion

Click the **>** arrow on any document row to expand the full event.

| Sub-view | Content | Best for |
|----------|---------|---------|
| Table | Field name + value pairs, all fields | Scanning structured fields, adding filters |
| JSON | Raw `_source` document | Copying exact values, debugging ingestion |
| Surrounding documents | Events ±N seconds around this event | Reconstructing a sequence of events |

**From the expanded view you can:**
- Click the filter icon next to any field value to add it as a filter chip (positive or negative).
- Click the column icon to add a field as a column.
- Use **Surrounding documents** to see the log lines immediately before and after an error — this is how you find the root cause rather than just the symptom.

**Surrounding documents gotcha:** surrounding documents are ordered by `@timestamp`. If multiple events share the exact same timestamp (common with high-throughput services logging at millisecond resolution), the ordering within that millisecond is not deterministic. Use a tiebreaker sort field (like `_seq_no`) if precise ordering within a millisecond matters.

---

## Examples

### Example 1: Structured Incident Triage — Payment Service Errors

**Scenario:** PagerDuty fires at 03:14 UTC. Payment service error rate spiked. Triage from cold start.

```kql
# Step 1 — set time picker to absolute: 2024-03-15 02:50 → 2024-03-15 03:30
# This pins the window; it will not drift as you work.

# Step 2 — broad error query, get volume and distribution
level: ERROR and service.name: payment-service

# Step 3 — add columns to the document table:
# @timestamp | kubernetes.pod.name | error.type | message
# (do this via the left sidebar + icons, not by typing)

# Step 4 — check Field Statistics tab on this result set
# Look at error.type top values — is it one error type or many?
# Look at kubernetes.pod.name — is it one pod or all pods?

# Step 5 — narrow to the dominant error type found in step 4
level: ERROR and service.name: payment-service and error.type: "java.net.SocketTimeoutException"

# Step 6 — find upstream target of the timeouts
level: ERROR and service.name: payment-service and message: "Read timed out" and upstream.service: *

# Step 7 — confirm it is NOT limited to one pod (ruling out a bad deploy on a single instance)
level: ERROR and service.name: payment-service and error.type: "java.net.SocketTimeoutException"
# → check pod name column — if all pods are affected, it's upstream, not a local crash

# Step 8 — expand one document →
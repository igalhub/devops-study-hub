---
title: Discover & Search
module: kibana
duration_min: 15
difficulty: beginner
tags: [kibana, discover, kql, search, elk]
exercises: 3
---

## Overview
Kibana Discover is the primary interface for ad-hoc log investigation and exploratory data analysis against Elasticsearch. In a DevOps context it's where you go first during an incident — searching logs, inspecting individual events, and understanding data shape before building dashboards. Being fast at KQL and comfortable navigating Discover is the difference between a 5-minute triage and a 30-minute one.

## Concepts

### The Discover Interface

The Discover UI has five zones:

| Zone | Purpose |
|---|---|
| Data view selector (top left) | Choose which index pattern / data view to query |
| Search bar | KQL or Lucene query input |
| Time picker (top right) | Absolute or relative time range |
| Field list (left sidebar) | Available fields; click to add as columns |
| Document table (centre) | Matching events, expandable rows |
| Histogram (above table) | Event count over time; click/drag to zoom |

### Data Views (Index Patterns)
A **data view** maps Kibana to one or more Elasticsearch indices. Examples: `logs-*`, `nginx-logs-*`, `filebeat-*`. Kibana reads the index mapping to understand field types (keyword, text, date, integer, IP, etc.).

Creating a data view: **Stack Management → Data Views → Create data view**

- **Index pattern**: glob that matches your index names (`logs-app-*`)
- **Timestamp field**: the field Kibana uses for the time histogram and time filter (usually `@timestamp`)
- **Name**: human-readable label shown in the selector

Without a correctly configured timestamp field, the time picker has no effect.

### KQL — Kibana Query Language
KQL is the default query language — simpler than Lucene, purpose-built for Kibana field-based queries. Always prefer KQL unless you need Lucene-specific features (wildcards in field names, fuzzy distance control).

**Free text search (searches across all fields):**

```
failed login
```

**Field match:**

```kql
status_code: 500
level: ERROR
http.method: POST
```

**Wildcards (on keyword fields):**

```kql
service.name: auth*
url.path: /api/v*/users
```

**Range queries:**

```kql
http.response.bytes > 10000
response_time_ms >= 500 and response_time_ms <= 2000
@timestamp >= "2024-03-15T00:00:00" and @timestamp <= "2024-03-15T06:00:00"
```

**Boolean operators:**

```kql
level: ERROR and service.name: payment-service
level: (ERROR or WARN) and not url.path: /healthz
```

**Phrase match (exact string in text field):**

```kql
message: "connection refused"
message: "out of memory"
```

**Existence check:**

```kql
error.message: *          # field exists and is non-null
not kubernetes.pod.name: *  # field is absent
```

**Nested field queries:**

```kql
user.roles: admin
tags: production
```

### KQL vs Lucene

| Feature | KQL | Lucene |
|---|---|---|
| Syntax | Simpler, forgiving | Strict, more powerful |
| Default | Yes (Kibana 7.3+) | Must switch manually |
| Wildcards in field names | No | Yes (`http.*: 500`) |
| Fuzzy search | No | `message:errror~1` |
| Proximity / boosting | No | Yes |
| Nested object queries | Yes | Limited |

Switch to Lucene via the search bar menu (KQL badge → switch to Lucene). Prefer KQL for everyday use.

### Field Filtering
The left sidebar lists all fields in the data view. Fields are coloured by type (keyword, text, number, date, boolean, IP, geo).

- **Hover a field** → see top 5 values and their document counts.
- **Click the + (pin) icon** → add as a column in the document table.
- **Filter for value** → click a value in the sidebar's top values → adds a filter chip to the search bar.
- **Filter out value** → the minus icon on the value.

Adding columns replaces the default `_source` display with just the fields you care about — much easier to read during an incident.

### Time Picker
Controls the query time range. Options:

- **Quick selects**: Last 15 minutes, Last 1 hour, Last 7 days, etc.
- **Relative**: "from 2 hours ago to now"
- **Absolute**: explicit start and end timestamps
- **Refresh**: auto-refresh interval (useful for live log tailing)

During an incident: use **absolute** ranges pinned to the incident window. This prevents the range shifting as time passes and makes screenshots reproducible.

### Saving Searches
Save a search (query + columns + time range filter) for reuse:

**Save (floppy disk icon) → name → Save**

Saved searches can be:
- Reopened from **Discover → Open**
- Embedded into a Dashboard as a search panel
- Referenced in alerts

### Field Statistics
Click **Field statistics** tab (next to Documents) to see a breakdown of every field: document count, percentage of docs with the field, cardinality, and top values. Useful for understanding a new data source before writing queries.

### Document Expansion
Click the **arrow** (expand icon) on any row to open the full document. Three sub-views:

| View | Use |
|---|---|
| Table | Field name + value pairs, sortable |
| JSON | Raw document JSON (copy for debugging) |
| Surrounding documents | Events immediately before/after this one in time |

From the expanded view you can:
- Pin/filter individual field values.
- View the raw `_source` JSON.
- Navigate to adjacent log lines (extremely useful for tracing an error's context).

## Examples

### Incident triage query sequence

```kql
# 1. Start broad — all errors in the last hour for your service
level: ERROR and service.name: checkout-service

# 2. Narrow by error type
level: ERROR and service.name: checkout-service and error.type: TimeoutException

# 3. Find the specific upstream dependency
level: ERROR and service.name: checkout-service and message: "upstream connect error"

# 4. Check if it's widespread or a single host
level: ERROR and service.name: checkout-service and not kubernetes.node.name: node-07
```

Add columns: `@timestamp`, `kubernetes.pod.name`, `http.url`, `error.message` — then export results as CSV via the share menu for postmortem evidence.

### Finding log anomalies

```kql
# Large responses (possible data exfiltration or bug)
http.response.bytes > 5000000 and http.method: GET

# Health check endpoints generating noise — exclude them
not url.path: /health and not url.path: /readyz and level: ERROR

# All 5xx errors except a known flapping service
http.response.status_code >= 500 and not service.name: legacy-batch-job
```

## Exercises

1. Write KQL queries for each of the following: (a) all POST requests returning 4xx on the `payments` service in the last 4 hours; (b) all events where `kubernetes.namespace` is either `production` or `staging` but NOT from pods with `canary` in their name; (c) events where `response_time_ms` is above 1000 and the `error` field exists.

2. In Discover, you need to create a reproducible view for your team showing: only the fields `@timestamp`, `service.name`, `level`, and `message`; filtered to `level: ERROR`; over the absolute window of the last incident (2024-03-15 02:00 to 04:00 UTC). Describe each step to configure this view and save it so a colleague can open it exactly as you left it.

3. Explain the difference between searching `message: "connection refused"` (double quotes) versus `message: connection refused` (no quotes) in KQL. When would each return different results? Give a concrete example of a log message where one query matches and the other doesn't.

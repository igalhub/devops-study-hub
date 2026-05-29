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

In the broader ELK/Elastic Stack toolchain, Discover sits between data ingestion (Beats, Logstash, Elastic Agent) and visualization (Dashboards, Lens). You use Discover to validate that logs are being ingested correctly, to explore a new data source before you know what fields exist, and to investigate specific incidents by drilling down from a dashboard alert into the raw events. Saved searches from Discover can be embedded directly in dashboards, so the work you do in Discover is reusable and composable with the rest of the stack.

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

```bash
# Verify which indices a glob matches using the Elasticsearch _cat API
GET /_cat/indices/logs-app-*?v&h=index,docs.count,store.size

# Check that @timestamp is mapped as date type
GET /logs-app-2024.03.15/_mapping/field/@timestamp
```

**Important:** if your index has multiple date fields (e.g., `@timestamp`, `event.created`, `ingest_timestamp`), the one you choose as the timestamp field controls the time picker. Choosing the wrong field means the time filter selects the wrong window — a common source of "I can't find the logs" confusion during incidents.

**Data view scope:** a single data view can span multiple indices via wildcards (`filebeat-*` matches `filebeat-7.17.0-2024.03.15`, `filebeat-8.0.0-2024.03.16`, etc.). This is intentional — you typically want to search across all dates in one query rather than selecting indices manually.

**Runtime fields:** data views also support runtime fields — fields computed at query time from existing document values without re-indexing. For example, if your logs store `duration_ms` as a string, you can define a runtime field that casts it to a number. These appear in the sidebar like normal fields.

---

### KQL — Kibana Query Language

KQL is the default query language — simpler than Lucene, purpose-built for Kibana field-based queries. It was introduced in Kibana 7.3 and is preferred for daily use. Always use KQL unless you need a Lucene-specific feature.

**Free text search** (searches across all indexed text fields):

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
error.message: *           # field exists and has a non-null value
not kubernetes.pod.name: * # field is absent from the document
```

**Nested field queries:**

```kql
user.roles: admin
tags: production
```

**KQL gotcha — text vs keyword fields:** wildcards work on `keyword` fields only. If `url.path` is mapped as `text`, `url.path: /api/*` will not work as expected. Check the field type in the sidebar (the coloured icon) before writing wildcard queries. Most ECS-compliant schemas expose both `url.path` (text) and `url.path.keyword` (keyword) — use the `.keyword` suffix for wildcards and exact matches.

**KQL gotcha — case sensitivity:** KQL field value matches on `keyword` fields are case-sensitive. `level: error` will not match documents where the field value is `ERROR`. On `text` fields, the analyser (usually lowercase) makes matching case-insensitive.

**KQL gotcha — special characters:** characters like `(`, `)`, `:`, `"`, `*`, `\` have syntactic meaning in KQL. If a field value contains them (e.g., a URL with a colon), wrap the value in quotes: `url.full: "https://api.example.com/v1"`.

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
- You need wildcard field names: `kubernetes.*: crashloopbackoff` matches any field under the `kubernetes` object.
- You need fuzzy matching for typo-tolerant searching: `message:recieve~1` matches `receive`.
- You're copying a query from Elasticsearch documentation (Lucene syntax maps directly to the `query_string` DSL).

**Prefer KQL for everything else.** KQL queries compile to the Elasticsearch `bool` query DSL, which is efficient and predictable. Lucene query strings compile via `query_string`, which has edge cases around special characters that cause parse errors.

**Lucene example for wildcard field names:**

```lucene
kubernetes.*: "OOMKilled"
```

This matches any field under the `kubernetes` object whose value is `OOMKilled` — useful when you don't know the exact field path yet.

---

### Field Filtering and Column Management

The left sidebar is one of the most powerful parts of Discover when used correctly.

**Sidebar interactions:**

| Action | How | Result |
|--------|-----|--------|
| See top values | Hover over a field name | Shows top 5 values with doc count percentages |
| Add as column | Click the `+` icon on hover | Adds field as a column in the document table |
| Filter for value | Click a value in top values | Adds `field: value` filter chip |
| Filter out value | Click the `−` icon on a value | Adds `not field: value` filter chip |
| View field stats | Click the field name | Opens cardinality, min/max, top values panel |

**Filter chips** appear below the search bar and are independent of the KQL query. They are ANDed with your KQL query. You can temporarily disable a chip (click the toggle) without deleting it — useful when you want to compare results with and without a filter without losing the state of either branch.

**Adding columns transforms the view:** by default, the document table shows `@timestamp` and the raw `_source` JSON blob. Once you add specific columns, `_source` is replaced with only those fields. For incident triage, a good default column set is:

```
@timestamp | service.name | level | http.response.status_code | message
```

**Removing a column:** hover over the column header → click the `×`. Or remove it from the sidebar by clicking the `×` next to the field name in the "Selected fields" section.

**Sorting:** click any column header to sort ascending/descending. Sort `@timestamp` descending (newest first) for live triage, or ascending (oldest first) when you need to read a causal sequence of events in chronological order.

**Pinning filters:** right-click a filter chip → **Pin across all apps**. A pinned filter persists even when you navigate to Dashboards or Canvas, allowing you to investigate a specific pod or service across multiple views without re-entering the filter.

---

### Time Picker

The time picker controls the query's time window. Getting this right is critical — using a rolling relative window during postmortem analysis causes results to shift as time passes.

| Mode | Syntax example | When to use |
|------|---------------|-------------|
| Quick select | "Last 15 minutes" | Live monitoring, quick checks |
| Relative | "From 2 hours ago to now" | Investigations where "now" should stay current |
| Absolute | `2024-03-15 02:00 → 2024-03-15 04:00` | Incident postmortems, reproducible views |
| Auto-refresh | Every 10s / 30s / 1m | Live log tailing during a deploy |

**Absolute time during incidents:** always switch to absolute time when you have identified the incident window. A relative "last 2 hours" query will silently drift as you work, potentially including or excluding events. An absolute window is stable, reproducible, and can be shared via URL with a colleague who will see exactly the same data.

**Histogram zoom shortcut:** click and drag across the histogram to zoom into that exact time window. This updates the time picker to absolute mode automatically — faster than typing timestamps manually and more precise for sub-minute windows.

**The URL encodes the full state:** the Discover URL contains the query, filters, time range, and selected columns encoded as a compressed payload. Copy the URL to share an identical investigation view. This is the fastest way to hand off a triage session without screensharing.

**Auto-refresh during deploys:** set auto-refresh to 10s and time range to "Last 5 minutes" to get a rolling tail of logs as a deployment rolls out. When you see errors appear, immediately switch to absolute time to pin the incident window before the events scroll out of the relative window.

---

### Saving Searches

A saved search captures: the KQL query, all active filter chips, the selected data view, the time range (if absolute), and the column configuration.

**To save:** click the floppy disk / **Save** button → enter a name → optionally check "Store time with saved search" → **Save**.

**Store time with saved search:** if checked, opening the saved search restores the exact time window. Use this for incident postmortems. Leave unchecked for operational saved searches (e.g., "All production errors") where you always want the latest data relative to now.

**Using saved searches:**
- **Reopen:** Discover → **Open** (folder icon) → select from list.
- **Embed in dashboard:** when editing a dashboard → **Add panel** → **Saved search** → select by name. The search renders as a live-updating log table panel inside the dashboard.
- **Reference in alerts:** Kibana alerting rules using the Elasticsearch query rule type can target the same index pattern and query logic you developed in Discover.

**Saved search vs dashboard panel:**

| | Saved Search | Dashboard Panel |
|--|-------------|-----------------|
| Shows | Raw log lines | Aggregated metrics, charts |
| Interactivity | Full expand/filter | Click-through to Discover |
| Use when | You need the actual events | You need counts, trends, rates |

**Naming convention tip:** prefix saved searches with the team or service name: `[payment] 5xx errors`, `[infra] node OOMKilled`. This makes the Open dialog scannable during incidents when you don't want to type a search from scratch.

---

### Field Statistics View

Click the **Field statistics** tab (next to the **Documents** tab) to get a statistical profile of your current query result without writing an aggregation query.

For each field you see:
- **Document count**: how many documents in the result set contain this field.
- **% coverage**: what percentage of matching documents have this field (helps identify sparse vs. dense fields).
- **Cardinality**: number of unique values (useful for deciding whether a field is suitable for aggregation).
- **Top values**: distribution of the most common values with percentages.

**Use case — understanding a new data source:** before writing dashboards or alerts against a new index, run Field Statistics on a broad query (e.g., last 7 days, no filters). This tells you which fields are populated, what cardinality looks like, and which fields are worth building aggregations on. Fields with 100% coverage and low cardinality (e.g., `environment`, `region`) make good aggregation dimensions. Fields with low coverage or extremely high cardinality (e.g., `trace.id`) are better used as filters or lookup keys.

**Use case — incident scoping:** run Field Statistics on your error query. If `kubernetes.node.name` shows 95% of errors concentrated on a single node, you have a strong signal of a node-level problem. If `error.type` cardinality is 1, the failure mode is uniform and likely has a single root cause.

---

### Document Expansion

Click the **›** arrow on any document row to expand the full event.

| Sub-view | Content | Best for |
|----------|---------|---------|
| Table | Field name + value pairs, all fields | Scanning structured fields, adding filters |
| JSON | Raw `_source` document | Copying exact values, debugging ingestion |
| Surrounding documents | Events ±N seconds around this event | Reconstructing a sequence of events |

**From the expanded view you can:**
- Click the filter icon next to any field value to add it as a positive or negative filter chip.
- Click the column icon to add a field as a column in the document table.
- Use **Surrounding documents** to see log lines immediately before and after an error — this is how you find root cause rather than just the symptom.

**Surrounding documents gotcha:** surrounding documents are ordered by `@timestamp`. If multiple events share the exact same timestamp (common with high-throughput services logging at millisecond resolution), ordering within that millisecond is non-deterministic. Use a tiebreaker sort field like `_seq_no` or `log.offset` if you need deterministic ordering within a millisecond.

**JSON view for debugging ingestion:** when a field is missing from the table view but you expect it to be there, switch to JSON view on a raw document. If the field is present in JSON but absent from the sidebar, the field mapping may not have been added to the data view — refresh the data view field list under Stack Management.

---

## Examples

### Example 1: Structured Incident Triage — Payment Service 5xx Spike

**Scenario:** PagerDuty fires at 03:14 UTC. Payment service error rate spiked. Triage from cold start in Discover.

```kql
# Step 1 — set the time picker to absolute
# 2024-03-15 02:50 → 2024-03-15 03:30
# This pins the window; it will not drift as you work.

# Step 2 — broad error query to establish volume
level: ERROR and service.name: payment-service

# Step 3 — add columns via the left sidebar:
# @timestamp | kubernetes.pod.name | error.type | http.response.status_code | message

# Step 4 — switch to Field Statistics tab on this result set
# Key questions:
#   error.type top values  → is it one error class or many?
#   kubernetes.pod.name    → one pod or all pods? (one = bad deploy; all = upstream)
#   http.response.status_code → 502? 503? 504? (gateway errors vs. app errors)

# Step 5 — narrow to the dominant error type found in step 4
level: ERROR and service.name: payment-service and error.type: "java.net.SocketTimeoutException"

# Step 6 — identify the upstream target of the timeouts
level: ERROR and service.name: payment-service and message: "Read timed out" and upstream.service: *
# The upstream.service field, if populated, names the dependency that is timing out

# Step 7 — confirm blast radius (one pod vs. all pods)
# Look at the kubernetes.pod.name column distribution
# All pods affected → upstream dependency issue, not a local crash
# One pod affected  → likely a bad container; cordon the node or restart the pod

# Step 8 — expand one representative document
# → Table view: note the exact upstream.service value and error.message
# → Surrounding documents: look 30 seconds before the first error
#    Did request rate suddenly spike? Did a deployment event appear?

# Step 9 — save this search for handoff
# Name: "[payment] SocketTimeoutException 2024-03-15"
# Check "Store time with saved search"
# Copy the URL and paste into the incident Slack thread
```

**Verify it worked:** your colleague opens the URL and sees the identical result set — same time window, same columns, same filters — without re-entering anything.

---

### Example 2: Validating a New Log Source After Onboarding

**Scenario:** a new microservice (`inventory-service`) has been instrumented with Elastic Agent and is shipping logs. Validate that the data is arriving correctly and fields are usable before building dashboards.

```bash
# Step 1 — from the Elasticsearch side, confirm the index exists and has documents
GET /_cat/indices/logs-inventory-*?v&h=index,docs.count,store.size,health

# Expected output:
# index                        docs.count store.size health
# logs-inventory-2024.03.15    142831     89.3mb     green

# Step 2 — check the @timestamp field mapping
GET /logs-inventory-2024.03.15/_mapping/field/@timestamp
# Confirm "type": "date" — if it's "keyword", the time picker won't work
```

```kql
# Step 3 — in Discover, create a data view: logs-inventory-*
# Timestamp field: @timestamp

# Step 4 — broad query, last 24 hours, no filters
*

# Step 5 — switch to Field Statistics tab
# Check for:
#   service.name coverage: should be 100% (every doc tagged with service name)
#   level coverage: should be 100% (every log has a severity)
#   message coverage: should be 100%
#   trace.id coverage: might be 60-80% (only traced requests)
#   kubernetes.pod.name: should match expected pod naming convention

# Step 6 — validate log levels are normalized (ECS uses lowercase)
level: (DEBUG or INFO or WARN or ERROR or FATAL)
# If you get 0 results, check for non-ECS values like "Warning", "warning", "INFORMATION"

# Step 7 — validate timestamp accuracy
# Sort @timestamp descending — newest document should be within the last 2 minutes
# If newest document is hours old, there's an ingestion pipeline lag

# Step 8 — spot-check a random document (JSON view)
# Confirm structured fields are parsed: http.response.status_code should be integer, not string
# "http.response.status_code": 200   ← correct (integer)
# "http.response.status_code": "200" ← incorrect (string — range queries won't work)
```

**Verify it worked:** Field Statistics shows `service.name` at 100% coverage, `level` at 100% coverage with values matching ECS conventions, and `@timestamp` is current. You can now build dashboards with confidence.

---

### Example 3: Postmortem Log Reconstruction — Database Connection Pool Exhaustion

**Scenario:** a production incident last night caused checkout failures for 18 minutes. Reconstruct the event sequence from logs for the postmortem report.

```kql
# Step 1 — set absolute time window to cover the full incident plus 10 min before
# 2024-03-14 22:10 → 2024-03-14 23:05
# Save this range — it will be referenced throughout the postmortem

# Step 2 — find the first error occurrence
level: ERROR and service.name: checkout-service
# Sort @timestamp ascending (oldest first) to find the first error
# Note the exact timestamp of the first error: 22:18:43.112 UTC

# Step 3 — find what preceded the errors (look back 5 minutes before first error)
# Set time range to: 2024-03-14 22:13 → 2024-03-14 22:20
service.name: checkout-service
# Sort ascending — look for WARN messages or unusual patterns before 22:18:43

# Step 4 — find the connection pool exhaustion signal
service.name: checkout-service and message: "connection pool"
# Expected to find: "HikariPool-1 - Connection is not available, request timed out after 30000ms"

# Step 5 — correlate with database-side logs
(service.name: checkout-service or service.name: postgres-proxy) and level: (WARN or ERROR)
# Did the database start logging slow queries or connection refusals at the same time?

# Step 6 — measure the blast radius across services
level: ERROR and message: "connection pool" and not service.name: checkout-service
# Did connection exhaustion cascade to other services sharing the same DB?

# Step 7 — find the recovery point
service.name: checkout-service and level: INFO and message: "connection pool"
# Look for "pool size increased" or "connections available" — marks recovery
# Sort ascending — the first INFO after the WARN/ERROR sequence = recovery time

# Step 8 — save the complete search for the postmortem document
# Name: "[postmortem] checkout DB pool exhaustion 2024-03-14"
# Enable "Store time with saved search"
# Embed in a postmortem dashboard panel alongside the error rate graph
```

**Verify it worked:** sort ascending on `@timestamp` and read the log sequence from top to bottom. You should be able to narrate the exact causal chain: increased request rate → pool exhaustion warnings → connection timeout errors → cascading failures → manual remediation → pool recovery.

---

### Example 4: Using KQL to Exclude Noise and Find Signal

**Scenario:** your application logs are flooded with health-check requests and background job logs. You need to isolate real user-facing errors.

```kql
# Problem: raw error search returns 80% noise
level: ERROR

# Noise sources identified from Field Statistics top values on url.path:
#   /healthz          (Kubernetes liveness probe — 40% of requests)
#   /readyz           (Kubernetes readiness probe — 15% of requests)
#   /_internal/metrics (Prometheus scrape — 10% of requests)
#   batch-job.*       (background jobs — 15% of errors from expected failures)

# Step 1 — exclude health check endpoints
level: ERROR and not url.path: (/healthz or /readyz or /_internal/metrics)

# Step 2 — exclude background job errors (these have a specific logger name)
level: ERROR
  and not url.path: (/healthz or /readyz or /_internal/metrics)
  and not logger.name: "com.example.jobs.*"

# Step 3 — add a column for http.response.status_code and url.path
# Use Field Statistics on this filtered result — what does error distribution look like now?

# Step 4 — further narrow to user-facing 5xx (not 4xx which are client errors)
level: ERROR
  and not url.path: (/healthz or /readyz or /_internal/metrics)
  and not logger.name: "com.example.jobs.*"
  and http.response.status_code >= 500

# Step 5 — save this as a reusable search: "[app] user-facing 5xx errors"
# Leave "Store time with saved search" UNCHECKED so it always shows current data
# Add to the main operations dashboard as a log panel
```

**Verify it worked:** compare document count before and after adding the exclusions. If Field Statistics on `url.path` no longer shows `/healthz` in the top values, the noise is filtered. The remaining errors are actionable.

---

## Exercises

### Exercise 1: KQL Query Construction Under Constraints

Using a Discover instance connected to any application log index, write KQL queries that satisfy all of the following constraints **without using the filter chips UI** (type everything in the search bar):

1. Find all log events where `level` is `ERROR` or `FATAL`, **and** `service.name` starts with `api-`, **and** the `message` field contains the phrase `"timeout"`, **and** the event does NOT come from a pod whose name ends in `-canary`.
2. Verify your query returns results, then check the Field Statistics tab. Identify: (a) the field with the highest cardinality in your result set, and (b) the field with the lowest document coverage percentage. Explain what low coverage means for that field's usefulness in a dashboard aggregation.
3. Modify the query to also exclude any document where `http.response.status_code` is absent (hint: use the existence check syntax).

**Goal:** build fluency writing multi-clause KQL from scratch, and connect field statistics to query design decisions.

---

### Exercise 2: Incident Time Window Pinning and URL Sharing

Simulate a postmortem investigation workflow:

1. Pick any 30-minute window from yesterday's logs in your environment. Use the histogram to identify a sub-range where event volume was higher than average (a natural "spike"). Click-drag on the histogram to zoom into that spike.
2. Confirm that the time picker switched to absolute mode automatically. Write down the exact timestamps it selected.
3. Add at least three columns to the document table that are more useful than the raw `_source` blob. Sort by `@timestamp` ascending.
4. Save the search with "Store time with saved search" enabled. Close the tab, reopen Discover, open your saved search, and confirm it restores the exact columns, filters, and time window.
5. Copy the URL of the saved search. Paste it into a new incognito/private browser window and confirm your colleague would see the identical view.

**Goal:** build the muscle memory of pinning absolute time windows and sharing investigation state — skills that matter most when handing off a live incident.

---

### Exercise 3: Field Type Investigation and Wildcard Debugging

This exercise tests understanding of the text vs. keyword distinction — the most common source of KQL query failures.

1. In Discover, open the left sidebar and find a field that has both a `text` type version and a `.keyword` subfield (look for fields with a `t` icon — hover to confirm type). Common candidates: `message`, `url.path`, `error.message`.
2. Write a wildcard query against the `text` version of the field (e.g., `url.path: /api/*`). Observe the result count.
3. Write the same wildcard query against the `.keyword` version (e.g., `url.path.keyword: /api/*`). Compare result counts. If the counts differ significantly, explain why based on how text analysis works.
4. Now write an exact phrase match (using quotes) against the `text` field. Write the same query without quotes. Explain the difference in what Elasticsearch matches in each case.
5. Using the Elasticsearch API directly, retrieve the mapping for your index and confirm the field type programmatically:

```bash
# Replace <index-name> and <field-name> with your values
GET /<index-name>/_mapping/field/<field-name>

# Expected output for a field with both text and keyword sub-types:
# {
#   "logs-app-2024.03.15": {
#     "mappings": {
#       "url.path": {
#         "full_name": "url.path",
#         "mapping": {
#           "path": {
#             "type": "text",
#             "fields": {
#               "keyword": {
#                 "type": "keyword",
#                 "ignore_above": 1024
#               }
#             }
#           }
#         }
#       }
#     }
#   }
# }
```

**Goal:** internalize the text/keyword distinction at the mapping level so you can debug query failures without guessing, and understand when to append `.keyword` to a field name.

---

### Exercise 4: Surrounding Documents for Root Cause Analysis

This exercise builds the habit of looking before and after an error, not just at the error itself.

1. Write a query that finds a single ERROR-level document in your log data. Expand it using the `›` arrow.
2. Navigate to **Surrounding documents** and set the window to ±2 minutes (adjust if your log volume is low — try ±5 minutes).
3. Sort the surrounding documents by `@timestamp` ascending. Read the sequence from top to bottom.
4. Answer the following questions from the log sequence alone (do not use any other tool):
   - What was the last INFO or DEBUG event logged by the same service immediately before the error?
   - Was there a WARN event between the last INFO and the ERROR? If so, what did it say?
   - How long (in seconds) elapsed between the first WARN and the first ERROR?
   - Did the error repeat after the first occurrence, or did it appear only once?
5. Based only on the surrounding document sequence, write a one-sentence hypothesis about the root cause. This mimics the postmortem skill of forming an initial hypothesis from logs before correlating with metrics.

**Goal:** practice the "zoom out before zooming in" approach to log investigation — errors rarely appear in isolation, and the events surrounding them carry more diagnostic information than the error itself.

---

### Quick Checks

6. Extract the index pattern from a Discover config stub. Run: `printf 'index: logs-*\ntime_field: @timestamp\n' | awk '/^index:/{print $2}'`

```expected_output
logs-*
```

7. Count active field filters in a search stub. Run: `printf 'filters:\n- field: level\n  value: error\n- field: service\n  value: api\n- field: env\n  value: prod\n' | grep -c '^- field:'`

```expected_output
3
```

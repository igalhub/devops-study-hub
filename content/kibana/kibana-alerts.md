---
title: Alerting & Reporting
module: kibana
duration_min: 20
difficulty: intermediate
tags: [kibana, alerting, rules, connectors, reporting, elk]
exercises: 3
---

## Overview

Kibana's alerting system lets you define rules that run on a schedule against Elasticsearch data and fire actions through connectors when conditions are met. For DevOps, this consolidates alerting on logs, metrics, and ML anomalies into the same tool you already use for dashboards — eliminating a separate alerting tier for Elasticsearch-backed observability data. Rules are first-class objects stored in the `.kibana` index, managed through the UI or API, and executed by Kibana's background task manager, which means alerting scales with your Kibana deployment rather than requiring external components.

The design philosophy centers on three decoupled primitives: **rules** (what to check), **connectors** (how to notify), and **actions** (which connector to call at which lifecycle stage). This separation means you define a Slack webhook once and reference it from dozens of rules. It also means changing a notification channel is a one-place edit, not a mass rule update. Alert instances are stateful — Kibana tracks whether a condition is currently active or has recovered, enabling auto-resolution workflows in downstream tools like PagerDuty.

In the broader DevOps toolchain, Kibana alerting sits between data ingestion (Beats, Logstash, APM agents pushing into Elasticsearch) and incident management (PagerDuty, OpsGenie, ServiceNow). The Reporting feature extends this by automating scheduled delivery of dashboards and search results as PDF or CSV — bridging the gap between real-time monitoring and asynchronous stakeholder communication like weekly operations reviews or compliance exports.

---

## Concepts

### Alerting Architecture

Three components make up every alert workflow:

| Component | Role | Where configured |
|-----------|------|-----------------|
| **Rule** | What to check, how often, and the threshold condition | Stack Management → Rules |
| **Connector** | Reusable notification channel (Slack, email, PagerDuty, webhook) | Stack Management → Connectors |
| **Action** | Binds a rule lifecycle event to a connector with a templated message | Inside each rule definition |

Rules run inside Kibana's task manager on a configurable schedule. Each execution queries Elasticsearch, evaluates the condition, and updates persisted alert instance state. One rule can produce multiple **alert instances** — for example, a rule grouped by `service.name` creates a separate instance per service that breaches the threshold, so notifications are scoped to the offending service rather than firing a generic global alert.

**Task manager gotcha:** if Kibana is overloaded or task manager falls behind, rule executions can be delayed. Monitor `kibana_task_manager_run_duration_seconds` and the **Stack Monitoring → Kibana → Task Manager** panel. If `drift` is consistently high, reduce rule frequency or scale Kibana horizontally.

Navigate to rules via: **Stack Management → Rules** or **Observability → Alerts → Rules** (Kibana 8.x reorganized the navigation; both paths reach the same underlying system).

---

### Built-in Rule Types

#### Elasticsearch Query Rule

The most flexible rule type. Runs any Elasticsearch query (KQL or full DSL) against any index pattern, then alerts when a count or aggregation crosses a threshold.

Key configuration parameters:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `index` | Index pattern to query | `logs-*`, `apm-*-transaction` |
| `query` | KQL or Lucene filter | `level: ERROR AND env: prod` |
| `aggType` | `count`, `avg`, `sum`, `min`, `max`, `pct` (percentile) | `avg` |
| `aggField` | Field to aggregate (required for non-count types) | `transaction.duration.us` |
| `timeWindowSize` + `timeWindowUnit` | Rolling window for the query | `5` + `m` |
| `thresholdComparator` | `>`, `>=`, `<`, `<=`, `between`, `notBetween` | `>` |
| `threshold` | Value(s) for the comparator | `[100]` or `[50, 200]` for between |
| `termField` + `termSize` | Group by field and number of top groups | `service.name`, `10` |

Example — alert if the average response time in any service exceeds 2 seconds over a 5-minute window:

```
Index:         apm-*-transaction
Query (KQL):   transaction.type: request AND labels.env: production
Aggregate:     Average of transaction.duration.us
When:          avg IS ABOVE 2000000   (2s in microseconds)
Over:          5 minutes
Group by:      service.name (top 10)
Run every:     1 minute
```

**Units gotcha:** APM stores durations in **microseconds**. `2000 ms = 2,000,000 µs`. Getting this wrong is a very common source of alerts that never fire or fire constantly.

#### Metric Threshold Rule

Purpose-built for infrastructure metrics from `metrics-*` or `metricbeat-*` indices. Simpler to configure for straightforward threshold scenarios.

Supports conditions combined with AND/OR:
- `system.cpu.total.norm.pct IS ABOVE 0.85`
- `system.memory.actual.used.pct IS ABOVE 0.90`
- Multiple conditions on the same rule: CPU **AND** memory both above threshold before firing.

**When to prefer Metric Threshold over ES Query:** when you're alerting on standard infrastructure metrics and don't need custom KQL filtering or percentile aggregations. For anything custom, use ES Query.

#### Anomaly Detection Rule (ML)

Fires when an Elastic ML job records an anomaly score above a configured threshold. Requires an active ML anomaly detection job — the rule doesn't run ML itself, it monitors ML job output.

| Anomaly score | Severity |
|---------------|----------|
| 25–49 | Warning |
| 50–74 | Minor |
| 75–89 | Major |
| 90–100 | Critical |

Practical use: alert on `score > 75` to catch major anomalies while ignoring statistical noise. ML rules excel at detecting volume-based anomalies (sudden drop in login events, unusual spike in 4xx errors) where static thresholds would require constant tuning.

**Prerequisite:** the ML job must be in a running or closed state with results. If the job is stopped, the anomaly rule will have nothing to evaluate and won't fire.

---

### Alert Lifecycle and State Management

Every alert instance (per rule, per group value) moves through a defined state machine:

```
INACTIVE
    │
    ▼ [threshold breached]
ACTIVE ──────────────────────────────────────────────┐
    │                                                 │
    ▼ [condition clears]                    [still active on next check]
RECOVERED                                    (re-notifies if configured)
    │
    ▼ [threshold breaches again]
ACTIVE
```

Actions are bound to **action groups**, which map to lifecycle events:

| Action group | When it fires |
|---|---|
| `query matched` / `threshold met` | Each check where the condition is active |
| `recovered` | First check after condition clears |

**Notify frequency** controls how often actions fire while an alert stays active:

| Option | Behavior | Use case |
|--------|-----------|----------|
| On every check interval | Fires on every rule execution while active | High-urgency, needs repeated paging |
| On custom interval | Fires every N hours while active | Reminder notifications |
| **Only on status change** | Fires once on transition (inactive→active, active→recovered) | **Recommended for most ops alerts** |

**Flapping detection:** when an alert alternates between active and recovered rapidly (e.g., a borderline threshold), Kibana marks it as **flapping** and suppresses notifications to reduce noise. Configure the lookback window and threshold under rule settings. Flapping state is visible in the Rules list — investigate the underlying instability rather than just suppressing.

---

### Connectors

Connectors are reusable, credentials-stored notification channels. Configure once, reference from many rules. Credentials (webhook URLs, API keys, SMTP passwords) are stored encrypted in Elasticsearch.

Navigate to: **Stack Management → Connectors → Create connector**

| Connector | Protocol | Primary use case |
|-----------|----------|-----------------|
| Email (SMTP) | SMTP | Structured alert emails to teams |
| Slack | Incoming webhook | Channel notifications |
| PagerDuty | Events API v2 | Incident creation and auto-resolution |
| Webhook | HTTP POST | Custom integrations, Alertmanager bridge |
| Jira | REST API | Auto-create tickets on alert |
| ServiceNow ITSM | REST API | Enterprise incident management |
| Microsoft Teams | Incoming webhook | Teams channel notifications |
| OpsGenie | REST API | On-call alert routing |

#### Slack Connector

Create via UI or API:

```bash
curl -X POST "http://kibana:5601/api/actions/connector" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey <base64-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Slack #alerts-prod",
    "connector_type_id": ".slack",
    "config": {
      "webhookUrl": "https://hooks.slack.com/services/T00/B00/XXXX"
    }
  }'
# Response includes "id" — save this; you reference it in rule actions
```

Action body uses **Mustache templates** to inject alert context:

```
*Alert:* {{rule.name}}
*Status:* {{alert.actionGroup}}
*Service:* {{context.group}}
*Value:* {{context.value}}
*Conditions:* {{context.conditions}}
*Link:* {{context.alertDetailsUrl}}
```

Common context variables (vary by rule type — check rule type documentation):

| Variable | Value |
|----------|-------|
| `{{rule.name}}` | Rule display name |
| `{{alert.actionGroup}}` | `query matched` or `recovered` |
| `{{context.group}}` | The group-by field value (e.g., service name) |
| `{{context.value}}` | The metric value that triggered the alert |
| `{{context.conditions}}` | Human-readable condition description |
| `{{context.alertDetailsUrl}}` | Deep link to the alert in Kibana |

#### PagerDuty Connector

The PagerDuty connector uses Events API v2. Critical configuration for auto-resolution:

```json
{
  "name": "PagerDuty Production",
  "connector_type_id": ".pagerduty",
  "config": {
    "apiUrl": "https://events.pagerduty.com/v2/enqueue"
  },
  "secrets": {
    "routingKey": "your-integration-key-here"
  }
}
```

In the rule, configure **two actions**:

| Action group | Event action | Severity |
|---|---|---|
| `query matched` (active) | `trigger` | `critical` |
| `recovered` | `resolve` | — |

**The most common PagerDuty misconfiguration:** only creating an action for the active state (`trigger`) and omitting the `recovered` action with event action `resolve`. Kibana cannot auto-resolve PagerDuty incidents without an explicit `resolve` action on the recovery group. Stale incidents accumulate and on-call fatigue increases.

The `dedup_key` is automatically set by Kibana to the alert instance ID — this is what links the `trigger` and `resolve` events so PagerDuty knows which incident to close.

#### Webhook Connector

Use for any integration not covered by built-in connectors, or to bridge into Prometheus Alertmanager:

```json
{
  "name": "Internal Alertmanager",
  "connector_type_id": ".webhook",
  "config": {
    "url": "https://alertmanager.internal/api/v2/alerts",
    "method": "post",
    "headers": {
      "Content-Type": "application/json",
      "X-API-Key": "{{secrets.apiKey}}"
    }
  },
  "secrets": {
    "apiKey": "my-secret-token"
  }
}
```

**Secrets handling:** never hardcode credentials in the `config` block. Use the `secrets` block — it is write-only (not returned by the API after creation) and encrypted at rest.

---

### Action Templates and Mustache Rendering

Every action body is rendered as a Mustache template at execution time. Understanding template syntax prevents malformed notifications:

```mustache
{{! Single value }}
Service: {{context.group}}

{{! Conditional block }}
{{#context.isRecovered}}
✅ Alert has resolved
{{/context.isRecovered}}

{{^context.isRecovered}}
🔴 Alert is active — value: {{context.value}}
{{/context.isRecovered}}

{{! Escaping — triple braces skip HTML escaping }}
Raw URL: {{{context.alertDetailsUrl}}}
```

**Mustache gotcha:** Kibana's Mustache implementation does **not** support arbitrary JavaScript logic, loops over unknown arrays, or helper functions. If you need complex formatting, use a webhook connector to a middleware service that transforms the payload before forwarding.

---

### Stack Monitoring Alerts

Stack Monitoring provides pre-built alerts for the Elastic Stack's own health. These are critical — they alert on the infrastructure that runs your other alerts.

| Alert | Default threshold | Why it matters |
|-------|------------------|---------------|
| Cluster health | Yellow or Red | Data loss risk (Red = shards unassigned) |
| Disk usage | 85% | Elasticsearch stops writing at 95% (flood-stage watermark) |
| CPU usage | 85% | Sustained high CPU causes indexing lag and query timeouts |
| JVM heap | 85% | Approaching GC pressure; potential OOM and node drop |
| Logstash pipeline throughput | Significant drop | Events are stuck or pipeline is down |
| Kibana task manager health | Execution failures | Alerts may stop firing silently |

Enable under **Stack Management → Stack Monitoring**. These alerts use the same connector/action framework — configure a connector first, then enable each alert and attach the connector.

**Disk usage gotcha:** Elasticsearch has a [disk watermark](https://www.elastic.co/guide/en/elasticsearch/reference/current/modules-cluster.html) system. At 85% (`low`), no new shards are allocated to that node. At 90% (`high`), shards are moved away. At 95% (`flood_stage`), all indices on that node are set to read-only. Alert at 80% to give yourself a response window before the 85% allocation cutoff.

---

### Reporting: PDF and CSV Export

#### On-Demand Export

From any dashboard: **Share → PDF Reports → Generate PDF**
From Discover: **Share → CSV Reports → Generate CSV**

Reports are generated asynchronously by a headless Chromium browser (PDF) or directly from Elasticsearch scroll API (CSV). Track status and download under **Stack Management → Reporting**.

| Format | Source | Best for |
|--------|--------|---------|
| PDF | Dashboard (Chromium render) | Executive/stakeholder reports, visualizations |
| CSV | Discover saved search | Data exports, compliance logs, bulk analysis |
| PNG | Individual visualization panel | Embedding in documents or tickets |

**PDF rendering gotcha:** the Chromium renderer uses the dashboard's saved time range and filters. If the dashboard uses a relative time range (`last 7 days`), the PDF captures data at generation time — which is usually what you want for scheduled reports. If it uses an absolute range, the PDF will always show the same historical window.

#### Scheduled Reports

Configure via the dashboard Share dialog:
1. Open the target dashboard.
2. **Share → PDF Reports → Generate report → Schedule** tab.
3. Set frequency (daily, weekly, monthly, custom cron).
4. Enter recipient emails (requires an email connector to be configured).
5. Save the schedule.

For CSV: same flow via **Share → CSV Reports** from a saved Discover search.

**Requirement:** an SMTP email connector must exist in **Stack Management → Connectors**. Reports cannot be emailed without it.

#### Reporting API

Generate reports programmatically (useful in CI/CD pipelines or external schedulers):

```bash
# Generate a PDF of a specific dashboard
DASHBOARD_ID="abc123-your-dashboard-uuid"
KIBANA_URL="https://kibana.internal:5601"
API_KEY="<base64-encoded-id:api_key>"

curl -s -X POST "${KIB
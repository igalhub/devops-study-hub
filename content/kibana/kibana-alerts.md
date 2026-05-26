---
title: Alerting & Reporting
module: kibana
duration_min: 20
difficulty: intermediate
tags: [kibana, alerting, rules, connectors, reporting, elk]
exercises: 3
---

## Overview
Kibana's alerting system (formerly known as Watcher in its early form) lets you define rules that run on a schedule against Elasticsearch data and trigger actions through connectors when conditions are met. For DevOps, this means you can alert on log error rates, metric thresholds, and ML anomalies from the same tool you use for dashboards — without needing a separate alerting system for Elasticsearch-backed data. Reporting adds scheduled PDF/CSV delivery of dashboards and Discover searches to stakeholders.

## Concepts

### Kibana Alerting Architecture

Three components:

| Component | Role |
|---|---|
| **Rule** | Defines what to check, how often, and the threshold condition |
| **Connector** | Defines how to notify (email, Slack, webhook, etc.) |
| **Action** | Binds a rule outcome to a connector; runs on alert/recovery |

Rules run inside Kibana on a schedule using a background task manager. Rule state is persisted in the `.kibana` index. Each rule can have multiple actions with different conditions (on active, on recovery, on every interval the alert stays active).

Navigate to: **Stack Management → Rules** (or **Observability → Alerts → Rules** depending on your Kibana version).

### Built-in Rule Types

#### Elasticsearch Query Rule
Most flexible. Run any Elasticsearch query; alert when result count or aggregation crosses a threshold.

Configuration:
- **Index**: which indices to query (e.g., `logs-*`)
- **Query**: KQL or Elasticsearch DSL
- **Aggregation**: count, or a metric aggregation (sum, avg, max)
- **Group by**: field to group results (one alert instance per group value)
- **Threshold**: condition and value (count > 50, avg > 500)
- **Time window**: rolling window for the query (last 5 minutes)
- **Check interval**: how often the rule runs (every 1 minute)

Example: alert if error count exceeds 100 in any 5-minute window, grouped by `service.name`:

```
Index: logs-*
Query (KQL): level: ERROR
Aggregate: Count
When: count IS ABOVE 100
Over: 5 minutes
Group by: service.name (top 10)
Run every: 1 minute
```

This creates one alert *instance* per service that breaches the threshold.

#### Threshold Rule (Metrics)
Purpose-built for metric threshold alerting on time series data. Simpler to configure than an ES query rule for straightforward scenarios.

- Works on `metrics-*` and `metricbeat-*` indices.
- Supports: above, below, above or below, between.
- Can set multiple conditions combined with AND/OR.

#### Anomaly Detection Rule (ML)
Fires when an Elastic ML anomaly detection job finds anomalies scoring above a configured threshold.

- Requires an active ML anomaly detection job.
- **Anomaly score threshold**: 50 (moderate), 75 (major), 90 (critical).
- Useful for surfacing unexpected patterns (traffic spikes, unusual error rates) without defining explicit thresholds.

### Alert Lifecycle

```
INACTIVE  →  [condition met]  →  ACTIVE  →  [condition clears]  →  RECOVERED
                                    │
                              [still active]
                                    │
                              ACTIVE (re-notifies if configured)
```

- **Active**: condition is currently breaching threshold. Actions with "When: Active" trigger.
- **Recovered**: condition has cleared. Actions with "When: Recovered" trigger — critical for automated "all clear" notifications.
- **Flapping detection**: Kibana tracks rules that rapidly alternate between active and recovered and can suppress noisy flapping alerts.

Action frequency options:
- **On check intervals** (every run while active) — can be very noisy.
- **On custom intervals** (e.g., every 4 hours while active).
- **Only on status change** (alert → active, active → recovered) — the recommended setting for most ops alerts.

### Connectors

Connectors are reusable notification channels. Create them once and reference them from multiple rules.

Navigate to: **Stack Management → Connectors → Create connector**

| Connector | Use case |
|---|---|
| Email (SMTP) | Send structured alert emails |
| Slack | Post to a Slack channel via incoming webhook |
| PagerDuty | Create/resolve PagerDuty incidents via Events API v2 |
| Webhook | HTTP POST to any URL (generic integration) |
| Jira | Create Jira issues on alert |
| ServiceNow | Create ITSM incidents |
| Microsoft Teams | Post to Teams channel |
| OpsGenie | Create OpsGenie alerts |

#### Slack connector configuration

```json
{
  "name": "Slack #alerts-prod",
  "connector_type_id": ".slack",
  "config": {
    "webhookUrl": "https://hooks.slack.com/services/T00/B00/XXXX"
  }
}
```

Action body (Mustache template):

```
*Alert:* {{rule.name}}
*Status:* {{alert.actionGroup}}
*Condition:* {{context.conditions}}
*Value:* {{context.value}}
*Service:* {{context.group}}
```

#### PagerDuty connector
The PagerDuty connector uses the Events API v2. Configure:
- **Integration key**: from your PagerDuty service's Events API v2 integration.
- **Event action**: `trigger` (on active), `resolve` (on recovery).
- **Severity**: `critical`, `error`, `warning`, `info`.

Map alert recovery → event action `resolve` to auto-resolve PagerDuty incidents when the condition clears.

#### Webhook connector
Use for integrations not covered by built-in connectors. HTTP POST with JSON body.

```json
{
  "name": "Custom Webhook",
  "connector_type_id": ".webhook",
  "config": {
    "url": "https://internal-alertmanager/api/alerts",
    "method": "post",
    "headers": {
      "Authorization": "Bearer {{secrets.token}}",
      "Content-Type": "application/json"
    }
  }
}
```

### Stack Monitoring Alerts
Stack Monitoring (under **Stack Management → Stack Monitoring**) provides built-in alerts for the Elastic Stack itself:

| Alert | Condition |
|---|---|
| Cluster health | Elasticsearch cluster status is yellow or red |
| Disk usage | Data node disk above threshold (e.g., 85%) |
| CPU usage | Node CPU above threshold |
| JVM memory | JVM heap > 85% |
| Logstash pipeline throughput | Events/second drops significantly |
| Kibana task manager | Task execution failures |

These alerts are pre-built — you just need to configure connectors and enable them. Essential for monitoring your monitoring infrastructure.

### Reporting: PDF and CSV Export

#### On-demand export
From any dashboard or Discover session:
- **Share → PDF Reports** — generates a paginated PDF of the current dashboard view.
- **Share → CSV Reports** — exports the raw Discover search results as CSV.

Reports are generated asynchronously. Kibana sends an email (if email connector is configured) or you download from **Stack Management → Reporting**.

#### Scheduled Reports
Kibana can generate and email reports on a schedule:

**From a dashboard**: Share → PDF Reports → Generate report → **Schedule** tab → set frequency and recipient emails.

Behind the scenes, Kibana uses a headless Chromium instance to render dashboards. The report captures the dashboard exactly as configured, with the time range at generation time.

CSV reports from Discover use the saved search's query and respect the time range at report run time — useful for automated daily log summaries.

Requirements for email delivery: an email connector must be configured in **Stack Management → Connectors**.

## Examples

### Full alert configuration: 5xx error rate

Rule type: **Elasticsearch query**

```yaml
name: "High 5xx Error Rate - Production"
rule_type: ".es-query"
schedule: "1m"           # run every minute
params:
  index: ["logs-*"]
  query: '{"kql": "http.response.status_code >= 500 AND environment: production"}'
  timeWindowSize: 5
  timeWindowUnit: "m"
  threshold: [50]
  thresholdComparator: ">"
  aggType: "count"
  groupBy: "top"
  termField: "service.name"
  termSize: 10

actions:
  # On alert active
  - id: slack-connector-id
    group: "query matched"
    frequency:
      notifyWhen: "onActionGroupChange"
    params:
      message: ":red_circle: *{{context.group}}* has {{context.value}} 5xx errors in 5min (threshold: 50)"

  # On recovery
  - id: slack-connector-id
    group: "recovered"
    params:
      message: ":white_check_mark: *{{context.group}}* 5xx error rate has recovered"
```

### Reporting API — generate programmatically

```bash
# Trigger a PDF report generation
curl -X POST "http://kibana:5601/api/reporting/generate/printablePdfV2" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey <base64-encoded-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jobParams": {
      "browserTimezone": "UTC",
      "layout": {"id": "print"},
      "objectType": "dashboard",
      "savedObjectId": "dashboard-uuid-here",
      "title": "Weekly Operations Report"
    }
  }'
```

## Exercises

1. Configure an Elasticsearch query rule that alerts when the 95th percentile response time of the `checkout-service` exceeds 2000 ms, measured over a 10-minute rolling window, checked every 2 minutes. Specify all required fields: index, KQL query, aggregation type, aggregation field, threshold, and check interval. Include both an active and a recovery action using a Slack connector.

2. A PagerDuty incident is being created every time an alert fires but never auto-resolved, causing PagerDuty to accumulate stale incidents. Identify the misconfiguration and describe exactly what needs to be changed in Kibana to enable automatic incident resolution.

3. Your security team needs a weekly CSV report every Monday at 06:00 UTC containing all authentication failure events from the past 7 days, with fields `@timestamp`, `user.name`, `source.ip`, and `error.message`. Describe how to set this up using Kibana Discover and the Reporting feature, including how to save the search and configure the schedule.

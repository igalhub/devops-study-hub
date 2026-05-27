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

The design philosophy centers on three decoupled primitives: **rules** (what to check), **connectors** (how to notify), and **actions** (which connector to call at which lifecycle stage). This separation means you define a Slack webhook once and reference it from dozens of rules. Changing a notification channel is a one-place edit, not a mass rule update. Alert instances are stateful — Kibana tracks whether a condition is currently active or has recovered, enabling auto-resolution workflows in downstream tools like PagerDuty.

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

| When to use | Rule type |
|-------------|-----------|
| Standard infra metrics, no custom filtering | Metric Threshold |
| Custom KQL filters, percentile aggregations, non-metric indices | Elasticsearch Query |
| Detecting statistical anomalies without fixed thresholds | Anomaly Detection (ML) |

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

**Prerequisite:** the ML job must be in a running or closed state with results. If the job is stopped, the anomaly rule will have nothing to evaluate and will not fire — and it will fail silently unless you monitor rule execution errors in Stack Monitoring.

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

**Flapping detection:** when an alert alternates between active and recovered rapidly (e.g., a borderline threshold), Kibana marks it as **flapping** and suppresses notifications to reduce noise. Configure the lookback window and threshold under rule settings. Flapping state is visible in the Rules list — investigate the underlying instability rather than just suppressing the symptom. A flapping alert often indicates a threshold set too close to normal operating variance.

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

The `dedup_key` is automatically set by Kibana to the alert instance ID — this is what links the `trigger` and `resolve` events so PagerDuty knows which incident to close. Do not override `dedup_key` in the action template unless you have a specific reason; doing so breaks auto-resolution.

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
      "Content-Type": "application/json"
    }
  },
  "secrets": {
    "user": "kibana-alerter",
    "password": "my-secret-token"
  }
}
```

**Secrets handling:** never hardcode credentials in the `config` block. Use the `secrets` block — it is write-only (not returned by the API after creation) and encrypted at rest in the `.kibana` index. If you export a connector via the Saved Objects API, secrets are redacted and must be re-entered on import.

---

### Action Templates and Mustache Rendering

Every action body is rendered as a Mustache template at execution time. Understanding template syntax prevents malformed notifications:

```mustache
{{! Single value }}
Service: {{context.group}}

{{! Conditional block — renders if value is truthy }}
{{#context.isRecovered}}
✅ Alert has resolved
{{/context.isRecovered}}

{{! Inverted block — renders if value is falsy }}
{{^context.isRecovered}}
🔴 Alert is active — value: {{context.value}}
{{/context.isRecovered}}

{{! Triple braces skip HTML escaping — use for URLs }}
Raw URL: {{{context.alertDetailsUrl}}}
```

**Mustache gotcha:** Kibana's Mustache implementation does **not** support arbitrary JavaScript logic, loops over unknown arrays, or helper functions. If you need complex payload transformation — for example, mapping alert fields to a proprietary incident API schema — use a webhook connector pointing to a small middleware service (Lambda, Cloud Function, or internal microservice) that reshapes the payload before forwarding.

**Template debugging:** use the **Test** button inside the connector configuration in the UI to send a test payload with synthetic context values. This is the fastest way to catch template syntax errors before a rule fires in production.

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

**Disk usage gotcha:** Elasticsearch has a [disk watermark](https://www.elastic.co/guide/en/elasticsearch/reference/current/modules-cluster.html) system. At 85% (`low`), no new shards are allocated to that node. At 90% (`high`), shards are moved away. At 95% (`flood_stage`), all indices on that node are set to read-only. Alert at 80% to give yourself a response window before the 85% allocation cutoff. Once indices go read-only, you must explicitly clear the block with `PUT <index>/_settings {"index.blocks.read_only_allow_delete": null}` after freeing space — they do not recover automatically.

---

### Reporting: PDF and CSV Export

#### On-Demand Export

From any dashboard: **Share → PDF Reports → Generate PDF**
From Discover: **Share → CSV Reports → Generate CSV**

Reports are generated asynchronously by a headless Chromium browser (PDF) or directly from the Elasticsearch scroll API (CSV). Track status and download under **Stack Management → Reporting**.

| Format | Source | Best for |
|--------|--------|---------|
| PDF | Dashboard (Chromium render) | Executive/stakeholder reports, visualizations |
| CSV | Discover saved search | Data exports, compliance logs, bulk analysis |
| PNG | Individual visualization panel | Embedding in documents or tickets |

**PDF rendering gotcha:** the Chromium renderer uses the dashboard's saved time range and filters. If the dashboard uses a relative time range (`last 7 days`), the PDF captures data at generation time — which is usually what you want for scheduled reports. If it uses an absolute range, the PDF will always show the same historical window regardless of when the report is generated.

#### Scheduled Reports

Configure via the dashboard Share dialog:
1. Open the target dashboard.
2. **Share → PDF Reports → Generate report → Schedule** tab.
3. Set frequency (daily, weekly, monthly, custom cron).
4. Enter recipient emails (requires an email connector to be configured).
5. Save the schedule.

For CSV: same flow via **Share → CSV Reports** from a saved Discover search.

**Requirement:** an SMTP email connector must exist in **Stack Management → Connectors**. Reports cannot be emailed without it. If the email connector is deleted or misconfigured after a schedule is created, scheduled reports will fail silently — verify connector health periodically.

#### Reporting API

Generate reports programmatically (useful in CI/CD pipelines or external schedulers):

```bash
DASHBOARD_ID="abc123-your-dashboard-uuid"
KIBANA_URL="https://kibana.internal:5601"
API_KEY="<base64-encoded-id:api_key>"

# Step 1: Submit the report generation job
JOB_URL=$(curl -s -X POST \
  "${KIBANA_URL}/api/reporting/generate/printablePdfV2" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"jobParams\": \"(browserTimezone:UTC,layout:(dimensions:(height:1080,width:1920),id:preserve_layout),locatorParams:!((id:DASHBOARD_APP_LOCATOR,params:(dashboardId:'${DASHBOARD_ID}',preserveSavedFilters:!t,timeRange:(from:now-7d,to:now),useHash:!f,viewMode:view))),objectType:dashboard,title:'Weekly Ops Report',version:'8.8.0')\"
  }" | jq -r '.path')

echo "Report job queued at: ${JOB_URL}"

# Step 2: Poll until complete (status: completed)
while true; do
  STATUS=$(curl -s \
    "${KIBANA_URL}${JOB_URL}" \
    -H "Authorization: ApiKey ${API_KEY}" | jq -r '.status')
  echo "Status: ${STATUS}"
  [[ "$STATUS" == "completed" ]] && break
  sleep 5
done

# Step 3: Download the PDF
curl -s \
  "${KIBANA_URL}${JOB_URL}/download" \
  -H "Authorization: ApiKey ${API_KEY}" \
  -o "weekly-ops-report.pdf"

echo "Report saved to weekly-ops-report.pdf"
```

**API gotcha:** the `jobParams` string is URL-encoded RISON (a compact JSON-like format). Constructing it manually is error-prone. The easiest way to get a valid `jobParams` value is to trigger a report from the UI, then inspect the POST request in your browser's developer tools Network tab and copy the `jobParams` from the request body.

---

## Examples

### Example 1: High Error Rate Alert with Slack Notification

**Scenario:** alert when error-level logs exceed 50 events per minute in the `production` environment, grouped by service.

**Step 1 — Create the Slack connector:**

```bash
curl -X POST "https://kibana.internal:5601/api/actions/connector" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${KIBANA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Slack #prod-alerts",
    "connector_type_id": ".slack",
    "config": {
      "webhookUrl": "https://hooks.slack.com/services/T00/B00/XXXX"
    }
  }' | jq '{id: .id, name: .name}'
# Save the returned "id" as CONNECTOR_ID
```

**Step 2 — Create the rule via API:**

```bash
curl -X POST "https://kibana.internal:5601/api/alerting/rule" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${KIBANA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "High Error Rate - Production",
    "rule_type_id": ".es-query",
    "consumer": "alerts",
    "schedule": { "interval": "1m" },
    "params": {
      "index": ["logs-*"],
      "timeField": "@timestamp",
      "timeWindowSize": 1,
      "timeWindowUnit": "m",
      "esQuery": "{\"query\":{\"bool\":{\"filter\":[{\"term\":{\"log.level\":\"error\"}},{\"term\":{\"labels.env\":\"production\"}}]}}}",
      "size": 0,
      "aggType": "count",
      "thresholdComparator": ">",
      "threshold": [50],
      "termField": "service.name",
      "termSize": 20
    },
    "actions": [
      {
        "id": "<CONNECTOR_ID>",
        "group": "query matched",
        "params": {
          "message": ":red_circle: *High error rate*\nService: {{context.group}}\nErrors in last 1m: {{context.value}}\nThreshold: 50\n{{context.alertDetailsUrl}}"
        },
        "frequency": {
          "notify_when": "onActionGroupChange"
        }
      },
      {
        "id": "<CONNECTOR_ID>",
        "group": "recovered",
        "params": {
          "message": ":white_check_mark: *Recovered*: {{context.group}} error rate is back to normal."
        },
        "frequency": {
          "notify_when": "onActionGroupChange"
        }
      }
    ]
  }'
```

**Step 3 — Verify:**

```bash
# List rules and check the new rule's status
curl -s "https://kibana.internal:5601/api/alerting/rules/_find?search=High+Error+Rate" \
  -H "Authorization: ApiKey ${KIBANA_API_KEY}" | jq '.data[] | {name, enabled, execution_status}'

# Expected output:
# {
#   "name": "High Error Rate - Production",
#   "enabled": true,
#   "execution_status": { "status": "ok", "last_execution_date": "..." }
# }
```

Navigate to **Stack Management → Rules**, find the rule, and click **Run now** to force an immediate execution and confirm it reaches Elasticsearch without errors.

---

### Example 2: PagerDuty Alert with Auto-Resolution for CPU Spike

**Scenario:** page on-call when any host's CPU exceeds 90% for 5 minutes, and auto-resolve when it drops below threshold.

**Step 1 — Create the PagerDuty connector:**

```bash
curl -X POST "https://kibana.internal:5601/api/actions/connector" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${KIBANA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PagerDuty Infra On-Call",
    "connector_type_id": ".pagerduty",
    "config": {
      "apiUrl": "https://events.pagerduty.com/v2/enqueue"
    },
    "secrets": {
      "routingKey": "your-32-char-integration-key"
    }
  }' | jq '{id: .id}'
```

**Step 2 — Create the Metric Threshold rule via UI:**

Navigate to **Stack Management → Rules → Create rule → Metric threshold**.

```
Name:       CPU High - Infrastructure
Check every: 1 minute

Conditions:
  WHEN system.cpu.total.norm.pct
  IS ABOVE 0.90
  FOR THE LAST 5 minutes

Group alerts by: host.name

Actions — Threshold met:
  Connector:    PagerDuty Infra On-Call
  Event action: trigger
  Severity:     critical
  Summary:      CPU alert: {{context.group}} at {{context.value}}%

Actions — Recovered:
  Connector:    PagerDuty Infra On-Call
  Event action: resolve
  Summary:      CPU recovered: {{context.group}}
```

**Step 3 — Verify auto-resolution works:**

```bash
# Simulate high CPU on a test host using stress
stress --cpu 8 --timeout 360 &

# After ~5 minutes, check PagerDuty for a new incident
# Kill the stress process — CPU drops
kill %1

# PagerDuty incident should auto-resolve within 1-2 minutes
# (one rule execution cycle after CPU drops below 0.90)
```

**What to check:** in the Kibana Rules UI, the alert instance for the stressed host should transition from **Active** → **Recovered** in the Alerts tab. A corresponding `resolve` event should appear in the PagerDuty incident timeline.

---

### Example 3: Scheduled Weekly PDF Report via API in a CI/CD Pipeline

**Scenario:** a GitLab CI job runs every Monday morning, generates a PDF of the weekly operations dashboard, and uploads it to an S3 bucket for the management team.

```yaml
# .gitlab-ci.yml
stages:
  - reports

weekly_ops_report:
  stage: reports
  image: alpine:3.18
  before_script:
    - apk add --no-cache curl jq
  script:
    - |
      KIBANA_URL="https://kibana.internal:5601"
      DASHBOARD_ID="${OPS_DASHBOARD_ID}"   # set as GitLab CI variable

      echo "Submitting report job..."
      RESPONSE=$(curl -sf -X POST \
        "${KIBANA_URL}/api/reporting/generate/printablePdfV2" \
        -H "kbn-xsrf: true" \
        -H "Authorization: ApiKey ${KIBANA_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"jobParams\": \"${REPORT_JOB_PARAMS}\"}")
        # REPORT_JOB_PARAMS: captured from browser dev tools, stored as CI variable

      JOB_PATH=$(echo "$RESPONSE" | jq -r '.path')
      echo "Job path: ${JOB_PATH}"

      # Poll with a 5-minute timeout
      ELAPSED=0
      while [ $ELAPSED -lt 300 ]; do
        STATUS=$(curl -sf "${KIBANA_URL}${JOB_PATH}" \
          -H "Authorization: ApiKey ${KIBANA_API_KEY}" | jq -r '.status')
        echo "Status: ${STATUS} (${ELAPSED}s elapsed)"
        [ "$STATUS" = "completed" ] && break
        [ "$STATUS" = "failed" ] && echo "Report failed" && exit 1
        sleep 15
        ELAPSED=$((ELAPSED + 15))
      done

      [ "$STATUS" != "completed" ] && echo "Timeout waiting for report" && exit 1

      # Download PDF
      curl -sf "${KIBANA_URL}${JOB_PATH}/download" \
        -H "Authorization: ApiKey ${KIBANA_API_KEY}" \
        -o "weekly-ops-$(date +%Y-%m-%d).pdf"

      echo "Report downloaded successfully"
  artifacts:
    paths:
      - "weekly-ops-*.pdf"
    expire_in: 30 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'  # triggered by GitLab scheduled pipeline
```

**Verify:** the PDF artifact appears in the GitLab job artifacts panel. Open it and confirm the time range reflects the past 7 days (not a stale absolute range). If the PDF shows the wrong data window, check the dashboard's saved time range in Kibana — update it to a relative range before re-capturing `jobParams`.

---

### Example 4: Webhook Connector Bridging Kibana Alerts to Prometheus Alertmanager

**Scenario:** your team uses Prometheus Alertmanager for routing and silencing. You want Kibana log-based alerts to flow through the same pipeline.

**Step 1 — Create the webhook connector:**

```bash
curl -X POST "https://kibana.internal:5601/api/actions/connector" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${KIBANA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Prometheus Alertmanager",
    "connector_type_id": ".webhook",
    "config": {
      "url": "https://alertmanager.internal:9093/api/v2/alerts",
      "method": "post",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }'
```

**Step 2 — Configure the action body** to match Alertmanager's expected format:

```json
[
  {
    "labels": {
      "alertname": "{{rule.name}}",
      "service": "{{context.group}}",
      "severity": "critical",
      "source": "kibana"
    },
    "annotations": {
      "summary": "{{context.conditions}}",
      "value": "{{context.value}}",
      "kibana_url": "{{{context.alertDetailsUrl}}}"
    },
    "endsAt": "{{#context.isRecovered}}{{date}}{{/context.isRecovered}}"
  }
]
```

**Note:** Alertmanager resolves alerts when it receives the same label set with `endsAt` set to a past or current timestamp. The Mustache conditional `{{#context.isRecovered}}` populates `endsAt` only on recovery; for active alerts it is omitted, which Alertmanager treats as still-firing.

**Step 3 — Verify:**

```bash
# Check Alertmanager API for the alert after triggering
curl -s "https://alertmanager.internal:9093/api/v2/alerts" | \
  jq '.[] | select(.labels.source == "kibana") | {alertname: .labels.alertname, status: .status.state}'
```

---

## Exercises

### Exercise 1: Create a Log Error Spike Rule and Validate Execution

**Goal:** practice configuring an Elasticsearch Query rule end-to-end, including understanding the query and threshold parameters.

1. In your Kibana instance, navigate to **Stack Management → Rules → Create rule** and choose **Elasticsearch query**.
2. Configure the rule to alert when the count of documents matching `log.level: "error"` in `logs-*` exceeds **10** in the last **2 minutes**. Run every **1 minute**. Do not add an action yet.
3. Save the rule. On the Rules list page, find your rule and click **Run now** to force an execution.
4. Examine the execution result in the **Execution history** tab. Identify:
   - Whether the rule status is `ok` or `active`.
   - The last execution duration.
   - If it's `ok` (no alert fired), manually index 15 error-level documents into `logs-*` using the Kibana Dev Console (`POST logs-test/_doc`) and run the rule again.
5. Explain in writing why the rule might still show `ok` even if errors exist — consider the time window, the `@timestamp` field, and whether your test documents have the correct timestamp.

---

### Exercise 2: Build a PagerDuty Connector with Correct Recovery Configuration

**Goal:** understand the two-action pattern required for auto-resolution and diagnose a common misconfiguration.

1. Create a PagerDuty connector (use a test service integration key, or use a webhook connector pointed at `https://webhook.site` as a stand-in).
2. Create an Elasticsearch Query rule that would alert on a condition you can trigger on demand (e.g., count of documents with `test.severity: "critical"` in a test index exceeding 0).
3. Attach **only** the trigger action (active group). Do **not** add the recovery action. Fire the alert by indexing a matching document.
4. Wait for the alert to appear as **Active** in the Alerts tab. Then delete the triggering document and wait for the rule to mark the alert as **Recovered**.
5. Observe that no recovery notification was sent (check webhook.site or PagerDuty). Add the `recovered` action with the resolve event action.
6. Re-trigger and re-resolve. Confirm the recovery action fires. Document what would have happened in production if the recovery action had been missing from day one.

---

### Exercise 3: Generate a Parameterized CSV Report via the Reporting API

**Goal:** automate report generation without the UI — a common requirement for compliance or data pipeline use cases.

1. In Kibana Discover, create a saved search that filters `logs-*` for `log.level: "error"` over the last 24 hours. Save it as `Daily Error Log Export`.
2. From the Discover **Share** menu, trigger a CSV report manually and download it to confirm it contains data.
3. In the browser developer tools, inspect the POST request sent when you clicked **Generate CSV**. Copy the `jobParams` value from the request body.
4. Use `curl` to submit the same report job via the API, poll for completion, and download the CSV file to your local machine. Script this as a shell function that accepts `DASHBOARD_ID` and `OUTPUT_FILE` as arguments.
5. Extend the script to fail with a non-zero exit code if the report status becomes `failed` or if polling exceeds 3 minutes. Explain when a CSV report might fail (hint: scroll context timeout, index not found, insufficient permissions).

---

### Exercise 4: Diagnose a Misconfigured Alert Using Task Manager Metrics

**Goal:** develop operational intuition for alert reliability — not just creating alerts, but knowing when they're broken.

1. Navigate to **Stack Management → Stack Monitoring → Kibana → Task Manager** (requires monitoring to be enabled).
2. Identify the following metrics and record their current values:
   - `Drift` (how far behind scheduled executions are running)
   - `Worker utilization`
   - `Failed tasks` count
3. Create a rule with a 10-second interval (the minimum). Observe whether task manager drift increases.
4. Answer the following:
   - What does high drift mean for alert reliability? Give a concrete example involving an incident response SLA.
   - If `failed tasks` is non-zero, where would you look to find the root cause? (Hint: Kibana server logs, rule execution history, Elasticsearch cluster health.)
   - What two operational changes could you make to reduce drift without changing rule logic?
5. Delete the 10-second rule after the exercise to reduce task manager load.
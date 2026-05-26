---
title: Integrations & Alert Routing
module: opsgenie
duration_min: 20
difficulty: intermediate
tags: [opsgenie, integrations, routing, prometheus, datadog, api, deduplication]
exercises: 3
---

## Overview
Opsgenie's value compounds when you connect it to your monitoring stack. Every monitoring tool you run — Prometheus, Grafana, Datadog, CloudWatch — generates alerts. Without routing intelligence, all of them land in a single noise pile. Opsgenie's integration rules give you fine-grained control: which team receives which alert, at what priority, and with what deduplication logic. This lesson covers the REST API, the major integrations, and the routing mechanics that make the difference between useful alerting and alert fatigue.

## Concepts

### Opsgenie REST API
The Opsgenie API is the integration backbone. Understanding it directly helps when native integrations don't exist or need customisation.

Base URL: `https://api.opsgenie.com/v2/`

Authentication: API key in the `Authorization` header.

```bash
# Create an alert via REST API
curl -X POST "https://api.opsgenie.com/v2/alerts" \
  -H "Content-Type: application/json" \
  -H "Authorization: GenieKey YOUR_API_KEY" \
  -d '{
    "message": "High CPU usage on web-01",
    "alias": "web-01-high-cpu",
    "description": "CPU usage exceeded 90% for 5 minutes on web-01",
    "responders": [{"name": "platform-team", "type": "team"}],
    "tags": ["cpu", "infrastructure", "production"],
    "priority": "P2",
    "details": {
      "host": "web-01",
      "metric": "cpu_usage_percent",
      "value": "92.4"
    }
  }'

# Close (resolve) an alert by alias
curl -X POST "https://api.opsgenie.com/v2/alerts/web-01-high-cpu/close?identifierType=alias" \
  -H "Authorization: GenieKey YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"note": "CPU usage returned to normal"}'

# Get alert details
curl -X GET "https://api.opsgenie.com/v2/alerts?query=status:open AND tag:production" \
  -H "Authorization: GenieKey YOUR_API_KEY"
```

The `alias` field is the deduplication key — two alerts with the same alias are treated as the same alert.

### Integrations Overview

Opsgenie integrations are configured per-team and generate an **integration API key** that the external tool sends alerts to.

Navigate to: **Teams → [Team] → Integrations → Add Integration**

Each integration has:
- A unique API key (used by the external tool).
- Optional **integration rules** for conditional routing and transformation.
- Assigned team (default responder).

| Integration | Type | Notes |
|---|---|---|
| Prometheus Alertmanager | Webhook | Configure in Alertmanager `receivers` |
| Grafana | Native | Built-in in Grafana contact points |
| Datadog | API key | Datadog webhook or Opsgenie monitor action |
| AWS CloudWatch | API key | Via CloudWatch SNS → Lambda → Opsgenie, or direct |
| Jira Software | Bi-directional | Alert → Jira issue; Jira issue → close alert |
| PagerDuty migration | Import tool | Migrate schedules/escalations |
| Generic webhook | Generic API | For anything not natively supported |

### Prometheus / Alertmanager Integration
In Prometheus, alert rules fire → Alertmanager routes → Opsgenie.

Alertmanager configuration:

```yaml
# alertmanager.yml
global:
  opsgenie_api_key: "YOUR_OPSGENIE_API_KEY"

receivers:
  - name: "opsgenie-platform"
    opsgenie_configs:
      - api_key: "TEAM_INTEGRATION_KEY"
        message: '{{ template "opsgenie.default.message" . }}'
        priority: '{{ if eq .GroupLabels.severity "critical" }}P1{{ else if eq .GroupLabels.severity "warning" }}P2{{ else }}P3{{ end }}'
        tags: '{{ range .GroupLabels.SortedPairs }}{{ .Name }}:{{ .Value }},{{ end }}'
        details:
          env: '{{ .GroupLabels.env }}'
          alertname: '{{ .GroupLabels.alertname }}'

route:
  receiver: "opsgenie-platform"
  group_by: ["alertname", "env", "service"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
```

### Grafana Integration
In Grafana, configure Opsgenie as a contact point:

**Alerting → Contact Points → Add contact point → Opsgenie**

Fields:
- **API Key**: Opsgenie team integration key.
- **Auto close**: resolve the Opsgenie alert when Grafana alert recovers (always enable this).
- **Override priority**: override the static priority, or use label templating.
- **Message**: Grafana annotation template: `{{ $labels.alertname }} - {{ $labels.instance }}`

### Datadog Integration
Two methods:

**Method 1 — Datadog webhook to Opsgenie**:
Datadog → Integrations → Webhooks → add Opsgenie API endpoint as webhook URL with the integration key.

**Method 2 — Opsgenie integration for Datadog**:
In Opsgenie, add the Datadog integration type, which generates an API key. In Datadog, configure the Opsgenie mention (`@opsgenie-team-name`) in monitor notifications.

Datadog → Monitor → Notification message:

```
{{#is_alert}}@opsgenie-platform-team{{/is_alert}}
{{#is_recovery}}@opsgenie-platform-team{{/is_recovery}}
```

### CloudWatch Integration
CloudWatch alarms → SNS topic → Lambda function → Opsgenie API.

Example Lambda (Python) for CloudWatch → Opsgenie:

```python
import json
import urllib.request

OPSGENIE_API_KEY = "YOUR_KEY"

def lambda_handler(event, context):
    sns_message = json.loads(event["Records"][0]["Sns"]["Message"])
    alarm_name = sns_message["AlarmName"]
    new_state = sns_message["NewStateValue"]

    if new_state == "ALARM":
        payload = {
            "message": f"CloudWatch: {alarm_name}",
            "alias": f"cloudwatch-{alarm_name}",
            "priority": "P2",
            "tags": ["cloudwatch", "aws"]
        }
        action = "alerts"
    else:
        payload = {"note": "Alarm cleared"}
        action = f"alerts/cloudwatch-{alarm_name}/close?identifierType=alias"

    req = urllib.request.Request(
        f"https://api.opsgenie.com/v2/{action}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"GenieKey {OPSGENIE_API_KEY}",
                 "Content-Type": "application/json"},
        method="POST"
    )
    urllib.request.urlopen(req)
```

### Integration Rules (Conditions and Actions)
Integration rules allow you to modify, route, or suppress alerts based on incoming alert fields — before the escalation policy fires.

Rules are evaluated in order; first matching rule wins (unless "continue" is checked).

**Condition types:**

| Condition | Example |
|---|---|
| Message contains | `message contains "OutOfMemory"` |
| Tags match | `tags include "production"` |
| Priority equals | `priority is P1` |
| Alert source | `source is "Prometheus"` |
| Custom detail field | `details.env equals "production"` |

**Action types:**

| Action | Use |
|---|---|
| Set priority | Override priority based on severity label |
| Add responder (team) | Route to a different team |
| Add tag | Enrich alert with environment or service tag |
| Set alias | Control deduplication key |
| Acknowledge | Auto-acknowledge low-noise alerts |
| Suppress | Drop the alert entirely (maintenance windows) |
| Change message | Normalise alert titles across tools |

Example integration rule: route DB alerts to the database team, override to P1 if severity=critical.

```
Rule 1: IF tags include "database" AND details.severity == "critical"
  THEN set priority to P1, add responder team: "database-team"

Rule 2: IF tags include "database"
  THEN add responder team: "database-team"

Rule 3 (default): route to platform-team
```

### Tags and Priorities (P1–P5)

| Priority | Meaning | Typical use |
|---|---|---|
| P1 | Critical | Production down, data loss, security breach |
| P2 | High | Major feature broken, significant degradation |
| P3 | Moderate | Non-critical issue, workaround exists |
| P4 | Low | Minor issue, informational |
| P5 | Informational | No action required |

Priority determines:
- Which notification methods fire (users configure per-priority notification rules).
- Whether the alert is counted in SLA breach metrics.
- Sorting in the alert list.

Tags are free-form strings. Convention: `env:production`, `team:platform`, `service:checkout`. Tags are searchable and filterable in the alert list and analytics.

### Deduplication and Suppression

**Deduplication** prevents creating duplicate alerts for the same condition. Controlled by the `alias` field — two alerts with the same alias merge into one, with subsequent notifications updating the existing alert.

Set alias to a stable identifier: `{service}-{alert_name}-{environment}`.

If the monitoring tool sends the same alert repeatedly (e.g., Prometheus repeats every 4 hours), Opsgenie adds notes to the existing alert rather than creating new ones.

**Suppression rules** (under integration rules or maintenance windows) drop matching alerts before they create Opsgenie notifications.

Maintenance window: **Settings → Maintenance** — during a scheduled maintenance, alerts matching specified filters are suppressed. Essential before planned outages to prevent alert storms.

```
Maintenance window:
  Name: "Planned DB maintenance 2024-03-20 02:00-04:00 UTC"
  Start: 2024-03-20 02:00 UTC
  End:   2024-03-20 04:00 UTC
  Affected: alerts with tag "database" OR responders include "database-team"
  Action: Suppress (create but suppress notification)
```

### Heartbeat Monitoring
A **heartbeat** is a signal that a system is alive — Opsgenie alerts if it stops receiving the signal.

Use case: monitoring cron jobs, batch processes, or agents that don't produce alerts when they fail; they simply go silent.

```bash
# Send a heartbeat ping (the system runs this on a schedule)
curl -X GET "https://api.opsgenie.com/v2/heartbeats/my-backup-job/ping" \
  -H "Authorization: GenieKey YOUR_API_KEY"
```

If the ping is not received within the heartbeat interval, Opsgenie creates an alert to the configured team.

Configure at: **Settings → Heartbeat Monitoring → Add Heartbeat**

Fields: name, interval (e.g., 10 minutes), interval unit, alert message, responder team.

## Examples

### Full routing logic for a multi-team setup

```
Integration: Prometheus (team: platform, default P3)

Rule 1: severity=critical AND env=production → P1, responder: platform-team + management-team
Rule 2: service=database → responder: database-team
Rule 3: service=frontend AND severity=warning → suppress (frontend has own alerting)
Rule 4: env=staging → P5, suppress notifications
Rule 5 (default): route to platform-team, keep priority from source
```

## Exercises

1. Write the complete Alertmanager `receivers` and `route` configuration to send Prometheus alerts to Opsgenie, where: `severity: critical` maps to P1, `severity: warning` maps to P2, all other alerts default to P3. The alert alias must be constructed from `alertname` + `instance` labels to ensure per-host deduplication.

2. Design the integration rules for a scenario where your Opsgenie integration receives alerts from three sources: Prometheus, Datadog, and a custom app. Rules required: (a) any alert tagged `security` goes to the security team at P1 regardless of source; (b) Datadog alerts tagged `staging` are suppressed entirely; (c) custom app alerts with `error_type: transient` are acknowledged automatically. Write each rule as a condition + action pair.

3. A batch job runs every 6 hours and must be monitored for silent failures. The job doesn't emit alerts when it fails — it just stops running. Explain how to use Opsgenie heartbeat monitoring for this: what the job must do, how to configure the heartbeat, what happens when the job fails, and how to test that the alerting works without actually failing the job.

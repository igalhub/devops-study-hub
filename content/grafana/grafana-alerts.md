---
title: Alerting & Notifications
module: grafana
duration_min: 20
difficulty: intermediate
tags: [grafana, alerting, contact-points, notification-policies, silences, oncall]
exercises: 3
---

## Overview
Grafana Unified Alerting (introduced in Grafana 8, default from Grafana 9) is a single alerting system that handles rule evaluation, routing, and notification delivery regardless of the backing data source. Before this, Grafana only supported per-panel alerts limited to graph panels. The unified system supports Prometheus, Loki, CloudWatch, SQL, and any other data source, and replaces the legacy Grafana alerting model. For DevOps engineers, Grafana alerting is relevant both as a standalone alerting system and as a frontend for Prometheus Alertmanager — the two integrate directly.

## Concepts

### Alert Rule Anatomy
An alert rule defines:
1. **Data source query** — what metric or log to evaluate.
2. **Condition** — threshold logic applied to the query result.
3. **Evaluation group** — how frequently and with what grouping the rule runs.
4. **Folder** — organizational unit for RBAC.
5. **Annotations and labels** — metadata attached to the alert when it fires.

**Creating a rule in the UI:** Alerting → Alert rules → New alert rule.

**Rule definition (exported as YAML for Grafana Managed Alerts):**
```yaml
apiVersion: 1
groups:
  - orgId: 1
    name: infrastructure
    folder: DevOps
    interval: 1m
    rules:
      - uid: cpu-high-uid
        title: High CPU Usage
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus-uid
            model:
              expr: 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
              intervalMs: 60000
              maxDataPoints: 43200
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              conditions:
                - evaluator:
                    params: [85]
                    type: gt
                  query:
                    params: [A]
        noDataState: NoData
        execErrState: Error
        for: 5m
        annotations:
          summary: "CPU above 85% on {{ $labels.instance }}"
          runbook_url: "https://wiki.example.com/runbooks/cpu-high"
        labels:
          severity: warning
          team: platform
```

The `for` field sets the **pending period** — the condition must hold for this duration before the alert transitions to Firing. This prevents flapping on transient spikes.

### Evaluation Groups
Rules are organized into **evaluation groups**. All rules in a group share the same evaluation interval and run sequentially within a group.

- Keep fast-responding rules (e.g., 1m interval) in separate groups from slow, expensive queries (e.g., 5m interval).
- Rules within a group share state — if the group evaluation takes longer than the interval, Grafana skips the next cycle and logs a warning.
- Group names appear in the alert UI and are useful for organizing by team or service.

### Alert State Machine
Each alert rule instance transitions through defined states:

```
Normal ──[condition true for < for duration]──► Pending
Pending ──[condition true for >= for duration]──► Firing
Firing ──[condition false]──► Normal
Normal/Pending/Firing ──[no data]──► NoData
Normal/Pending/Firing ──[eval error]──► Error
```

| State | Meaning |
|-------|---------|
| Normal | Condition not met — no alert |
| Pending | Condition met but within the `for` window |
| Firing | Condition met beyond the `for` window — alert is active |
| NoData | Query returned no data — configurable behavior |
| Error | Query or evaluation failed |

**NoData and Error behaviors** are configurable per rule: `NoData` can be treated as `Normal`, `NoData`, or `Alerting`. Same for `Error`. Choose based on whether missing data is expected (e.g., a scaled-down service) or a sign of a problem.

### Contact Points
A contact point is a notification channel — Slack, email, PagerDuty, webhook, OpsGenie, etc. A single contact point can have multiple integrations.

**Slack contact point (UI config):**
```
Name: platform-slack
Integration: Slack
Webhook URL: https://hooks.slack.com/services/...
Channel: #alerts-platform
Message: |
  {{ range .Alerts }}
  *Alert:* {{ .Annotations.summary }}
  *Severity:* {{ .Labels.severity }}
  *Status:* {{ .Status }}
  {{ end }}
```

**Email contact point:**
```
Name: oncall-email
Integration: Email
Addresses: oncall@example.com;backup@example.com
Subject: [{{ .Status | toUpper }}] {{ .GroupLabels.alertname }}
```

**PagerDuty contact point:**
```
Name: pagerduty-critical
Integration: PagerDuty
Integration Key: <service integration key>
Severity: {{ if eq .CommonLabels.severity "critical" }}critical{{ else }}warning{{ end }}
```

### Notification Policies
Notification policies are a routing tree. They match alert labels to contact points. The tree has a root policy (catch-all) and nested matchers.

**Policy routing example:**
```
Root policy → contact: default-email

├── Match: severity=critical → contact: pagerduty-critical
│     └── Match: team=database → contact: dba-pagerduty
│
├── Match: severity=warning → contact: platform-slack
│
└── Match: env=staging → contact: dev-slack
      Mute timings: business-hours-only
```

Rules: Grafana evaluates policies top-to-bottom and uses the first match (unless `Continue matching` is enabled on a node, which allows multiple policies to match the same alert).

**Key fields per policy:**
- **Matchers** — label=value pairs (exact, regex, or existence check)
- **Contact point** — where to send notifications
- **Group by** — which labels to use when grouping alerts into a single notification
- **Group wait / Group interval / Repeat interval** — timing controls to prevent notification storms

### Silences
A silence suppresses notifications for matching alerts during a defined time window. It does not stop alert evaluation — the rule still transitions states, but notifications are not sent.

**Creating a silence:**
```
Start: 2026-06-01 02:00 UTC
End:   2026-06-01 04:00 UTC
Matchers:
  - alertname=HighCPU
  - env=prod
Comment: Scheduled maintenance window — kernel upgrade
Created by: igal
```

Silences are useful for:
- Planned maintenance windows
- Known infrastructure changes that will trigger false positives
- Suppressing noisy alerts during an active incident investigation

**API-driven silence creation:**
```bash
curl -X POST http://admin:admin@localhost:3000/api/alertmanager/grafana/api/v2/silences \
  -H "Content-Type: application/json" \
  -d '{
    "matchers": [
      { "name": "env", "value": "prod", "isRegex": false },
      { "name": "alertname", "value": "HighCPU", "isRegex": false }
    ],
    "startsAt": "2026-06-01T02:00:00Z",
    "endsAt":   "2026-06-01T04:00:00Z",
    "createdBy": "igal",
    "comment":   "Kernel upgrade maintenance"
  }'
```

### Grafana vs Prometheus Alertmanager
Grafana Unified Alerting can run in two modes:

| Mode | Rules stored in | Routing handled by |
|------|----------------|--------------------|
| Grafana Managed Alerts | Grafana DB | Grafana built-in Alertmanager |
| Prometheus Rules | Prometheus / Ruler | External Alertmanager |

In the second mode, Grafana forwards alerts to an external Alertmanager (configured under **Alerting → Admin → Alertmanagers**). This is common in large deployments where Alertmanager is already the source of truth for routing.

## Examples

**End-to-end: fire a Slack alert when error rate exceeds 1%:**

1. Create a Prometheus alert rule:
   - Query A: `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) * 100`
   - Condition C: threshold > 1 (applied to A)
   - `for: 2m`, labels: `severity=warning, team=platform`

2. Create a Slack contact point with your Incoming Webhook URL.

3. Add a notification policy: match `team=platform`, route to the Slack contact point, group by `alertname`.

4. Generate errors in your test service and observe the alert transition: Normal → Pending (2 min) → Firing → Slack message received.

5. Create a silence for the alert and confirm Slack notifications stop while the alert remains in Firing state in the UI.

## Exercises

1. Write a Grafana alert rule YAML (for provisioning) that fires when the 5-minute average CPU across all nodes exceeds 90% for 3 minutes. Attach an annotation with a `runbook_url` and a label `severity=critical`.
2. Configure a notification policy tree with three levels: critical alerts go to PagerDuty, warning alerts go to Slack, and all staging-environment alerts are silenced during non-business hours using a mute timing.
3. Use the Grafana API to create a silence that suppresses all alerts with `env=staging` for a 2-hour window. Then list active silences via the API and confirm your silence appears.

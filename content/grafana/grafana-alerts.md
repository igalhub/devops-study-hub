---
title: Alerting & Notifications
module: grafana
duration_min: 30
difficulty: intermediate
tags: [grafana, alerting, contact-points, notification-policies, silences, mute-timings, oncall, provisioning]
exercises: 3
---

## Overview

Grafana Unified Alerting (introduced in Grafana 8, default from Grafana 9) is a single alerting system that handles rule evaluation, routing, and notification delivery regardless of the backing data source. Before this, Grafana only supported per-panel alerts limited to graph panels. The unified system supports Prometheus, Loki, CloudWatch, SQL, and any other data source, and replaces the legacy Grafana alerting model completely.

The alerting pipeline has four distinct stages: rules define *what* fires, evaluation groups define *when* rules run, contact points define *how* notifications are delivered, and notification policies define *who* receives which alerts. Each stage is independently configurable — you can add a new contact point without changing any rules, or change routing without rewriting alert expressions. Understanding this separation is both operationally useful and common in interviews.

Grafana alerting integrates directly with Prometheus Alertmanager — Grafana can forward alerts to an external Alertmanager instance rather than using its own built-in router. In larger organizations, Alertmanager is often already the authoritative routing system, and Grafana sits in front of it as a rule editor and visualization layer. Knowing both modes makes you more versatile in mixed-tool environments.

## Concepts

### Alert Rule Anatomy

An alert rule defines:
1. **Data source query** — what metric or log to evaluate.
2. **Condition** — threshold logic applied to the query result.
3. **Evaluation group** — how frequently and with what grouping the rule runs.
4. **Folder** — organizational unit used for RBAC permissions.
5. **Annotations and labels** — metadata attached to the alert when it fires.

**Creating a rule in the UI:**
1. Go to **Alerting → Alert rules → New alert rule**.
2. **Step 1 — Set rule name and folder**: Enter a name. Select or create a folder (e.g., "DevOps").
3. **Step 2 — Set queries and conditions**:
   - Query A: your metric query (e.g., a PromQL expression).
   - Condition step (type: Threshold or Math): defines when the alert fires. Add a new query of type **Threshold**, reference query A, and set the operator (e.g., `IS ABOVE 85`).
4. **Step 3 — Set alert evaluation behavior**:
   - **Evaluation group**: select or create a group with an interval (e.g., `1m`).
   - **Pending period** (`for`): how long the condition must hold before firing (e.g., `5m`).
5. **Step 4 — Add annotations and labels**:
   - Labels: `severity=warning`, `team=platform` — used for routing.
   - Annotations: `summary`, `description`, `runbook_url` — shown in notifications.
6. Click **Save rule and exit**.

**Rule definition (exported as YAML for Grafana Managed Alerts provisioning):**
```yaml
# /etc/grafana/provisioning/alerting/rules.yaml
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
            datasourceUid: prometheus-prod-uid
            model:
              expr: 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
              intervalMs: 60000
              maxDataPoints: 43200
          - refId: C
            datasourceUid: __expr__        # "__expr__" is the built-in expression data source
            model:
              type: threshold
              conditions:
                - evaluator:
                    params: [85]
                    type: gt              # greater than
                  query:
                    params: [A]           # references refId A
        noDataState: NoData
        execErrState: Error
        for: 5m
        annotations:
          summary: "CPU above 85% on {{ $labels.instance }}"
          description: "CPU utilization has been above 85% for more than 5 minutes."
          runbook_url: "https://wiki.example.com/runbooks/cpu-high"
        labels:
          severity: warning
          team: platform
```

The `for` field sets the **pending period** — the condition must hold continuously for this duration before the alert transitions to Firing. This is the primary mechanism for avoiding false positives from transient spikes.

### Evaluation Groups

Rules are organized into **evaluation groups**. All rules in a group share the same evaluation interval and run sequentially within the group.

**Creating an evaluation group:**
When creating or editing a rule in the UI, under **Set alert evaluation behavior**, click **New evaluation group** and set:
- **Evaluation group name**: e.g., `infrastructure-1m`
- **Evaluation interval**: e.g., `1m`

Then set the **Pending period** (the `for` duration) independently.

**Best practices:**
- Keep fast-responding rules (1m interval) in separate groups from slow, expensive queries (5m interval). A slow query blocking a group delays all subsequent rules in that group.
- Rules within a group run sequentially — if one query takes 30s and the interval is 1m, the group has only 30s left for all other rules.
- Name groups by team and interval: `platform-1m`, `platform-5m`, `dba-1m`.

### Alert State Machine

Each alert rule instance transitions through defined states:

```
Normal ──[condition met for < pending period]──► Pending
Pending ──[condition met for >= pending period]──► Firing
Firing ──[condition no longer met]──► Normal
Any state ──[no data returned]──► NoData
Any state ──[evaluation error]──► Error
```

| State | Meaning |
|-------|---------|
| Normal | Condition not met — no alert |
| Pending | Condition met but within the `for` window |
| Firing | Condition met beyond the `for` window — alert is active |
| NoData | Query returned no data — configurable behavior |
| Error | Query or evaluation failed |

**Configuring NoData and Error behavior** — each rule has separate settings:
- `noDataState`: `NoData` (default), `Alerting`, or `OK`
- `execErrState`: `Error` (default), `Alerting`, or `OK`

Choose based on what missing data means for your context. A scaled-down service returning no metrics should be `OK`. A critical service with no metrics should be `Alerting`. Set this explicitly — the default `NoData` state shows in the UI but does NOT trigger notifications unless you route the `NoData` state through your policies.

### Contact Points

A contact point is a notification channel — Slack, email, PagerDuty, webhook, OpsGenie, etc.

**Creating a contact point in the UI:**
1. Go to **Alerting → Contact points → Add contact point**.
2. Set a **Name** (e.g., `platform-slack`).
3. Click **Add contact point integration** and select the type (Slack, Email, PagerDuty, Webhook, etc.).
4. Fill in the integration-specific fields.
5. Click **Test** to send a test notification.
6. Click **Save contact point**.

A single contact point can have multiple integrations — e.g., one contact point that sends both Slack and email.

**Slack contact point configuration:**
```
Name: platform-slack
Integration: Slack
Webhook URL: https://hooks.slack.com/services/T.../B.../...
Channel: #alerts-platform
Username: Grafana
Message body:
  {{ range .Alerts }}
  *Alert:* {{ .Annotations.summary }}
  *Severity:* {{ .Labels.severity }}
  *Status:* {{ .Status }}
  *Starts At:* {{ .StartsAt }}
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
Integration Key: <service integration key from PagerDuty Events API v2>
Severity: {{ if eq .CommonLabels.severity "critical" }}critical{{ else }}warning{{ end }}
Summary: {{ .CommonAnnotations.summary }}
```

**Webhook contact point (generic HTTP):**
```
Name: custom-webhook
Integration: Webhook
URL: https://your-service.example.com/alerts
HTTP Method: POST
HTTP Headers:
  Authorization: Bearer your-token
Message: (uses Grafana's default JSON payload — includes all alert data)
```

### Notification Policies

Notification policies are a routing tree. They match alert labels to contact points. The tree has a root policy (catch-all) and nested matchers.

**Viewing and editing the policy tree:**
Go to **Alerting → Notification policies**.

The tree is structured as:
```
Root policy
├── Matcher 1
│     └── Nested matcher 1a
└── Matcher 2
```

**Editing the root policy:**
Click **Edit** on the root policy. Set:
- **Default contact point** — where all unmatched alerts go.
- **Group by** — labels used to group related alerts into a single notification (e.g., `alertname`, `cluster`).
- **Timing** — group wait, group interval, repeat interval.

**Adding a nested policy:**
Click **+ New nested policy** under any policy node.

**Policy routing example:**
```
Root policy → contact: default-email
  Group by: [alertname, cluster]
  Group wait: 30s
  Group interval: 5m
  Repeat interval: 4h

├── Match: severity=critical → contact: pagerduty-critical
│     Continue matching: false
│     └── Match: team=database → contact: dba-pagerduty
│
├── Match: severity=warning → contact: platform-slack
│
└── Match: env=staging → contact: dev-slack
      Mute timings: non-business-hours
```

**Timing controls:**
- **Group wait** — how long to wait before sending the first notification after a new group of alerts fires (buffers for grouping).
- **Group interval** — minimum time between notifications for the same group when new alerts are added.
- **Repeat interval** — how often to re-notify for an already-firing alert.

**Matchers:**
Each policy node uses matchers to filter which alerts it applies to. Matchers support:
- Exact match: `severity = critical`
- Regex match: `alertname =~ ".*CPU.*"`
- Existence check: `team` (matches any alert that has the `team` label)
- Negation: `env != prod`

### Mute Timings

Mute timings suppress notifications during specified time windows without affecting alert evaluation or routing. Unlike silences (which are ad hoc), mute timings are recurring schedules that you define once and reference from notification policies.

**Creating a mute timing:**
1. Go to **Alerting → Mute timings → Add mute timing**.
2. Set **Name** (e.g., `non-business-hours`).
3. Click **Add mute timing interval** and configure:
   - **Days of the week**: e.g., `Monday:Friday` for weekdays, `Saturday,Sunday` for weekends.
   - **Start time / End time**: in HH:MM format (24h UTC).
   - **Days of the month**, **Months**, **Years**: optional refinement for monthly patch windows.

**Example — suppress staging alerts outside business hours:**
```
Name: non-business-hours

Interval 1:
  Time range: 00:00 – 09:00  (midnight to 9am UTC)
  Days of week: Monday, Tuesday, Wednesday, Thursday, Friday

Interval 2:
  Time range: 18:00 – 24:00  (6pm to midnight UTC)
  Days of week: Monday, Tuesday, Wednesday, Thursday, Friday

Interval 3:
  Days of week: Saturday, Sunday
  (no time range = all day Saturday and Sunday)
```

**Attaching a mute timing to a notification policy:**
1. In the policy tree, click **Edit** on the policy node you want to mute.
2. Under **Mute timings**, click **Add mute timing** and select the timing name.
3. Save.

When the current time falls within any interval of the attached mute timing, notifications from that policy are suppressed. The alert still fires and is visible in the Grafana alert state view — only the notification is held.

**Critical distinction from silences:**
- **Mute timings**: configured in advance, recurring, managed as named objects referenced by policies.
- **Silences**: ad hoc, one-time (or fixed-window), managed separately, override notifications for specific label matchers.

### Silences

A silence suppresses notifications for matching alerts during a defined time window. It does not stop alert evaluation — the rule still transitions states.

**Creating a silence in the UI:**
1. Go to **Alerting → Silences → Add silence**.
2. Set:
   - **Silence start**: date/time in UTC.
   - **Silence end**: date/time in UTC. Or use **Duration** to set a relative period.
   - **Matchers**: label key/value pairs that the silence applies to. An alert must match ALL matchers to be silenced.
   - **Comment**: required — describe why this silence exists.
   - **Created by**: your name/username.
3. Click **Submit**.

**Creating a silence via API:**
```bash
curl -X POST http://admin:admin@localhost:3000/api/alertmanager/grafana/api/v2/silences \
  -H "Content-Type: application/json" \
  -d '{
    "matchers": [
      { "name": "env",       "value": "staging", "isRegex": false },
      { "name": "alertname", "value": "HighCPU",  "isRegex": false }
    ],
    "startsAt": "2026-06-01T02:00:00Z",
    "endsAt":   "2026-06-01T04:00:00Z",
    "createdBy": "igal",
    "comment":   "Kernel upgrade maintenance"
  }'
```

Response includes a `silenceID` (UUID) you can use to update or delete the silence.

**Listing active silences via API:**
```bash
curl -s http://admin:admin@localhost:3000/api/alertmanager/grafana/api/v2/silences | jq '.[] | {id, comment, state, startsAt, endsAt}'
```

**Deleting a silence:**
```bash
curl -X DELETE http://admin:admin@localhost:3000/api/alertmanager/grafana/api/v2/silences/<silenceID>
```

### Grafana vs Prometheus Alertmanager

Grafana Unified Alerting can run in two modes:

| Mode | Rules stored in | Routing handled by |
|------|----------------|--------------------|
| Grafana Managed Alerts | Grafana DB | Grafana built-in Alertmanager |
| Prometheus Rules | Prometheus / Ruler (Mimir/Thanos) | External Alertmanager |

**Forwarding to an external Alertmanager:**
1. Go to **Alerting → Admin → Alertmanagers**.
2. Click **Add Alertmanager**.
3. Enter the Alertmanager URL (e.g., `http://alertmanager:9093`).
4. Set to **Active** — Grafana forwards all alerts to this instance in addition to (or instead of) the built-in router.

This is common in large deployments where Alertmanager already manages routing, silences, and inhibition rules for a Prometheus-native stack, and Grafana is added for unified rule management and visualization.

### Provisioning Alert Rules and Contact Points as Code

Just like dashboards and data sources, alerting configuration can be provisioned from YAML files.

**Contact points provisioning:**
```yaml
# /etc/grafana/provisioning/alerting/contact-points.yaml
apiVersion: 1

contactPoints:
  - orgId: 1
    name: platform-slack
    receivers:
      - uid: slack-receiver-uid
        type: slack
        settings:
          url: "https://hooks.slack.com/services/..."
          channel: "#alerts-platform"
          text: "{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}"
```

**Notification policies provisioning:**
```yaml
# /etc/grafana/provisioning/alerting/notification-policies.yaml
apiVersion: 1

policies:
  - orgId: 1
    receiver: default-email
    group_by: [alertname, cluster]
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    routes:
      - receiver: pagerduty-critical
        matchers:
          - severity = critical
      - receiver: platform-slack
        matchers:
          - severity = warning
      - receiver: dev-slack
        matchers:
          - env = staging
        mute_time_intervals:
          - non-business-hours
```

**Mute timings provisioning:**
```yaml
# /etc/grafana/provisioning/alerting/mute-timings.yaml
apiVersion: 1

muteTimes:
  - orgId: 1
    name: non-business-hours
    time_intervals:
      - weekdays: [monday, tuesday, wednesday, thursday, friday]
        times:
          - start_time: "00:00"
            end_time: "09:00"
          - start_time: "18:00"
            end_time: "24:00"
      - weekdays: [saturday, sunday]
```

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

**API call to check current alert states:**
```bash
# List all active (firing) alerts via the Alertmanager API
curl -s http://admin:admin@localhost:3000/api/alertmanager/grafana/api/v2/alerts \
  | jq '.[] | {alertname: .labels.alertname, state: .status.state, summary: .annotations.summary}'

# List all alert rules and their current state
curl -s http://admin:admin@localhost:3000/api/prometheus/grafana/api/v1/rules \
  | jq '.data.groups[].rules[] | {name: .name, state: .state}'
```

## Exercises

1. Write a Grafana alert rule YAML (for provisioning under `/etc/grafana/provisioning/alerting/`) that fires when the 5-minute average CPU across all nodes exceeds 90% for 3 minutes. Use the expression: `100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)` for query A, and a Threshold condition step referencing A with `IS ABOVE 90`. Set `for: 3m`. Attach an annotation with `runbook_url: "https://wiki.example.com/runbooks/cpu-high"` and labels `severity=critical` and `team=platform`. Load the file and confirm the rule appears under **Alerting → Alert rules**.

2. Configure a notification policy tree with three levels: critical alerts (`severity=critical`) go to a PagerDuty contact point, warning alerts (`severity=warning`) go to a Slack contact point, and all staging-environment alerts (`env=staging`) use a mute timing that suppresses notifications outside Monday–Friday 09:00–18:00 UTC. Create the mute timing first (**Alerting → Mute timings → Add mute timing**), then attach it to the staging policy node. Verify the structure in the UI matches your intended routing.

3. Use the Grafana API to create a silence that suppresses all alerts with `env=staging` for a 2-hour window starting from now. Construct the `startsAt` and `endsAt` values using: `date -u +"%Y-%m-%dT%H:%M:%SZ"` for start, and add 2 hours for end. After POST-ing the silence, list active silences via the API and confirm your silence appears with state `active`. Then delete it using the returned `silenceID`.

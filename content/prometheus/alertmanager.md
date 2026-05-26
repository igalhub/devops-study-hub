---
title: Alertmanager
module: prometheus
duration_min: 20
difficulty: intermediate
tags: [prometheus, alertmanager, alerting, oncall, slack, pagerduty]
exercises: 3
---

## Overview
Alertmanager handles the lifecycle of alerts fired by Prometheus (and other Prometheus-compatible systems). It receives raw alert events, groups related alerts to reduce noise, routes them to the correct receiver based on labels, deduplicates repeated firings, and manages silences for planned maintenance. Understanding Alertmanager is essential for on-call work — misconfigured routing trees cause missed pages or alert storms, both of which have direct production impact. The Prometheus server evaluates alerting rules and sends alerts to Alertmanager over HTTP; Alertmanager then decides who gets notified and when.

## Concepts

### Alerting Rules in Prometheus
Alerting rules live in rule files loaded by Prometheus (same files as recording rules). A rule fires an alert when its expression returns a non-empty result for longer than the `for` duration.

```yaml
# rules/alerts.yml
groups:
  - name: availability
    rules:

      - alert: InstanceDown
        expr: up == 0
        for: 2m          # must be true for 2m before firing
        labels:
          severity: critical
          team: infra
        annotations:
          summary: "Instance {{ $labels.instance }} is down"
          description: "Job {{ $labels.job }} on {{ $labels.instance }} has been down for more than 2 minutes."
          runbook_url: "https://wiki.example.com/runbooks/instance-down"

      - alert: HighErrorRate
        expr: job:http_error_ratio:rate5m > 0.05
        for: 5m
        labels:
          severity: warning
          team: backend
        annotations:
          summary: "High error rate on {{ $labels.job }}"
          description: "Error rate is {{ $value | humanizePercentage }} (threshold: 5%)"

      - alert: DiskFillingSoon
        expr: predict_linear(node_filesystem_free_bytes{fstype!="tmpfs"}[6h], 4*3600) < 0
        for: 10m
        labels:
          severity: warning
          team: infra
        annotations:
          summary: "Disk on {{ $labels.instance }} will fill within 4 hours"
```

**Alert states:**
- **Inactive** — expression is false
- **Pending** — expression is true, `for` timer not yet elapsed
- **Firing** — expression has been true for longer than `for`

The `for` clause is critical: it prevents flapping and reduces noise from transient spikes. A value of 0 fires immediately. For critical alerts on infrastructure, 1-2 minutes is typical; for SLO violations, 5-10 minutes avoids paging on brief traffic bursts.

**Labels vs Annotations:**
- `labels` — become part of the alert identity; used for routing in Alertmanager. Keep these low-cardinality.
- `annotations` — human-readable context; not used for routing. Use Go template syntax to interpolate `$labels` and `$value`.

### Alertmanager Pipeline
When Prometheus fires an alert, it sends it to Alertmanager. The pipeline:

```
Incoming alerts
      │
      ▼
  [Inhibition]    ← suppress alerts when a parent alert is firing
      │
      ▼
  [Silencing]     ← mute alerts matching a silence matcher
      │
      ▼
  [Routing tree]  ← match alerts to receivers based on labels
      │
      ▼
  [Grouping]      ← bundle related alerts into one notification
      │
      ▼
  [Deduplication] ← don't re-send if alert is already active
      │
      ▼
  [Receiver]      ← Slack, PagerDuty, email, webhook, etc.
```

### Routing Tree
The routing tree is the core of Alertmanager config. It's a tree of `route` nodes; each alert walks the tree top-down and is matched to the first (or all, if `continue: true`) matching route.

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m           # how long to wait before sending "resolved"
  slack_api_url: "https://hooks.slack.com/services/..."

route:
  # Root route — catches everything not matched by children
  receiver: "default-slack"
  group_by: ["alertname", "job"]
  group_wait: 30s               # wait for more alerts before sending first notification
  group_interval: 5m            # how long to wait before re-sending a group
  repeat_interval: 4h           # how often to re-send an ongoing alert

  routes:
    # Critical infra alerts → PagerDuty
    - match:
        severity: critical
        team: infra
      receiver: pagerduty-infra
      group_wait: 10s           # page faster for critical
      repeat_interval: 1h

    # Backend team → their Slack channel
    - match_re:
        team: "backend|api"
      receiver: slack-backend
      continue: false           # stop routing after this match (default)

    # Catch-all warning → low-priority Slack
    - match:
        severity: warning
      receiver: slack-warnings
```

**Grouping parameters:**
| Parameter | Description |
|-----------|-------------|
| `group_by` | Labels to group alerts by. `["..."]` groups everything together. |
| `group_wait` | Delay before sending the first notification for a new group — allows batching. |
| `group_interval` | Minimum time before sending a new notification for an existing group when new alerts arrive. |
| `repeat_interval` | How often to re-send a notification for an already-firing group. |

**`continue: true`:** by default, routing stops at the first match. Set `continue: true` to send to this receiver AND continue matching further routes (useful for audit logging, NOC channel, etc.).

### Receiver Configuration

```yaml
receivers:
  - name: "default-slack"
    slack_configs:
      - channel: "#alerts-general"
        title: "{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}"
        text: >-
          {{ range .Alerts -}}
          *Alert:* {{ .Annotations.summary }}
          *Severity:* {{ .Labels.severity }}
          *Description:* {{ .Annotations.description }}
          {{ end }}
        send_resolved: true

  - name: "pagerduty-infra"
    pagerduty_configs:
      - routing_key: "<PD_integration_key>"
        severity: "{{ .CommonLabels.severity }}"
        description: "{{ .CommonAnnotations.summary }}"
        details:
          firing: "{{ .Alerts.Firing | len }}"
          resolved: "{{ .Alerts.Resolved | len }}"
        send_resolved: true

  - name: "slack-backend"
    slack_configs:
      - api_url: "https://hooks.slack.com/services/BACKEND_WEBHOOK"
        channel: "#backend-alerts"
        send_resolved: true

  - name: "slack-warnings"
    slack_configs:
      - channel: "#alerts-low-priority"
        send_resolved: false    # don't clutter channel with resolves

  - name: "email-oncall"
    email_configs:
      - to: "oncall@example.com"
        from: "alertmanager@example.com"
        smarthost: "smtp.example.com:587"
        auth_username: "alertmanager@example.com"
        auth_password: "<password>"
        require_tls: true
```

**Webhook receiver** (generic integrations — OpsGenie, custom scripts):
```yaml
  - name: "webhook-custom"
    webhook_configs:
      - url: "http://my-handler:8080/alert"
        send_resolved: true
        http_config:
          bearer_token: "<token>"
```

### Inhibition Rules
Inhibition suppresses alerts when another alert is already firing. Classic use case: if a node is down, suppress all the application alerts firing because of that node being down.

```yaml
inhibit_rules:
  # Suppress warning alerts when a critical alert for the same instance fires
  - source_match:
      severity: critical
    target_match:
      severity: warning
    equal: ["instance", "job"]   # both alerts must share these label values

  # Suppress all alerts for an instance if InstanceDown is firing
  - source_match:
      alertname: InstanceDown
    target_match_re:
      alertname: ".+"
    equal: ["instance"]
```

### Silences
Silences are created via the Alertmanager UI or API. They mute matching alerts for a time window — used during maintenance, deployments, or known incidents.

```bash
# Create a silence via API (expires in 2 hours)
curl -s -X POST http://alertmanager:9093/api/v2/silences \
  -H "Content-Type: application/json" \
  -d '{
    "matchers": [
      {"name": "instance", "value": "host1:9100", "isRegex": false},
      {"name": "job", "value": "node", "isRegex": false}
    ],
    "startsAt": "2024-01-01T02:00:00Z",
    "endsAt": "2024-01-01T04:00:00Z",
    "createdBy": "igal",
    "comment": "Scheduled maintenance window"
  }'

# List active silences
curl -s http://alertmanager:9093/api/v2/silences | jq '.[] | select(.status.state=="active")'

# Delete a silence
curl -s -X DELETE http://alertmanager:9093/api/v2/silences/<silence_id>
```

**amtool** — CLI for Alertmanager management:
```bash
amtool --alertmanager.url=http://alertmanager:9093 silence add \
  alertname=InstanceDown instance=host1:9100 \
  --duration=2h \
  --author=igal \
  --comment="Maintenance"

amtool --alertmanager.url=http://alertmanager:9093 alert query
amtool --alertmanager.url=http://alertmanager:9093 config show
```

### Deduplication
Alertmanager deduplicates alerts automatically: if the same alert (same labels) keeps firing, only one notification is sent (then repeated per `repeat_interval`). This is different from grouping — deduplication prevents re-sending the same alert within a group, while grouping controls how alerts are bundled into notifications.

## Examples

**Run Alertmanager with Docker:**

```bash
cat > /tmp/alertmanager.yml <<EOF
global:
  resolve_timeout: 5m
route:
  receiver: "null"
  routes: []
receivers:
  - name: "null"
EOF

docker run -d \
  --name alertmanager \
  -p 9093:9093 \
  -v /tmp/alertmanager.yml:/etc/alertmanager/alertmanager.yml \
  prom/alertmanager

# Check config validity
docker run --rm \
  -v /tmp/alertmanager.yml:/etc/alertmanager/alertmanager.yml \
  prom/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --check-config

# Validate Prometheus rule files
promtool check rules rules/alerts.yml
```

**Test routing without sending real notifications:**
```bash
# Use amtool to test which receiver an alert would hit
amtool config routes test \
  --config.file=/tmp/alertmanager.yml \
  severity=critical team=infra alertname=InstanceDown
```

## Exercises

1. Write a complete `alertmanager.yml` that routes: (a) `severity=critical` alerts to PagerDuty with a 10s group_wait, (b) `severity=warning` alerts to a Slack channel with 5m group_wait, (c) everything else to a "null" receiver (drop). Add an inhibition rule that suppresses warning alerts when a critical alert fires for the same `job`.

2. Write three alerting rules in a Prometheus rule file: (a) `InstanceDown` — any target with `up == 0` for 2 minutes, severity critical; (b) `HighMemoryUsage` — `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10` for 5 minutes, severity warning; (c) `DiskWillFillIn4Hours` — using `predict_linear`, 10 minute `for`, severity warning. Include meaningful annotations with Go template variable interpolation.

3. Given a Kubernetes cluster that has an `InstanceDown` alert firing for a node, write the inhibition rule that would suppress `KubePodCrashLooping` and `KubeDeploymentReplicasMismatch` alerts for pods on that same node. Assume the alerts share an `instance` label identifying the node.

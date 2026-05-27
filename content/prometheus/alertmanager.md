---
title: Alertmanager
module: prometheus
duration_min: 20
difficulty: intermediate
tags: [prometheus, alertmanager, alerting, oncall, slack, pagerduty]
exercises: 3
---

## Overview

Alertmanager handles the lifecycle of alerts fired by Prometheus (and other Prometheus-compatible systems). It receives raw alert events, groups related alerts to reduce noise, routes them to the correct receiver based on labels, deduplicates repeated firings, and manages silences for planned maintenance. Understanding Alertmanager is essential for on-call work — misconfigured routing trees cause missed pages or alert storms, both of which have direct production impact.

The split between Prometheus and Alertmanager is deliberate. Prometheus evaluates alerting rules and sends alert events to Alertmanager over HTTP — but Prometheus has no opinion about who gets notified or when. Alertmanager is solely responsible for the notification lifecycle: grouping alerts that arrive close together, waiting before sending (to allow bursts to settle), routing by label, and suppressing duplicates. This separation means multiple Prometheus instances can all send to the same Alertmanager cluster, and Alertmanager handles deduplication across them.

A critical operational point: misconfiguring `group_wait`, `group_interval`, and `repeat_interval` causes two failure modes. Too aggressive (very short intervals) and you generate alert spam that trains people to ignore pages. Too conservative (very long `repeat_interval`) and a sustained incident stops generating pages after the first notification, leaving it invisible. Calibrating these values for each team's on-call culture is as important as writing the alerting expressions.

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
- **Inactive** — expression is false (or returns no result)
- **Pending** — expression is true, `for` timer not yet elapsed
- **Firing** — expression has been true for longer than `for`

The `for` clause prevents flapping and reduces noise from transient spikes. A value of `0` fires immediately. For critical infrastructure alerts, 1-2 minutes is typical. For SLO violations, 5-10 minutes avoids paging on brief traffic bursts.

**Labels vs Annotations:**
- `labels` — become part of the alert identity; used by Alertmanager for routing and inhibition. Keep these low-cardinality (severity, team, env).
- `annotations` — human-readable context attached to the notification. Not used for routing. Use Go template syntax to interpolate dynamic values.

### Go Templates in Annotations

Alertmanager and Prometheus rule annotations support Go template syntax. You will use this in every real alert to include context that helps the on-call engineer respond faster.

**Available template variables:**

| Variable | Type | Description |
|----------|------|-------------|
| `$labels` | map | All labels on the alert (metric labels + alert labels) |
| `$value` | float64 | The numeric value of the alerting expression at the time the alert fired |
| `$externalURL` | string | The Prometheus/Alertmanager external URL (for links back to the UI) |

**Accessing labels:**

```yaml
annotations:
  summary: "Instance {{ $labels.instance }} is down"
  description: "Job {{ $labels.job }} on {{ $labels.instance }} has been down for 2 minutes."
```

**Formatting the numeric value:**

```yaml
annotations:
  # $value is the raw float: 0.073
  description: "Error rate is {{ $value }}"                    # → "Error rate is 0.073"
  description: "Error rate is {{ $value | humanize }}"         # → "Error rate is 73m" (milli-units)
  description: "Error rate is {{ $value | humanizePercentage }}" # → "Error rate is 7.3%"
  description: "Free bytes: {{ $value | humanize1024 }}"       # → human-readable bytes (KiB, MiB)
```

**`humanizePercentage`** expects a fraction (0 to 1) and formats it as a percentage. If your expression returns `0.073`, the template renders `"7.3%"`.

**Iterating over labels in Alertmanager receiver templates:**

In receiver config (e.g., Slack message body), you have access to `.Alerts` — a slice of alert objects. Each alert has `.Labels` and `.Annotations`:

```yaml
slack_configs:
  - text: >-
      {{ range .Alerts -}}
      *Alert:* {{ .Annotations.summary }}
      *Severity:* {{ .Labels.severity }}
      *Value:* {{ .Annotations.description }}
      {{ end }}
```

**Conditional in templates:**

```yaml
annotations:
  description: >-
    {{ if eq $labels.severity "critical" }}
    CRITICAL: {{ $labels.instance }} is unreachable.
    {{ else }}
    WARNING: {{ $labels.instance }} may be degraded.
    {{ end }}
```

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

The routing tree is the core of Alertmanager config. It is a tree of `route` nodes; each alert walks the tree top-down and is matched to the first (or all, if `continue: true`) matching route. The root route is a catch-all — it must have a receiver and cannot have match conditions.

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

**`match` vs `match_re`:**
- `match` performs exact string equality on label values.
- `match_re` performs regex matching (RE2 syntax) on label values.

```yaml
# Exact match — both labels must match exactly
- match:
    severity: critical
    team: infra

# Regex match — team label matches "backend" OR "api"
- match_re:
    team: "backend|api"
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

  - name: "null"   # drop alerts — used as a catch-all when you want to silence a category
    # no configs needed — empty receiver discards alerts
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

Inhibition suppresses alerts when another (source) alert is already firing. The classic use case: if a node is down, suppress all the application alerts firing because of that node going down — otherwise every pod on that node pages separately.

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

**How the `equal` field works:** the inhibition rule only suppresses `target` alerts when the `source` alert and the `target` alert have identical values for all labels listed in `equal`. This prevents a node outage in one datacenter from suppressing alerts in a different datacenter that happen to share the same severity label.

**`target_match_re`:** matches any alert where the label value matches the regex. `alertname: ".+"` matches every alert (any non-empty alertname). This lets you suppress all alerts of any name for a given instance when that instance is down.

**Kubernetes node inhibition — suppressing pod alerts when a node is down:**

```yaml
inhibit_rules:
  # When InstanceDown fires for a node, suppress pod-level alerts on that node
  - source_match:
      alertname: InstanceDown
    target_match_re:
      alertname: "KubePodCrashLooping|KubeDeploymentReplicasMismatch"
    equal: ["instance"]
```

This works because `InstanceDown` has an `instance` label (the node address), and the Kubernetes alerts for pods on that node also carry an `instance` label pointing to the same node. When they match, the pod alerts are suppressed.

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

# Check config validity without running
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

**Complete alertmanager.yml with routing, receivers, and inhibition:**

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: "null"
  group_by: ["alertname", "job"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
    - match:
        severity: critical
      receiver: pagerduty-infra
      group_wait: 10s
      repeat_interval: 1h

    - match:
        severity: warning
      receiver: slack-warnings
      group_wait: 5m
      repeat_interval: 4h

inhibit_rules:
  - source_match:
      severity: critical
    target_match:
      severity: warning
    equal: ["job"]

receivers:
  - name: "null"

  - name: pagerduty-infra
    pagerduty_configs:
      - routing_key: "<PD_key>"
        send_resolved: true

  - name: slack-warnings
    slack_configs:
      - api_url: "https://hooks.slack.com/services/..."
        channel: "#warnings"
        send_resolved: true
```

## Exercises

1. Write a complete `alertmanager.yml` that routes: (a) `severity=critical` alerts to PagerDuty with a 10s group_wait, (b) `severity=warning` alerts to a Slack channel with 5m group_wait, (c) everything else to a "null" receiver (drop). Add an inhibition rule that suppresses warning alerts when a critical alert fires for the same `job`.

2. Write three alerting rules in a Prometheus rule file: (a) `InstanceDown` — any target with `up == 0` for 2 minutes, severity critical; (b) `HighMemoryUsage` — `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10` for 5 minutes, severity warning; (c) `DiskWillFillIn4Hours` — using `predict_linear`, 10 minute `for`, severity warning. Include meaningful annotations with Go template variable interpolation for `$labels.instance` and `$value | humanizePercentage` where applicable.

3. Given a Kubernetes cluster that has an `InstanceDown` alert firing for a node, write the inhibition rule that would suppress `KubePodCrashLooping` and `KubeDeploymentReplicasMismatch` alerts for pods on that same node. Assume the alerts share an `instance` label identifying the node.

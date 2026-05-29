---
title: Alerting and Dashboards
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, datadog, alerting, dashboards, monitors, pagerduty, slo]
exercises: 4
---

## Overview

Effective alerting and dashboards are the difference between a team that detects and resolves incidents quickly and one that discovers outages from user complaints. Alerts are the mechanism by which your monitoring system demands human attention — but only when that attention is actually warranted. Dashboards are the mechanism by which engineers develop situational awareness, both during normal operations and under the pressure of an active incident. Getting both right requires deliberate design decisions, not just connecting metrics to notification channels.

The core tension in alerting is precision versus recall: alert on too little and you miss real problems; alert on too much and engineers start ignoring pages. This phenomenon — alert fatigue — is one of the most common and damaging failure modes in on-call culture. It results in missed critical alerts buried under noise, engineers who disable monitors to get sleep, and a monitoring system that provides false confidence. Good alerting design minimizes false positives through appropriate evaluation windows and thresholds, requires every alert to be actionable, and routes notifications by severity so a CPU warning doesn't page someone at 3 AM.

In the broader DevOps toolchain, alerting and dashboards sit at the output layer of the observability stack. Metrics, logs, and traces are collected and stored by tools like Datadog, Prometheus, or Grafana; alerting and dashboards are how that raw data becomes operational intelligence. Datadog serves as the primary platform in this lesson because it integrates all three signal types (metrics, logs, APM traces) and provides monitors, dashboards, SLOs, and synthetics in a single product — patterns that translate directly to equivalent tools like Grafana Alerting, PagerDuty, or AWS CloudWatch.

---

## Concepts

### Datadog Monitor Types

A monitor is a continuous evaluation of a query against a threshold or condition. Datadog offers several monitor types targeting different data sources and use cases. Choosing the right type determines how accurately your alert reflects the underlying problem.

| Monitor Type | Data Source | Best For |
|---|---|---|
| **Metric** | Time-series metrics | CPU, memory, request rates, error rates |
| **Log** | Indexed log events | Error log spikes, specific log patterns |
| **APM** | Distributed trace data | Service error rate, p99 latency |
| **Composite** | Two or more monitors | Reducing false positives by requiring multiple conditions |
| **Anomaly** | Historical metric patterns | Seasonal traffic, gradual degradation without fixed thresholds |
| **Forecast** | Projected metric values | Disk filling up, capacity planning |
| **Outlier** | Group of similar hosts/services | One pod behaving differently from its peers |

**Metric monitor** — alert when a metric crosses a threshold:
```
Query: avg(last_5m):avg:system.cpu.user{env:production,service:myapp} > 85
Alert: CPU > 85% for 5 minutes
Warning: CPU > 70% for 5 minutes
Recovery: CPU < 70%
```

**Log monitor** — alert on log patterns:
```
Query: logs("service:myapp status:error").rollup("count").last("5m") > 50
→ Alert when more than 50 error logs appear in 5 minutes
```

**APM monitor** — alert on service metrics derived from distributed traces:
```
Query: avg(last_10m):
  avg:trace.flask.request.errors{service:myapp,env:prod}
  / avg:trace.flask.request.hits{service:myapp,env:prod}
  * 100 > 5
→ Alert when error rate exceeds 5%
```

**Composite monitor** — trigger only when multiple conditions are simultaneously true:
```
Alert if (high_cpu_monitor) AND (high_memory_monitor)
→ Eliminates false positives from transient CPU spikes that resolve on their own
```

**Anomaly monitor** — alert when a metric deviates from its expected seasonal pattern:
```
Query: avg(last_1h):anomalies(
  avg:trace.web.request.duration.by.service{service:myapp},
  'basic',
  3
) >= 1
→ Alert when latency is 3 standard deviations above the expected value
   for this time of day and day of week
```

**When to use anomaly monitors:** they work well for metrics with predictable seasonal patterns (traffic that's always lower on weekends, batch jobs that run nightly) where a fixed threshold would either miss daytime spikes or false-positive on normal night-time lows.

**When anomaly monitors fail:** during launches, traffic migrations, or any sustained change in baseline behavior, the model adapts slowly and generates noise. Don't rely on them as your only alert for critical paths.

---

### Monitor Configuration Best Practices

Every field in a monitor configuration is an opportunity to reduce false positives, improve response time, and make the on-call engineer's job easier.

```yaml
# Terraform: Datadog provider monitor resource
resource "datadog_monitor" "api_error_rate" {
  name    = "High API Error Rate - myapp [{{env}}]"
  type    = "metric alert"

  # Message supports template variables and conditional blocks
  message = <<-EOT
    Error rate is {{value}}% on {{service.name}}
    Threshold: {{threshold}}% | Warning: {{warn_threshold}}%

    **Runbook:** https://wiki.mycompany.com/runbooks/api-errors
    **APM service page:** https://app.datadoghq.com/apm/service/myapp

    {{#is_alert}}
      @pagerduty-platform-oncall
    {{/is_alert}}
    {{#is_warning}}
      @slack-platform-team
    {{/is_warning}}
    {{#is_recovery}}
      Resolved — error rate returned below threshold.
      @slack-platform-team
    {{/is_recovery}}
  EOT

  query = <<-EOQ
    avg(last_5m):
      avg:trace.flask.request.errors{service:myapp,env:production}
      / avg:trace.flask.request.hits{service:myapp,env:production}
      * 100
  EOQ

  thresholds = {
    critical          = 5.0
    critical_recovery = 3.0   # hysteresis: must drop to 3% to recover from 5%
    warning           = 2.0
    warning_recovery  = 1.5
  }

  # Alert if no data arrives — the service itself may be down
  notify_no_data    = true
  no_data_timeframe = 10   # minutes

  # Prevent alert storm from resolving/re-firing on flapping metrics
  renotify_interval  = 60     # re-page every 60 min while still firing
  require_full_window = true  # don't alert on partial evaluation windows at startup

  tags = ["env:production", "service:myapp", "team:platform", "severity:critical"]
}
```

**Hysteresis (recovery thresholds):** setting `critical_recovery` below `critical` prevents flapping — where a metric oscillates around the threshold and fires/recovers repeatedly. Without it, a metric at 5.1% → 4.9% → 5.1% generates three alert events in minutes. Each flip is a page.

**`notify_no_data`:** this is frequently overlooked. If a service crashes and stops emitting metrics, a threshold-based monitor will show `OK` (no data to breach the threshold) unless you explicitly enable no-data alerting. Always enable it for critical service monitors.

**`require_full_window`:** prevents false alerts when a monitor starts or a host restarts and only has 30 seconds of data in a 5-minute window. The partial average can look extreme because the denominator is small.

**Threshold tuning checklist:**
- Pull 30 days of historical data for the metric
- Set warning at ~75th percentile of normal spikes, critical at ~99th
- Never set thresholds on day one — let the system run for a week first
- Review alert history monthly: if a critical fires without action taken, lower the threshold or remove the alert

---

### Notification Routing

Routing determines who gets paged, by what channel, and when. Misrouted alerts are nearly as harmful as missing alerts — paging the wrong team delays response, and paging everyone creates diffused responsibility where no one acts because everyone assumes someone else will.

```
Alert fires
    │
    ▼
Datadog evaluates monitor state (ALERT / WARN / NO DATA / RECOVERY)
    │
    ├─ ALERT   → @pagerduty-platform-oncall  → PagerDuty → phone/SMS to on-call
    ├─ WARN    → @slack-platform-team        → Slack channel notification
    ├─ NO DATA → @pagerduty-platform-oncall  (if notify_no_data = true)
    └─ RECOVERY → @slack-platform-team       → informational only, no page
```

**Severity model — map alert priority to escalation path:**

| Priority | Condition | Channel | Hours |
|---|---|---|---|
| P1 | Production down or data loss | PagerDuty → phone/SMS | 24/7 |
| P2 | Degraded production service | PagerDuty → push notification | 24/7 |
| P3 | Elevated concern, not yet user-impacting | Slack | Business hours |
| P4 | Informational trend | Email / ticket | Async |

**Conditional blocks in monitor messages** give you fine-grained routing without creating duplicate monitors:

```
{{#is_alert}}
  @pagerduty-platform-oncall
  Severity: P1 — immediate response required
{{/is_alert}}

{{#is_warning}}
  @slack-platform-team
  Severity: P3 — investigate during business hours
{{/is_warning}}

{{#is_recovery}}
  @slack-platform-team
  Alert resolved after {{duration}} minutes
{{/is_recovery}}

{{#is_no_data}}
  @pagerduty-platform-oncall
  No metrics received — service may be down entirely
{{/is_no_data}}
```

**Multi-team routing with tag-based conditions:** if the same monitor covers multiple services or teams, use `@team-<name>` handles tied to the service tag so the alert self-routes:

```
{{#is_alert}}
  Affected service: {{service.name}}
  @pagerduty-{{team.name}}-oncall
{{/is_alert}}
```

**PagerDuty escalation policy:** Datadog sends the alert; PagerDuty owns the escalation logic (retry after N minutes, escalate to secondary on-call, notify manager). Don't duplicate escalation logic inside Datadog monitor messages. Datadog routes to the correct PagerDuty service; PagerDuty handles what happens next. Mixing the two creates configuration drift where the Datadog message says one thing and PagerDuty does another.

**Downtime scheduling:** before a planned maintenance window, schedule a Datadog downtime to mute monitors. Failing to do this fills PagerDuty with false alerts during deployments, which trains engineers to ignore alerts — the first step toward alert fatigue.

```bash
# Mute all monitors tagged service:myapp for a 30-minute deploy window
# Using the Datadog API via curl
curl -X POST "https://api.datadoghq.com/api/v1/downtime" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": ["service:myapp"],
    "start": 1700000000,
    "end":   1700001800,
    "message": "Scheduled deploy v2.4.1 — silencing monitors"
  }'
```

---

### Dashboard Design

A dashboard that shows everything shows nothing useful under incident pressure. The most effective dashboards are built around a specific question for a specific audience — before you add a widget, ask "what decision does this panel help someone make?"

**Dashboard archetypes:**

| Type | Audience | Primary Question | Key Metrics |
|---|---|---|---|
| **Service (RED)** | Service owners, on-call | Is my service healthy right now? | Request rate, error rate, duration |
| **Infrastructure (USE)** | SRE, platform team | Are my hosts/pods under stress? | CPU utilization, saturation, errors |
| **Business** | Engineering leadership, product | Are users succeeding? | Signups, conversion, revenue, DAU |
| **Incident** | On-call during an active incident | What is broken and why? | Narrowly scoped to the incident type |
| **Dependency** | On-call, service owners | Are my upstream/downstream services healthy? | Latency, error rate per dependency |

**RED method** (Rate, Errors, Duration) — the standard framework for service-level dashboards:
- **Rate:** requests per second — is the service receiving traffic at all?
- **Errors:** error rate (%) — is it serving those requests successfully?
- **Duration:** p50/p95/p99 latency — is it serving them fast enough?

**USE method** (Utilization, Saturation, Errors) — for infrastructure resources:
- **Utilization:** what percentage of capacity is being used? (CPU 70%)
- **Saturation:** is work queuing up? (load average, queue depth, throttled CPU)
- **Errors:** are hardware or OS errors occurring?

**Service dashboard layout — ordered by diagnostic value:**
```
Row 1 — Health indicators (answer: is it broken right now?)
  • Error rate          [timeseries, threshold line at 1% warn / 5% critical]
  • p99 request latency [timeseries, threshold line at SLO target]
  • Request rate        [timeseries — a drop to zero is its own failure mode]

Row 2 — Dependencies (answer: is something upstream/downstream causing it?)
  • Downstream service error rates  [timeseries, one line per dependency]
  • Database query duration          [timeseries, p95]
  • Cache hit rate                   [timeseries — drop = cache flush or miss storm]
  • External API latency             [timeseries, grouped by provider]

Row 3 — Infrastructure (answer: is the host or pod responsible?)
  • CPU utilization    [timeseries, grouped by pod]
  • Memory usage       [timeseries — watch for sawtooth pattern = memory leak]
  • Pod / replica count [timeseries — sudden drop = crash loop or eviction]
  • Network errors     [timeseries]

Row 4 — Context (answer: what changed?)
  • Deployment events  [event overlay on timeseries — correlate with Row 1 spikes]
  • Recent error logs  [log stream widget, filtered to service + env]
```

**Template variables** enable a single dashboard to cover all environments and services without duplication:

```
$env     → production | staging | dev
$service → myapp | payment-service | user-service
$region  → us-east-1 | eu-west-1
```

Every query in the dashboard references these as tag filters:

```
avg:trace.flask.request.errors{env:$env,service:$service,region:$region}
```

Switching `$env` from `production` to `staging` instantly updates every panel — no rebuilding required, and no risk of investigating the wrong environment during an incident.

**Widget type selection:**

| Widget | Use When |
|---|---|
| **Timeseries** | Tracking change over time — the default choice for most metrics |
| **Query Value** | Current state needs instant readability at a glance (error rate = 2.3%) |
| **Heatmap** | Distribution of values across many hosts or pods simultaneously |
| **Top List** | Ranking by magnitude (top 10 slowest endpoints, top 5 error-generating services) |
| **Log Stream** | Correlated logs visible alongside metrics without leaving the dashboard |
| **SLO Widget** | Remaining error budget and rolling compliance status |
| **Event Timeline** | Overlaying deploys, config changes, and incidents onto metric timelines |

**Dashboard anti-patterns to avoid:**
- Panels with no threshold lines — a number without context is meaningless under pressure
- Most important signal buried below the fold — health indicators belong in Row 1
- More than 20 panels on one dashboard — split into focused sub-dashboards linked from a top-level overview
- Panels using different time ranges — forces mental reconciliation during incidents
- Hard-coded environment tags — a dashboard pinned to `env:production` cannot be reused for staging investigations

---

### SLO Dashboards and Error Budget Alerting

Service Level Objectives formalize the target reliability of a service and give the team a shared language for reliability risk. An SLO dashboard makes the error budget — the allowed amount of unreliability — visible, and error budget alerts fire before the budget is exhausted rather than after the SLO has been violated.

**Key terms:**

| Term | Definition | Example |
|---|---|---|
| **SLI** | Service Level Indicator — the metric being measured | % of requests returning 2xx |
| **SLO** | Service Level Objective — the target for that metric | 99.9% over 30 days |
| **Error budget** | How much unreliability is permitted | 0.1% of requests = ~43.8 min/month downtime |
| **Burn rate** | How fast the error budget is being consumed | Burn rate 2× = budget exhausted in 15 days instead of 30 |

```yaml
# Terraform: Datadog SLO definition
resource "datadog_service_level_objective" "api_availability" {
  name        = "API Availability - myapp"
  type        = "metric"
  description = "99.9% of API requests return non-5xx responses over a 30-day rolling window"

  query {
    # Good events: requests that did NOT return a 5xx error
    numerator   = "sum:trace.flask.request.hits{service:myapp,env:production,!http.status_class:5xx}.as_count()"
    # Total events: all requests
    denominator = "sum:trace.flask.request.hits{service:myapp,env:production}.as_count()"
  }

  thresholds {
    timeframe = "30d"
    target    = 99.9
    warning   = 99.95   # warn at 99.95% — gives runway before violating 99.9%
  }

  thresholds {
    timeframe = "7d"    # shorter window catches recent degradation faster
    target    = 99.9
    warning   = 99.95
  }

  tags = ["env:production", "service:myapp", "team:platform"]
}
```

**Error budget alert — burn rate based:**

Threshold-based SLO alerts fire too late: by the time the 30-day SLO has been breached, the error budget is already gone. Burn-rate alerts fire early by detecting that the budget is being consumed faster than sustainable.

```yaml
resource "datadog_monitor" "error_budget_burn_fast" {
  name    = "Error Budget Burn Rate - myapp (fast burn)"
  type    = "slo alert"

  # Alert when burn rate exceeds 14.4× for 1 hour
  # At 14.4× burn, the monthly budget is consumed in ~2 hours — page immediately
  query = "burn_rate(\"${datadog_service_level_objective.api_availability.id}\").over(\"1h\") > 14.4"

  message = <<-EOT
    Fast error budget burn detected on myapp.
    At this rate, the monthly error budget will be exhausted in under 2 hours.

    Current error rate suggests a significant production incident.
    **Runbook:** https://wiki.mycompany.com/runbooks/slo-burn

    @pagerduty-platform-oncall
  EOT

  thresholds = {
    critical = 14.4   # 2-hour budget exhaustion
    warning  = 6.0    # 5-hour budget exhaustion
  }

  tags = ["env:production", "service:myapp", "team:platform", "severity:critical"]
}

resource "datadog_monitor" "error_budget_burn_slow" {
  name    = "Error Budget Burn Rate - myapp (slow burn)"
  type    = "slo alert"

  # Alert when burn rate exceeds 3× for 6 hours
  # Catches slow leaks that wouldn't page for days but will exhaust budget by month end
  query = "burn_rate(\"${datadog_service_level_objective.api_availability.id}\").over(\"6h\") > 3"

  message = <<-EOT
    Slow error budget burn detected on myapp.
    At this rate, the monthly error budget will be exhausted before the month ends.

    Not an immediate emergency but requires investigation today.
    @slack-platform-team
  EOT

  thresholds = {
    critical = 3.0
  }

  tags = ["env:production", "service:myapp", "team:platform", "severity:warning"]
}
```

**Why two burn-rate windows?** A fast burn at 14.4× for one hour catches acute incidents (a bad deploy causing 20% errors). A slow burn at 3× for six hours catches gradual degradation (a memory leak causing 0.5% elevated errors that compounds over days). Using only a fast-burn alert misses the slow leak; using only a slow-burn alert pages too late for acute incidents.

**SLO dashboard layout:**
```
Row 1 — Budget status
  • SLO Widget: 30-day compliance (% and remaining budget in minutes)
  • SLO Widget: 7-day compliance
  • Query Value: current burn rate (colored red if > 1×)

Row 2 — Trend
  • Timeseries: error rate over 30 days with SLO target line
  • Timeseries: burn rate over 30 days with 1× reference line

Row 3 — Recent incidents
  • Event timeline: SLO alert firings
  • Top list: time periods with highest error rate (identify worst incidents)
```

**Error budget as a policy tool:** when the error budget is depleted, the team stops shipping new features until reliability is restored. When the budget is full, the team can take on riskier changes. This makes the SLO dashboard a product planning artifact, not just an ops artifact.

---

## Examples

### Example 1: Full Terraform Monitor Stack for a Flask API

This example provisions a complete set of monitors for a production Flask API: an error rate monitor, a latency monitor, and a no-data guard, all tagged consistently for routing.

```hcl
# variables.tf
variable "dd_api_key" {}
variable "dd_app_key" {}

# provider.tf
terraform {
  required_providers {
    datadog = {
      source  = "DataDog/datadog"
      version = "~> 3.0"
    }
  }
}

provider "datadog" {
  api_key = var.dd_api_key
  app_key = var.dd_app_key
}

# monitors.tf

# 1. Error rate monitor — fires when >5% of requests return errors
resource "datadog_monitor" "flask_error_rate" {
  name    = "Flask API Error Rate - production"
  type    = "metric alert"
  message = <<-EOT
    Flask API error rate is {{value}}% (threshold: {{threshold}}%)
    Service: myapp | Env: production

    Check APM for traces: https://app.datadoghq.com/apm/service/myapp
    Runbook: https://wiki.internal/runbooks/flask-errors

    {{#is_alert}}@pagerduty-platform-oncall{{/is_alert}}
    {{#is_warning}}@slack-platform-alerts{{/is_warning}}
    {{#is_recovery}}@slack-platform-alerts Resolved after {{duration}} min{{/is_recovery}}
  EOT

  query = "avg(last_5m):avg:trace.flask.request.errors{service:myapp,env:production} / avg:trace.flask.request.hits{service:myapp,env:production} * 100"

  thresholds = {
    critical          = 5.0
    critical_recovery = 3.0
    warning           = 2.0
    warning_recovery  = 1.0
  }

  notify_no_data      = true
  no_data_timeframe   = 10
  require_full_window = true
  renotify_interval   = 60

  tags = ["env:production", "service:myapp", "team:platform", "severity:critical"]
}

# 2. p99 latency monitor — fires when 99th percentile latency exceeds 800ms
resource "datadog_monitor" "flask_p99_latency" {
  name    = "Flask API p99 Latency - production"
  type    = "metric alert"
  message = <<-EOT
    p99 latency is {{value}}ms (threshold: {{threshold}}ms)
    Runbook: https://wiki.internal/runbooks/flask-latency

    {{#is_alert}}@pagerduty-platform-oncall{{/is_alert}}
    {{#is_warning}}@slack-platform-alerts{{/is_warning}}
    {{#is_recovery}}@slack-platform-alerts Latency recovered{{/is_recovery}}
  EOT

  # p99 is the 0.99 quantile of the distribution
  query = "avg(last_10m):p99:trace.flask.request.duration{service:myapp,env:production} > 0.8"

  thresholds = {
    critical          = 0.8    # 800ms
    critical_recovery = 0.6    # 600ms
    warning           = 0.5    # 500ms
    warning_recovery  = 0.4
  }

  notify_no_data      = true
  no_data_timeframe   = 10
  require_full_window = true

  tags = ["env:production", "service:myapp", "team:platform", "severity:critical"]
}

# 3. Composite monitor — page only when BOTH error rate AND latency are elevated
#    Eliminates false positives from latency spikes during traffic bursts
#    that resolve before causing real user impact
resource "datadog_monitor" "flask_degraded_composite" {
  name    = "Flask API Degraded (error + latency) - production"
  type    = "composite"
  message = <<-EOT
    Both error rate AND p99 latency are elevated simultaneously.
    This indicates a real service degradation, not a transient spike.

    @pagerduty-platform-oncall
  EOT

  # References monitor IDs — both must be in ALERT state to fire
  query = "${datadog_monitor.flask_error_rate.id} && ${datadog_monitor.flask_p99_latency.id}"

  tags = ["env:production", "service:myapp", "team:platform", "severity:critical"]
}
```

**Verify it worked:**
```bash
# List monitors filtered by service tag using the Datadog CLI (datadog-ci) or API
curl -X GET "https://api.datadoghq.com/api/v1/monitor?tags=service:myapp" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  | jq '.[].name'

# Expected output:
# "Flask API Error Rate - production"
# "Flask API p99 Latency - production"
# "Flask API Degraded (error + latency) - production"
```

---

### Example 2: Grafana Alerting with Prometheus (Non-Datadog Stack)

For teams running Prometheus + Grafana, the same alerting principles apply with different syntax. This shows a complete alert rule file and the equivalent Grafana alert YAML.

```yaml
# prometheus/rules/myapp.yml
# AlertManager receives these and routes to PagerDuty/Slack

groups:
  - name: myapp_slo
    interval: 1m   # evaluate every minute
    rules:

      # Error rate alert — mirrors the Datadog example above
      - alert: HighErrorRate
        expr: |
          (
            sum(rate(http_requests_total{job="myapp",status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{job="myapp"}[5m]))
          ) * 100 > 5
        for: 5m    # must be true for 5 consecutive minutes — prevents flapping
        labels:
          severity: critical
          team: platform
          env: production
        annotations:
          summary: "High error rate on myapp ({{ $value | printf \"%.1f\" }}%)"
          runbook: "https://wiki.internal/runbooks/myapp-errors"
          dashboard: "https://grafana.internal/d/myapp-service"

      # Warning threshold — separate rule, routed differently in AlertManager
      - alert: ElevatedErrorRate
        expr: |
          (
            sum(rate(http_requests_total{job="myapp",status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{job="myapp"}[5m]))
          ) * 100 > 2
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Elevated error rate on myapp ({{ $value | printf \"%.1f\" }}%)"

      # p99 latency using histogram_quantile
      - alert: HighP99Latency
        expr: |
          histogram_quantile(
            0.99,
            sum by (le) (
              rate(http_request_duration_seconds_bucket{job="myapp"}[5m])
            )
          ) > 0.8
        for: 10m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "p99 latency {{ $value | printf \"%.0f\" }}ms exceeds 800ms"
```

```yaml
# alertmanager/config.yml
route:
  group_by: ['alertname', 'env', 'team']
  group_wait: 30s        # wait 30s before sending first notification (batch related alerts)
  group_interval: 5m     # wait 5m before sending update on an active group
  repeat_interval: 1h    # resend if still firing after 1h

  receiver: slack-default
  routes:
    # Critical alerts go to PagerDuty
    - match:
        severity: critical
      receiver: pagerduty-platform
      continue: true   # also send to Slack for visibility

    # Warning alerts go to Slack only
    - match:
        severity: warning
      receiver: slack-platform

receivers:
  - name: pagerduty-platform
    pagerduty_configs:
      - routing_key: "${PAGERDUTY_INTEGRATION_KEY}"
        description: "{{ .CommonAnnotations.summary }}"
        details:
          runbook: "{{ .CommonAnnotations.runbook }}"
          dashboard: "{{ .CommonAnnotations.dashboard }}"

  - name: slack-platform
    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: "#platform-alerts"
        title: "{{ .CommonLabels.alertname }}"
        text: "{{ .CommonAnnotations.summary }}"
```

**Verify alerts are loaded:**
```bash
# Check Prometheus rule evaluation status
curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[].rules[] | {name: .name, state: .state}'

# Check AlertManager routing tree
curl -s http://localhost:9093/api/v2/status | jq '.config.original' | head -30

# Manually fire a test alert to verify routing
curl -X POST http://localhost:9093/api/v1/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {"alertname":"TestAlert","severity":"critical","team":"platform"},
    "annotations": {"summary":"Test alert — verify PagerDuty routing"}
  }]'
```

---

### Example 3: SLO Dashboard as Code with Terraform

This example creates an SLO, a burn-rate monitor, and a Datadog dashboard displaying the error budget — all in one Terraform module so they stay synchronized.

```hcl
# slo.tf

resource "datadog_service_level_objective" "checkout_availability" {
  name        = "Checkout Service Availability"
  type        = "metric"
  description = "99.95% of checkout requests succeed (non-5xx) over 30 days"

  query {
    numerator   = "sum:trace.express.request.hits{service:checkout,env:production,!http.status_class:5xx}.as_count()"
    denominator = "sum:trace.express.request.hits{service:checkout,env:production}.as_count()"
  }

  thresholds {
    timeframe = "30d"
    target    = 99.95
    warning   = 99.97
  }

  tags = ["env:production", "service:checkout", "team:payments"]
}

# Fast burn-rate alert: 14.4× burn for 1h = budget gone in 2 hours
resource "datadog_monitor" "checkout_fast_burn" {
  name    = "Checkout SLO Fast Burn (14.4×)"
  type    = "slo alert"
  message = <<-EOT
    Checkout availability SLO is burning fast.
    At 14.4× burn rate, monthly error budget exhausted in ~2 hours.

    Immediate investigation required.
    Runbook: https://wiki.internal/runbooks/checkout-slo

    @pagerduty-payments-oncall
  EOT

  query = "burn_rate(\"${datadog_service_level_objective.checkout_availability.id}\").over(\"1h\") > 14.4"

  thresholds = {
    critical = 14.4
    warning  = 6.0
  }

  tags = ["env:production", "service:checkout", "severity:critical"]
}

# SLO dashboard wired to the SLO resource above
resource "datadog_dashboard" "checkout_slo" {
  title       = "Checkout Service — SLO & Error Budget"
  layout_type = "ordered"

  # Template variable lets you switch between environments
  template_variable {
    name    = "env"
    prefix  = "env"
    default = "production"
  }

  # Row 1: Budget status — instant answer to "are we on track?"
  widget {
    service_level_objective_definition {
      title             = "30-Day Availability SLO"
      slo_id            = datadog_service_level_objective.checkout_availability.id
      time_windows      = ["30d", "7d"]
      show_error_budget = true
      view_type         = "detail"
    }
  }

  # Row 2: Error rate trend over 30 days
  widget {
    timeseries_definition {
      title = "Error Rate vs SLO Target"
      request {
        q            = "100 - (sum:trace.express.request.hits{service:checkout,env:$env,!http.status_class:5xx}.as_count() / sum:trace.express.request.hits{service:checkout,env:$env}.as_count() * 100)"
        display_type = "line"
      }
      # Reference line at SLO target
      marker {
        value        = "y = 0.05"   # 0.05% error = 99.95% availability
        display_type = "error dashed"
        label        = "SLO threshold (0.05% errors)"
      }
    }
  }

  # Row 3: Burn rate
  widget {
    timeseries_definition {
      title = "Error Budget Burn Rate (1× = sustainable)"
      request {
        # Burn rate is current error rate / (1 - SLO target)
        # Simplified approximation for display
        q            = "sum:trace.express.request.hits{service:checkout,env:$env,http.status_class:5xx}.as_count() / (sum:trace.express.request.hits{service:checkout,env:$env}.as_count() * 0.0005)"
        display_type = "bars"
      }
      marker {
        value        = "y = 1"
        display_type = "warning dashed"
        label        = "1× — sustainable burn rate"
      }
    }
  }
}
```

**Verify the dashboard was created:**
```bash
terraform apply -auto-approve

# Retrieve the dashboard URL from Terraform state
terraform output -json | jq '.checkout_slo_dashboard_url.value'

# Or query the API
curl -s "https://api.datadoghq.com/api/v1/dashboard" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  | jq '.dashboards[] | select(.title | contains("Checkout")) | .url'
```

---

### Example 4: Alert Runbook Integration Pattern

An alert without a runbook forces the on-call engineer to reason from scratch under pressure. This example shows a monitor that links directly to a structured runbook and embeds enough diagnostic context in the alert body to survive a 3 AM page.

```hcl
resource "datadog_monitor" "payment_service_errors" {
  name = "Payment Service Error Rate - production [{{env}}]"
  type = "metric alert"

  # The message is the first thing the on-call engineer reads.
  # It must answer three questions without requiring navigation:
  # 1. What is happening?
  # 2. What is the blast radius?
  # 3. What do I do first?
  message = <<-EOT
    ## Payment Service Error Rate Elevated

    **Current value:** {{value}}%
    **Threshold:** {{threshold}}%
    **Environment:** {{env.name}}
    **Service:** {{service.name}}

    ### Immediate blast radius
    Payment processing failures affect checkout completion.
    Each minute of >5% errors = ~{{value | multiply: 0.05}}% of transactions failing.

    ### Quick diagnostic links
    - APM Service Map: https://app.datadoghq.com/apm/map?env={{env.name}}&service=payment-service
    - Error trace samples: https://app.datadoghq.com/apm/traces?query=service:payment-service%20status:error
    - Dashboard: https://app.datadoghq.com/dashboard/xyz-abc-def/payment-service
    - Logs: https://app.datadoghq.com/logs?query=service:payment-service%20status:error

    ### Runbook: First 5 minutes
    1. Check APM for the most common error type (timeout vs 500 vs dependency)
    2. Check recent deployments on the dashboard event overlay
    3. If Stripe API errors: check https://status.stripe.com
    4. If DB errors: check RDS dashboard for connection pool exhaustion
    5. If >10% errors for >5 min: declare incident in #incidents

    **Full runbook:** https://wiki.internal/runbooks/payment-service-errors

    {{#is_alert}}@pagerduty-payments-oncall{{/is_alert}}
    {{#is_warning}}@slack-payments-team{{/is_warning}}
    {{#is_recovery}}
      @slack-payments-team
      Resolved after {{duration}} minutes. Error rate: {{value}}%
      Please add a post-mortem item if duration > 10 minutes.
    {{/is_recovery}}
  EOT

  query = "avg(last_5m):avg:trace.express.request.errors{service:payment-service,env:production} / avg:trace.express.request.hits{service:payment-service,env:production} * 100"

  thresholds = {
    critical          = 5.0
    critical_recovery = 2.0
    warning           = 1.0
    warning_recovery  = 0.5
  }

  notify_no_data      = true
  no_data_timeframe   = 5    # payment service must emit data every 5 min
  require_full_window = true
  renotify_interval   = 30   # re-page every 30 min (payments = high business impact)

  tags = ["env:production", "service:payment-service", "team:payments", "severity:critical", "pii:false"]
}
```

**Verify the alert fires correctly using a synthetic threshold test:**
```bash
# Force the monitor into an alert state via the API (useful in staging)
# First, get the monitor ID from Terraform state
MONITOR_ID=$(terraform show -json | jq '.values.root_module.resources[] | select(.name=="payment_service_errors") | .values.id')

# Mute it first if you're testing in production
curl -X POST "https://api.datadoghq.com/api/v1/monitor/${MONITOR_ID}/mute" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}"

# Verify monitor status
curl -s "https://api.datadoghq.com/api/v1/monitor/${MONITOR_ID}" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  | jq '{name: .name, overall_state: .overall_state, query: .query}'
```

---

## Exercises

### Exercise 1: Design an Alert Threshold from Historical Data

**Objective:** practice threshold selection using real metric behavior rather than arbitrary numbers.

**Setup:** You have 30 days of p99 latency data for a service. The data shows:
- Typical daytime p99: 120–180ms
- Typical nighttime p99: 60–90ms
- Peak traffic spikes (daily): up to 350ms for 2–5 minutes
- Previous incidents (3 events): 600ms, 820ms, 950ms sustained for >10 minutes

**Task:**
1. Using the data above, determine appropriate warning and critical thresholds for a p99 latency monitor. Justify each threshold value — don't just pick numbers.
2. Write the Datadog metric monitor query for this alert, targeting a service called `order-service` in `env:production`.
3. Determine whether you should use `last_5m` or `last_15m` as your evaluation window. What is the trade-off? Which is appropriate here?
4. Set recovery thresholds that prevent flapping based on the data above.
5. Would you use a fixed-threshold monitor or an anomaly monitor for this metric? Explain why, considering the day/night pattern in the data.

**Expected deliverable:** a complete `datadog_monitor` Terraform resource with your chosen values and inline comments explaining each decision.

---

### Exercise 2: Build a RED Dashboard with Template Variables

**Objective:** build a service health dashboard that covers multiple environments without duplication.

**Task:**
1. Create a Datadog dashboard (via the UI or Terraform) for a service called `inventory-service` that includes:
   - A timeseries panel for request rate (`trace.flask.request.hits`)
   - A timeseries panel for error rate (errors / total * 100)
   - A timeseries panel for p99 latency (`trace.flask.request.duration`)
   - A query value widget showing current error rate
2. Add three template variables: `$env` (production/staging/dev), `$region` (us-east-1/eu-west-1), and `$version`.
3. Add threshold markers to the error rate panel at 1% (warning) and 5% (critical).
4. Add an event overlay to the timeseries panels that shows Datadog deployment events for `service:inventory-service`.

**Verification:** switch `$env` from `production` to `staging` and confirm all panels update. Switch back to `production` and confirm the panels are not permanently changed.

**Stretch goal:** add a Row 2 with two dependency panels — one showing database query duration and one showing cache hit rate. Explain what a sudden drop in cache hit rate indicates and how it would appear on the error rate panel.

---

### Exercise 3: Diagnose and Fix Alert Fatigue

**Objective:** given a broken monitor configuration, identify the specific problems and correct them.

**Broken configuration:**
```hcl
resource "datadog_monitor" "broken_alert" {
  name    = "CPU High"
  type    = "metric alert"
  message = "CPU is high @everyone"

  query = "avg(last_1m):avg:system.cpu.user{*} > 50"

  thresholds = {
    critical = 50.0
    warning  = 49.0
  }

  notify_no_data   = false
  renotify_interval = 0

  tags = []
}
```

**Task:**
1. Identify at least **five** specific problems with this configuration. For each problem, explain what negative operational consequence it causes (not just that it "looks wrong").
2. Write a corrected version of this monitor for a production service called `worker-service`, assuming CPU is normally 30–45% under load and spikes to 75–80% during incidents.
3. Explain why `avg:system.cpu.user{*}` is a dangerous query scope. What would you use instead, and what tag filters would you apply?
4. The monitor uses `last_1m` evaluation window. What problem does this cause, and what would you change it to?

---

### Exercise 4: Implement Multi-Window Burn-Rate Alerting

**Objective:** implement the two-window burn-rate alerting strategy from the SLO section and validate that the windows catch different failure types.

**Background:** You are responsible for a service with a 99.9% availability SLO over 30 days. The total error budget is 43.8 minutes of downtime per month.

**Task:**
1. Calculate: at a burn rate of 14.4×, how many minutes until the monthly error budget is exhausted? Show your arithmetic.
2. Calculate: at a burn rate of 3×, how many days until the monthly error budget is exhausted?
3. Write the two Datadog SLO alert monitors (fast burn and slow burn) for a service called `search-service`. Use the burn rates from questions 1 and 2.
4. Explain in 3–4 sentences why a single threshold-based monitor on the SLO's 30-day compliance percentage would fail to catch an acute incident in its early stages. What property of the 30-day rolling window causes this?
5. **Design question:** A colleague suggests adding a third window — 5-minute burn rate at 36× — to catch catastrophic failures even faster. What is the risk of this approach, and under what circumstances would you accept that risk?

---

### Quick Checks

6. Calculate the error rate as a percentage. Run: `python3 -c "errors=15; total=200; print(round(errors/total*100, 1))"`

```expected_output
7.5
```

hint: Think about how to express a fraction as a percentage using basic arithmetic in a Python one-liner.
hint: Use python3 -c with variables for errors and total, then print the result of dividing errors by total, multiplying by 100, and rounding to one decimal place with round().

7. Count monitors in a config stub. Run: `printf 'monitors:\n- name: CPU High\n- name: Error Rate\n- name: API Latency\n' | grep -c '^- name:'`

```expected_output
3
```

hint: Think about how you can filter lines matching a specific pattern and have the tool count those matches directly.
hint: Use grep with the -c flag to count lines matching the pattern '^- name:' from the piped input.

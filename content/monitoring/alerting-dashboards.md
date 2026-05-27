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

  # Prevents a brief spike from firing; metric must stay above threshold
  # for the full evaluation window
  # (controlled by the time aggregation in the query: last_5m)

  tags = ["env:production", "service:myapp", "team:platform", "severity:critical"]
}
```

**Hysteresis (recovery thresholds):** setting `critical_recovery` below `critical` prevents flapping — where a metric oscillates around the threshold and fires/recovers repeatedly. Without it, a metric at 5.1% → 4.9% → 5.1% generates three alert events in minutes.

**`notify_no_data`:** this is frequently overlooked. If a service crashes and stops emitting metrics, a threshold-based monitor will show `OK` (no data to breach the threshold) unless you explicitly enable no-data alerting. Always enable it for critical service monitors.

**`require_full_window`:** prevents false alerts when a monitor starts or a host restarts and only has 30 seconds of data in a 5-minute window. The partial average can look extreme.

**Threshold tuning checklist:**
- Pull 30 days of historical data for the metric
- Set warning at ~75th percentile of normal spikes, critical at ~99th
- Never set thresholds on day one — let the system run for a week first
- Review alert history monthly: if a critical fires without action taken, lower the threshold or remove the alert

---

### Notification Routing

Routing determines who gets paged, by what channel, and when. Misrouted alerts are nearly as harmful as missing alerts — paging the wrong team delays response, and paging everyone creates diffused responsibility.

```
Alert fires
    │
    ▼
Datadog evaluates monitor state (ALERT / WARN / NO DATA / RECOVERY)
    │
    ├─ ALERT  → @pagerduty-platform-oncall  → PagerDuty → phone/SMS to on-call
    ├─ WARN   → @slack-platform-team        → Slack channel notification
    └─ NO DATA → @pagerduty-platform-oncall (if notify_no_data = true)
```

**Severity model — map alert priority to escalation path:**

| Priority | Condition | Channel | Hours |
|---|---|---|---|
| P1 | Production down or data loss | PagerDuty → phone/SMS | 24/7 |
| P2 | Degraded production service | PagerDuty → push notification | Business hours |
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

**Multi-team routing with tag-based conditions:** if the same monitor covers multiple services or teams, use `@team-<name>` handles tied to the service tag:

```
{{#is_alert}}
  {{#service.name}}
  Affected service: {{service.name}}
  {{/service.name}}
  @pagerduty-{{team.name}}-oncall
{{/is_alert}}
```

**PagerDuty escalation policy:** Datadog sends the alert; PagerDuty owns the escalation logic (retry after N minutes, escalate to secondary on-call, notify manager). Don't duplicate escalation logic inside Datadog monitor messages. Datadog should only route to the correct PagerDuty service; PagerDuty handles what happens next.

---

### Dashboard Design

A dashboard that shows everything shows nothing useful. The most effective dashboards are built around a specific question for a specific audience — before you add a widget, ask "what decision does this panel help someone make?"

**Dashboard archetypes:**

| Type | Audience | Primary Question | Key Metrics |
|---|---|---|---|
| **Service (RED)** | Service owners, on-call | Is my service healthy right now? | Request rate, error rate, duration |
| **Infrastructure (USE)** | SRE, platform team | Are my hosts/pods under stress? | CPU utilization, saturation, errors |
| **Business** | Engineering leadership, product | Are users succeeding? | Signups, conversion, revenue, DAU |
| **Incident** | On-call during an incident | What is broken and why? | Narrowly scoped to the incident type |
| **Dependency** | On-call, service owners | Are my upstream/downstream services healthy? | Latency, error rate per dependency |

**RED method** (Rate, Errors, Duration) — the standard framework for service-level dashboards:
- **Rate:** requests per second — is the service receiving traffic?
- **Errors:** error rate (%) — is it serving those requests successfully?
- **Duration:** p50/p95/p99 latency — is it serving them fast enough?

**USE method** (Utilization, Saturation, Errors) — for infrastructure resources:
- **Utilization:** what percentage of capacity is being used? (CPU 70%)
- **Saturation:** is work queuing up? (load average, queue depth)
- **Errors:** are hardware or OS errors occurring?

**Service dashboard layout — ordered by diagnostic value:**
```
Row 1 — Health indicators (answer: is it broken?)
  • Error rate [timeseries, threshold line at 1% warn, 5% critical]
  • p99 request latency [timeseries, threshold line at 500ms]
  • Request rate [timeseries — spot traffic drops = another failure mode]

Row 2 — Dependencies (answer: is something upstream/downstream causing it?)
  • Downstream service error rates [timeseries, one line per dependency]
  • Database query duration [timeseries]
  • Cache hit rate [timeseries — drop in hit rate = cache flush or miss storm]

Row 3 — Infrastructure (answer: is the host/pod responsible?)
  • CPU utilization [timeseries, grouped by pod]
  • Memory usage [timeseries]
  • Pod / replica count [timeseries — sudden drop = crash loop]

Row 4 — Context
  • Deployment events [event overlay on time series]
  • Recent error logs [log stream widget, filtered to this service]
```

**Template variables** enable a single dashboard to cover all environments and services:

```
$env     → production | staging | dev
$service → myapp | payment-service | user-service
$region  → us-east-1 | eu-west-1
```

Every query in the dashboard references `$env`, `$service`, and `$region` as tag filters:

```
avg:trace.flask.request.errors{env:$env, service:$service, region:$region}
```

Switching `$env` from `production` to `staging` instantly updates every panel — no rebuilding.

**Widget type selection:**

| Widget | Use When |
|---|---|
| **Timeseries** | You need to see change over time (always use for anything on a dashboard) |
| **Query Value** | Current state needs instant readability (error rate = 2.3%) |
| **Heatmap** | Distribution of values across many hosts/pods |
| **Top List** | Ranking (top 10 slowest endpoints) |
| **Log Stream** | Correlated logs visible alongside metrics |
| **SLO Widget** | Remaining error budget, compliance status |

**Dashboard anti-patterns to avoid:**
- Panels with no threshold lines — a number without context is meaningless under pressure
- Dashboards that require scrolling to find the most important signal — put health indicators at the top
- More than 20 panels on one dashboard — split into focused sub-dashboards
- Panels using different time ranges — forces mental reconciliation during incidents
- No template variables — a dashboard hard-coded to `env:production` can't be used for staging investigations

---

### SLO Dashboards and Error Budget Alerting

Service Level Objectives (SLOs) formalize the target reliability of a service. An SLO dashboard makes the error budget — the allowed amount of unreliability — visible and actionable.

**Key terms:**

| Term | Definition | Example |
|---|---|---|
| **SLI** | Service Level Indicator — the metric being measured | % of requests returning 2xx |
| **SLO** | Service Level Objective — the target for that metric | 99.9% over 30 days |
| **Error budget** | How much unreliability is permitted | 0.1% of requests = ~43 min/month downtime |
| **Burn rate** | How fast you're consuming error budget | Burn rate 2× = budget exhausted in 15 days instead of 30 |

```yaml
# Terraform: Datadog SLO definition
resource "datadog_service_level_objective" "api_availability" {
  name        = "API Availability - myapp"
  type        = "metric"
  description = "99.9% of API requests return non-5xx responses"

  query {
    # Good events: non-error requests
    numerator   = "sum:trace.flask.request.hits{service:myapp,env:production,!status:error}.as_count()"
    # Total events: all requests
    denominator = "sum:trace.flask.request.hits{service:myapp,env:production}.as_count()"
  }

  thresholds {
    timeframe = "7d"
    target    = 99.9
    warning
---
title: Alerting and Dashboards
module: monitoring
duration_min: 20
difficulty: intermediate
tags: [monitoring, datadog, alerting, dashboards, monitors, pagerduty, slo]
exercises: 4
---

## Overview
Alerts tell you when something needs attention. Dashboards show you what's happening. The hard part isn't setting them up — it's avoiding alert fatigue (too many alerts that train on-call engineers to ignore them) and building dashboards that answer the right questions quickly. This lesson covers Datadog monitors, notification routing, and dashboard design that's actually useful under pressure.

## Concepts

### Datadog Monitor Types

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

**APM monitor** — alert on service metrics from distributed traces:
```
Query: avg(last_10m):avg:trace.flask.request.errors{service:myapp,env:prod} / avg:trace.flask.request.hits{service:myapp,env:prod} * 100 > 5
→ Alert when error rate exceeds 5%
```

**Composite monitor** — trigger when multiple conditions are met simultaneously:
```
Alert if (high CPU monitor) AND (high memory monitor)
→ Reduces false positives from short CPU spikes alone
```

**Anomaly monitor** — alert when a metric deviates from its historical pattern:
```
Query: avg(last_1h):anomalies(avg:trace.web.request.duration.by.service{service:myapp}, 'basic', 3) >= 1
→ Alert when latency is 3 standard deviations from expected for this time of day
```

### Monitor Configuration Best Practices
```yaml
# Monitor configuration (via Terraform / Datadog provider)
resource "datadog_monitor" "api_error_rate" {
  name    = "High API Error Rate - myapp"
  type    = "metric alert"
  message = <<-EOT
    Error rate is {{value}}% on {{service.name}} (threshold: {{threshold}}%)
    
    Runbook: https://wiki.mycompany.com/runbooks/api-errors
    
    @pagerduty-platform-team
  EOT

  query = "avg(last_5m):avg:trace.flask.request.errors{service:myapp,env:production} / avg:trace.flask.request.hits{service:myapp,env:production} * 100"

  thresholds = {
    critical = 5.0
    warning  = 2.0
  }

  notify_no_data    = true
  no_data_timeframe = 10    # alert if no data for 10 minutes (service may be down)
  
  renotify_interval = 60    # re-alert every 60 minutes if still firing

  tags = ["env:production", "service:myapp", "team:platform"]
}
```

**Avoid alert fatigue:**
- Set thresholds based on historical data, not gut feel
- Add `warning` thresholds to give notice before `critical`
- Use evaluation windows long enough to suppress transient spikes (5m, not 1m)
- Every alert should have a runbook link in the message
- Review firing alerts weekly — if an alert fires and no one acts, remove it

### Notification Routing
```
Alert fires
    ↓
Datadog evaluates routing
    ↓
@pagerduty-service → PagerDuty → on-call engineer (phone/SMS)
@slack-channel     → Slack → team channel
@email             → email
```

**Priority levels:**
```
P1 — production incident, page immediately (PagerDuty, 24/7 on-call)
P2 — degraded service, page during business hours
P3 — elevated concern, Slack notification only
P4 — informational, email
```

```
# In monitor message body:
{{#is_alert}}
  @pagerduty-platform-oncall     # only pages when alert fires
{{/is_alert}}
{{#is_warning}}
  @slack-platform-team           # notifies on warning
{{/is_warning}}
```

### Dashboard Design
A good dashboard answers a specific question for a specific audience.

**Types:**
- **Service dashboard** — health of one service (RED metrics: rate, errors, duration)
- **Infrastructure dashboard** — host-level metrics (USE: utilization, saturation, errors)
- **Business dashboard** — product metrics (signups, revenue, conversion)
- **Incident dashboard** — focused view for diagnosing a specific incident type

```
# Service dashboard layout (top to bottom):
1. Health indicators: error rate, p99 latency, request rate (with threshold lines)
2. Dependencies: downstream service health, DB query time, cache hit rate
3. Infrastructure: CPU, memory, pod count
4. Recent deployments (deployment events overlay on time series)
5. Logs widget: recent errors for this service
```

**Template variables** make dashboards reusable:
```
$env     = production | staging | dev
$service = myapp | payment-service | user-service
$region  = us-east-1 | eu-west-1
```

Every query in the dashboard uses `$env` and `$service` — switch the variable to see a different environment or service without rebuilding the dashboard.

### SLO Dashboards
```yaml
# Datadog SLO definition
resource "datadog_service_level_objective" "api_availability" {
  name        = "API Availability - myapp"
  type        = "metric"
  description = "99.9% of API requests return 2xx"

  query {
    numerator   = "sum:trace.flask.request.hits{service:myapp,env:production,status:!error}.as_count()"
    denominator = "sum:trace.flask.request.hits{service:myapp,env:production}.as_count()"
  }

  thresholds {
    timeframe = "7d"
    target    = 99.9
    warning   = 99.95
  }

  thresholds {
    timeframe = "30d"
    target    = 99.9
  }

  tags = ["service:myapp", "env:production"]
}
```

### Synthetic Monitoring
```yaml
# Datadog synthetic API test — runs every 5 minutes from multiple locations
resource "datadog_synthetics_test" "api_health" {
  type    = "api"
  subtype = "http"

  request_definition {
    method = "GET"
    url    = "https://api.myapp.com/health"
  }

  assertion {
    type     = "statusCode"
    operator = "is"
    target   = "200"
  }

  assertion {
    type     = "responseTime"
    operator = "lessThan"
    target   = 1000   # ms
  }

  locations = ["aws:us-east-1", "aws:eu-west-1", "aws:ap-southeast-1"]

  options_list {
    tick_every = 300   # every 5 minutes
  }
}
```

## Examples

### On-Call Runbook Structure
Every alert should reference a runbook:

```markdown
## Alert: High API Error Rate

### What it means
More than 5% of API requests are returning 5xx errors over the last 5 minutes.

### Immediate investigation
1. `kubectl logs -l app=myapp -n production --tail=100` — check for exceptions
2. Check the [APM service page](https://app.datadoghq.com) for error traces
3. `kubectl get pods -n production` — are pods healthy?
4. Check downstream: is the database reachable? Is Redis up?

### Common causes
- Deployment introduced a bug → roll back with `kubectl rollout undo deployment/myapp`
- Database connection pool exhausted → check `db.pool.size` metric
- Upstream dependency down → check dependency service monitors

### Escalation
If not resolved in 15 minutes, escalate to the service owner.
```

## Exercises

1. Create a Datadog metric monitor that alerts when API error rate exceeds 5% over 5 minutes. Set a warning threshold at 2%. Include a Slack notification for warning, PagerDuty for alert. Write the runbook link in the message body.
2. Build a service dashboard for a web API with: request rate (timeseries), p95 latency (timeseries with threshold line at 300ms), error rate (query value with color thresholds), and pod count. Add template variables for `$env` and `$service`.
3. Create a Datadog SLO for 99.9% API availability over 30 days. Add it to your dashboard as an SLO widget showing remaining error budget. Set a burn rate alert that fires when you're burning error budget too fast.
4. Configure a synthetic test that hits your API's `/health` endpoint every 5 minutes from 3 geographic locations. Set it to alert if status code is not 200 or response time exceeds 1 second. Verify it appears in the Synthetics dashboard.

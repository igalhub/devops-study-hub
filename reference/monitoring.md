# Monitoring (Datadog) — Quick Reference

## Datadog Agent

| Command | Description |
|---------|-------------|
| `datadog-agent status` | Full agent status |
| `datadog-agent check check_name` | Run a check manually |
| `datadog-agent configcheck` | Validate check configs |
| `datadog-agent diagnose` | Run connectivity diagnostics |
| `datadog-agent hostname` | Show reported hostname |
| `datadog-agent flare` | Create support flare |
| `systemctl status datadog-agent` | Agent service status |
| `journalctl -u datadog-agent -f` | Follow agent logs |

## Datadog CLI (dogstatsd / ddtrace)

| Command | Description |
|---------|-------------|
| `DD_ENV=prod DD_SERVICE=web ddtrace-run python app.py` | APM trace injection |
| `DD_AGENT_HOST=localhost ddtrace-run gunicorn app:app` | Remote agent |
| `dog metric post my.metric 42 --tags env:prod` | Post custom metric |
| `dog event post "Deploy" "v1.2.3 deployed" --alert_type info` | Post event |
| `dog monitor mute ID --end 1700000000` | Mute monitor until time |

## DogStatsD Metrics (from code)

| Type | Pattern | Description |
|------|---------|-------------|
| Count | `statsd.increment("requests.count", tags=["env:prod"])` | Increment counter |
| Gauge | `statsd.gauge("queue.depth", 42)` | Set gauge value |
| Histogram | `statsd.histogram("response.time", 0.234)` | Track distribution |
| Timing | `statsd.timing("query.ms", 150)` | Timing in ms |
| Set | `statsd.set("unique.users", user_id)` | Count unique values |

## Query Language (Metrics)

| Query | Description |
|-------|-------------|
| `avg:system.cpu.user{*}` | Average CPU across all hosts |
| `sum:nginx.net.request_per_s{env:prod}` | Sum by tag filter |
| `avg:system.load.1{host:web01}` | Single host |
| `top(avg:system.cpu.user{*} by {host}, 5, "max", "desc")` | Top 5 hosts by CPU |
| `anomalies(avg:db.query.time{*}, 'basic', 2)` | Anomaly detection |
| `forecast(avg:disk.used{*}, 'linear', 7)` | 7-day forecast |
| `diff(avg:system.mem.used{*})` | Rate of change |

## Monitor Alert Thresholds (YAML)

```yaml
type: metric alert
query: "avg(last_5m):avg:system.cpu.user{env:prod} > 80"
thresholds:
  critical: 80
  warning: 60
  critical_recovery: 75
  warning_recovery: 55
```

## Logs Query Syntax

| Query | Description |
|-------|-------------|
| `service:nginx status:error` | Errors from nginx |
| `env:prod @http.status_code:[500 TO 599]` | 5xx in production |
| `@duration:>1000` | Requests over 1s |
| `"connection refused"` | Exact phrase |
| `-status:info` | Exclude info level |
| `@user.id:12345 service:auth` | Specific user auth events |

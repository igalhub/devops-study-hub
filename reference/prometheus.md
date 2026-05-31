# Prometheus — Quick Reference

## PromQL Basics

| Query | Description |
|-------|-------------|
| `metric_name` | Instant vector — current value |
| `metric_name[5m]` | Range vector — last 5 minutes |
| `metric_name{label="val"}` | Filter by label |
| `metric_name{label=~"val.*"}` | Label regex match |
| `metric_name{label!="val"}` | Label not equal |
| `metric_name{label!~"val.*"}` | Label regex not match |
| `metric_name offset 1h` | Value 1 hour ago |

## Aggregation Operators

| Query | Description |
|-------|-------------|
| `sum(metric)` | Sum all series |
| `sum by (label) (metric)` | Sum grouped by label |
| `avg(metric)` | Average |
| `max(metric)` | Maximum |
| `min(metric)` | Minimum |
| `count(metric)` | Count series |
| `topk(5, metric)` | Top 5 by value |
| `bottomk(5, metric)` | Bottom 5 by value |

## Rate & Change Functions

| Query | Description |
|-------|-------------|
| `rate(counter[5m])` | Per-second rate over 5m (smooth) |
| `irate(counter[5m])` | Instant rate (last 2 samples) |
| `increase(counter[1h])` | Total increase over 1h |
| `delta(gauge[10m])` | Change in gauge over 10m |
| `deriv(gauge[5m])` | Per-second derivative |
| `predict_linear(gauge[1h], 3600)` | Predict value in 1h |

## Common Metrics

| Metric | Description |
|--------|-------------|
| `up` | Target scrape status (1=up, 0=down) |
| `scrape_duration_seconds` | How long scrape took |
| `process_cpu_seconds_total` | CPU usage (counter) |
| `process_resident_memory_bytes` | RSS memory |
| `http_requests_total` | HTTP request counter |
| `http_request_duration_seconds` | Request latency histogram |
| `node_cpu_seconds_total` | CPU time by mode |
| `node_memory_MemAvailable_bytes` | Available memory |
| `node_filesystem_avail_bytes` | Available disk space |
| `node_network_receive_bytes_total` | Network RX bytes |

## alertmanager CLI

| Command | Description |
|---------|-------------|
| `amtool alert` | List active alerts |
| `amtool alert query alertname=name` | Filter alerts |
| `amtool silence add alertname=name` | Create silence |
| `amtool silence list` | List silences |
| `amtool silence expire ID` | Remove silence |
| `amtool config show` | Show loaded config |
| `amtool check-config alertmanager.yml` | Validate config |

## promtool

| Command | Description |
|---------|-------------|
| `promtool check config prometheus.yml` | Validate config |
| `promtool check rules rules.yml` | Validate alert rules |
| `promtool query instant http://localhost:9090 'up'` | Run instant query |
| `promtool query range http://localhost:9090 'up'` | Run range query |
| `promtool test rules tests.yml` | Unit test alert rules |

## Recording Rule Patterns

```yaml
groups:
  - name: example
    interval: 30s
    rules:
      - record: job:http_requests:rate5m
        expr: sum by (job) (rate(http_requests_total[5m]))
      - alert: HighErrorRate
        expr: rate(http_errors_total[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High error rate on {{ $labels.job }}"
```

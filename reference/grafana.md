# Grafana — Quick Reference

## grafana-cli

| Command | Description |
|---------|-------------|
| `grafana-cli plugins list-remote` | List available plugins |
| `grafana-cli plugins install plugin-id` | Install plugin |
| `grafana-cli plugins ls` | List installed plugins |
| `grafana-cli plugins remove plugin-id` | Remove plugin |
| `grafana-cli plugins update-all` | Update all plugins |
| `grafana-cli admin reset-admin-password newpass` | Reset admin password |

## HTTP API (curl patterns)

```bash
GRAFANA="http://admin:password@localhost:3000"

# Health check
curl "$GRAFANA/api/health"

# List dashboards
curl "$GRAFANA/api/search?type=dash-db"

# Get dashboard by UID
curl "$GRAFANA/api/dashboards/uid/DASHBOARD_UID"

# Import dashboard
curl -X POST "$GRAFANA/api/dashboards/import" \
  -H "Content-Type: application/json" \
  -d @dashboard.json

# List data sources
curl "$GRAFANA/api/datasources"

# List alert rules
curl "$GRAFANA/api/v1/provisioning/alert-rules"

# Silence an alert
curl -X POST "$GRAFANA/api/alertmanager/grafana/api/v2/silences" \
  -H "Content-Type: application/json" \
  -d '{"matchers":[{"name":"alertname","value":"MyAlert","isRegex":false}],"startsAt":"...","endsAt":"..."}'
```

## Dashboard Provisioning (YAML)

```yaml
apiVersion: 1
providers:
  - name: default
    type: file
    options:
      path: /etc/grafana/dashboards
      foldersFromFilesStructure: true
```

## Data Source Provisioning (YAML)

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus:9090
    isDefault: true
  - name: Loki
    type: loki
    url: http://loki:3100
```

## Common Variables in Dashboards

| Variable | Description |
|----------|-------------|
| `$__timeFilter(column)` | SQL time filter from dashboard range |
| `$__interval` | Auto-calculated interval |
| `$__rate_interval` | Recommended for rate() queries |
| `$__from` | Dashboard from time (ms) |
| `$__to` | Dashboard to time (ms) |
| `${variable}` | Template variable substitution |
| `${variable:regex}` | With regex formatting |

## LogQL (Loki) Quick Reference

| Query | Description |
|-------|-------------|
| `{service="nginx"}` | All logs from nginx |
| `{service="nginx"} \|= "ERROR"` | Filter for "ERROR" string |
| `{service="nginx"} != "DEBUG"` | Exclude "DEBUG" |
| `{service="nginx"} \| json` | Parse JSON logs |
| `{service="nginx"} \| pattern '<ip> - - [<_>] "<method> <uri> <_>" <status>'` | Pattern parser |
| `rate({service="nginx"} \|= "error" [5m])` | Error rate per second |
| `count_over_time({service="nginx"}[5m])` | Log count over time |

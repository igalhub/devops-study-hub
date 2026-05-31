# Opsgenie — Quick Reference

## Opsgenie CLI (opsgenie-cli / ogcli)

| Command | Description |
|---------|-------------|
| `ogcli get alert --id ID` | Get alert details |
| `ogcli list alert` | List open alerts |
| `ogcli create alert --message "msg" --priority P2` | Create alert |
| `ogcli acknowledge alert --id ID` | Acknowledge alert |
| `ogcli close alert --id ID --note "resolved"` | Close alert |
| `ogcli add alert note --id ID --note "msg"` | Add note to alert |
| `ogcli list schedule` | List on-call schedules |
| `ogcli get who-is-on-call --schedule "Team"` | Current on-call |

## Alerts API (curl)

```bash
OG_KEY="your-api-key"
BASE="https://api.opsgenie.com/v2"

# Create alert
curl -X POST "$BASE/alerts" \
  -H "Authorization: GenieKey $OG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Disk usage > 90%","priority":"P2","tags":["disk","production"]}'

# Get alert
curl -X GET "$BASE/alerts/ID" \
  -H "Authorization: GenieKey $OG_KEY"

# List open alerts
curl -X GET "$BASE/alerts?status=open&limit=20" \
  -H "Authorization: GenieKey $OG_KEY"

# Acknowledge alert
curl -X POST "$BASE/alerts/ID/acknowledge" \
  -H "Authorization: GenieKey $OG_KEY" \
  -d '{"note":"Looking into it"}'

# Close alert
curl -X DELETE "$BASE/alerts/ID" \
  -H "Authorization: GenieKey $OG_KEY"

# Who is on-call
curl -X GET "$BASE/schedules/SCHEDULE_ID/on-calls" \
  -H "Authorization: GenieKey $OG_KEY"
```

## Alert Priority Levels

| Priority | Meaning |
|----------|---------|
| `P1` | Critical — service down, immediate response |
| `P2` | High — impaired functionality |
| `P3` | Moderate — degraded but operational |
| `P4` | Low — non-urgent issue |
| `P5` | Informational — no action required |

## Integration Types

| Integration | Trigger method |
|-------------|----------------|
| Prometheus Alertmanager | Webhook to Opsgenie API |
| Grafana | Built-in Opsgenie notification channel |
| Zabbix | Script action with curl |
| Datadog | Native Opsgenie integration |
| PagerDuty → Opsgenie | Via integration bridge |
| Email | Send to `alerts@domain.opsgenie.net` |
| REST API | POST to `/v2/alerts` |

## Notification Policy Escalation (YAML concept)

```
On-call rotation:
  - Primary: Team member A (immediate)
  - +5 min: Team member B (if no ack)
  - +15 min: Engineering manager (escalation)
  - +30 min: VP Engineering (critical escalation)
```

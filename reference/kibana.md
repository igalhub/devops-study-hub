# Kibana — Quick Reference

## KQL (Kibana Query Language)

| Query | Description |
|-------|-------------|
| `status: 404` | Exact field match |
| `status: 4*` | Wildcard match |
| `status >= 400 and status < 500` | Numeric range |
| `message: "connection refused"` | Phrase search |
| `response_time > 1000` | Greater than |
| `NOT status: 200` | Negate |
| `service: nginx AND status: error` | AND |
| `env: prod OR env: staging` | OR |
| `tags: (error OR warning)` | Multiple values |
| `_exists_: user.id` | Field exists |
| `NOT _exists_: error_code` | Field missing |

## Lucene Query Syntax (Discover fallback)

| Query | Description |
|-------|-------------|
| `field:value` | Term match |
| `field:"exact phrase"` | Phrase match |
| `field:val*` | Wildcard |
| `field:[100 TO 200]` | Inclusive range |
| `field:{100 TO 200}` | Exclusive range |
| `field:[100 TO *]` | Open-ended range |
| `+must -mustnot should` | Boolean shorthand |
| `field:(a OR b)` | Multiple terms |

## ES\|QL (Elasticsearch Query Language)

```esql
FROM logs-*
| WHERE @timestamp >= NOW() - 1 hour
| WHERE status >= 400
| STATS count = COUNT(*) BY service
| SORT count DESC
| LIMIT 10
```

```esql
FROM metrics-*
| EVAL response_ms = response_time / 1000000
| WHERE response_ms > 1
| STATS avg_ms = AVG(response_ms), p95 = PERCENTILE(response_ms, 95) BY endpoint
```

## Dashboard URLs (Dev Tools Console)

```
# Discover
/app/discover

# Dashboard
/app/dashboards

# Dev Tools (run Elasticsearch queries directly)
/app/dev_tools

# Stack Monitoring
/app/monitoring
```

## Dev Tools Console Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Execute request |
| `Ctrl+/` | Comment/uncomment |
| `Ctrl+Space` | Autocomplete |
| `Ctrl+I` | Auto-indent |
| `Ctrl+Home` | Jump to start |

## Index Patterns / Data Views

| Action | Location |
|--------|----------|
| Create data view | Stack Management → Data Views → Create |
| Set default data view | Click star on data view |
| Refresh field list | Edit data view → Refresh |
| Field format override | Edit data view → field → edit format |

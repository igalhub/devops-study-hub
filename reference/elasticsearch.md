# Elasticsearch — Quick Reference

## Cluster & Health

| API Call | Description |
|----------|-------------|
| `GET /_cluster/health` | Cluster health (green/yellow/red) |
| `GET /_cluster/stats` | Cluster-wide statistics |
| `GET /_nodes/stats` | Per-node stats |
| `GET /_cat/nodes?v` | Node list with roles |
| `GET /_cat/shards?v` | Shard allocation |
| `GET /_cat/allocation?v` | Disk usage per node |
| `GET /_cat/pending_tasks` | Pending cluster tasks |

## Index Management

| API Call | Description |
|----------|-------------|
| `GET /_cat/indices?v` | List indices with stats |
| `PUT /myindex` | Create index |
| `PUT /myindex` `{ "settings": { "number_of_shards": 1 } }` | Create with settings |
| `DELETE /myindex` | Delete index |
| `GET /myindex/_settings` | Show index settings |
| `GET /myindex/_mapping` | Show index mapping |
| `POST /myindex/_open` | Open closed index |
| `POST /myindex/_close` | Close index |
| `POST /myindex/_refresh` | Force refresh (make docs searchable) |
| `POST /myindex/_flush` | Force flush to disk |
| `POST /_aliases` `{ "actions": [...] }` | Manage aliases |

## Document CRUD

| API Call | Description |
|----------|-------------|
| `PUT /index/_doc/ID` `{ ... }` | Index document with ID |
| `POST /index/_doc` `{ ... }` | Index with auto-generated ID |
| `GET /index/_doc/ID` | Retrieve document |
| `POST /index/_update/ID` `{ "doc": { ... } }` | Partial update |
| `DELETE /index/_doc/ID` | Delete document |
| `POST /index/_delete_by_query` `{ "query": { ... } }` | Delete by query |
| `GET /index/_count` `{ "query": { ... } }` | Count matching docs |

## Search Queries

| Query | Description |
|-------|-------------|
| `{ "query": { "match_all": {} } }` | All documents |
| `{ "query": { "match": { "field": "text" } } }` | Full-text match |
| `{ "query": { "term": { "field": "exact" } } }` | Exact keyword match |
| `{ "query": { "range": { "field": { "gte": 10 } } } }` | Range filter |
| `{ "query": { "bool": { "must": [...], "filter": [...] } } }` | Boolean query |
| `{ "query": { "wildcard": { "field": "val*" } } }` | Wildcard |
| `{ "from": 0, "size": 20, "query": { ... } }` | Pagination |
| `{ "sort": [{ "field": "desc" }], "query": { ... } }` | Sort results |

## Aggregations

| Aggregation | Description |
|-------------|-------------|
| `{ "aggs": { "by_field": { "terms": { "field": "status" } } } }` | Count by field value |
| `{ "aggs": { "avg_price": { "avg": { "field": "price" } } } }` | Average |
| `{ "aggs": { "total": { "sum": { "field": "amount" } } } }` | Sum |
| `{ "aggs": { "over_time": { "date_histogram": { "field": "@timestamp", "calendar_interval": "day" } } } }` | Time histogram |

## Index Lifecycle (ILM)

| API Call | Description |
|----------|-------------|
| `GET /_ilm/policy` | List ILM policies |
| `PUT /_ilm/policy/myPolicy` `{ "policy": { ... } }` | Create ILM policy |
| `GET /index/_ilm/explain` | Show index ILM status |
| `POST /index/_ilm/retry` | Retry failed ILM step |

## curl Shorthand

```bash
# Set base URL
ES="http://localhost:9200"

curl -X GET "$ES/_cluster/health?pretty"
curl -X GET "$ES/_cat/indices?v&s=index"
curl -X POST "$ES/myindex/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{"query":{"match_all":{}}}'
```

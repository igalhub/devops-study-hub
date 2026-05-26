---
title: Inputs, Filters & Outputs
module: logstash
duration_min: 25
difficulty: intermediate
tags: [logstash, grok, filters, inputs, outputs, elk]
exercises: 3
---

## Overview
The plugin triad — inputs, filters, and outputs — is where the bulk of Logstash pipeline authoring happens. Getting this right determines whether your data arrives in Elasticsearch clean, correctly typed, and with accurate timestamps. Grok in particular is the most-used and most-debugged filter in ELK deployments. This lesson covers the most production-relevant plugins and patterns you'll encounter in real DevOps environments.

## Concepts

### Inputs

#### file
Tails a file on disk, tracking position in a sincedb file.

```ruby
input {
  file {
    path => ["/var/log/nginx/access.log", "/var/log/nginx/error.log"]
    start_position => "end"          # "beginning" to reprocess
    sincedb_path => "/var/lib/logstash/.sincedb_nginx"
    mode => "tail"                   # "read" for static files
    tags => ["nginx"]
  }
}
```

#### beats
Receives data from Filebeat, Metricbeat, etc. over the Beats protocol (Lumberjack v2).

```ruby
input {
  beats {
    port => 5044
    ssl => true
    ssl_certificate => "/etc/logstash/certs/logstash.crt"
    ssl_key => "/etc/logstash/certs/logstash.key"
  }
}
```

#### tcp / udp
Useful for syslog-over-TCP, legacy log shippers, or quick integration tests.

```ruby
input {
  tcp {
    port => 5000
    codec => json_lines
  }
  udp {
    port => 5001
    codec => plain
  }
}
```

#### kafka
High-throughput ingest from Kafka topics. Logstash acts as a consumer group.

```ruby
input {
  kafka {
    bootstrap_servers => "kafka01:9092,kafka02:9092"
    topics => ["app-logs", "infra-logs"]
    group_id => "logstash-consumers"
    consumer_threads => 4
    codec => json
    auto_offset_reset => "latest"
  }
}
```

#### syslog
Accepts RFC 3164 / RFC 5424 syslog messages and auto-parses facility, severity, and host.

```ruby
input {
  syslog {
    port => 514
    type => "syslog"
  }
}
```

### Filters

#### grok — Pattern Matching
Grok is regex with named captures, backed by a library of ~120 built-in patterns.

Syntax: `%{PATTERN_NAME:field_name}` or `%{PATTERN_NAME:field_name:data_type}`

Common built-in patterns:

| Pattern | Matches |
|---|---|
| `%{IP}` | IPv4/IPv6 address |
| `%{NUMBER}` | Integer or float |
| `%{WORD}` | `\b\w+\b` |
| `%{DATA}` | `.*?` (non-greedy) |
| `%{GREEDYDATA}` | `.*` (greedy) |
| `%{COMBINEDAPACHELOG}` | Full Apache combined log line |
| `%{SYSLOGBASE}` | Syslog header (timestamp, host, program) |
| `%{TIMESTAMP_ISO8601}` | ISO 8601 timestamp |
| `%{LOGLEVEL}` | DEBUG, INFO, WARN, ERROR, etc. |

```ruby
filter {
  grok {
    match => {
      "message" => "%{IP:client_ip} - %{USER:ident} \[%{HTTPDATE:timestamp}\] \"%{WORD:method} %{URIPATHPARAM:request} HTTP/%{NUMBER:http_version}\" %{NUMBER:status_code:integer} %{NUMBER:bytes:integer}"
    }
    tag_on_failure => ["_grokparsefailure"]   # default, override for custom tagging
    overwrite => ["message"]
  }
}
```

Multiple patterns (tries in order, first match wins):

```ruby
grok {
  match => {
    "message" => [
      "%{COMBINEDAPACHELOG}",
      "%{COMMONAPACHELOG}"
    ]
  }
}
```

#### mutate
Field manipulation: rename, convert, replace, strip, split, merge, remove.

```ruby
filter {
  mutate {
    rename      => { "host" => "source_host" }
    convert     => { "status_code" => "integer"
                     "response_time" => "float" }
    add_field   => { "environment" => "production" }
    remove_field => ["agent", "auth", "@version"]
    uppercase   => ["http_method"]
    strip       => ["user_agent"]     # trim whitespace
    split       => { "tags_csv" => "," }
  }
}
```

#### date
Parse a string into `@timestamp`. Critical — without this, Logstash sets `@timestamp` to ingest time, not the event's actual time.

```ruby
filter {
  date {
    match => [ "timestamp", "dd/MMM/yyyy:HH:mm:ss Z",
                            "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
                            "UNIX", "UNIX_MS" ]
    target => "@timestamp"
    timezone => "UTC"
    remove_field => ["timestamp"]
  }
}
```

#### json
Parse a JSON string field into structured fields.

```ruby
filter {
  json {
    source => "message"
    target => "parsed"        # nest under key; omit to merge at top level
    skip_on_invalid_json => true
  }
}
```

#### drop
Discard events matching a condition. Use to filter noise before it reaches Elasticsearch.

```ruby
filter {
  if [status_code] == 200 and [path] =~ /^\/health/ {
    drop { }
  }
}
```

#### Conditionals (if/else if/else)
Conditionals can wrap any filter. Supported operators: `==`, `!=`, `<`, `>`, `=~` (regex match), `!~`, `in`, `not in`.

```ruby
filter {
  if [type] == "apache" {
    grok { match => { "message" => "%{COMBINEDAPACHELOG}" } }
  } else if [type] == "syslog" {
    grok { match => { "message" => "%{SYSLOGBASE} %{GREEDYDATA:syslog_message}" } }
    mutate { rename => { "syslog_message" => "message" } }
  } else {
    mutate { add_tag => ["unrecognised_type"] }
  }
}
```

### Outputs

#### elasticsearch
The primary output for ELK pipelines.

```ruby
output {
  elasticsearch {
    hosts => ["https://es01:9200", "https://es02:9200"]
    index => "logs-%{[fields][app]}-%{+YYYY.MM.dd}"
    user => "logstash_writer"
    password => "${ES_PASSWORD}"   # environment variable interpolation
    ssl => true
    cacert => "/etc/logstash/certs/ca.crt"
    manage_template => false       # use ILM instead
    ilm_enabled => true
    ilm_rollover_alias => "logs-app"
    ilm_policy => "logs-30d"
    action => "index"              # or "create", "update", "delete"
    retry_on_conflict => 3
  }
}
```

#### file
Write events to disk — useful for debugging or archival.

```ruby
output {
  file {
    path => "/tmp/logstash-debug-%{+YYYY-MM-dd}.log"
    codec => json_lines
  }
}
```

#### stdout
Development and debugging only.

```ruby
output {
  stdout { codec => rubydebug }
}
```

#### kafka
Fan out to Kafka for downstream consumers.

```ruby
output {
  kafka {
    bootstrap_servers => "kafka01:9092"
    topic_id => "processed-logs"
    codec => json
    compression_type => "snappy"
  }
}
```

### Codecs
Codecs operate at the boundary of input/output and control serialisation. Set on the input or output plugin, not in the filter section.

| Codec | Use case |
|---|---|
| `plain` | Raw text, one event per line |
| `json` | Single JSON object per event |
| `json_lines` | Newline-delimited JSON (NDJSON) |
| `rubydebug` | Human-readable Ruby hash (stdout only) |
| `multiline` | Combine multi-line records (e.g., Java stack traces) |

```ruby
input {
  file {
    path => "/var/log/app/app.log"
    codec => multiline {
      pattern => "^\d{4}-\d{2}-\d{2}"   # new event starts with a date
      negate => true
      what => "previous"                  # append non-matching to previous event
    }
  }
}
```

### @timestamp Handling
`@timestamp` must reflect the event's actual time, not ingest time. The workflow:

1. Grok extracts the timestamp string into a field (e.g., `log_timestamp`).
2. The `date` filter parses it into `@timestamp`.
3. `remove_field` cleans up the raw string field.

If you skip step 2, all events in Elasticsearch will have their ingest time as `@timestamp`, making time-based queries and dashboards misleading.

### Grok Debugger
Test patterns without running a full pipeline:

- **Kibana Dev Tools → Grok Debugger** — paste sample log line and pattern, see parsed fields interactively.
- **Online:** `https://grokdebug.herokuapp.com`
- **CLI:** `logstash --config.test_and_exit` catches syntax errors but not pattern mismatches.

Common failure pattern: `_grokparsefailure` tag on events means no pattern matched. Check with:

```bash
curl -s "http://localhost:9600/_node/stats/pipelines/main" | jq '.pipelines.main.events'
```

## Examples

### Full pipeline: Beats → Nginx parse → Elasticsearch

```ruby
input {
  beats {
    port => 5044
  }
}

filter {
  if [log][file][path] =~ "nginx" {
    grok {
      match => { "message" => "%{COMBINEDAPACHELOG}" }
    }
    date {
      match => [ "timestamp", "dd/MMM/yyyy:HH:mm:ss Z" ]
      target => "@timestamp"
      remove_field => ["timestamp"]
    }
    mutate {
      convert => { "response" => "integer" }
      convert => { "bytes"    => "integer" }
      add_field => { "service" => "nginx" }
      remove_field => ["message"]
    }
    if [response] >= 500 {
      mutate { add_tag => ["error", "5xx"] }
    }
  }
}

output {
  elasticsearch {
    hosts => ["https://elasticsearch:9200"]
    index => "nginx-logs-%{+YYYY.MM.dd}"
    user => "logstash_writer"
    password => "${ES_PASSWORD}"
  }
  if "error" in [tags] {
    file {
      path => "/var/log/logstash/errors.log"
      codec => json_lines
    }
  }
}
```

## Exercises

1. Write a grok pattern that parses this log line into fields `timestamp`, `level`, `service`, and `message`:
   `2024-03-15T14:32:01.456Z ERROR auth-service Failed login attempt for user=admin ip=10.0.0.5`

2. Add a filter block to the above pipeline that: drops any event where `level` is `DEBUG`, converts `level` to uppercase, and adds a field `datacenter` with value `eu-west-1`.

3. A colleague reports that events in Elasticsearch all have the same `@timestamp` — the time Logstash ingested them, not the actual log time. Identify which filter is missing and write the correct `date` filter block to fix it, given that the log timestamp field is named `log_ts` and is in format `yyyy-MM-dd HH:mm:ss`.

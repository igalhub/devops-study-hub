---
title: Inputs, Filters & Outputs
module: logstash
duration_min: 25
difficulty: intermediate
tags: [logstash, grok, filters, inputs, outputs, elk]
exercises: 3
---

## Overview

The plugin triad — inputs, filters, and outputs — is where the bulk of Logstash pipeline authoring happens. Getting this right determines whether your data arrives in Elasticsearch clean, correctly typed, and with accurate timestamps. Grok in particular is the most-used and most-debugged filter in ELK deployments. A common source of confusion is that grok looks complex but follows a simple rule: every pattern is a named regex that captures into a field. Once you understand that rule, you can build any pattern from the library of ~120 built-ins.

This lesson walks through each plugin category in the order you'll use them: inputs first (where data comes from), then filters (how to transform it), then outputs (where it goes). Every concept is followed by a working code block. The exercises at the end require only what is taught here — no assumed knowledge of regex beyond the basics taught in the grok section.

A key principle throughout: every event that enters Logstash is a hash of key-value pairs. Filters add keys, remove keys, rename keys, or change values. The output serialises that hash and sends it somewhere. There is no magic — just data manipulation at each step.

## Concepts

### Inputs

Inputs define where events come from. Multiple inputs can exist in a single pipeline. All events from all inputs flow into the same filter chain.

#### file

Tails a file on disk, tracking read position in a **sincedb** file (a small file that records the inode and byte offset). On restart, Logstash resumes from where it left off.

```ruby
input {
  file {
    path => ["/var/log/nginx/access.log", "/var/log/nginx/error.log"]
    # "end" = only new lines (production); "beginning" = reprocess entire file (dev/testing)
    start_position => "end"
    # sincedb records the read position; /dev/null disables persistence (always re-reads)
    sincedb_path => "/var/lib/logstash/.sincedb_nginx"
    mode => "tail"          # "tail" for growing files; "read" for static files
    tags => ["nginx"]       # every event from this input gets this tag
    stat_interval => "1s"   # how often to check file for new content
  }
}
```

#### beats

Receives events from Filebeat, Metricbeat, Heartbeat, etc. over the Beats protocol (Lumberjack v2 — a binary framed TCP protocol with backpressure support).

```ruby
input {
  beats {
    port => 5044                                       # listen on this TCP port
    ssl => true                                        # require TLS (always in production)
    ssl_certificate => "/etc/logstash/certs/logstash.crt"
    ssl_key => "/etc/logstash/certs/logstash.key"
    # ssl_certificate_authorities — for mutual TLS (client cert verification)
  }
}
```

Filebeat automatically sets the `[log][file][path]` field, `[agent][type]`, and `[event][dataset]`. You can use these in filter conditionals to route different log files through different grok patterns.

#### tcp / udp

Useful for syslog-over-TCP/UDP, legacy log shippers, or quick integration tests (you can send events with `nc`).

```ruby
input {
  tcp {
    port => 5000
    codec => json_lines    # expect newline-delimited JSON
  }
  udp {
    port => 5001
    codec => plain         # raw text, one event per UDP datagram
  }
}
```

Test TCP input from command line:
```bash
echo '{"level":"ERROR","message":"test event"}' | nc localhost 5000
```

#### kafka

High-throughput ingest from Kafka topics. Logstash acts as a consumer group member.

```ruby
input {
  kafka {
    bootstrap_servers => "kafka01:9092,kafka02:9092"
    topics => ["app-logs", "infra-logs"]
    group_id => "logstash-consumers"    # all Logstash nodes with same group_id share partitions
    consumer_threads => 4               # one thread per Kafka partition (ideally)
    codec => json                       # parse each message as JSON
    auto_offset_reset => "latest"       # "earliest" to replay from beginning
    session_timeout_ms => "30000"
  }
}
```

#### syslog

Accepts RFC 3164 / RFC 5424 syslog messages and auto-parses facility, severity, host, and program fields.

```ruby
input {
  syslog {
    port => 514
    type => "syslog"       # sets [type] field for use in filter conditionals
  }
}
```

After parsing, syslog input adds: `facility`, `severity`, `priority`, `program`, `pid`, `logsource`, `timestamp`.

### Filters

Filters transform events. Multiple filter plugins in the same `filter {}` block run in order, top to bottom.

#### grok — Pattern Matching (the core skill)

Grok parses unstructured text into named fields using a library of named regex patterns. The fundamental syntax rule is:

```
%{PATTERN_NAME:field_name}
```

Where:
- `PATTERN_NAME` is a pre-defined pattern (which is itself a regex).
- `field_name` is what the captured text gets stored as on the event.
- Optionally add `:data_type` (integer or float) to auto-convert: `%{NUMBER:status_code:integer}`.

The patterns are just named regex aliases. `%{IP}` is `(?:(?:[0-1]?[0-9]{1,2}|2[0-4][0-9]|25[0-5])[.]...)`. You never need to write this — you just use `%{IP:client_ip}`.

**Common built-in patterns:**

| Pattern | Matches | Example |
|---|---|---|
| `%{IP}` | IPv4/IPv6 address | `192.168.1.10` |
| `%{NUMBER}` | Integer or float | `200`, `3.14` |
| `%{WORD}` | Non-whitespace word | `GET`, `ERROR` |
| `%{DATA}` | Any chars, non-greedy (`.*?`) | `anything up to next match` |
| `%{GREEDYDATA}` | Any chars, greedy (`.*`) | Rest of line |
| `%{HTTPDATE}` | Apache/Nginx date | `15/Mar/2024:14:32:01 +0000` |
| `%{COMBINEDAPACHELOG}` | Full Apache combined log line | Complete access log line |
| `%{SYSLOGBASE}` | Syslog header | `Mar 15 14:32:01 host program[pid]:` |
| `%{TIMESTAMP_ISO8601}` | ISO 8601 timestamp | `2024-03-15T14:32:01.456Z` |
| `%{LOGLEVEL}` | Log level keywords | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `%{URI}` | Full URI | `https://example.com/path?q=1` |
| `%{URIPATH}` | URI path only | `/api/v2/users` |
| `%{HOSTNAME}` | Hostname or IP | `web-01.example.com` |

**Building a pattern step by step:**

Take this log line:
```
2024-03-15T14:32:01.456Z ERROR auth-service Failed login attempt for user=admin ip=10.0.0.5
```

Break it into parts:
```
2024-03-15T14:32:01.456Z    → %{TIMESTAMP_ISO8601:log_timestamp}
ERROR                        → %{LOGLEVEL:level}
auth-service                 → %{HOSTNAME:service}
Failed login attempt for ... → %{GREEDYDATA:log_message}
```

Combine them, matching the spaces literally:
```ruby
filter {
  grok {
    match => {
      "message" => "%{TIMESTAMP_ISO8601:log_timestamp} %{LOGLEVEL:level} %{HOSTNAME:service} %{GREEDYDATA:log_message}"
    }
    tag_on_failure => ["_grokparsefailure"]   # default tag when no pattern matches
    # overwrite => ["message"]                # replace message field with captured value
  }
}
```

**Multiple pattern attempts** (tries in order; first match wins):
```ruby
grok {
  match => {
    "message" => [
      "%{COMBINEDAPACHELOG}",       # try Apache combined log format first
      "%{COMMONAPACHELOG}"          # fall back to common format
    ]
  }
}
```

**Custom patterns** — define inline for patterns not in the built-in library:
```ruby
filter {
  grok {
    pattern_definitions => {
      "REQUEST_ID" => "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
      "DEPLOY_ID"  => "deploy-[0-9]+"
    }
    match => {
      "message" => "Request %{REQUEST_ID:request_id} from %{IP:source_ip}"
    }
  }
}
```

**Checking grok failures:**
When no pattern matches, the event gets the `_grokparsefailure` tag and the `message` field is left unchanged. Always handle failures:

```ruby
filter {
  grok {
    match => { "message" => "%{COMBINEDAPACHELOG}" }
    tag_on_failure => ["_grokparsefailure"]
  }
  if "_grokparsefailure" in [tags] {
    mutate { add_field => { "parse_error" => "grok pattern did not match" } }
  }
}
```

#### mutate

Field manipulation: rename, convert types, add, remove, replace, strip whitespace, split strings.

```ruby
filter {
  mutate {
    # Rename a field (old_name => new_name)
    rename => { "host" => "source_host" }

    # Convert field types ("string" → actual types in Elasticsearch)
    convert => {
      "status_code"   => "integer"   # "200" → 200
      "response_time" => "float"     # "1.234" → 1.234
      "is_error"      => "boolean"   # "true" → true
    }

    # Add new fields
    add_field => {
      "environment" => "production"
      "datacenter"  => "eu-west-1"
    }

    # Remove fields (always clean up fields you don't need in Elasticsearch)
    remove_field => ["agent", "auth", "@version", "message"]

    # Replace field value
    replace => { "message" => "Processed by Logstash" }

    # Change case
    uppercase => ["http_method"]    # "get" → "GET"
    lowercase => ["level"]          # "ERROR" → "error"

    # Strip leading/trailing whitespace
    strip => ["user_agent"]

    # Split a string into an array
    split => { "tags_csv" => "," }  # "prod,web,eu" → ["prod","web","eu"]

    # Merge an array field into another
    merge => { "all_tags" => "tags_csv" }
  }
}
```

#### date

Parses a string field into `@timestamp`. This is critical — without the `date` filter, all events in Elasticsearch will have the Logstash ingest time as `@timestamp`, not the actual log event time. Time-based dashboards and incident timelines will be wrong.

The workflow is always: (1) grok extracts the timestamp string into a field, (2) `date` parses that field and sets `@timestamp`, (3) `remove_field` cleans up the raw string.

```ruby
filter {
  date {
    # "timestamp" is the field name extracted by grok
    # List multiple formats — Logstash tries each until one matches
    match => [
      "timestamp",
      "dd/MMM/yyyy:HH:mm:ss Z",      # Apache format: 15/Mar/2024:14:32:01 +0000
      "yyyy-MM-dd'T'HH:mm:ss.SSSZ",  # ISO 8601 with millis
      "yyyy-MM-dd HH:mm:ss",          # MySQL/generic format
      "UNIX",                          # Unix epoch seconds (integer string)
      "UNIX_MS"                        # Unix epoch milliseconds
    ]
    target => "@timestamp"            # always write to @timestamp
    timezone => "UTC"                 # assume UTC if timezone not in the field
    remove_field => ["timestamp"]     # clean up the raw string field
  }
}
```

Format pattern tokens:
- `yyyy` — 4-digit year; `yy` — 2-digit year.
- `MM` — 2-digit month number; `MMM` — abbreviated month name (Jan, Feb...).
- `dd` — day; `HH` — 24-hour; `mm` — minutes; `ss` — seconds; `SSS` — milliseconds.
- `Z` — timezone offset like `+0000`; `z` — timezone abbreviation like `UTC`.

#### json

Parse a JSON string field into structured fields on the event.

```ruby
filter {
  json {
    source => "message"          # field containing the JSON string
    target => "parsed"           # nest parsed fields under this key (omit to merge at top level)
    skip_on_invalid_json => true # if false, tags event with _jsonparsefailure on bad JSON
    remove_field => ["message"]  # clean up after parsing
  }
}
```

If your application emits structured JSON logs, use the `json` input codec instead:
```ruby
input {
  file {
    path => "/var/log/app/app.log"
    codec => json   # parse each line as a JSON object directly (no json filter needed)
  }
}
```

#### drop

Discard events matching a condition. Events are gone — they will not reach the output. Use to filter health check noise, debug messages, or any events you don't need in Elasticsearch.

```ruby
filter {
  # Drop health check endpoints with 200 responses
  if [status_code] == 200 and [path] =~ /^\/health/ {
    drop { }
  }

  # Drop debug-level log events
  if [level] == "DEBUG" {
    drop { }
  }
}
```

#### Conditionals (if/else if/else)

Conditionals wrap any filter plugin to apply it selectively.

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

# Tag events based on HTTP status
filter {
  if [status_code] >= 500 {
    mutate { add_tag => ["error", "5xx"] }
  } else if [status_code] >= 400 {
    mutate { add_tag => ["warning", "4xx"] }
  }
}
```

Check if a tag is present: `if "nginx" in [tags]`.
Check if a field exists: `if [field_name]` (truthy if field exists and is non-null/non-empty).
Check if a field does not exist: `if ![field_name]`.

#### geoip

Enrich events with geographic data (country, city, latitude/longitude) based on an IP address. Requires the MaxMind GeoLite2 database (bundled with Logstash).

```ruby
filter {
  geoip {
    source => "client_ip"        # field containing the IP address
    target => "geoip"            # nest output under this field
    # fields => ["city_name", "country_name", "location"]  # limit what's added
  }
}
```

Output fields under `[geoip]`: `country_name`, `country_code2`, `city_name`, `region_name`, `location` (geo_point for Kibana Maps), `latitude`, `longitude`.

#### useragent

Parse a User-Agent string into structured browser/OS fields.

```ruby
filter {
  useragent {
    source => "agent"           # field containing the raw User-Agent string
    target => "user_agent"      # nest under this field
    remove_field => ["agent"]   # clean up raw field
  }
}
```

Adds: `[user_agent][name]` (Chrome, Firefox), `[user_agent][os][name]` (Windows, macOS), `[user_agent][device][name]`.

### Outputs

Outputs send events to their final destination. Multiple outputs can run in the same pipeline — every event goes to every output (unless wrapped in a conditional).

#### elasticsearch (primary output)

```ruby
output {
  elasticsearch {
    hosts => ["https://es01:9200", "https://es02:9200"]

    # Dynamic index name: field value + date
    index => "logs-%{[fields][app]}-%{+YYYY.MM.dd}"

    user => "logstash_writer"
    password => "${ES_PASSWORD}"      # environment variable interpolation
    ssl => true
    cacert => "/etc/logstash/certs/ca.crt"

    # Index template management
    manage_template => false          # use ILM/data streams instead

    # ILM (Index Lifecycle Management) settings
    ilm_enabled => true
    ilm_rollover_alias => "logs-app"
    ilm_policy => "logs-30d"

    action => "index"                 # "create", "update", "delete" also valid
    retry_on_conflict => 3            # retries for "update" action
    document_id => "%{[trace_id]}"    # set to deduplicate on a field (optional)
  }
}
```

The `index` field supports dynamic values using field references `%{field_name}` and date format patterns `%{+YYYY.MM.dd}`. The date format is evaluated against `@timestamp`.

#### stdout (development only)

```ruby
output {
  stdout {
    codec => rubydebug    # human-readable Ruby hash — shows all fields
  }
}
```

#### file

Write events to disk — useful for debugging or archival before Elasticsearch:

```ruby
output {
  file {
    path => "/tmp/logstash-debug-%{+YYYY-MM-dd}.log"
    codec => json_lines    # one JSON object per line (NDJSON)
    flush_interval => 2    # seconds between file flushes
  }
}
```

#### Conditional output routing

```ruby
output {
  # All events go to Elasticsearch
  elasticsearch {
    hosts => ["https://elasticsearch:9200"]
    index => "logs-%{+YYYY.MM.dd}"
  }

  # Error events also go to a separate file
  if "error" in [tags] {
    file {
      path => "/var/log/logstash/errors.log"
      codec => json_lines
    }
  }
}
```

### Codecs

Codecs control how events are serialised/deserialised at input and output boundaries. Set on the input or output plugin, not inside the filter block.

| Codec | Use case |
|---|---|
| `plain` | Raw text, one event per line |
| `json` | Single JSON object per event |
| `json_lines` | Newline-delimited JSON (NDJSON), one JSON object per line |
| `rubydebug` | Human-readable Ruby hash (stdout only, development) |
| `multiline` | Combine multiple lines into one event (Java stack traces, etc.) |

**multiline codec** — joining Java exceptions into one event:

```ruby
input {
  file {
    path => "/var/log/app/app.log"
    codec => multiline {
      # Pattern that marks the START of a new event (a line beginning with a date)
      pattern => "^\d{4}-\d{2}-\d{2}"
      negate => true          # lines that do NOT match the pattern...
      what => "previous"      # ...are appended to the PREVIOUS event
    }
  }
}
```

This means: "when a line doesn't start with a date, it's a continuation of the previous event" — exactly how Java stack trace lines work.

### @timestamp Handling — The Complete Workflow

This is the single most common misconfiguration in new Logstash setups. The correct workflow:

```ruby
filter {
  # Step 1: grok extracts the timestamp string into a named field
  grok {
    match => { "message" => "%{TIMESTAMP_ISO8601:log_ts} %{LOGLEVEL:level} %{GREEDYDATA:msg}" }
  }

  # Step 2: date filter parses that field and writes to @timestamp
  date {
    match => [ "log_ts", "yyyy-MM-dd'T'HH:mm:ss.SSSZ" ]
    target => "@timestamp"
    timezone => "UTC"
    remove_field => ["log_ts"]   # Step 3: clean up — don't store both
  }
}
```

Without step 2: every document in Elasticsearch gets `@timestamp` = time Logstash processed the event. A query for logs from `2024-03-15 14:00` will return nothing because they were all indexed with today's timestamp.

### Grok Debugger

Test grok patterns without running a full pipeline:

- **Kibana Dev Tools → Grok Debugger** — paste a sample log line and a pattern; see all captured fields interactively. This is the fastest way to iterate.
- **Online tool:** `https://grokdebugger.com` — no Kibana needed.
- **CLI:** `logstash --config.test_and_exit` catches config syntax errors but not pattern mismatch — a pattern can be syntactically valid and match nothing.

When a grok pattern fails, the event gets the `_grokparsefailure` tag. To find how many events are failing:

```bash
curl -s "http://localhost:9600/_node/stats/pipelines/main" | \
  jq '.pipelines.main.plugins.filters[] | select(.name == "grok") | .events'
```

The `events.in` vs `events.out` difference for a grok filter is the number of pattern-failure events (events still pass through; they just get the failure tag).

## Examples

### Full pipeline: Beats → Nginx parse → Elasticsearch

```ruby
# /etc/logstash/conf.d/nginx.conf

input {
  beats {
    port => 5044    # Filebeat connects here
  }
}

filter {
  # Only apply nginx parsing to nginx log files
  # Filebeat sets [log][file][path]; check if it contains "nginx"
  if [log][file][path] =~ "nginx" {

    grok {
      # %{COMBINEDAPACHELOG} parses the full Apache/Nginx combined log format:
      # clientip ident auth [timestamp] "verb request httpversion" response bytes "referrer" "agent"
      match => { "message" => "%{COMBINEDAPACHELOG}" }
    }

    date {
      # "timestamp" is what %{COMBINEDAPACHELOG} names the date field
      match => [ "timestamp", "dd/MMM/yyyy:HH:mm:ss Z" ]
      target => "@timestamp"
      remove_field => ["timestamp"]
    }

    mutate {
      convert => { "response" => "integer" }    # HTTP status code as int
      convert => { "bytes"    => "integer" }    # response size as int
      add_field => { "service" => "nginx" }     # static enrichment
      remove_field => ["message", "auth"]       # drop fields we don't need
    }

    # Tag 5xx responses for easy filtering
    if [response] >= 500 {
      mutate { add_tag => ["error", "5xx"] }
    } else if [response] >= 400 {
      mutate { add_tag => ["client_error", "4xx"] }
    }

    # Drop health check noise (200 responses to /healthz)
    if [response] == 200 and [request] =~ /\/health/ {
      drop { }
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

  # Write errors to a local file for quick grep access
  if "error" in [tags] {
    file {
      path => "/var/log/logstash/nginx-errors.log"
      codec => json_lines
    }
  }
}
```

### Parsing a custom application log format

Log line to parse:
```
2024-03-15 14:32:01 ERROR auth-service req_id=a1b2c3d4 user=admin duration_ms=452 status=failed
```

```ruby
filter {
  grok {
    match => {
      "message" => "%{TIMESTAMP_ISO8601:log_ts} %{LOGLEVEL:level} %{HOSTNAME:service} req_id=%{WORD:request_id} user=%{WORD:username} duration_ms=%{NUMBER:duration_ms:integer} status=%{WORD:status}"
    }
  }
  date {
    match => [ "log_ts", "yyyy-MM-dd HH:mm:ss" ]
    target => "@timestamp"
    remove_field => ["log_ts"]
  }
  mutate {
    remove_field => ["message", "@version"]
    add_field => { "env" => "production" }
  }
  if [level] == "DEBUG" {
    drop { }
  }
}
```

Result event fields: `level`, `service`, `request_id`, `username`, `duration_ms` (integer), `status`, `env`, `@timestamp`.

## Exercises

1. Write a grok pattern that parses this log line into fields `log_timestamp`, `level`, `service`, and `log_message`:
   ```
   2024-03-15T14:32:01.456Z ERROR auth-service Failed login attempt for user=admin ip=10.0.0.5
   ```
   Then write the complete `filter {}` block that: (a) applies your grok pattern; (b) parses `log_timestamp` into `@timestamp` using the `date` filter with format `yyyy-MM-dd'T'HH:mm:ss.SSSZ`; (c) removes the `log_timestamp` field after parsing.

2. Add a filter block that: (a) drops any event where `level` equals `DEBUG`; (b) converts `level` to uppercase using `mutate`; (c) adds a field `datacenter` with value `eu-west-1`; (d) adds the tag `error` if `level` is `ERROR`. Write these as a single `filter {}` block with the correct order of operations.

3. A colleague reports that events in Elasticsearch all have the same `@timestamp` — the time Logstash ingested them, not the actual log time. The log timestamp field extracted by grok is named `log_ts` and is in the format `yyyy-MM-dd HH:mm:ss`. (a) Identify which filter is missing. (b) Write the correct `date` filter block to fix the issue, including removing the `log_ts` field after parsing. (c) Explain why leaving `log_ts` in the event would cause no harm to Elasticsearch but would waste storage.

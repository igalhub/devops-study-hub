# Logstash — Quick Reference

## CLI Commands

| Command | Description |
|---------|-------------|
| `logstash -f pipeline.conf` | Run with config file |
| `logstash -f /etc/logstash/conf.d/` | Run config directory |
| `logstash --config.test_and_exit -f pipeline.conf` | Validate config, then exit |
| `logstash --config.reload.automatic -f pipeline.conf` | Auto-reload on change |
| `logstash -e 'input { stdin{} } output { stdout{} }'` | Inline pipeline (testing) |
| `logstash --log.level debug -f pipeline.conf` | Debug logging |
| `logstash-plugin list` | List installed plugins |
| `logstash-plugin install plugin-name` | Install plugin |

## Pipeline Structure

```ruby
input {
  beats { port => 5044 }          # From Filebeat
  file { path => "/var/log/*.log" start_position => "beginning" }
  kafka { topics => ["logs"] bootstrap_servers => "kafka:9092" }
}

filter {
  grok { match => { "message" => "%{COMBINEDAPACHELOG}" } }
  date { match => ["timestamp", "dd/MMM/yyyy:HH:mm:ss Z"] }
  mutate {
    rename => { "host" => "hostname" }
    remove_field => ["beat", "input", "prospector"]
    add_field => { "env" => "production" }
    convert => { "bytes" => "integer" }
  }
  geoip { source => "clientip" }
}

output {
  elasticsearch {
    hosts => ["http://elasticsearch:9200"]
    index => "logs-%{+YYYY.MM.dd}"
  }
  stdout { codec => rubydebug }   # Debug to console
}
```

## Common Filters

| Filter | Key Options | Description |
|--------|------------|-------------|
| `grok` | `match`, `patterns_dir` | Parse unstructured text |
| `date` | `match`, `target` | Parse and set @timestamp |
| `mutate` | `rename`, `add_field`, `remove_field`, `convert` | Transform fields |
| `json` | `source`, `target` | Parse JSON field |
| `csv` | `separator`, `columns` | Parse CSV line |
| `kv` | `source`, `field_split`, `value_split` | Parse key=value pairs |
| `geoip` | `source` | Add geo data from IP |
| `useragent` | `source` | Parse user agent strings |
| `drop` | `if condition` | Drop events matching condition |
| `clone` | `clones` | Duplicate event |

## Conditionals

```ruby
filter {
  if [status] >= 500 {
    mutate { add_tag => ["error"] }
  } else if [status] >= 400 {
    mutate { add_tag => ["warning"] }
  }

  if "_grokparsefailure" in [tags] {
    drop { }
  }

  if [type] == "nginx" {
    grok { match => { ... } }
  }
}
```

## Common Grok Patterns

| Pattern | Matches |
|---------|---------|
| `%{IP:client}` | IP address → `client` field |
| `%{NUMBER:bytes:int}` | Number → `bytes` field (integer) |
| `%{WORD:method}` | Single word |
| `%{DATA:request}` | Any characters (non-greedy) |
| `%{GREEDYDATA:message}` | Remainder of line |
| `%{COMBINEDAPACHELOG}` | Full Apache/nginx log line |
| `%{TIMESTAMP_ISO8601:timestamp}` | ISO 8601 timestamp |
| `%{HTTPD_COMMONLOG}` | Common log format |

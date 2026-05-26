---
title: Exporters & Service Discovery
module: prometheus
duration_min: 20
difficulty: intermediate
tags: [prometheus, exporters, service-discovery, kubernetes, relabeling, node-exporter]
exercises: 3
---

## Overview
Prometheus scrapes targets that expose metrics in the Prometheus text format. Most existing systems (Linux hosts, databases, network devices) don't natively expose this format — exporters bridge that gap by translating native metrics into Prometheus format. Alongside exporters, service discovery (SD) mechanisms replace static target lists with dynamic queries against infrastructure APIs — Kubernetes, Consul, EC2, DNS, etc. Relabeling rules give fine-grained control over which targets are scraped and what labels they carry. These three topics — exporters, service discovery, and relabeling — are what make Prometheus operationally practical at scale.

## Concepts

### node_exporter
`node_exporter` exposes Linux host metrics: CPU, memory, disk I/O, filesystem, network, load average, and more. It is the standard starting point for host monitoring.

```bash
# Run node_exporter
docker run -d \
  --name node_exporter \
  --net="host" \
  --pid="host" \
  -v "/:/host:ro,rslave" \
  prom/node-exporter \
  --path.rootfs=/host

# Default port: 9100
curl -s http://localhost:9100/metrics | grep '^node_' | head -20
```

**Key node_exporter metric families:**

| Metric | Type | Description |
|--------|------|-------------|
| `node_cpu_seconds_total{mode}` | counter | CPU time per mode (idle, user, system, iowait…) |
| `node_memory_MemAvailable_bytes` | gauge | Available memory |
| `node_memory_MemTotal_bytes` | gauge | Total memory |
| `node_filesystem_free_bytes` | gauge | Free space per filesystem |
| `node_disk_read_bytes_total` | counter | Disk bytes read |
| `node_disk_written_bytes_total` | counter | Disk bytes written |
| `node_network_receive_bytes_total` | counter | Network bytes received per interface |
| `node_load1` / `node_load5` / `node_load15` | gauge | Load averages |
| `node_vmstat_pgmajfault` | counter | Major page faults |

**Enabling/disabling collectors:**
```bash
# Disable unused collectors to reduce cardinality
node_exporter \
  --collector.disable-defaults \
  --collector.cpu \
  --collector.meminfo \
  --collector.filesystem \
  --collector.diskstats \
  --collector.netdev \
  --collector.loadavg
```

### blackbox_exporter
`blackbox_exporter` performs active probing — it makes requests on behalf of Prometheus and reports availability and latency. Supported modules: HTTP, HTTPS, TCP, ICMP, DNS.

```yaml
# blackbox.yml
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: [200]
      method: GET
      fail_if_ssl: false
      fail_if_not_ssl: false
      tls_config:
        insecure_skip_verify: false

  http_post_2xx:
    prober: http
    http:
      method: POST
      headers:
        Content-Type: application/json

  tcp_connect:
    prober: tcp
    timeout: 5s

  icmp_ping:
    prober: icmp
    timeout: 5s
    icmp:
      preferred_ip_protocol: ip4
```

Blackbox exporter is scraped with a `target` parameter — Prometheus passes the URL to probe:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: "blackbox"
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
          - https://example.com
          - https://api.example.com/health
    relabel_configs:
      # Set instance label to the target URL
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      # Point scrape at the blackbox exporter itself
      - target_label: __address__
        replacement: blackbox-exporter:9115
```

**Key blackbox metrics:**

| Metric | Description |
|--------|-------------|
| `probe_success` | 1 if probe succeeded, 0 if not |
| `probe_duration_seconds` | Total probe duration |
| `probe_http_status_code` | HTTP status code returned |
| `probe_http_ssl` | 1 if SSL was used |
| `probe_ssl_earliest_cert_expiry` | Unix timestamp of earliest cert expiry |
| `probe_dns_lookup_time_seconds` | DNS resolution time |

### Custom Exporters
For internal systems with no existing exporter, write one using a Prometheus client library.

**Python example — exporting application queue depth:**

```python
from prometheus_client import start_http_server, Gauge, Counter, Histogram
import time
import random

# Define metrics
queue_depth = Gauge('app_queue_depth', 'Current number of items in queue',
                    ['queue_name'])
processed_total = Counter('app_jobs_processed_total', 'Jobs processed',
                          ['queue_name', 'status'])
processing_duration = Histogram('app_job_duration_seconds', 'Job processing time',
                                ['queue_name'],
                                buckets=[0.1, 0.5, 1.0, 5.0, 10.0])

def collect_metrics():
    """Called periodically to refresh gauge values from external system."""
    for q in ['high_priority', 'low_priority']:
        depth = get_queue_depth(q)           # your actual data source
        queue_depth.labels(queue_name=q).set(depth)

if __name__ == '__main__':
    start_http_server(8000)       # starts /metrics endpoint on :8000
    while True:
        collect_metrics()
        time.sleep(15)
```

**Naming conventions for custom metrics:**
- Format: `<namespace>_<subsystem>_<name>_<unit>`
- Units: `_seconds`, `_bytes`, `_total` (counters), `_ratio`, `_info`
- Example: `myapp_database_query_duration_seconds`

### Kubernetes Service Discovery
In Kubernetes, `kubernetes_sd_configs` dynamically discovers targets from the Kubernetes API. Prometheus can discover: nodes, pods, services, endpoints, ingresses.

```yaml
scrape_configs:
  # Scrape all pods with annotation prometheus.io/scrape: "true"
  - job_name: "kubernetes-pods"
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: ["production", "staging"]   # omit to discover all namespaces
    relabel_configs:
      # Only scrape pods with the annotation
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"

      # Use custom metrics path if annotated
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)

      # Use custom port if annotated
      - source_labels: [__address__,
                        __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: "([^:]+)(?::\\d+)?;(\\d+)"
        replacement: "$1:$2"
        target_label: __address__

      # Preserve useful pod metadata as labels
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app

  # Scrape Kubernetes nodes (node_exporter must be on each node)
  - job_name: "kubernetes-nodes"
    kubernetes_sd_configs:
      - role: node
    relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)   # copy all k8s node labels
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/$1/proxy/metrics
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
```

**Common `__meta_kubernetes_*` labels by role:**

| Role | Meta label | Description |
|------|-----------|-------------|
| pod | `__meta_kubernetes_pod_name` | Pod name |
| pod | `__meta_kubernetes_namespace` | Namespace |
| pod | `__meta_kubernetes_pod_label_<key>` | Pod labels |
| pod | `__meta_kubernetes_pod_annotation_<key>` | Pod annotations |
| pod | `__meta_kubernetes_pod_container_port_number` | Container port |
| node | `__meta_kubernetes_node_name` | Node name |
| node | `__meta_kubernetes_node_label_<key>` | Node labels |
| service | `__meta_kubernetes_service_name` | Service name |
| endpoints | `__meta_kubernetes_endpoint_port_name` | Named port |

### Relabeling
Relabeling is Prometheus's most powerful (and complex) mechanism. It runs a sequence of rules against the label set of each discovered target, before and after scraping.

**Two phases:**
- `relabel_configs` — runs on targets before scraping. Controls which targets are scraped and what labels they carry.
- `metric_relabel_configs` — runs on each scraped sample. Controls which metrics are stored and with what labels.

**Actions:**

| Action | Effect |
|--------|--------|
| `replace` | Regex match on `source_labels`, write result to `target_label` (default) |
| `keep` | Drop targets/series where regex does NOT match |
| `drop` | Drop targets/series where regex matches |
| `labelmap` | Copy labels matching `regex` to new names (regex capture groups) |
| `labeldrop` | Remove labels matching `regex` |
| `labelkeep` | Remove labels NOT matching `regex` |
| `hashmod` | Shard targets across multiple Prometheus instances |

```yaml
relabel_configs:
  # Drop targets from a specific namespace
  - source_labels: [__meta_kubernetes_namespace]
    action: drop
    regex: kube-system

  # Rename a label
  - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
    action: replace
    target_label: app

  # Copy all kubernetes labels matching "app_*" to top-level labels
  - action: labelmap
    regex: __meta_kubernetes_pod_label_(.+)

  # Drop high-cardinality metrics (metric_relabel_configs)
metric_relabel_configs:
  - source_labels: [__name__]
    regex: "go_gc_.*"
    action: drop

  # Drop container metrics for pause containers
  - source_labels: [container]
    regex: "POD"
    action: drop
```

### File-Based Service Discovery
`file_sd_configs` reads target lists from JSON or YAML files. Prometheus watches the files for changes and reloads without restart. Useful for custom automation or integration with CMDBs.

```yaml
scrape_configs:
  - job_name: "dynamic-hosts"
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/*.json
        refresh_interval: 30s
```

```json
// /etc/prometheus/targets/app-servers.json
[
  {
    "targets": ["app-1:8080", "app-2:8080"],
    "labels": {
      "env": "production",
      "team": "backend"
    }
  },
  {
    "targets": ["app-staging:8080"],
    "labels": {
      "env": "staging",
      "team": "backend"
    }
  }
]
```

## Examples

**Deploy node_exporter as a Kubernetes DaemonSet:**

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9100"
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: node-exporter
          image: prom/node-exporter:latest
          ports:
            - containerPort: 9100
              hostPort: 9100
          volumeMounts:
            - name: host-root
              mountPath: /host
              readOnly: true
          args:
            - --path.rootfs=/host
      volumes:
        - name: host-root
          hostPath:
            path: /
      tolerations:
        - operator: Exists    # run on all nodes including masters
```

**Verify service discovery is working:**
```bash
# Check what targets Prometheus discovered and their labels
curl -s http://localhost:9090/api/v1/targets | \
  jq '.data.activeTargets[] | {job: .labels.job, instance: .labels.instance, health: .health}'

# Check for dropped targets (relabeling dropped them)
curl -s http://localhost:9090/api/v1/targets?state=dropped | jq '.data.droppedTargets | length'
```

## Exercises

1. Write a `prometheus.yml` scrape job that uses `kubernetes_sd_configs` with `role: endpoints` to scrape all services in the `production` namespace that have the label `app.kubernetes.io/monitored: "true"`. Include relabeling to: (a) keep only those matching endpoints, (b) set `namespace`, `service`, and `pod` labels from Kubernetes metadata, (c) use the `prometheus.io/port` annotation to override the default port.

2. Write a blackbox_exporter probe configuration and matching Prometheus scrape job that checks the HTTPS health endpoint of three services: `api.example.com/health`, `auth.example.com/health`, `payments.example.com/health`. The probe should fail if the SSL certificate is not valid, and the `instance` label should be the probed URL (not the blackbox exporter address). Write an alerting rule that fires if `probe_success == 0` for 2 minutes OR if `probe_ssl_earliest_cert_expiry - time() < 86400 * 14` (cert expires within 14 days).

3. Write `metric_relabel_configs` rules to: (a) drop all `go_*` runtime metrics from all targets, (b) drop all metrics where `container="POD"`, (c) for the metric `http_request_duration_seconds_bucket`, drop all buckets where `le` is greater than `10` (the `le` label value is a string; use regex matching). Explain why dropping high-cardinality or unused metrics at the scrape layer is preferable to dropping them in PromQL.

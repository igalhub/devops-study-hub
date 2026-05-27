"""
Seed handcrafted quiz questions for the Prometheus module.

Run from the backend/ directory:
    python3 seed_quiz.py

Idempotent: skips any lesson that already has questions.
"""
import json
from db import get_conn, init_db

PROMETHEUS_QUESTIONS = {
    "intro-metrics": [
        {
            "question": "Prometheus uses a pull-based architecture. When is the Pushgateway the right tool to use?",
            "options": [
                "For short-lived batch jobs and cron tasks that exit before Prometheus can scrape them",
                "When Prometheus is behind a NAT or firewall and can't reach the targets",
                "For any service that doesn't want to expose a /metrics endpoint",
                "When you need to push metrics to multiple Prometheus instances simultaneously",
            ],
            "correct_index": 0,
            "explanation": "Short-lived jobs (batch scripts, cron tasks) exit before Prometheus's scrape interval fires. Pushgateway lets them push metrics that Prometheus can then scrape. For everything else, direct scraping is preferred because Prometheus's health-check semantics (scrape failure = target down) break with the Pushgateway.",
        },
        {
            "question": "A metric tracks the current number of items waiting in a job queue. Which Prometheus metric type is correct?",
            "options": [
                "Counter, because the queue only grows when new jobs are enqueued",
                "Gauge, because queue depth can go up and down",
                "Histogram, because you need to observe the distribution of queue lengths",
                "Summary, because queue depth needs client-side quantile calculation",
            ],
            "correct_index": 1,
            "explanation": "Queue depth is a point-in-time value that can increase (new jobs arrive) and decrease (jobs are processed). That bidirectional behavior is what gauges model. Counters only go up — using one for queue depth would be wrong, and rate()/increase() on it would produce nonsense.",
        },
        {
            "question": "Your team runs 20 replicas of a web service, each exposing a histogram of response latencies. You want to compute the p99 latency across all replicas. Which metric type allows this aggregation?",
            "options": [
                "Histogram, because its buckets are additive and can be summed across instances",
                "Summary, because quantiles are already calculated and just need to be averaged",
                "Either type — both aggregate correctly across instances",
                "Neither — you must query each instance separately and take the maximum",
            ],
            "correct_index": 0,
            "explanation": "Histogram buckets are counters stored server-side (in Prometheus), so you can sum them across instances with `sum()` and then call `histogram_quantile()` on the aggregated buckets. Summary quantiles are computed inside each application process — you cannot meaningfully average percentiles from different distributions.",
        },
        {
            "question": "A developer wants to add a label to track which user made each HTTP request: `http_requests_total{user_id=\"...\"}`. What is the primary risk?",
            "options": [
                "Prometheus does not support string labels — only numeric values",
                "The label will create one time series per unique user ID, potentially millions, exhausting Prometheus memory",
                "User IDs cannot be scraped from the /metrics endpoint",
                "The label will cause rate() to return incorrect values for user-specific queries",
            ],
            "correct_index": 1,
            "explanation": "Each unique combination of label values creates a separate time series. With millions of users, `user_id` creates millions of series — a cardinality explosion that can OOM Prometheus. High-cardinality data belongs in a log or tracing system, not in metric labels. Good labels have bounded, low-cardinality value sets: `method`, `status`, `region`, `env`.",
        },
        {
            "question": "You have a counter `http_requests_total` that resets to 0 when a process restarts. Why use `rate(http_requests_total[5m])` instead of reading the raw counter value?",
            "options": [
                "rate() detects counter resets and adjusts the calculation so restarts don't produce negative or misleading rates",
                "Counters don't expose their raw values — rate() is the only way to read them",
                "rate() converts the counter from bytes to requests per second",
                "rate() filters out zero values that accumulate when the service is idle",
            ],
            "correct_index": 0,
            "explanation": "Counters reset to 0 on process restart. If you just subtract two raw values across a restart, you get a huge negative delta. rate() looks at a range vector, detects when a counter decreases (a reset), and handles it correctly — giving you the true per-second rate even across restarts.",
        },
    ],

    "promql": [
        {
            "question": "What does `http_requests_total[5m]` return in PromQL?",
            "options": [
                "A single float — the total number of requests in the last 5 minutes",
                "A range vector — all scraped samples for each matched series over the last 5 minutes",
                "An instant vector — the per-second request rate over 5 minutes",
                "A scalar — the count of time series that had data in the last 5 minutes",
            ],
            "correct_index": 1,
            "explanation": "The `[5m]` syntax is a range selector. It returns a range vector: for each matched time series, it includes all samples Prometheus scraped within the past 5 minutes. Functions like rate() and irate() take a range vector as input. You can't graph a range vector directly — it must be passed to a function first.",
        },
        {
            "question": "Your service has a traffic spike causing 5xx errors. An alert should fire quickly when the error rate jumps. Which function is more appropriate: rate() or irate()?",
            "options": [
                "rate() — it's more stable and avoids false positives from a single bad scrape",
                "irate() — it uses only the last two data points and responds faster to sudden spikes",
                "Both are identical for spike detection — use either",
                "increase() — it captures the raw increment rather than a per-second rate",
            ],
            "correct_index": 1,
            "explanation": "irate() uses only the last two samples in the range, making it very sensitive to sudden changes. rate() averages across all samples in the range, smoothing out spikes. For alerting on a genuine spike, irate() fires faster. For dashboards and trends where stability matters more, rate() is preferred.",
        },
        {
            "question": "You want the total HTTP request rate across all instances, broken down only by job. Which expression is correct?",
            "options": [
                "rate(http_requests_total[5m])",
                "sum(rate(http_requests_total[5m]))",
                "sum by(job) (rate(http_requests_total[5m]))",
                "rate(sum(http_requests_total)[5m])",
            ],
            "correct_index": 2,
            "explanation": "`sum by(job)` aggregates all series with the same `job` label together, summing their values and discarding all other labels (instance, handler, status). The result is one time series per distinct job. `sum` without `by()` collapses everything to one number; `rate(sum(...)[5m])` is invalid because you can't take a range vector of an instant vector.",
        },
        {
            "question": "What does `histogram_quantile(0.99, sum by(le) (rate(http_duration_seconds_bucket[5m])))` compute?",
            "options": [
                "The 99th percentile latency, aggregated across all instances",
                "The fraction of requests faster than 0.99 seconds",
                "The rate of requests at the 99th percentile bucket",
                "The 99th percentile of the request rate (not latency)",
            ],
            "correct_index": 0,
            "explanation": "histogram_quantile() estimates a quantile from histogram bucket counts. The 0.99 argument means p99. `sum by(le)` aggregates the bucket counts across all instances (keeping the `le` bucket boundary label that histogram_quantile needs). `rate()` on the `_bucket` series first converts accumulating counts to a per-second rate, making the result a rate-weighted latency distribution.",
        },
        {
            "question": "An alerting rule has `for: 5m`. A condition becomes true at 10:00, then false at 10:03, then true again at 10:04. When does the alert fire?",
            "options": [
                "At 10:05, because 5 minutes have passed since the condition first became true",
                "At 10:09, because the `for` timer resets when the condition becomes false and 5 minutes must pass continuously",
                "At 10:00, because `for` is only a delay for the first occurrence",
                "Never — `for: 5m` means the alert self-resolves after 5 minutes",
            ],
            "correct_index": 1,
            "explanation": "The `for` clause requires the expression to be continuously true for the specified duration. The alert enters 'Pending' state when the condition first fires, and resets back to 'Inactive' if the condition becomes false at any point. The 5-minute clock restarts at 10:04 when the condition becomes true again, so the alert would fire at 10:09.",
        },
    ],

    "alertmanager": [
        {
            "question": "In an Alertmanager configuration, `group_wait` controls what?",
            "options": [
                "How long Alertmanager waits before sending the first notification for a new alert group, to allow related alerts to arrive",
                "How long to wait between repeat notifications for an ongoing incident",
                "The maximum time an alert can remain in Pending state before Alertmanager drops it",
                "How long Prometheus waits before re-sending an alert to Alertmanager",
            ],
            "correct_index": 0,
            "explanation": "group_wait is the initial buffer period for a newly-created alert group. When the first alert in a group fires, Alertmanager waits `group_wait` before notifying — this lets related alerts that fire within seconds of each other be batched into one notification. group_interval controls re-notifications when new alerts join an existing group; repeat_interval controls how often to re-notify for an unchanged firing alert.",
        },
        {
            "question": "An inhibition rule suppresses `severity: warning` alerts when a `severity: critical` alert is firing for the same instance. Why is this useful?",
            "options": [
                "It prevents alert storms where a single root cause triggers many lower-priority child alerts",
                "It automatically resolves the warning alert when the critical alert is acknowledged",
                "It escalates the warning alert to critical severity automatically",
                "It prevents the warning alert from being stored in Prometheus's alert history",
            ],
            "correct_index": 0,
            "explanation": "When a node is completely down, you might get dozens of alerts for individual services on that node. Inhibition rules let you suppress all those secondary alerts when the root-cause alert (node down) is firing — reducing noise and keeping the on-call engineer focused on the real problem.",
        },
        {
            "question": "An alert doesn't match any child route in the Alertmanager routing tree. Where does it go?",
            "options": [
                "It is silently dropped — unmatched alerts are discarded",
                "It is sent to every configured receiver as a fallback",
                "It goes to the root route's receiver, which acts as the catch-all",
                "Alertmanager logs an error and marks the alert as failed",
            ],
            "correct_index": 2,
            "explanation": "Every routing tree must have a root route with a receiver. Alerts that don't match any child route fall through to the root route, ensuring nothing is silently lost. A common pattern is to set the root route's receiver to a low-priority channel (like a Slack channel) and add specific child routes for high-priority alerts that page on-call.",
        },
        {
            "question": "You're writing an alerting rule. Which of these belongs in `annotations` rather than `labels`?",
            "options": [
                "severity: critical",
                "team: database",
                "summary: \"Replica lag on {{ $labels.instance }} is {{ $value }}s\"",
                "env: production",
            ],
            "correct_index": 2,
            "explanation": "Labels become part of the alert's identity and are used by Alertmanager for routing, inhibition, and silencing — they must be low-cardinality and static. Annotations carry human-readable context for the notification message. Dynamic strings using Go template syntax ({{ $labels.X }}, {{ $value }}) belong in annotations because they vary per alert instance and can't be used for routing.",
        },
        {
            "question": "You create a silence in Alertmanager for a 2-hour maintenance window. During the silence, what happens to matching alerts?",
            "options": [
                "Prometheus stops evaluating the alerting rule for those targets",
                "The alerts still fire and are visible in Alertmanager, but no notifications are sent",
                "The alerts are auto-resolved in Prometheus and re-evaluated after the silence expires",
                "Alertmanager deletes the alert history for the silenced period",
            ],
            "correct_index": 1,
            "explanation": "Silences suppress notifications without affecting alert evaluation. Prometheus still evaluates the rule and Alertmanager still receives the alert — you can see it in the Alertmanager UI. This is intentional: after the maintenance window, you want Alertmanager to resume notifications immediately if the condition is still true, without any re-evaluation delay.",
        },
    ],

    "exporters": [
        {
            "question": "node_exporter is typically run with `--net=host` and `--pid=host`. Why?",
            "options": [
                "To expose the /metrics endpoint on port 9100 without port mapping",
                "To allow node_exporter to read host-level network interfaces and process table, not just the container's",
                "To give node_exporter access to the Docker daemon socket",
                "To prevent other containers from interfering with node_exporter's metrics collection",
            ],
            "correct_index": 1,
            "explanation": "node_exporter collects host-level metrics: all network interfaces, all filesystems, all processes. Without `--net=host`, it only sees the container's network namespace (one interface, no host interfaces). Without `--pid=host`, it can't read the host process table. These flags give it the same visibility as a native daemon running directly on the host.",
        },
        {
            "question": "The blackbox_exporter differs from application-level exporters because it:",
            "options": [
                "Reads metrics from log files rather than HTTP endpoints",
                "Actively probes endpoints (HTTP, TCP, ICMP) from Prometheus's perspective and reports availability and latency",
                "Collects metrics from Kubernetes control plane components",
                "Aggregates metrics from multiple Prometheus instances into a single federation endpoint",
            ],
            "correct_index": 1,
            "explanation": "blackbox_exporter performs synthetic monitoring — it makes test requests on behalf of Prometheus and reports whether the endpoint was reachable, its HTTP status, TLS certificate validity, and response time. This catches external-facing availability issues that an application's own /metrics endpoint won't detect (the app might report itself healthy while being unreachable from the load balancer).",
        },
        {
            "question": "A relabeling rule has `action: keep` and matches on the label `__meta_kubernetes_pod_annotation_prometheus_io_scrape`. What does this do?",
            "options": [
                "Keeps the annotation on the scraped metric labels for all pods",
                "Scrapes only pods where that annotation is present and matches the regex (e.g. 'true'), dropping all others",
                "Drops pods that have the annotation and keeps those that don't",
                "Renames the annotation to a simpler label name on the resulting metrics",
            ],
            "correct_index": 1,
            "explanation": "`action: keep` retains only targets where the source label's value matches the regex — all non-matching targets are dropped before scraping begins. This is the standard pattern for opt-in scraping in Kubernetes: pods annotate themselves with `prometheus.io/scrape: 'true'`, and the keep rule filters to only those pods.",
        },
        {
            "question": "Kubernetes service discovery with `role: pod` discovers targets. Before any relabeling, what does Prometheus discover?",
            "options": [
                "Only pods in the same namespace as the Prometheus deployment",
                "Only pods that expose port 9090 or have a /metrics path",
                "All running pods across the cluster, each with their Kubernetes metadata as `__meta_kubernetes_pod_*` labels",
                "Only pods whose service has a prometheus.io/scrape annotation",
            ],
            "correct_index": 2,
            "explanation": "kubernetes_sd_configs queries the Kubernetes API server and returns all pods (or whichever role is configured) as potential scrape targets. Each target comes with all its Kubernetes metadata as `__meta_kubernetes_pod_*` labels. Filtering (annotations, namespaces, ports) is done afterwards via relabeling rules — discovery itself is intentionally broad.",
        },
        {
            "question": "Which of these is an anti-pattern when using Pushgateway?",
            "options": [
                "A batch job pushes its completion time and exit code after finishing",
                "A cron job pushes its duration metric at the end of each run",
                "A long-running web service pushes its request count every 15 seconds instead of exposing /metrics",
                "A CI pipeline pushes build duration and test pass/fail counts after each run",
            ],
            "correct_index": 2,
            "explanation": "Pushgateway is designed for short-lived jobs that exit before Prometheus can scrape them. Using it for a long-running service breaks Prometheus's health-check model: if the service crashes, its last-pushed metrics persist in the Pushgateway indefinitely — Prometheus won't detect the outage. Long-running services should expose /metrics directly so Prometheus can detect scrape failures.",
        },
    ],
}


def seed_prometheus_quiz():
    init_db()
    conn = get_conn()

    for lesson_slug, questions in PROMETHEUS_QUESTIONS.items():
        lesson = conn.execute(
            "SELECT id FROM lessons WHERE slug = ?", (lesson_slug,)
        ).fetchone()

        if not lesson:
            print(f"Lesson not found: {lesson_slug} — skipping")
            continue

        lesson_id = lesson["id"]
        existing = conn.execute(
            "SELECT COUNT(*) as n FROM quiz_questions WHERE lesson_id = ?", (lesson_id,)
        ).fetchone()["n"]

        if existing > 0:
            print(f"{lesson_slug}: already has {existing} questions — skipping")
            continue

        for q in questions:
            conn.execute(
                """INSERT INTO quiz_questions (lesson_id, question, options, correct_index, explanation)
                   VALUES (?, ?, ?, ?, ?)""",
                (lesson_id, q["question"], json.dumps(q["options"]), q["correct_index"], q["explanation"]),
            )

        conn.commit()
        print(f"{lesson_slug}: inserted {len(questions)} questions (lesson_id={lesson_id})")

    conn.close()


if __name__ == "__main__":
    seed_prometheus_quiz()

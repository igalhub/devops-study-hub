---
title: Incident Management Workflow
module: opsgenie
duration_min: 20
difficulty: intermediate
tags: [opsgenie, incident-management, postmortem, jira, mttr, mtta]
exercises: 3
---

## Overview

Opsgenie is not just an alert router — it is a full incident management platform built around the idea that outages are processes, not emergencies to be improvised through. The alert-to-incident lifecycle, war room coordination, status page updates, and postmortem creation are all structured surfaces where DevOps engineers operate during and after outages. Treating these surfaces as a system — rather than reacting to each in isolation — is what separates teams with consistent 30-minute MTTRs from teams that take hours. Understanding the Opsgenie incident workflow means you can run an incident predictably under pressure, hand it off mid-flight, and reconstruct it accurately afterwards.

Opsgenie's core design principle is that every meaningful action during an incident should be captured automatically in a timeline, and every human decision should be an explicit, logged state change. This is why alerts and incidents are distinct objects, why severity levels drive automated behavior, and why the postmortem is generated from the incident log rather than reconstructed from memory. The platform is opinionated: it wants you to declare incidents early, keep the timeline annotated, and close the loop with action items tied to real tickets.

In the broader DevOps toolchain, Opsgenie sits at the intersection of observability (receives alerts from Prometheus, Datadog, CloudWatch), communication (integrates with Slack and Teams), project tracking (syncs with Jira Service Management), and customer communication (connects to Atlassian Statuspage). It is the coordination layer that links a firing metric to a resolved customer impact to a completed remediation task. Engineers working in SRE, platform engineering, or on-call rotation roles interact with Opsgenie under the worst conditions — high stress, incomplete information, time pressure — so knowing the workflow cold is a genuine operational advantage.

---

## Concepts

### Alert vs. Incident: Two Distinct Objects

Alerts and incidents are not the same thing in Opsgenie, and conflating them is a common source of confusion during real outages.

| Object | What it is | Lifecycle | Scope |
|--------|-----------|-----------|-------|
| **Alert** | A single notification from a monitoring source | Open → Acknowledged → Resolved | One signal, one team, one on-call |
| **Incident** | A declared coordinated response to broader impact | Open → Investigating → Identified → Monitoring → Resolved → Closed | Multiple responders, linked alerts, public status |

An alert can exist without ever becoming an incident — a transient CPU spike that auto-resolves is an alert. An incident should be declared when the impact is customer-visible, cross-team, or requires coordination beyond the on-call engineer's immediate capability.

The lifecycle looks like this:

```
[Monitoring tool fires alert]
        │
        ▼
  ALERT: Open
        │
        ├─── Auto-resolves within N minutes? ──→ ALERT: Resolved (no incident)
        │
        └─── On-call acknowledges
                    │
                    ├─── Impact is contained, on-call handles alone? ──→ ALERT: Resolved
                    │
                    └─── Broader impact, needs coordination?
                                │
                                ▼
                    INCIDENT: Open
                         │
                         ▼
                    INCIDENT: Investigating
                         │
                         ▼
                    INCIDENT: Identified  ◄── root cause known
                         │
                         ▼
                    INCIDENT: Monitoring  ◄── fix deployed, watching
                         │
                         ▼
                    INCIDENT: Resolved
                         │
                         ▼
                    INCIDENT: Closed  ◄── postmortem complete
                         │
                         ▼
                    [Postmortem created]
```

**To declare an incident from an alert:** Alert detail → **Create Incident** — this links the alert to the new incident and seeds the incident timeline with the alert's timestamp, source, and metadata.

**To declare an incident directly:** Incidents → **Create Incident** — use this when the impact is known before a specific alert fires (e.g., a customer reports an outage before monitoring catches it).

**Non-obvious behavior:** Resolving the linked alert does not automatically resolve the incident. These are separate state machines. You must resolve the incident explicitly. This is intentional — the incident may have impacts that outlast the triggering alert.

---

### Incident Severity Levels

Severity is not just a label — in a properly configured Opsgenie environment, it drives automated behavior: who gets paged, whether a status page is updated, and whether a postmortem is mandatory.

| Severity | Label | Customer Impact | Status Page | Postmortem | Typical Response |
|----------|-------|----------------|-------------|------------|-----------------|
| SEV-1 | Critical | Full service down, revenue impact, data loss risk | Major Outage | Mandatory | Incident Commander + full team |
| SEV-2 | High | Major feature broken, significant degradation (>20% users) | Degraded Performance | Mandatory | On-call + team lead |
| SEV-3 | Moderate | Partial impact, workaround exists | Optional | Optional | On-call engineer |
| SEV-4 | Low | Minor, cosmetic, internal-only | No | No | Ticket, no page |

Severity can — and should — be upgraded mid-incident if the situation worsens. Downgrading is also valid once impact is confirmed smaller than initially assessed. Every severity change is logged in the incident timeline automatically.

**Gotcha:** Many teams skip declaring SEV-3 incidents because they feel minor. This is a mistake. SEV-3 incidents that are tracked generate timeline data and postmortem candidates. Patterns of SEV-3s in the same service are often the leading indicator of an upcoming SEV-1. If it touches customers, declare it.

Configure automated severity-based escalation rules under **Teams → [Team] → Escalation Policies** — for example, auto-escalate to Incident Commander if a SEV-1 is not acknowledged within 5 minutes.

---

### War Room: Slack and Teams Integration

A war room is a dedicated communication channel created for the duration of an incident. Its purpose is to give every responder a single shared context and prevent information from being scattered across DMs, existing channels, or verbal calls.

**Slack integration setup:** Settings → Integrations → Slack → Enable → Authorize workspace → Configure channel naming template.

Recommended channel naming template: `#inc-{date}-{incident-id}-{short-title}`
Example: `#inc-20240314-inc-114-checkout-down`

When an incident is declared with Slack integration active:
1. Opsgenie creates the dedicated channel using the naming template.
2. Invites all incident responders automatically (based on the responder list in Opsgenie).
3. Posts the incident summary: severity, description, Opsgenie link, and current status.
4. Mirrors all subsequent Opsgenie state changes as messages in the channel.

**Bidirectional sync** means actions in Slack are reflected in Opsgenie. Key Slack slash commands (requires Opsgenie Slack app installed):

```bash
/opsgenie ack <alert-id>          # acknowledge alert — updates state in Opsgenie
/opsgenie close <alert-id>        # resolve alert — updates state in Opsgenie
/opsgenie list                    # list open alerts for your teams
/opsgenie incident create         # launch incident creation wizard in Slack
/opsgenie incident update <id>    # post a status update to incident timeline
/opsgenie whoison                 # show current on-call for all teams
```

**Microsoft Teams integration:** Settings → Integrations → Microsoft Teams. Creates a Teams meeting bridge for voice/video and posts updates to a configured channel. Useful for organizations not on Slack.

**Non-obvious behavior:** The Slack channel persists after the incident is resolved. Archive it after the postmortem is complete. Do not reuse incident channels — having `#inc-20240314-inc-114-checkout-down` fully preserved is valuable for postmortem reconstruction weeks later.

---

### Status Page Updates

During a customer-impacting incident, external and internal stakeholders need a single source of truth for service status. Opsgenie integrates natively with **Atlassian Statuspage** (both are Atlassian products).

**Integration path:** Settings → Integrations → Statuspage → Connect → Map Opsgenie incidents to Statuspage components.

Component mapping example:

```yaml
# Statuspage component → triggered by Opsgenie incidents affecting these services
components:
  - statuspage_component: "Checkout"
    trigger_on: ["checkout-service", "payment-gateway"]
    sev1_status: "major_outage"
    sev2_status: "partial_outage"
    sev3_status: "degraded_performance"

  - statuspage_component: "API"
    trigger_on: ["api-gateway", "auth-service"]
    sev1_status: "major_outage"
    sev2_status: "partial_outage"
```

**Automated status page behavior when a SEV-1 incident is declared:**
1. Statuspage component moves to `Major Outage`.
2. A new Statuspage incident is created and linked.
3. Email/SMS subscribers are notified automatically.
4. When Opsgenie incident resolves → Statuspage component returns to `Operational`.

**Manual status page update during an incident:**
Incident detail → **Update Status Page** → select component → set status → write customer-facing message → post.

**Status page update cadence (SRE best practice):**

| Time | Action |
|------|--------|
| T+0 to T+5 min | Initial update: acknowledge impact, state you are investigating |
| Every 30 min | Progress update: what you know, what you are doing, next update time |
| On resolution | Resolution update: service restored, brief cause summary |
| T+24h to T+72h | Add postmortem link once published |

**Gotcha:** "We're investigating" every 30 minutes feels redundant, but it is not. Customers and stakeholders interpret silence as abandonment. The cadence is a communication discipline, not an information-delivery requirement.

---

### Incident Timeline

The incident timeline is the automatic, append-only log of everything that happens during an incident. It is populated by Opsgenie without any manual effort from responders and is the single source of truth for postmortem reconstruction.

**What gets logged automatically:**
- Alert received and routed.
- On-call notified (method: push, call, SMS).
- Alert acknowledged by [user] at [timestamp].
- Severity changed from X to Y by [user].
- Responder added: [user].
- Status page updated to [status].
- Incident status changed to [status] by [user].
- Linked alert resolved.

**What you must add manually:**
- Hypotheses being investigated.
- Test results or query output.
- Decision points ("decided to rollback rather than forward-fix").
- Customer communication timestamps.
- Time root cause was identified (mark this explicitly — it determines MTTI).

Add a manual note: Incident detail → **Add Note** → text → Save. This appears inline in the timeline at the current timestamp.

A well-annotated timeline for a 35-minute incident might look like:

```
14:30 UTC  [AUTO] Alert received: checkout-error-rate-high (P1)
14:30 UTC  [AUTO] Routed to platform-team, on-call: alice@example.com
14:30 UTC  [AUTO] Notification sent to Alice: push + phone call
14:33 UTC  [AUTO] Alert acknowledged by Alice
14:34 UTC  [AUTO] Incident INC-114 created: "Checkout degraded - SEV-1"
14:34 UTC  [AUTO] Slack channel #inc-20240314-inc-114-checkout-down created
14:35 UTC  [AUTO] Status page updated: Checkout → Major Outage
14:35 UTC  [NOTE] Alice: "Error rate 25%, deployment at 14:20 is suspect. Checking diff."
14:41 UTC  [NOTE] Alice: "Bad env var in config map deployed at 14:20. DB_POOL_SIZE=0."
14:42 UTC  [AUTO] Incident status → Identified
14:43 UTC  [NOTE] Alice: "Rollback initiated via kubectl rollout undo"
14:58 UTC  [NOTE] Alice: "Error rate below 1%. Monitoring for 5 min before resolving."
15:03 UTC  [AUTO] Incident status → Monitoring
15:05 UTC  [AUTO] Incident status → Resolved by Alice
15:05 UTC  [AUTO] Status page updated: Checkout → Operational
15:05 UTC  [AUTO] MTTR calculated: 35 min | MTTA: 3 min | MTTI: 11 min
```

**The discipline of timeline notes is what separates a useful postmortem from a vague one.** If you skip notes during the incident, you will spend the next day reconstructing from Slack history and memory — both unreliable.

---

### Key Metrics: MTTA, MTTI, MTTR

Opsgenie calculates three core incident metrics automatically from timeline events. Understanding what each measures — and what it tells you about your process — is essential for SRE reporting and post-incident improvement.

| Metric | Full Name | Measured From → To | What it reveals |
|--------|-----------|---------------------|-----------------|
| **MTTA** | Mean Time To Acknowledge | Alert created → Alert acknowledged | On-call notification effectiveness, rotation health |
| **MTTI** | Mean Time To Identify | Alert created → Root cause identified | Investigation efficiency, observability quality |
| **MTTR** | Mean Time To Resolve | Alert created → Incident resolved | End-to-end response process quality |

These are averages over a reporting period, not per-incident values. Opsgenie's **Reports** section (Reports → Incidents) provides MTTA, MTTI, and MTTR broken down by team, service, and time window.

**How to use these metrics operationally:**

- **High MTTA** → notification policy problem. People are not being reached. Check escalation timeout, contact methods, and on-call rotation coverage.
- **High MTTI relative to MTTR** → observability problem. Engineers are being paged but cannot find the cause. Invest in better dashboards, runbooks, and alert context.
- **High MTTR relative to MTTI** → execution problem. Root cause is found quickly but fixes take too long. Invest in rollback automation, deployment tooling, and change freeze processes.

**Gotcha:** MTTR only measures from alert creation to incident resolution. If monitoring lags — for example, a metric alert fires 10 minutes after the actual failure — your MTTR understates the real customer impact duration. Track "customer impact duration" separately by noting when the first customer report arrived in the timeline.

**Gotcha:** MTTI requires a human to mark the "Identified" status transition. If engineers skip this transition and jump straight from Investigating to Monitoring, MTTI cannot be calculated. Enforce the full status progression in your incident runbook.

---

### Postmortem Creation

Opsgenie generates a postmortem draft directly from the incident timeline. The draft pre-populates everything that was logged automatically, leaving only the analytical sections for human completion.

**To generate:** Incident detail → **Create Postmortem** → select destination (Opsgenie, Confluence, Google Docs, or Jira).

**Auto-populated sections:**
- Incident summary, severity, duration, MTTR, MTTA.
- Full timeline (from the incident log).
- Responder list with join/leave times.
- Linked alerts and their sources.

**Sections requiring human input:**

```markdown
## Summary
One paragraph: what happened, scope, duration, resolution.
Write for an audience who was not in the incident.

## Impact
- User-facing: X% of users could not complete checkout for 35 minutes.
- Revenue: estimated $12,000 lost (based on avg checkout rate × duration).
- Internal: 3 engineers engaged for 35 minutes.

## Root Cause
The technical cause — not the person. Describe the mechanism.
"DB_POOL_SIZE was set to 0 in the config map, causing all DB connections
to fail immediately. The deployment was not caught because the staging
environment uses a mock DB client."

## Contributing Factors
Systemic issues that allowed the root cause to manifest:
- No pre-deploy validation for required config map keys.
- Staging environment does not use a real DB client.
- No automated rollback trigger on elevated error rate.

## What Went Well
- MTTA was 3 minutes — on-call notification effective.
- Root cause identified in 11 minutes from alert.
- Rollback procedure was documented and executed without hesitation.

## What Went Poorly
- Status page update took 5 minutes — should be within 2 min for SEV-1.
- No runbook for config map validation failures.
- Monitoring did not catch the bad config before deployment.

## Action Items
| Item | Owner | Due | Ticket |
|------|-------|-----|--------|
| Add config map key validation to CI pipeline | carol | 2024-03-29 | PLAT-2342 |
| Add automated rollback on error rate > 5% for 3 min | bob | 2024-03-22 | PLAT-2341 |
| Update staging to use real DB client in integration tests | dave | 2024-04-05 | PLAT-2343 |
```

**Blameless postmortem principle:** The root cause is always a system failure, never a person failure. If a person made a mistake, the question is: what system allowed that mistake to have this impact? That system gap is the action item. Attributing root cause to human error produces postmortems that generate no lasting improvement.

**Timing:** Publish within 48 hours. After 72 hours, memory degrades and momentum is lost. Block 60–90 minutes for postmortem review with all responders within 24 hours of resolution.

---

### Opsgenie + Jira Service Management Integration

Jira Service Management (JSM) is Atlassian's ITSM platform. Since both JSM and Opsgenie are Atlassian products, the integration is native and bidirectional — meaning state changes in either system propagate to the other without manual webhook configuration.

**Setup:** Settings → Integrations → Jira Service Management → Connect → Select JSM project → Configure field mappings.

**Priority mapping:**

| Opsgenie Priority | JSM Priority | Default trigger behavior |
|-------------------|-------------|--------------------------|
| P1 | Highest | Auto-create JSM issue, assign to on-call, set SLA timer |
| P2 | High | Auto-create JSM issue, assign to on-call |
| P3 | Medium | Create JSM issue on acknowledgement |
| P4 | Low | Create JSM issue on resolution (for tracking) |
| P5 | Lowest | No auto-creation; manual only |

**Bidirectional sync behavior:**

| Action in Opsgenie | Effect in JSM | Action in JSM | Effect in Opsgenie |
|--------------------|--------------|---------------|-------------------|
| Alert acknowledged | Issue status → In Progress | Issue resolved | Alert auto-closed |
| Incident created | JSM incident issue created | Comment added | Timeline note added |
| Severity changed | JSM priority updated | Priority changed | Opsgenie severity updated |
| Postmortem linked | JSM issue updated with postmortem URL | — | — |

**Field mapping configuration (YAML export from Opsgenie):**

```yaml
# Opsgenie → JSM field mapping
# Found under: Settings → Integrations → JSM → Field Mappings
integration:
  name: "JSM-Production"
  type: "jiraServiceManagement"
  settings:
    project_key: "INFRA"
    issue_type: "Incident"
    field_mappings:
      summary: "{{alert.message}}"
      description: |
        *Source:* {{alert.source}}
        *Team:* {{alert.teams}}
        *Priority:* {{alert.priority}}
        *Details:* {{alert.description}}
      priority:
        P1: "Highest"
        P2: "High"
        P3: "Medium"
        P4: "Low"
      labels:
        - "opsgenie"
        - "{{alert.teams}}"
    auto_create_on: ["P1", "P2"]
    auto_close_jira_on_resolve: true
    auto_resolve_opsgenie_on_jira_close: true
```

**Gotcha:** If `auto_resolve_opsgenie_on_jira_close` is enabled and a JSM issue is accidentally closed, the Opsgenie alert closes with it — even if the underlying system is still degraded. Disable this setting for SEV-1 incidents and require explicit Opsgenie resolution. Use the flag for P3/P4 only where the risk is low.

**Postmortem action items → Jira tickets:** After a postmortem is complete, each action item should become a Jira ticket. Opsgenie's postmortem UI has a **Create Ticket** button per action item row that creates a linked Jira issue in the configured project and populates it with the action item text, owner, and due date. This closes the loop between the incident response and the actual engineering work that prevents recurrence.

---

### Notification Policies and Escalation

Notification policies define how an alert reaches a person. Escalation policies define what happens if they do not respond. Both are configured at the team level, and together they determine your MTTA floor.

**Notification policy (per user):** Profile → Notification Rules → Add Rule.

A typical on-call engineer's notification stack:

```
Immediately:    Mobile push notification
After 1 min:    SMS to mobile
After 3 min:    Phone call
After 5 min:    Phone call (backup number)
```

**Escalation policy (per team):** Teams → [Team] → Escalation Policies → Add Policy.

```yaml
# Example escalation policy: platform-team-critical
name: "Platform Team - Critical"
steps:
  - notify:
      target: "on-call schedule: platform-primary"
      wait_minutes: 0
  - notify:
      target: "on-call schedule: platform-secondary"
      wait_minutes: 5        # if primary does not acknowledge in 5 min
    condition: "not acknowledged"
  - notify:
      target: "user: alice@example.com"  # team lead, always notified at 10 min
      wait_minutes: 10
    condition: "not acknowledged"
  - notify:
      target: "team: platform-team"      # broadcast to whole team at 15 min
      wait_minutes: 15
    condition: "not acknowledged"
```

**Routing rules** determine which escalation policy receives an incoming alert. They evaluate alert properties (source, tags, priority, message content) and send to the appropriate policy.

```yaml
# Routing rule for platform team
rules:
  - name: "Route P1 checkout alerts to critical policy"
    conditions:
      - field: "priority"
        operation: "equals"
        value: "P1"
      - field: "tags"
        operation: "contains"
        value: "checkout"
    route_to: "Platform Team - Critical"

  - name: "Route all other platform alerts to standard policy"
    conditions:
      - field: "teams"
        operation: "contains"
        value: "platform-team"
    route_to: "Platform Team - Standard"
```

**Non-obvious behavior:** Escalation policies are evaluated in order, and the first matching rule wins. Put the most specific rules first and the catch-all last. A misconfigured routing rule that sends P1 alerts to a low-priority policy is one of the most common causes of high MTTA — and it is invisible until an incident occurs.

---

## Examples

### Example 1: End-to-End SEV-1 Incident Response

**Scenario:** A Prometheus alert fires at 14:30 UTC indicating the checkout service error rate has exceeded 10% for 3 consecutive minutes. This is a customer-impacting SEV-1.

**Setup:** Prometheus is already integrated with Opsgenie via the Prometheus Alertmanager webhook. The platform team's escalation policy is configured as shown in the Notification Policies section above.

**Step 1 — Alert fires and routes automatically.**

Alertmanager config that sends to Opsgenie:

```yaml
# alertmanager.yml — Opsgenie receiver configuration
receivers:
  - name: 'opsgenie-platform'
    opsgenie_configs:
      - api_key: '<YOUR_OPSGENIE_API_KEY>'
        api_url: 'https://api.opsgenie.com/'
        message: '{{ .GroupLabels.alertname }}'
        description: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
        priority: '{{ if eq .GroupLabels.severity "critical" }}P1{{ else if eq .GroupLabels.severity "warning" }}P2{{ else }}P3{{ end }}'
        tags: '{{ range .GroupLabels.SortedPairs }}{{ .Name }}:{{ .Value }},{{ end }}'
        # Responders are set to team so routing rules apply
        responders:
          - name: 'platform-team'
            type: 'team'

route:
  receiver: 'opsgenie-platform'
  group_by: ['alertname', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
```

**Step 2 — On-call acknowledges and declares incident.**

Alice receives the push notification, opens Opsgenie, and within the alert:

```
Alert: checkout-error-rate-high (P1)
Source: Prometheus / alertmanager
Fired: 14:30:05 UTC
Tags: service:checkout, severity:critical, env:production

[Acknowledge]  [Create Incident]  [Snooze]
```

Alice taps **Acknowledge** (logged: MTTA = 3 min), then **Create Incident**:

```
Incident Name:  Checkout service degraded - elevated error rate
Severity:       SEV-1
Impacted Service: checkout
Responders:     platform-team
Message:        Error rate 25%, investigating deployment at 14:20
```

**Step 3 — War room and status page update automatically.**

Within 30 seconds of incident creation:
- Slack channel `#inc-20240314-inc-114-checkout-down` is created.
- All platform-team members are invited.
- Statuspage `Checkout` component moves to `Major Outage`.
- Statuspage subscribers receive email notification.

**Step 4 — Investigation with timeline notes.**

Alice adds notes in Opsgenie as she investigates:

```bash
# Alice checks recent deployments
kubectl rollout history deployment/checkout-service -n production
# Output shows a deployment at 14:20

# Checks the config diff
kubectl describe configmap checkout-config -n production | grep DB_POOL
# DB_POOL_SIZE: 0  ← the problem

# Confirms via logs
kubectl logs -l app=checkout -n production --since=15m | grep "connection pool"
# "connection pool exhausted: max_size=0"
```

She adds to the Opsgenie incident timeline:
```
[14:41] "Root cause found: DB_POOL_SIZE=0 in configmap deployed at 14:20.
         All DB connections failing immediately. Initiating rollback."
```

Changes incident status → **Identified**.

**Step 5 — Remediation.**

```bash
# Roll back the bad deployment
kubectl rollout undo deployment/checkout-service -n production

# Watch the rollout
kubectl rollout status deployment/checkout-service -n production
# Waiting for deployment "checkout-service" rollout to finish: 2 out of 3 new replicas have been updated...
# deployment "checkout-service" successfully rolled out

# Verify error rate in Prometheus
curl -s 'http://prometheus:9090/api/v1/query?query=rate(checkout_errors_total[2m])' \
  | jq '.data.result[0].value[1]'
# "0.008"  ← below 1%
```

Timeline note: `[14:58] "Rollback complete. Error rate 0.8%. Monitoring for 5 min before resolving."`

**Step 6 — Resolve and verify.**

After 5 minutes of stable metrics, Alice changes incident status → **Monitoring** → **Resolved**.

```
[AUTO] Incident INC-114 resolved by Alice at 15:05 UTC
[AUTO] Status page updated: Checkout → Operational
[AUTO] MTTR: 35 min | MTTA: 3 min | MTTI: 11 min
[AUTO] JSM issue INFRA-2891 status updated → Resolved
```

**Verify:** Open Opsgenie Reports → Incidents → filter last 24 hours → confirm INC-114 shows MTTR 35 min and status Closed.

---

### Example 2: Configuring a Severity-Based Escalation Policy via API

**Scenario:** You need to programmatically configure a new escalation policy for the `payments-team` that auto-escalates SEV-1 incidents to the team lead if unacknowledged after 5 minutes. This is done via the Opsgenie REST API, useful for infrastructure-as-code setups.

```bash
#!/bin/bash
# create-escalation-policy.sh
# Creates a payments-team escalation policy with SEV-1 auto-escalation
# Requires: OPSGENIE_API_KEY environment variable set

OPSGENIE_API_KEY="${OPSGENIE_API_KEY:?OPSGENIE_API_KEY must be set}"
BASE_URL="https://api.opsgenie.com/v2"

# Step 1: Get the team ID for payments-team
TEAM_RESPONSE=$(curl -s -X GET "${BASE_URL}/teams/payments-team" \
  -H "Authorization: GenieKey ${OPSGENIE_API_KEY}" \
  -H "Content-Type: application/json")

TEAM_ID=$(echo "${TEAM_RESPONSE}" | jq -r '.data.id')
echo "Team ID: ${TEAM_ID}"

# Step 2: Get the on-call schedule ID for payments-team
SCHEDULE_RESPONSE=$(curl -s -X GET "${BASE_URL}/schedules?teamId=${TEAM_ID}" \
  -H "Authorization: GenieKey ${OPSGENIE_API_KEY}")

SCHEDULE_ID=$(echo "${SCHEDULE_RESPONSE}" | jq -r '.data[0].id')
echo "Schedule ID: ${SCHEDULE_ID}"

# Step 3: Create the escalation policy
# Rules execute in order; each rule fires if the condition is met
curl -s -X POST "${BASE_URL}/escalations" \
  -H "Authorization: GenieKey ${OPSGENIE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Payments Team - P1 Critical Escalation\",
    \"description\": \"Auto-escalates P1 alerts to team lead after 5 min\",
    \"ownerTeam\": {\"id\": \"${TEAM_ID}\"},
    \"rules\": [
      {
        \"condition\": \"if-not-acked\",
        \"notifyType\": \"next\",
        \"delay\": {\"timeAmount\": 0, \"timeUnit\": \"minutes\"},
        \"recipient\": {
          \"type\": \"schedule\",
          \"id\": \"${SCHEDULE_ID}\"
        }
      },
      {
        \"condition\": \"if-not-acked\",
        \"notifyType\": \"next\",
        \"delay\": {\"timeAmount\": 5, \"timeUnit\": \"minutes\"},
        \"recipient\": {
          \"type\": \"user\",
          \"username\": \"payments-lead@example.com\"
        }
      },
      {
        \"condition\": \"if-not-acked\",
        \"notifyType\": \"all\",
        \"delay\": {\"timeAmount\": 10, \"timeUnit\": \"minutes\"},
        \"recipient\": {
          \"type\": \"team\",
          \"id\": \"${TEAM_ID}\"
        }
      }
    ],
    \"repeat\": {
      \"waitInterval\": 5,
      \"count\": 3,
      \"resetRecipientStates\": true,
      \"closeAlertAfterAll\": false
    }
  }" | jq '.result'

# Expected output: "Created"
```

**Verify:** Navigate to Teams → payments-team → Escalation Policies. Confirm "Payments Team - P1 Critical Escalation" appears with three steps.

---

### Example 3: Postmortem Generation and Jira Action Item Tracking

**Scenario:** INC-114 from Example 1 is resolved. Generate a postmortem and create Jira tickets for each action item using the Opsgenie API.

```bash
#!/bin/bash
# generate-postmortem-and-tickets.sh
# Generates a postmortem from a resolved incident and creates Jira action item tickets

OPSGENIE_API_KEY="${OPSGENIE_API_KEY:?}"
JIRA_BASE_URL="https://your-org.atlassian.net"
JIRA_EMAIL="${JIRA_EMAIL:?}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:?}"
INCIDENT_ID="INC-114"

# Step 1: Fetch incident details and timeline
curl -s -X GET "https://api.opsgenie.com/v1/incidents/${INCIDENT_ID}" \
  -H "Authorization: GenieKey ${OPSGENIE_API_KEY}" \
  | jq '{
      id: .data.id,
      message: .data.message,
      severity: .data.severity,
      createdAt: .data.createdAt,
      resolvedAt: .data.resolvedAt,
      mttr: .data.extraProperties.mttr,
      mtta: .data.extraProperties.mtta,
      mtti: .data.extraProperties.mtti
    }'

# Step 2: Define action items from postmortem
# In practice these come from the postmortem review meeting
declare -a ACTION_ITEMS=(
  "Add config map key validation to CI pipeline|carol@example.com|2024-03-29|PLAT"
  "Add automated rollback on error rate > 5% for 3 min|bob@example.com|2024-03-22|PLAT"
  "Update staging to use real DB client in integration tests|dave@example.com|2024-04-05|PLAT"
)

# Step 3: Create a Jira ticket for each action item
for item in "${ACTION_ITEMS[@]}"; do
  IFS='|' read -r summary assignee_email due_date project <<< "${item}"

  TICKET_RESPONSE=$(curl -s -X POST \
    "${JIRA_BASE_URL}/rest/api/3/issue" \
    -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"fields\": {
        \"project\": {\"key\": \"${project}\"},
        \"summary\": \"[Post-Incident INC-114] ${summary}\",
        \"description\": {
          \"type\": \"doc\",
          \"version\": 1,
          \"content\": [{
            \"type\": \"paragraph\",
            \"content\": [{
              \"type\": \"text\",
              \"text\": \"Action item from INC-114 postmortem. See: https://app.opsgenie.com/incident/${INCIDENT_ID}\"
            }]
          }]
        },
        \"issuetype\": {\"name\": \"Task\"},
        \"assignee\": {\"emailAddress\": \"${assignee_email}\"},
        \"duedate\": \"${due_date}\",
        \"labels\": [\"postmortem\", \"incident-INC-114\"]
      }
    }")

  TICKET_KEY=$(echo "${TICKET_RESPONSE}" | jq -r '.key')
  echo "Created: ${TICKET_KEY} — ${summary}"
done
```

**Verify:** Open Jira project PLAT and filter by label `incident-INC-114`. Confirm three tickets exist with correct assignees and due dates. Open the Opsgenie postmortem for INC-114 and manually paste the Jira ticket keys into the action items table — or use the **Create Ticket** button in the UI for future incidents to do this automatically.

---

## Exercises

### Exercise 1: Simulate a Full Incident Lifecycle in Opsgenie

**Goal:** Practice the complete declare → investigate → resolve → close flow without time pressure so the steps are automatic when they matter.

**Setup required:** A free Opsgenie trial account (app.opsgenie.com), your own user as the on-call responder, Slack integration connected to a personal workspace.

1. Navigate to Alerts → **Create Alert manually**. Set message to `"Simulated: payment-service latency spike"`, priority P1, tag with `service:payments, env:production`.
2. Acknowledge the alert from your notification or the alert detail page. Note the MTTA timestamp.
3. From the alert detail, click **Create Incident**. Set severity SEV-2, name it `"Payments latency elevated - sim"`.
4. Confirm a Slack channel was created (if Slack integration is enabled). Post a message in the channel and verify it appears in the Opsgenie incident timeline as a note.
5. Add three manual timeline notes with realistic investigation content: one hypothesis, one finding, one decision.
6. Transition the incident through each status: **Investigating → Identified → Monitoring → Resolved**.
7. After resolving, click **Create Postmortem**. Complete the Summary, Root Cause, and at least two Action Items sections.
8. **Verify:** Open Reports → Incidents. Confirm your incident appears with MTTA, MTTI, and MTTR all populated. If MTTI is missing, check whether you transitioned through the Identified status.

---

### Exercise 2: Build and Test a Routing Rule

**Goal:** Understand how alert properties determine which team and escalation policy handles an alert — and verify your logic before a real incident.

**Setup required:** Opsgenie account with at least two teams configured (e.g., `platform-team` and `payments-team`).

1. Navigate to Teams → platform-team → **Routing Rules → Add Rule**.
2. Create a rule that routes alerts matching ALL of these conditions to the platform-team's critical escalation policy:
   - `priority` equals `P1`
   - `tags` contains `service:checkout`
3. Create a second rule (below the first) as a catch-all: route all other platform-team alerts to the standard escalation policy.
4. **Test the routing rule:** In the routing rule editor, use the **Test Rule** feature. Input an alert payload:
   ```json
   {
     "message": "checkout-error-rate-high",
     "priority": "P1",
     "tags": ["service:checkout", "env:production"]
   }
   ```
   Verify it matches the first rule, not the catch-all.
5. Test a second payload with `priority: "P2"` and `tags: ["service:checkout"]`. Verify it falls through to the catch-all.
6. **Challenge:** Add a third rule between the two existing rules that routes P1 alerts tagged `service:payments` to `payments-team`'s escalation policy. Re-run both test payloads and confirm routing is unchanged for the checkout P1 alert. Explain in a comment why rule order mattered here.

---

### Exercise 3: Analyze MTTR Data and Identify Process Bottlenecks

**Goal:** Use Opsgenie's reporting to draw actionable conclusions about incident response quality — the kind of analysis you would present in a quarterly SRE review.

**Setup required:** At least 5 historical incidents in your Opsgenie account (use the simulation from Exercise 1 repeated with variations, or use a team account with real history).

1. Navigate to Reports → **Incidents**. Set time range to the last 30 days.
2. Export the incident data as CSV (Download button in the top right).
3. Open the CSV and calculate the following manually or in a spreadsheet:
   - Average MTTA across all incidents.
   - Average MTTI across all incidents.
   - Average MTTR across all incidents.
   - MTTR broken down by severity (SEV-1 vs SEV-2 vs SEV-3).
4. For each metric, answer: is this number acceptable? Use the following benchmarks as a reference:

   | Metric | Good | Needs Improvement | Poor |
   |--------|------|------------------|------|
   | MTTA | < 5 min | 5–15 min | > 15 min |
   | MTTI | < 20 min | 20–45 min | > 45 min |
   | MTTR | < 60 min | 60–180 min | > 3 hours |

5. Identify the single largest gap between your data and the benchmark. Write a 3–5 sentence diagnosis: what process or tooling failure is most likely causing this gap, and what one change would you propose to address it?
6. **Challenge:** In Reports → Alerts, find the alert source (integration) responsible for the highest number of P1 alerts. Determine whether those alerts have a consistently high or low MTTA. Form a hypothesis: is this a notification policy issue, a routing rule issue, or an on-call scheduling issue? Write the hypothesis in one paragraph with supporting data from the report.
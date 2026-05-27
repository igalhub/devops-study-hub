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

### Postmortem Creation

Opsgenie generates a postmortem draft directly from the incident timeline. The draft pre-populates everything that was logged automatically, leaving only the analytical sections for human completion.

**To generate:** Incident detail → **Create Postmortem** → select destination (Opsgenie, Confluence, Google Docs, or Jira).

**Auto-populated sections:**
- Incident summary, severity, duration, MTTR, MTTA.
- Full timeline (from the incident log).
- Responder list with join/leave times.
- Linked alerts and their sources.

**Sections requiring human input:**

```
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

Jira Service Management (JSM) is Atlassian's ITSM platform. Since both JSM and Opsgenie are Atlassian products, the integration is native and bidirectional — meaning state changes in either system propagate to the other without webhook configuration.

**Setup:** Settings → Integrations → Jira Service Management → Connect → Select JSM project → Configure field mappings.

**Priority mapping:**

| Opsgenie Priority | JSM Priority | Typical trigger behavior |
|-------------------|-------------|--------------------------|
| P1 | Highest | Auto-create JSM issue, assign to on-call |
| P2 | High | Auto-create JSM issue, assign to on-call |
| P3 | Medium | Create JSM issue on acknowledgement |
| P4
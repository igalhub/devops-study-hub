---
title: Incident Management Workflow
module: opsgenie
duration_min: 20
difficulty: intermediate
tags: [opsgenie, incident-management, postmortem, jira, mttr, mtta]
exercises: 3
---

## Overview
Opsgenie is not just an alert router — it is a full incident management platform. The alert-to-incident lifecycle, war room coordination, status page updates, and postmortem creation are all surfaces where DevOps engineers work during and after outages. Understanding this lifecycle means you can run an incident systematically rather than reactively, reducing mean time to resolution and improving the quality of retrospectives. This lesson covers the full operational workflow from first alert to closed postmortem.

## Concepts

### Alert → Incident Lifecycle

Alerts and incidents are distinct objects in Opsgenie:

- **Alert**: a single notification from a monitoring tool. May resolve on its own. Routed to a team and on-call engineer.
- **Incident**: a declared, coordinated response to a broader impact. Groups one or more related alerts. Has a severity, status, responder list, and timeline.

Lifecycle states:

```
[Alert fires]
    │
    ▼
ALERT: Open → Acknowledged → Resolved
    │ (if impact is broader, declare incident)
    ▼
INCIDENT: Open → Investigating → Identified → Monitoring → Resolved → Closed
    │
    ▼
[Postmortem created]
```

Declaring an incident from an alert: **Alert detail → Create Incident** — this links the alert to a new incident and starts the incident timeline.

Alternatively, create an incident directly: **Incidents → Create Incident**

### Incident Severity Levels

Opsgenie incidents use SEV (severity) levels. Typical mapping:

| Severity | Label | Definition | Example |
|---|---|---|---|
| SEV-1 | Critical | Full service down, revenue impact, data loss | Checkout service returning 500 to all users |
| SEV-2 | High | Major feature broken, significant degradation | Payments slow (>10s) for >20% of users |
| SEV-3 | Moderate | Partial impact, workaround available | Search returning stale results; users can reload |
| SEV-4 | Low | Minor, cosmetic, or internal only | Dashboard shows incorrect metric label |

Severity determines: who is paged, whether the status page is updated, and whether a postmortem is required (SEV-1/2 typically mandatory; SEV-3 optional).

### War Room — Slack and Teams Integration
A **war room** is a dedicated communication channel created for the duration of an incident. Opsgenie can automatically create a Slack channel or Teams meeting when an incident is declared.

**Slack integration**: **Settings → Integrations → Slack**

Once configured, declaring an incident with Slack integration enabled:
1. Creates a dedicated Slack channel: `#incident-2024-031-checkout-down`.
2. Invites the incident responders automatically.
3. Posts the incident summary, severity, and a link back to Opsgenie.
4. Mirrors Opsgenie alert state changes as messages in the channel (acknowledged, escalated, resolved).

Opsgenie also supports bidirectional sync: actions taken in Slack (e.g., typing `/opsgenie ack`) are reflected in Opsgenie, and vice versa.

For Microsoft Teams: **Settings → Integrations → Microsoft Teams** — creates a Teams meeting bridge and posts to a configured channel.

Opsgenie incident commands in Slack (with the Opsgenie Slack app):

```
/opsgenie ack <alert-id>        -- acknowledge alert
/opsgenie close <alert-id>      -- close alert
/opsgenie list                  -- list open alerts for your teams
/opsgenie incident create       -- start incident creation wizard
```

### Status Page Updates
During a customer-impacting incident, stakeholders need a public or internal status page. Opsgenie integrates with **Atlassian Statuspage** (same corporate family).

Integration path: **Settings → Integrations → Statuspage**

When an Opsgenie incident is created at SEV-1 or SEV-2:
- Automatically update the relevant Statuspage component to `Degraded Performance` or `Major Outage`.
- When the incident resolves, automatically update Statuspage to `Operational`.

Manual update during incident:
- Incident detail → **Update Status Page** → choose component + status + message.
- Post an **incident update** message visible to subscribers.

Status page update cadence (SRE best practice):
- Initial update: within 5 minutes of incident declaration.
- Progress updates: every 30 minutes minimum.
- Resolution update: as soon as service is restored.
- Postmortem link: added once published (24–72h post-incident).

### Postmortem Creation
Opsgenie generates postmortem templates directly from the incident timeline.

**Incident detail → Create Postmortem**

The generated document includes:
- Incident summary, severity, duration.
- Alert and escalation timeline (auto-populated from Opsgenie events).
- Responder list.
- Blank sections: impact, root cause, contributing factors, action items.

Postmortems can be created inside Opsgenie or exported to Jira, Confluence, or a Google Doc.

**Blameless postmortem sections** (industry standard):

```
1. Summary           — one paragraph, what happened and impact
2. Timeline          — chronological events (auto-populated from incident log)
3. Impact            — how many users, what functionality, revenue estimate
4. Root cause        — technical cause (not person-blame)
5. Contributing factors — systemic issues that allowed the root cause to manifest
6. What went well    — processes/tools that helped during response
7. What went poorly  — friction points, gaps, delays
8. Action items      — owner, due date, JIRA ticket per item
```

### Incident Timeline
Every state change, comment, acknowledgement, escalation, and responder addition is logged in the incident timeline automatically.

Entries in the timeline:
- Alert acknowledged by Alice at 14:32 UTC.
- Incident severity changed from SEV-2 to SEV-1 at 14:38 UTC.
- Bob added as responder at 14:39 UTC.
- Status page updated to "Major Outage" at 14:40 UTC.
- Root cause identified at 15:05 UTC.
- Service restored at 15:22 UTC.
- Incident resolved at 15:25 UTC.

The timeline is the source of truth for postmortem reconstruction. Add manual notes during the incident using the "Add note" feature: **Incident detail → Note** — these appear in the timeline and postmortem.

### Opsgenie + Jira Service Management Integration
Jira Service Management (JSM) is Atlassian's ITSM platform. Opsgenie has deep native integration:

**Bi-directional sync:**
- Opsgenie alert → JSM creates a linked issue.
- JSM issue state change → Opsgenie alert acknowledged or resolved.
- Postmortem action items → JSM issues assigned to owners.

Configuration: **Settings → Integrations → Jira Service Management**

Map fields:
```
Opsgenie Priority → JSM Priority
P1 → Highest
P2 → High
P3 → Medium
P4 → Low
P5 → Lowest

Opsgenie alert status → JSM issue status
Open → Open
Acknowledged → In Progress
Resolved → Resolved
```

**Alert-to-issue workflow:**
1. P1 alert fires in Opsgenie.
2. Integration rule: if priority is P1, create JSM issue automatically.
3. JSM issue is assigned to the on-call engineer.
4. When Opsgenie alert resolves, JSM issue moves to "Resolved".
5. Postmortem action items are created as JSM sub-tasks.

### MTTR and MTTA Metrics

| Metric | Definition | Formula |
|---|---|---|
| **MTTA** | Mean Time To Acknowledge | Avg time from alert creation to first acknowledgement |
| **MTTR** | Mean Time To Resolve | Avg time from alert creation to resolution |
| **MTTI** | Mean Time To Identify | Avg time from alert creation to root cause identified |
| **MTTD** | Mean Time To Detect | Avg time from issue start to alert firing (monitoring lag) |

Opsgenie tracks MTTA and MTTR automatically per team, per integration, per time period.

Access: **Analytics → Team Reports → Mean Response Metrics**

Use case:
- **MTTA trending up**: escalation policy may be misconfigured; on-call engineers not acknowledging promptly; notification methods not reaching them.
- **MTTR trending up**: incidents taking longer to resolve; may indicate knowledge gaps, lack of runbooks, or dependency on unavailable team members.
- **Compare MTTA across teams**: identify teams that need better on-call practices.

Export metrics via API for custom reporting:

```bash
curl -X GET \
  "https://api.opsgenie.com/v2/reports/metrics?startDate=2024-01-01&endDate=2024-03-31&teamId=TEAM_ID" \
  -H "Authorization: GenieKey YOUR_API_KEY"
```

## Examples

### Complete P1 incident workflow walkthrough

```
14:30 UTC — Prometheus fires alert: checkout-service error rate > 10%
14:30 UTC — Opsgenie receives alert, routes to platform-team, P1
14:30 UTC — Alice (on-call) receives phone call and push notification
14:33 UTC — Alice acknowledges in Opsgenie (MTTA: 3 min)
14:34 UTC — Alice declares incident: "Checkout service degraded - SEV-1"
14:34 UTC — Opsgenie creates #incident-2024-114 Slack channel, invites Alice + team lead
14:35 UTC — Alice updates status page: "Checkout → Major Outage"
14:35 UTC — Alice adds note in Opsgenie: "Error rate at 25%, investigating deployment from 14:20"
14:48 UTC — Root cause found: bad config in deploy 14:20
14:50 UTC — Rollback initiated
15:02 UTC — Error rate drops below 1%
15:05 UTC — Alice resolves incident in Opsgenie
15:05 UTC — Status page auto-updated: "Checkout → Operational"
15:05 UTC — MTTR: 35 minutes
15:05 UTC — Opsgenie generates postmortem draft
Next day — Postmortem completed, 3 action items created as Jira tickets
```

### Postmortem action item format

```
Action item: Add automated rollback trigger when error rate exceeds 5% for 3 minutes
Owner: Bob (platform team)
Due: 2024-03-22
Jira: PLAT-2341
Status: In Progress

Action item: Add pre-deploy error rate baseline check to CI pipeline
Owner: Carol (devops)
Due: 2024-03-29
Jira: PLAT-2342
Status: Open
```

## Exercises

1. Walk through a SEV-2 incident from the moment an alert fires to postmortem closure. Specify: the exact sequence of actions in Opsgenie, who takes each action and when, what Slack channel activities occur, what the status page shows at each stage, and what the postmortem must contain. Be precise enough that a new team member could follow it as a runbook.

2. Your team's MTTA has risen from 3 minutes to 11 minutes over the past quarter. List five concrete hypotheses for what could be causing this, and for each, describe one change to Opsgenie configuration or team practice that would address it.

3. Configure the Opsgenie ↔ Jira Service Management integration for a P1/P2 alert policy. Specify: which alert conditions automatically create a JSM issue, how priority maps between systems, how alert resolution maps to JSM issue status, and how postmortem action items flow into Jira. Describe any integration rules needed in Opsgenie to implement this.

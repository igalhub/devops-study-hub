---
title: On-Call Schedules & Escalations
module: opsgenie
duration_min: 20
difficulty: beginner
tags: [opsgenie, on-call, schedules, escalation, incident-management]
exercises: 3
---

## Overview
Opsgenie is Atlassian's alert management and on-call scheduling platform. At its core it answers two questions: who is on call right now, and what happens if they don't respond? In DevOps teams, Opsgenie sits between monitoring tools (Prometheus, Datadog, Grafana) and the humans who fix things. Understanding schedules and escalation policies is the foundation — everything else (integrations, routing, incidents) builds on top of this.

## Concepts

### Teams and Users

**Users** are individuals with an Opsgenie account. Each user has:
- Contact methods: phone, SMS, email, mobile push (configured in profile).
- Notification rules: personal preference for how and when to be notified (e.g., "during business hours: email only; outside hours: phone call if not acknowledged in 5 minutes").
- Role: Admin, User, Stakeholder, or Read Only.

**Teams** group users around a service or function. A team:
- Owns one or more escalation policies.
- Has its own alert queue.
- Can own integrations (alerts from a specific source route to a specific team's queue).

Teams are the organisational unit for routing. When an alert is routed to Team A, Opsgenie uses Team A's escalation policy to decide who to notify.

Navigate to: **Teams → [Team Name] → Members / On-call / Schedules / Escalation Policies**

### Schedule Types

A **schedule** defines a rotation — who is on call and when. Schedules consist of **rotations**, and each rotation defines:

- **Participants**: users or teams to include.
- **Rotation type**: how participants cycle.
- **Start date and time**.
- **Rotation length**: how long before the schedule cycles to the next participant.

#### Weekly Rotation
The most common. Each participant is on call for a full week.

```
Week 1: Alice
Week 2: Bob
Week 3: Carol
→ repeat
```

**Schedule time restriction**: limit the schedule to certain hours (e.g., Mon–Fri 09:00–17:00) so the rotation only applies during business hours.

#### Daily Rotation
Participants rotate every day. Suitable for high-traffic services where a week of on-call is too long.

```
Mon: Alice
Tue: Bob
Wed: Carol
Thu: Alice
...
```

#### Follow-the-Sun (Timezone-based)
For global teams, follow-the-sun uses multiple rotations within the same schedule, each restricted to a geographic timezone's business hours. Participants in each timezone cover their own business day.

```
Rotation 1: EU team (07:00–16:00 UTC)
Rotation 2: US East team (14:00–23:00 UTC)
Rotation 3: Asia-Pacific team (23:00–07:00 UTC)
→ No gaps; always covered
```

In Opsgenie, implement this by creating one schedule with three rotations, each with a **time restriction** and a different participant list.

#### Custom Rotation Length
Set any rotation length: 12 hours, 3 days, 2 weeks. Useful for services with lighter on-call loads or unusual team structures.

### Override Management
**Overrides** temporarily replace a scheduled participant with someone else. Use cases:
- A team member is on vacation.
- Swapping shifts between two engineers.
- Adding extra coverage during a planned event (product launch, Black Friday).

Creating an override: **Schedules → [Schedule Name] → Add Override**
- Select replacement user.
- Set start and end time.
- The override appears in the schedule timeline with a different colour.

Overrides are visible on the schedule calendar and via the API. They are also reported in on-call analytics, so time-tracking and fairness reporting remains accurate.

Who-is-on-call API:

```bash
curl -X GET "https://api.opsgenie.com/v2/schedules/my-schedule/on-calls" \
  -H "Authorization: GenieKey YOUR_API_KEY"
```

### Escalation Policies
An **escalation policy** defines what happens when an alert is not acknowledged within a time limit. It is the "if nobody responds, then…" logic.

An escalation policy consists of one or more **steps**:

```
Step 1: Notify [on-call person from schedule]     — wait 5 minutes
Step 2: Notify [backup on-call / next in rotation] — wait 10 minutes
Step 3: Notify [team lead]                          — wait 15 minutes
Step 4: Notify [VP Engineering]                    — wait 20 minutes
```

Each step specifies:
- **Who to notify**: on-call from a schedule, a specific user, a team, or all team members.
- **Notify via**: any combination of contact methods (default is per-user notification rules).
- **Wait time**: how long to wait before escalating if the alert is not acknowledged.

**Auto-close escalation**: optionally stop escalating after a set time (e.g., if no response after 30 minutes, close the alert and create a post-mortem task). Rarely used in production — most teams prefer to escalate to a VP or emergency contact rather than auto-close.

Configuration: **Teams → [Team Name] → Escalation Policies → Add Escalation Policy**

### On-Call Participant Rules
Within a schedule rotation, you can define **participant rules**:

- **None**: notify all participants simultaneously (not a rotation — more of a broadcast).
- **One at a time (rotation)**: standard rotation, one person at a time.
- **Random**: randomly select from the list.

For escalation steps that target "on-call from schedule", Opsgenie evaluates the schedule at the moment of escalation and uses the currently on-call participant.

### Schedule Gaps
A **gap** occurs when no one is scheduled for a time slot. Gaps mean alerts during that window will not notify anyone — a dangerous condition.

Gap scenarios:
- A rotation ends and the next one hasn't started.
- A timezone restriction leaves hours uncovered.
- All participants are removed from a rotation without replacements.

Opsgenie warns about gaps in the schedule UI with a visual indicator. Review gaps before they occur:

**Schedules → [Schedule Name] → Timeline view** — gaps appear as empty (white) periods.

Mitigation: add a fallback rotation with the team lead as participant with no time restriction, placed after all primary rotations. This catches any gaps.

### Notification Methods and Priority
Each user configures their personal notification preferences under **Profile → Notification Rules**. Typical setup:

```
Priority P1 / P2 alerts:
  - Immediately: push notification
  - If not acknowledged in 3 min: phone call

Priority P3 / P4 alerts:
  - Immediately: email + push notification

Priority P5 (informational):
  - Email only
```

The separation between priority-based notification rules and escalation policies is important: escalations determine *who* gets notified over time, while notification rules determine *how* the individual is notified.

## Examples

### Follow-the-sun schedule configuration

```
Schedule: "Platform Team - Global"

Rotation 1: EU Coverage
  Participants: alice@co.com, bob@co.com
  Rotation type: Weekly
  Start: Monday 07:00 UTC
  Restrictions: Mon–Fri 07:00–15:00 UTC

Rotation 2: US East Coverage
  Participants: carol@co.com, dave@co.com
  Rotation type: Weekly
  Start: Monday 13:00 UTC
  Restrictions: Mon–Fri 13:00–22:00 UTC

Rotation 3: Weekend Fallback
  Participants: alice@co.com (team lead)
  Rotation type: Weekly
  Start: Saturday 00:00 UTC
  Restrictions: Sat–Sun 00:00–23:59 UTC
```

### Escalation policy for a P1 alert

```
Policy name: "Platform - P1 Escalation"

Step 1 (0 min): Notify on-call from "Platform Team - Global" schedule
Step 2 (5 min): Notify on-call from "Platform Team - Global" schedule (re-notify)
Step 3 (10 min): Notify user: platform-lead@co.com (direct, phone call)
Step 4 (20 min): Notify team: Engineering Leadership (all members)
Repeat: 3 times if still unacknowledged, then keep open
```

### Checking schedule via Opsgenie API

```bash
# Get current on-call for a named schedule
curl -X GET \
  "https://api.opsgenie.com/v2/schedules/platform-global/on-calls?scheduleIdentifierType=name&flat=true" \
  -H "Authorization: GenieKey YOUR_API_KEY" | jq '.data.onCallParticipants'

# List all overrides for a schedule
curl -X GET \
  "https://api.opsgenie.com/v2/schedules/platform-global/overrides" \
  -H "Authorization: GenieKey YOUR_API_KEY"
```

## Exercises

1. Design an on-call schedule for a 5-person SRE team (3 in London, 2 in New York) running a 24/7 production service. Specify: rotation type for each geographic group, time restrictions, how weekend coverage is handled, and how gaps are avoided. Draw the schedule as a weekly table showing who is on call for each time block.

2. Write the escalation policy for a critical payment processing service. Requirements: P1 alerts must reach a human within 5 minutes; if unacknowledged at 5 minutes escalate to the backup; at 15 minutes escalate to the engineering manager; never auto-close. Specify each step with wait times, who is notified, and via what method.

3. An on-call engineer is going on vacation for 10 days next month. Describe the full process to create an override in Opsgenie: what fields you'd fill in, how you'd verify the override was applied correctly in the schedule UI, and how you'd use the API to confirm the replacement engineer would have been returned for a query during that vacation window.

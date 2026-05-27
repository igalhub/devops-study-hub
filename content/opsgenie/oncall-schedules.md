---
title: On-Call Schedules & Escalations
module: opsgenie
duration_min: 20
difficulty: beginner
tags: [opsgenie, on-call, schedules, escalation, incident-management]
exercises: 3
---

## Overview

Opsgenie is Atlassian's alert management and on-call scheduling platform. At its core it answers two questions: who is on call right now, and what happens if they don't respond? In DevOps teams, Opsgenie sits between monitoring tools (Prometheus, Datadog, Grafana) and the humans who fix things. Without a system like Opsgenie, alerts land in a shared inbox or Slack channel where diffusion of responsibility is almost guaranteed — everyone assumes someone else saw it. Opsgenie solves this by making accountability explicit: a specific person is on call, they have a deadline to respond, and if they miss it, a defined chain of escalation fires automatically.

The design philosophy is separation of concerns: *schedules* answer "who is available when," *escalation policies* answer "what happens when no one responds," and *routing rules* answer "which team owns this alert." These three concepts compose to handle arbitrarily complex organizational structures. A small startup might have one schedule and one escalation policy. A large enterprise might have hundreds, but each is built from the same primitives. This modularity means you can change one piece — swap a rotation type, add an escalation step — without rebuilding everything else.

In the broader DevOps toolchain, Opsgenie is the last mile between detection and response. Prometheus fires an alert; Alertmanager routes it to Opsgenie; Opsgenie determines the on-call engineer and notifies them. It integrates with incident management (Jira, PagerDuty-style incident timelines), communication tools (Slack, Microsoft Teams), and runbook systems so that when an engineer is paged, they receive context alongside the notification. Mastering schedules and escalation policies is the foundation — everything else in Opsgenie assumes you have these configured correctly.

---

## Concepts

### Teams and Users

**Users** are individuals with an Opsgenie account. Each user has:

| Attribute | Description |
|-----------|-------------|
| **Contact methods** | Phone, SMS, email, mobile push — configured in user profile |
| **Notification rules** | Personal rules for *how* and *when* to be notified per priority level |
| **Role** | Admin, User, Stakeholder, or Read Only |
| **Time zone** | Used to display schedule times and apply notification rules correctly |

**Teams** group users around a service or function and are the primary routing unit in Opsgenie. When an alert arrives, it is routed to a team, which then applies that team's escalation policy. A team owns:

- One or more escalation policies
- One or more schedules
- Its own alert queue
- Integrations (alerts from a specific monitoring source can route directly to a specific team)

Navigate to: **Teams → [Team Name] → Members / On-call / Schedules / Escalation Policies**

**Gotcha:** A user can belong to multiple teams, but their notification rules are global — the same rules apply regardless of which team's alert reaches them. If a user wants different notification behavior for different services, the workaround is creating separate Opsgenie accounts, which is rarely worth the overhead. Design notification rules to cover the most critical scenario.

---

### Schedule Structure

A **schedule** is a named object that, at any given moment, resolves to a set of on-call participants. A schedule is made up of one or more **rotations**. Understanding this two-level structure is critical.

```
Schedule: "Platform Team - Global"
├── Rotation 1: EU Business Hours
│     participants: [alice, bob]
│     type: weekly
│     restriction: Mon–Fri 07:00–15:00 UTC
├── Rotation 2: US East Business Hours
│     participants: [carol, dave]
│     type: weekly
│     restriction: Mon–Fri 14:00–22:00 UTC
└── Rotation 3: Fallback (no restriction)
      participants: [team-lead]
      type: weekly
```

When Opsgenie evaluates who is on call, it looks at all active rotations at the current moment. If multiple rotations overlap, all matching participants are considered on call simultaneously. The escalation policy then determines which of those participants to notify first.

**Key schedule properties:**

| Property | What it controls |
|----------|-----------------|
| **Rotation type** | How participants cycle (daily, weekly, custom) |
| **Rotation length** | Duration before advancing to the next participant |
| **Time restriction** | Hours/days during which this rotation is active |
| **Start date/time** | When the rotation begins; determines who is "first" in the cycle |
| **Participants** | Ordered list of users or groups |

---

### Rotation Types

#### Weekly Rotation
The most common rotation. Each participant is on call for one full week before the cycle advances.

```
Week 1 (Mon 00:00 – Sun 23:59): Alice
Week 2 (Mon 00:00 – Sun 23:59): Bob
Week 3 (Mon 00:00 – Sun 23:59): Carol
→ repeat
```

Best for teams with three or more members where a week of on-call is manageable. The fatigue trade-off: less context-switching, but seven consecutive days of responsibility.

#### Daily Rotation
Participants rotate every 24 hours. Good for high-traffic services or teams that want to distribute load more evenly.

```
Mon: Alice
Tue: Bob
Wed: Carol
Thu: Alice
Fri: Bob
...
```

**Gotcha:** Daily rotations create more handoff points. Ensure your runbooks and incident context are well-documented — whoever picks up on Tuesday shouldn't need to phone whoever was on Monday to understand ongoing issues.

#### Follow-the-Sun
Not a distinct rotation type in the UI — it's a *pattern* implemented by combining multiple rotations with time restrictions in a single schedule. Each rotation covers one geographic region's business hours, creating continuous 24/7 coverage with no single engineer working outside their local day.

```
Rotation 1: EU (07:00–15:00 UTC)   → alice, bob alternate weekly
Rotation 2: US East (14:00–22:00 UTC) → carol, dave alternate weekly
Rotation 3: APAC (22:00–07:00 UTC) → eve, frank alternate weekly
```

The one-hour overlaps (14:00–15:00, 22:00–23:00) are intentional — they create a handoff window where both outgoing and incoming engineers are nominally available.

#### Custom Rotation Length
Set any duration: 12 hours, 3 days, 2 weeks. Useful for:
- 12-hour shifts on a small team that wants day/night split
- 2-week rotations when the on-call load is very low

```
Custom example — 12-hour split:
  Shift A: Mon–Sun 06:00–18:00 UTC → Alice (day shift)
  Shift B: Mon–Sun 18:00–06:00 UTC → Bob (night shift)
```

---

### Schedule Gaps

A **gap** occurs when no rotation is active for a time window. Alerts during a gap will not notify anyone. This is a silent failure — Opsgenie will not error; it simply has no one to notify.

**Common gap causes:**

| Cause | Example |
|-------|---------|
| Time restriction leaves hours uncovered | Rotation set to Mon–Fri 09:00–17:00 with no weekend coverage |
| All participants removed from a rotation | Rotation still exists but participant list is empty |
| Rotation end date reached | Rotation was set with an expiry that passed |
| Override applied but replacement not covering full window | Override ends at 18:00; schedule resumes at 09:00 next day — 15-hour gap |

**How to detect gaps:** Open **Schedules → [Schedule Name] → Timeline view**. Gaps appear as empty (white or greyed-out) periods with no participant label. Opsgenie also displays a warning banner on the schedule if gaps exist within the next 30 days.

**Mitigation pattern — fallback rotation:**

```
Add a final rotation with:
  Participant: [team-lead or on-call manager]
  Time restriction: none (covers all hours)
  Rotation type: weekly (single participant, always the same person)
  Priority: lowest (only activates when no other rotation matches)
```

Because rotations within a schedule are evaluated in order, a fallback rotation at the bottom with no time restriction catches anything the primary rotations miss.

---

### Override Management

An **override** temporarily replaces a scheduled participant without modifying the underlying rotation. This is the correct mechanism for vacations, shift swaps, and event coverage.

**Override fields:**

| Field | Description |
|-------|-------------|
| **User** | The replacement (who will be on call instead) |
| **Start time** | When the override begins (inclusive) |
| **End time** | When the override ends (exclusive) |
| **Alias** | Optional label for the override (e.g., "Alice vacation") |

Navigate to: **Schedules → [Schedule Name] → Add Override**

Overrides are visible in the schedule timeline (displayed in a distinct color) and are included in on-call analytics — so fairness reporting and compensation calculations remain accurate even when shifts are swapped.

**API: create an override**

```bash
# Create an override: replace alice with carol from Dec 20 to Dec 30
curl -X POST "https://api.opsgenie.com/v2/schedules/platform-global/overrides" \
  -H "Authorization: GenieKey YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "type": "user",
      "username": "carol@company.com"
    },
    "startDate": "2024-12-20T00:00:00Z",
    "endDate": "2024-12-30T00:00:00Z",
    "alias": "alice-vacation-dec"
  }'
```

**API: verify who is on call at a future date**

```bash
# Check who would be on call on Dec 25 at 14:00 UTC
curl -X GET \
  "https://api.opsgenie.com/v2/schedules/platform-global/on-calls?scheduleIdentifierType=name&flat=true&date=2024-12-25T14:00:00Z" \
  -H "Authorization: GenieKey YOUR_API_KEY" | jq '.data.onCallParticipants'
```

Expected output if override is correctly applied:
```json
[
  {
    "name": "Carol Smith",
    "type": "user"
  }
]
```

**Gotcha:** Overrides do not cascade through escalation policies. If your escalation policy says "notify on-call from schedule," it picks up the override correctly. But if your escalation policy hardcodes a specific user's name (e.g., "notify alice@company.com"), the override has no effect — Alice still gets paged even while on vacation. Always reference schedules in escalation steps, not individual users, for vacation coverage to work automatically.

---

### Escalation Policies

An **escalation policy** defines what happens when an alert is not acknowledged within a time window. It is the "if nobody responds, then…" chain. Every alert routed to a team triggers that team's escalation policy.

**Escalation policy structure:**

```
Policy: "Platform - P1 Escalation"
│
├─ Step 1 [at 0 min]:  Notify on-call from schedule "platform-global"
│                       via: push notification + SMS
├─ Step 2 [at 5 min]:  Notify on-call from schedule "platform-global"
│                       via: phone call (re-notify same person, different method)
├─ Step 3 [at 10 min]: Notify user: platform-lead@company.com
│                       via: phone call
├─ Step 4 [at 20 min]: Notify team: Engineering Leadership (all members)
│                       via: push + phone call
│
└─ Repeat policy: 3 times, then keep alert open (never auto-close)
```

**Step configuration options:**

| Field | Options |
|-------|---------|
| **Notify** | On-call from schedule, specific user, team (all members), team (on-call only) |
| **Via** | Default (user's own notification rules), or override with specific methods |
| **Wait before next step** | Minutes to wait for acknowledgment before escalating |

**Escalation repeat:** After all steps complete without acknowledgment, the policy can repeat (notify all steps again) up to N times. After repeats are exhausted, the alert remains open but escalation stops. Never configure auto-close for production services — a silent unacknowledged alert is worse than an annoying ongoing one.

**Gotcha:** The wait time in each step is measured from the *previous step*, not from the alert creation time. Step 1 fires at 0 min. Step 2 fires 5 min later (5 min total). Step 3 fires 10 min after step 2 (15 min total). Read your policy's cumulative times carefully, especially in an SLA context where you've promised "P1 alert reaches a human within 10 minutes."

---

### Notification Methods and Priority

Each user configures personal notification rules under **Profile → Notification Rules**. These rules are independent of escalation policies — they control *how* an individual is contacted, not *when* or *who*.

**Typical notification rule setup:**

```
For alerts with priority P1 or P2:
  Immediately:           mobile push notification
  If not ack in 2 min:  SMS
  If not ack in 4 min:  phone call

For alerts with priority P3 or P4:
  Immediately:           email + mobile push notification

For alerts with priority P5 (informational):
  Immediately:           email only
```

**Alert priority mapping:**

| Priority | Typical use | Expected response |
|----------|-------------|-------------------|
| P1 | Customer-facing outage, data loss | Immediate, any time |
| P2 | Degraded performance, partial outage | Within 15 minutes |
| P3 | Non-customer-facing, recoverable | Business hours |
| P4 | Warning, investigate soon | Best effort |
| P5 | Informational | No action required |

**Separation of concerns — the key mental model:**

- **Escalation policy** = *who* gets notified and *when* (the chain of responsibility over time)
- **Notification rules** = *how* each person is reached (phone vs. push vs. email, per priority)

This separation means you can update how a person is contacted without touching the escalation policy, and you can restructure team responsibility chains without touching individual notification preferences.

**Gotcha:** If an escalation step is configured with an explicit contact method override (e.g., "always phone call"), it bypasses the user's personal notification rules entirely. Use this sparingly — it removes the user's ability to tune their own experience.

---

### On-Call Participant Rules Within Rotations

When a rotation has multiple participants and an escalation step targets "on-call from schedule," exactly one participant is on call at any moment (the current rotation slot). However, you can configure the rotation to present participants differently:

| Mode | Behavior | Use case |
|------|----------|----------|
| **One at a time (default)** | Single participant on call per rotation slot | Standard weekly/daily rotation |
| **All participants simultaneously** | Everyone in the rotation is on call at once | Broadcast coverage, small critical teams |
| **Random** | One participant selected randomly each period | Load distribution, unpredictable assignment |

For most production services, use "one at a time." Simultaneous mode is occasionally useful for a small leadership team where any executive should be reachable, but it creates ambiguity about who is *responsible*.

---

## Examples

### Example 1: Follow-the-Sun Schedule Configuration

A platform team with engineers in London and New York wants continuous 24/7 coverage. Weekend coverage falls to a rotating lead.

```
Schedule name: "Platform Team - Global"

─── Rotation 1: EU Business Hours ───────────────────────────────
  Participants (in order): alice@company.com, bob@company.com
  Rotation type: Weekly
  Rotation start: 2024-01-01 Monday 07:00 UTC
  Time restriction: Mon–Fri  07:00–15:00 UTC
  # Alice covers week 1; Bob covers week 2; repeat.
  # Ends at 15:00 UTC (16:00 London time) — engineers finish their day.

─── Rotation 2: US East Business Hours ──────────────────────────
  Participants (in order): carol@company.com, dave@company.com
  Rotation type: Weekly
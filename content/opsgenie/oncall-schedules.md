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

**Gotcha:** The start date and time of a rotation directly determines which participant is "slot 1." If you create a weekly rotation starting on a Wednesday, the first participant owns that Wednesday through the following Tuesday. Misaligning the start date is the most common cause of the wrong engineer being on call at the start of a new rotation cycle. Always verify using **Schedules → Timeline** after creation.

---

### Rotation Types

#### Weekly Rotation
The most common rotation. Each participant is on call for one full week before the cycle advances.

```
Week 1 (Mon 00:00 – Sun 23:59 UTC): Alice
Week 2 (Mon 00:00 – Sun 23:59 UTC): Bob
Week 3 (Mon 00:00 – Sun 23:59 UTC): Carol
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

**Gotcha:** Daily rotations create more handoff points. Ensure your runbooks and incident context are well-documented — whoever picks up on Tuesday shouldn't need to phone whoever was on Monday to understand ongoing issues. Pair daily rotations with a mandatory end-of-shift summary in your incident management tool.

#### Follow-the-Sun
Not a distinct rotation type in the UI — it's a *pattern* implemented by combining multiple rotations with time restrictions in a single schedule. Each rotation covers one geographic region's business hours, creating continuous 24/7 coverage with no single engineer working outside their local day.

```
Rotation 1: EU        (07:00–15:00 UTC) → alice, bob alternate weekly
Rotation 2: US East   (14:00–22:00 UTC) → carol, dave alternate weekly
Rotation 3: APAC      (22:00–07:00 UTC) → eve, frank alternate weekly
```

The one-hour overlaps (14:00–15:00, 22:00–23:00) are intentional — they create a handoff window where both outgoing and incoming engineers are nominally available.

#### Custom Rotation Length
Set any duration: 12 hours, 3 days, 2 weeks. Useful for:
- 12-hour shifts on a small team that wants day/night split
- 2-week rotations when the on-call load is very low

```
Custom example — 12-hour split:
  Shift A: Mon–Sun 06:00–18:00 UTC → Alice (day shift)
  Shift B: Mon–Sun 18:00–06:00 UTC → Bob  (night shift)
```

**Comparison of rotation types:**

| Type | Cadence | Best for | Watch out for |
|------|---------|----------|---------------|
| Weekly | 7 days | Teams ≥ 3, moderate load | 7-day fatigue, holiday week |
| Daily | 24 hours | High alert volume, large teams | Handoff quality, context loss |
| Follow-the-Sun | Regional hours | Globally distributed teams | Gap between regions if misconfigured |
| Custom | Any interval | Niche shift structures | Complex cycle math, misaligned start dates |

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
  Purpose: catch-all for any hour not covered by primary rotations
```

Because rotations within a schedule are evaluated together, a fallback rotation with no time restriction ensures someone is always on call. The escalation policy's step ordering still controls who is notified first when multiple rotations overlap — the fallback doesn't jump the queue, it just fills the void.

**API: check for gaps programmatically**

```bash
# Retrieve the on-call timeline for the next 7 days
# and look for periods where onCallParticipants is empty
curl -X GET \
  "https://api.opsgenie.com/v2/schedules/platform-global/timeline?scheduleIdentifierType=name&intervalUnit=days&interval=7" \
  -H "Authorization: GenieKey YOUR_API_KEY" | \
  jq '.data.finalTimeline.rotations[].periods[] | select(.recipient == null) | .startDate, .endDate'
```

An empty response means no gaps were found. Any output indicates a gap and the time window it covers.

---

### Override Management

An **override** temporarily replaces a scheduled participant without modifying the underlying rotation. This is the correct mechanism for vacations, shift swaps, and event coverage.

**Override fields:**

| Field | Description |
|-------|-------------|
| **User** | The replacement (who will be on call instead) |
| **Start time** | When the override begins (inclusive) |
| **End time** | When the override ends (exclusive) |
| **Alias** | Optional label for the override (e.g., "alice-vacation-dec") |

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

**API: list all active overrides**

```bash
# List overrides currently in effect for the schedule
curl -X GET \
  "https://api.opsgenie.com/v2/schedules/platform-global/overrides?scheduleIdentifierType=name" \
  -H "Authorization: GenieKey YOUR_API_KEY" | jq '.data[] | {alias: .alias, user: .user.username, start: .startDate, end: .endDate}'
```

**Gotcha:** Overrides do not cascade through escalation policies. If your escalation policy references "on-call from schedule," it picks up the override correctly. But if your escalation policy hardcodes a specific user's name (e.g., "notify alice@company.com"), the override has no effect — Alice still gets paged even while on vacation. **Always reference schedules in escalation steps, not individual users**, for vacation coverage to work automatically.

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

**Escalation repeat:** After all steps complete without acknowledgment, the policy can repeat (notify all steps again) up to N times. After repeats are exhausted, the alert remains open but escalation stops. **Never configure auto-close for production services** — a silent unacknowledged alert is worse than an annoying ongoing one.

**Gotcha:** The wait time in each step is measured from the *previous step firing*, not from alert creation. Step 1 fires at 0 min. Step 2 fires 5 min later (5 min total elapsed). Step 3 fires 10 min after step 2 (15 min total elapsed). Read your policy's cumulative times carefully, especially when you've promised SLA-level commitments like "P1 alert reaches a human within 10 minutes." In the example above, the manager is called at 15 minutes — that violates a 10-minute SLA.

**Escalation policy per priority (recommended pattern):**

Rather than a single policy, create one per alert priority:

| Policy name | Step 1 wait | Step 2 target | Step 3 target | Repeat |
|-------------|-------------|---------------|---------------|--------|
| P1-Critical | 0 min | On-call (5 min) | Manager (10 min) | 3x |
| P2-High | 0 min | On-call (10 min) | Team lead (20 min) | 2x |
| P3-Medium | 0 min | On-call (30 min) | — | 1x |
| P4-Low | 0 min | — | — | 0x (no repeat) |

Wire this up in routing rules: alerts with `priority: P1` route to the P1-Critical policy, and so on. This prevents a disk-space warning from calling your VP of Engineering at 3am.

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

**Gotcha:** If an escalation step is configured with an explicit contact method override (e.g., "always phone call regardless of user rules"), it bypasses the user's personal notification rules entirely. Use this sparingly and only for the most critical escalation steps. It removes the user's ability to tune their own experience and can cause alert fatigue if overused — engineers who can't customize notifications are more likely to disable them.

---

### Routing Rules

**Routing rules** are the bridge between an incoming alert and the team + escalation policy that handles it. They evaluate alert properties (source, priority, tags, message content) and direct the alert accordingly.

```
Routing Rule: "Production Alerts → Platform Team"
  Condition:  alert.tags contains "env:production"
  AND         alert.source == "prometheus"
  Route to:   Platform Team → P1-Critical escalation policy

Routing Rule: "Staging Alerts → Platform Team (low priority)"
  Condition:  alert.tags contains "env:staging"
  Route to:   Platform Team → P3-Medium escalation policy

Routing Rule: "Default (catch-all)"
  Condition:  (none — matches everything)
  Route to:   Platform Team → P2-High escalation policy
```

**Routing rule evaluation order matters.** Rules are evaluated top-to-bottom and the first match wins. Place the most specific rules at the top and the catch-all at the bottom.

**Gotcha:** If no routing rule matches and there is no catch-all, the alert is routed to the **default team's default escalation policy** — not silently dropped, but potentially misrouted. Always add a catch-all routing rule at the bottom of every team's ruleset so unexpected alerts go somewhere deliberate.

---

### On-Call Participant Modes Within Rotations

When a rotation has multiple participants and an escalation step targets "on-call from schedule," exactly one participant is on call at any moment (the current rotation slot) by default. However, you can configure the rotation to behave differently:

| Mode | Behavior | Use case |
|------|----------|----------|
| **One at a time (default)** | Single participant on call per rotation slot | Standard weekly/daily rotation |
| **All participants simultaneously** | Everyone in the rotation is on call at once | Broadcast coverage, small critical teams |
| **Random** | One participant selected randomly each period | Load distribution, unpredictable assignment |

For most production services, use "one at a time." Simultaneous mode is occasionally useful for a small leadership team where any executive should be reachable, but it creates ambiguity about who is *responsible* — when everyone is on call, no one feels fully accountable. If you use simultaneous mode, your escalation policy must be explicit about who acknowledges.

---

## Examples

### Example 1: Follow-the-Sun Schedule via API

A platform team with engineers in London (EU) and New York (US East) wants continuous 24/7 weekday coverage. A team lead handles weekends.

```bash
# Step 1: Create the schedule shell
curl -X POST "https://api.opsgenie.com/v2/schedules" \
  -H "Authorization: GenieKey YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Platform Team - Global",
    "description": "Follow-the-sun coverage for platform engineering",
    "timezone": "UTC",
    "enabled": true,
    "ownerTeam": {
      "name": "Platform Team"
    },
    "rotations": [
      {
        "name": "EU Business Hours",
        "startDate": "2024-01-01T07:00:00Z",
        "type": "weekly",
        "length": 1,
        "participants": [
          {"type": "user", "username": "alice@company.com"},
          {"type": "user", "username": "bob@company.com"}
        ],
        "timeRestriction": {
          "type": "weekday-and-time-of-day",
          "restrictions": [
            {"day": "monday",    "startHour": 7,  "startMin": 0, "endHour": 15, "endMin": 0},
            {"day": "tuesday",   "startHour": 7,  "startMin": 0, "endHour": 15, "endMin": 0},
            {"day": "wednesday", "startHour": 7,  "startMin": 0, "endHour": 15, "endMin": 0},
            {"day": "thursday",  "startHour": 7,  "startMin": 0, "endHour": 15, "endMin": 0},
            {"day": "friday",    "startHour": 7,  "startMin": 0, "endHour": 15, "endMin": 0}
          ]
        }
      },
      {
        "name": "US East Business Hours",
        "startDate": "2024-01-01T14:00:00Z",
        "type": "weekly",
        "length": 1,
        "participants": [
          {"type": "user", "username": "carol@company.com"},
          {"type": "user", "username": "dave@company.com"}
        ],
        "timeRestriction": {
          "type": "weekday-and-time-of-day",
          "restrictions": [
            {"day": "monday",    "startHour": 14, "startMin": 0, "endHour": 22, "endMin": 0},
            {"day": "tuesday",   "startHour": 14, "startMin": 0, "endHour": 22, "endMin": 0},
            {"day": "wednesday", "startHour": 14, "startMin": 0, "endHour": 22, "endMin": 0},
            {"day": "thursday",  "startHour": 14, "startMin": 0, "endHour": 22, "endMin": 0},
            {"day": "friday",    "startHour": 14, "startMin": 0, "endHour": 22, "endMin": 0}
          ]
        }
      },
      {
        "name": "Fallback - All Hours",
        # No timeRestriction — covers nights, weekends, and any gap the regional rotations miss
        "startDate": "2024-01-01T00:00:00Z",
        "type": "weekly",
        "length": 1,
        "participants": [
          {"type": "user", "username": "teamlead@company.com"}
        ]
      }
    ]
  }'

# Step 2: Verify EU rotation is active on a Monday morning
curl -X GET \
  "https://api.opsgenie.com/v2/schedules/Platform%20Team%20-%20Global/on-calls?scheduleIdentifierType=name&flat=true&date=2024-01-08T09:00:00Z" \
  -H "Authorization: GenieKey YOUR_API_KEY" | jq '.data.onCallParticipants[].name'
# Expected: "Alice Johnson" (week 2 of EU rotation)

# Step 3: Verify fallback is active at weekend midnight
curl -X GET \
  "https://api.opsgenie.com/v2/schedules/Platform%20Team%20-%20Global/on-calls?scheduleIdentifierType=name&flat=true&date=2024-01-06T02:00:00Z" \
  -H "Authorization: GenieKey YOUR_API_KEY" | jq '.data.onCallParticipants[].name'
# Expected: "Team Lead" (fallback rotation, Saturday 02:00 UTC)
```

The 14:00–15:00 UTC overlap between EU and US East rotations means both the outgoing EU engineer and the incoming US East engineer are technically on call simultaneously — a deliberate handoff window. The escalation policy should target the schedule (not individual users) so it automatically picks up whoever the current slot owner is.

---

### Example 2: Multi-Step Escalation Policy with Priority Tiers

This example creates two escalation policies — one for P1 and one for P3 — and wires them to the schedule from Example 1.

```bash
# Create P1 escalation policy: aggressive, short windows
curl -X POST "https://api.opsgenie.com/v2/escalations" \
  -H "Authorization: GenieKey YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Platform - P1 Critical",
    "description": "Customer-facing outage escalation chain",
    "ownerTeam": {"name": "Platform Team"},
    "rules": [
      {
        "condition": "if-not-acked",
        "notifyType": "default",
        "delay": {"timeAmount": 0, "timeUnit": "minutes"},
        "recipient": {
          "type": "schedule",
          "name": "Platform Team - Global"
        }
      },
      {
        "condition": "if-not-acked",
        "notifyType": "default",
        "delay": {"timeAmount": 5, "timeUnit": "minutes"},
        "recipient": {
          "type": "schedule",
          "name": "Platform Team - Global"
        }
      },
      {
        # Manager call at 10 min total elapsed (5+5). Hardcoded user is acceptable
        # for a manager escalation — managers do not rotate, so override risk is low.
        "condition": "if-not-acked",
        "notifyType": "default",
        "delay": {"timeAmount": 5, "timeUnit": "minutes"},
        "recipient": {
          "type": "user",
          "username": "vp-engineering@company.com"
        }
      }
    ],
    "repeat": {
      "waitInterval": 15,
      "count": 3,
      "resetRecipientStates": true,
      "closeAlertAfterAll": false   # Never auto-close production alerts
    }
  }'

# Create P3 escalation policy: relaxed, single step
curl -X POST "https://api.opsgenie.com/v2/escalations" \
  -H "Authorization: GenieKey YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Platform - P3 Medium",
    "description": "Non-critical alert — notify once, no repeat",
    "ownerTeam": {"name": "Platform Team"},
    "rules": [
      {
        "condition": "if-not-acked",
        "notifyType": "default",
        "delay": {"timeAmount": 0, "timeUnit": "minutes"},
        "recipient": {
          "type": "schedule",
          "name": "Platform Team - Global"
        }
      }
    ],
    "repeat": {
      "waitInterval": 60,
      "count": 1,
      "resetRecipientStates": false,
      "closeAlertAfterAll": false
    }
  }'

# Verify: list escalation policies for the team
curl -X GET \
  "https://api.opsgenie.com/v2/escalations?teamId=TEAM_ID_HERE" \
  -H "Authorization: GenieKey YOUR_API_KEY" | jq '.data[] | {name: .name, steps: (.rules | length)}'
# Expected output:
# {"name": "Platform - P1 Critical", "steps": 3}
# {"name": "Platform - P3 Medium",   "steps": 1}
```

---

### Example 3: Automated Override for a Holiday Blackout Period

A script that reads a CSV of planned time-off and creates Opsgenie overrides in bulk. Useful for managing a whole quarter of vacation schedules at once.

```bash
#!/usr/bin/env bash
# bulk_overrides.sh
# CSV format: schedule_name,replacement_user,start_iso8601,end_iso8601,alias
# Example row: Platform Team - Global,carol@company.com,2024-12-23T00:00:00Z,2024-12-27T00:00:00Z,alice-xmas

API_KEY="${OPSGENIE_API_KEY:?Must set OPSGENIE_API_KEY}"
CSV_FILE="${1:?Usage: $0 overrides.csv}"

while IFS=',' read -r schedule replacement start end alias; do
  # Skip header line
  [[ "$schedule" == "schedule_name" ]] && continue

  echo "Creating override: $alias ($replacement covers $start → $end)"

  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://api.opsgenie.com/v2/schedules/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$schedule'))")/overrides" \
    -H "Authorization: GenieKey $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"user\": {\"type\": \"user\", \"username\": \"$replacement\"},
      \"startDate\": \"$start\",
      \"endDate\": \"$end\",
      \"alias\": \"$alias\"
    }")

  if [[ "$RESPONSE" == "201" ]]; then
    echo "  ✓ Created successfully"
  else
    echo "  ✗ Failed with HTTP $RESPONSE — check schedule name and user email"
  fi

done < "$CSV_FILE"
```

```csv
# overrides.csv
schedule_name,replacement_user,start_iso8601,end_iso8601,alias
Platform Team - Global,carol@company.com,2024-12-23T00:00:00Z,2024-12-27T00:00:00Z,alice-xmas
Platform Team - Global,dave@company.com,2024-12-28T00:00:00Z,2025-01-02T00:00:00Z,bob-newyear
```

```bash
# Run the script
chmod +x bulk_overrides.sh
export OPSGENIE_API_KEY="your_key_here"
./bulk_overrides.sh overrides.csv

# Verify: check who is on call on Dec 25
curl -s "https://api.opsgenie.com/v2/schedules/Platform%20Team%20-%20Global/on-calls?scheduleIdentifierType=name&flat=true&date=2024-12-25T12:00:00Z" \
  -H "Authorization: GenieKey $OPSGENIE_API_KEY" | jq '.data.onCallParticipants[].name'
# Expected: "Carol Smith"
```

---

### Example 4: Prometheus Alertmanager → Opsgenie Integration

Connect an existing Alertmanager deployment to route alerts into Opsgenie with the correct priority mapping.

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: 'opsgenie-default'
  routes:
    # P1: Any alert tagged severity=critical goes to the critical receiver
    - match:
        severity: critical
      receiver: 'opsgenie-p1'
      continue: false

    # P3: warnings route to low-priority receiver
    - match:
        severity: warning
      receiver: 'opsgenie-p3'
      continue: false

receivers:
  - name: 'opsgenie-p1'
    opsgenie_configs:
      - api_key: '<YOUR_OPSGENIE_API_KEY>'
        # api_url defaults to https://api.opsgenie.com/ — override for EU: https://api.eu.opsgenie.com/
        priority: 'P1'
        message: '{{ .GroupLabels.alertname }} — {{ .GroupLabels.cluster }}'
        description: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
        tags: 'env:production,team:platform'
        # Responders links the alert directly to the Platform Team in Opsgenie
        responders:
          - name: 'Platform Team'
            type: 'team'

  - name: 'opsgenie-p3'
    opsgenie_configs:
      - api_key: '<YOUR_OPSGENIE_API_KEY>'
        priority: 'P3'
        message: '{{ .GroupLabels.alertname }} — {{ .GroupLabels.cluster }}'
        description: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
        tags: 'env:production,team:platform'
        responders:
          - name: 'Platform Team'
            type: 'team'

  - name: 'opsgenie-default'
    opsgenie_configs:
      - api_key: '<YOUR_OPSGENIE_API_KEY>'
        priority: 'P2'
        message: '{{ .GroupLabels.alertname }}'
        responders:
          - name: 'Platform Team'
            type: 'team'
```

```bash
# Validate the alertmanager config before reloading
amtool check-config alertmanager.yml

# Reload without restart (if Alertmanager is running with --web.enable-lifecycle)
curl -X POST http://localhost:9093/-/reload

# Test: manually send a firing alert to Alertmanager and watch Opsgenie
amtool alert add \
  alertname="TestCriticalAlert" \
  severity="critical" \
  cluster="prod-us-east-1" \
  --annotation=description="Synthetic test alert — safe to acknowledge"

# Verify: the alert should appear in Opsgenie within ~30 seconds (group_wait)
# Check: Teams → Platform Team → Alert Activity
```

**Gotcha:** Alertmanager's `repeat_interval: 12h` means if an alert fires and is not resolved, Alertmanager re-sends it to Opsgenie every 12 hours. If the Opsgenie alert is already acknowledged, the repeat sends create a *new* alert rather than updating the existing one, depending on your deduplication key (`alias` field). Set `alias` in `opsgenie_configs` to a deterministic value based on alert labels to enable deduplication:

```yaml
alias: '{{ .GroupLabels.alertname }}-{{ .GroupLabels.cluster }}'
```

---

## Exercises

### Exercise 1: Audit a Schedule for Coverage Gaps

**Goal:** Practice identifying and fixing gaps using the API.

1. Create a schedule via the Opsgenie UI with a single weekly rotation restricted to **Monday–Friday, 09:00–17:00 UTC** with two participants. Do not add a fallback rotation.
2. Use the API to query who is on call on a **Saturday at 14:00 UTC**:
   ```bash
   curl -X GET \
     "https://api.opsgenie.com/v2/schedules/YOUR_SCHEDULE_NAME/on-calls?scheduleIdentifierType=name&flat=true&date=2024-06-15T14:00:00Z" \
     -H "Authorization: GenieKey YOUR_API_KEY" | jq '.data.onCallParticipants'
   ```
3. Observe the empty result (the gap). Now add a fallback rotation via the UI with no time restriction and a single participant (yourself or a test user).
4. Re-run the same API query and confirm the fallback participant appears.
5. **Explain in your own words:** Why does having a gap in a schedule result in a silent failure rather than an error? What are the operational consequences of an undetected gap in a production environment?

---

### Exercise 2: Design an Escalation Policy for an SLA Constraint

**Goal:** Translate a business requirement into escalation policy configuration.

Your team has an SLA that states: *"P1 alerts must reach an engineer within 5 minutes and a manager within 15 minutes, 24/7."*

1. Design the escalation policy steps on paper (or in a text file) before touching the UI. Specify:
   - How many steps the policy needs
   - The wait time between each step
   - Who each step notifies (on-call from schedule vs. named user)
   - Why each choice satisfies or risks violating the SLA
2. Create the policy in the Opsgenie UI under your team.
3. Verify the cumulative timing: if step 1 fires at 0 min, what is the total elapsed time when the manager is first contacted?
4. **Gotcha challenge:** Change your policy so that step 2 has a 12-minute wait. Does this still satisfy the "manager within 15 minutes" SLA? Show your math. If it doesn't, what is the minimum wait you can set at step 2 given a 5-minute step 1 wait?

---

### Exercise 3: Automate a Shift Swap via the API

**Goal:** Use the Opsgenie override API to handle a real-world shift swap scenario without touching the UI.

**Scenario:** Alice is on call this week (weekly rotation). She has a dentist appointment on Wednesday from 10:00–13:00 UTC and has asked Bob to cover. You need to:

1. Write a `curl` command to create an override replacing Alice with Bob for exactly that window on the next occurring Wednesday.
2. After creating the override, query the on-call endpoint for **Wednesday at 11:30 UTC** and confirm Bob appears.
3. Query again for **Wednesday at 14:00 UTC** (after the override ends) and confirm Alice has resumed.
4. Delete the override using its returned ID:
   ```bash
   curl -X DELETE \
     "https://api.opsgenie.com/v2/schedules/YOUR_SCHEDULE/overrides/OVERRIDE_ALIAS_OR_ID?scheduleIdentifierType=name" \
     -H "Authorization: GenieKey YOUR_API_KEY"
   ```
5. Query **Wednesday at 11:30 UTC** once more and confirm Alice is back on call (override deleted, rotation restored).
6. **Reflection question:** If your escalation policy hardcoded `alice@company.com` instead of referencing the schedule, would step 2 have shown Bob? Why or why not? What does this tell you about escalation policy design?

---

### Exercise 4: Map an Alert Source to the Correct Escalation Policy

**Goal:** Understand routing rules by building an end-to-end alert path from source to engineer.

1. In Opsgenie, create two escalation policies for your team:
   - `High-Priority` — three steps, 5-minute waits, phone call on step 3
   - `Low-Priority` — one step, no repeat
2. Create two routing rules for your team:
   - Rule 1: If alert tags contain `env:production` → route to `High-Priority`
   - Rule 2 (catch-all): All other alerts → route to `Low-Priority`
3. Use the Opsgenie API to create a test alert with the `env:production` tag:
   ```bash
   curl -X POST "https://api.opsgenie.com/v2/alerts" \
     -H "Authorization: GenieKey YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "message": "Test production alert",
       "priority": "P1",
       "tags": ["env:production", "synthetic-test"],
       "details": {"source": "exercise-4"}
     }'
   ```
4. In the Opsgenie UI, find the alert and confirm it was routed to `High-Priority`. Check the alert's **Activity Log** tab to see which escalation steps fired.
5. Create a second alert *without* the `env:production` tag and verify it routes to `Low-Priority`.
6. **Reflection question:** What would happen if you reversed the order of your routing rules (catch-all first, specific rule second)? Test it and explain the result.
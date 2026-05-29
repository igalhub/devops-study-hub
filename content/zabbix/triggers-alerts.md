---
title: Triggers & Alerting
module: zabbix
duration_min: 20
difficulty: intermediate
tags: [zabbix, triggers, alerting, media-types, actions, escalation, maintenance]
exercises: 3
---

## Overview
Zabbix triggers are boolean expressions evaluated against item values. When a trigger evaluates to true (PROBLEM state), Zabbix generates an event that can drive notifications, auto-remediation, or ticket creation. The alerting pipeline — triggers → events → actions → media types — is the operational core of Zabbix. Understanding how to write correct trigger expressions, configure multi-channel notifications, build escalation ladders, and suppress alerts during planned maintenance are all skills that come up in both interviews and day-to-day operations. A poorly written trigger expression is one of the most common sources of alert fatigue in production Zabbix deployments.

## Concepts

### Trigger Expressions
A trigger expression evaluates to 0 (OK) or 1 (PROBLEM). The expression language uses functions applied to item history.

**Basic expression syntax:**
```
last(/hostname/item.key) operator threshold
```

**Common trigger functions:**

| Function | Description | Example |
|----------|-------------|---------|
| `last()` | Most recent value | `last(/host/agent.ping) = 0` |
| `avg(,Xs)` | Average over time window | `avg(/host/system.cpu.load,300s) > 5` |
| `min(,Xs)` | Minimum over window | `min(/host/net.if.in[eth0],60s) < 100` |
| `max(,Xs)` | Maximum over window | `max(/host/vfs.fs.size[/,pused],3600s) > 90` |
| `nodata(,Xs)` | True if no data received for X seconds | `nodata(/host/agent.ping,300s) = 1` |
| `diff()` | True if last value differs from previous | `diff(/host/system.uname) = 1` |
| `count(,Xs,pattern)` | Count values matching pattern in window | `count(/host/log[/var/log/app.log,ERROR],60s,like,ERROR) > 10` |
| `change()` | Absolute difference between last two values | `change(/host/system.cpu.load) > 2` |
| `fuzzytime(,Xs)` | True if host time deviates from server time by > X sec | `fuzzytime(/host/system.localtime,60s) = 0` |

**Multi-condition expressions:**
```
# CPU high AND memory low (compound problem)
avg(/web-01/system.cpu.util[,user],300s) > 85
and
last(/web-01/vm.memory.size[pavailable]) < 10

# Disk full on any filesystem (using LLD-created items)
last(/web-01/vfs.fs.size[/data,pused]) > 95
or
last(/web-01/vfs.fs.size[/,pused]) > 95
```

**Best practices for trigger expressions:**
- Use `avg()` over a window rather than `last()` for CPU/memory to avoid single-sample false positives.
- Set a **recovery expression** to define when PROBLEM clears — avoids triggers that flip back to OK too quickly.
- Always test expressions using **Configuration → Hosts → Items → Test** before deploying.

**Recovery expression example:**
```
Problem:  avg(/host/system.cpu.load[all,avg1],300s) > 5
Recovery: avg(/host/system.cpu.load[all,avg1],300s) < 3
```
The trigger fires at load > 5 but only clears when load drops below 3. This hysteresis prevents flapping.

### Severity Levels
Zabbix has six built-in severity levels used to prioritize and route alerts.

| Level | Color | Typical Use |
|-------|-------|-------------|
| Not classified | Grey | Default, unreviewed triggers |
| Information | Blue | FYI events — config changes, planned reboots |
| Warning | Yellow | Early indicators — disk at 75%, CPU at 60% |
| Average | Orange | Actionable issues — service degraded |
| High | Red | Service impaired — needs immediate attention |
| Disaster | Dark red | Complete outage — page someone now |

Severity filters appear in media type and action configurations, letting you route Disaster-level alerts to PagerDuty while Warning goes only to Slack.

### Trigger Dependencies
Trigger dependencies prevent downstream alert storms. When a root-cause trigger fires, dependent triggers are suppressed even if their conditions are also true.

**Example:**
- Trigger A: "Host unreachable" (network switch is down)
- Trigger B: "SSH port unavailable on web-01"
- Trigger C: "HTTP check failing on web-01"

If A depends on (is blocked by) B and C: when the switch goes down, B and C fire but A does NOT notify if B or C is already in PROBLEM state.

More commonly, reverse the dependency: B and C depend on A. If A fires (host unreachable), B and C are suppressed because the root cause is already known.

**Configuring dependencies:**
```
Configuration → Triggers → (select trigger) → Dependencies tab → Add
```

Add the dependency: "This trigger is suppressed when: [parent trigger]"

### Media Types
A media type defines how Zabbix delivers notifications. It is independent of routing — the same media type is reused across multiple actions.

**Built-in media types:**
- Email (SMTP)
- SMS (via external gateway scripts)
- Webhook (generic HTTP)

**Email media type configuration:**
```
SMTP server:    smtp.gmail.com
SMTP port:      587
SMTP helo:      gmail.com
SMTP email:     zabbix@example.com
Security:       STARTTLS
Authentication: Username/Password
Username:       zabbix@example.com
Password:       <app password>
```

**Slack webhook media type:**
Zabbix ships a built-in Slack media type. Configuration:
```
Media type: Slack
bot_token:   xoxb-your-bot-token
channel:     #alerts
```
Message template uses Zabbix macros:
```
{TRIGGER.NAME} on {HOST.NAME}
Severity: {TRIGGER.SEVERITY}
Status: {TRIGGER.STATUS}
```

**Custom webhook media type (generic HTTP):**
```
Name: PagerDuty
Type: Webhook
URL: https://events.pagerduty.com/v2/enqueue
Request method: POST
Headers:
  Content-Type: application/json
Parameters:
  payload: {
    "routing_key": "{$PD_INTEGRATION_KEY}",
    "event_action": "trigger",
    "dedup_key": "{EVENT.ID}",
    "payload": {
      "summary": "{TRIGGER.NAME}",
      "severity": "{TRIGGER.SEVERITY}",
      "source": "{HOST.NAME}",
      "custom_details": {
        "item_value": "{ITEM.VALUE}"
      }
    }
  }
```

**Assigning a media type to a user:**
```
Administration → Users → (user) → Media tab → Add
Type: Slack
Send to: @username
When active: 1-7,00:00-24:00
Use if severity: Warning, Average, High, Disaster
```

### Action Configuration
Actions define the routing logic: when a trigger fires matching certain criteria, send a notification via a specific media type to specific users.

**Action components:**
1. **Conditions** — filter which events trigger this action (by host group, trigger severity, trigger name regex, etc.)
2. **Operations** — what to do (send message, run remote command)
3. **Recovery operations** — what to do when the trigger returns to OK
4. **Update operations** — what to do when the event is acknowledged

**Example action — notify on-call for Disaster/High severity:**
```
Action name: Notify Platform On-Call

Conditions (ALL must match):
  - Trigger severity >= High
  - Host group = Linux servers

Operations:
  - Step 1: Send message to user: oncall-user via PagerDuty
    Default operation step duration: 1h

Recovery operations:
  - Send message to user: oncall-user via PagerDuty
    (Uses recovery message template)
```

### Escalation Steps
Zabbix actions support multi-step escalation. If the problem is not acknowledged within the step duration, the next step fires.

```
Step 1 (0-1h):   Send Slack to #alerts-platform
Step 2 (1h-2h):  Send PagerDuty to on-call engineer
Step 3 (2h+):    Send PagerDuty to engineering manager
                 + Run remote command: /usr/local/bin/auto-restart-service.sh
```

**Operation step duration:** each step runs for its defined duration. If the event is **acknowledged** before a step triggers, escalation stops (configurable — you can set escalation to continue even after acknowledgment).

**Remote command operations** run scripts on Zabbix agents or the server itself. Use with care — remote execution expands the attack surface. Scope with `AllowKey=system.run[*]` in the agent config and only if `EnableRemoteCommands=1`.

### Maintenance Windows
Maintenance windows suppress alerts for specific hosts or host groups during planned downtime without deleting triggers.

**Create a maintenance window:**
```
Configuration → Maintenance → Create maintenance

Name: Monthly kernel patching - web tier
Maintenance type: With data collection (metrics still stored)
Active since/till: 2026-06-01 02:00 – 2026-06-01 04:00

Hosts/Groups: Linux servers → web-tier group

Schedule type: One time only
```

`With data collection` — metrics are still recorded, only notifications are suppressed. Useful for post-maintenance review.
`No data collection` — items are not polled. Use when the host is powered off.

**Recurring maintenance:**
Set `Schedule type: Weekly` or `Monthly` with specific day-of-week offsets for patch cycles.

## Examples

**Full alert pipeline — disk space warning with escalation:**

1. Item: `vfs.fs.size[/data,pused]` (collected every 5 minutes)
2. Trigger:
   ```
   Problem: last(/web-01/vfs.fs.size[/data,pused]) > 85
   Recovery: last(/web-01/vfs.fs.size[/data,pused]) < 80
   Severity: Warning
   ```
3. Action conditions: Trigger severity = Warning, Host group = Web Tier
4. Operations:
   - Step 1 (0–30m): Slack `#alerts` — "Disk /data at {ITEM.VALUE}% on {HOST.NAME}"
   - Step 2 (30m–2h): PagerDuty page to on-call
5. Recovery operations: Slack `#alerts` — "RESOLVED: Disk /data now at {ITEM.VALUE}%"

**Test trigger expression without waiting for real data:**
```
Configuration → Hosts → Items → (select item) → Test
```
Enter a test value and confirm the trigger would fire.

**Check active alerts via API:**
```bash
curl -s -X POST http://zabbix-server/api_jsonrpc.php \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "trigger.get",
    "params": {
      "only_true": 1,
      "selectHosts": ["host"],
      "output": ["description", "priority", "lastchange"]
    },
    "auth": "<auth-token>",
    "id": 1
  }' | jq '.result[] | {host: .hosts[0].host, trigger: .description, severity: .priority}'
```

## Exercises

1. Write a trigger expression for a host that fires at `Average` severity when the 5-minute CPU load average exceeds 4 for more than 3 consecutive minutes, and recovers only when it drops below 2. Include a recovery expression. Explain why using `avg()` instead of `last()` is important here.
2. Configure a three-step escalation action: Step 1 sends a Slack message to `#alerts`, Step 2 (after 30 minutes if unacknowledged) sends a PagerDuty alert to on-call, Step 3 (after 1 hour) sends an email to the engineering manager. Set conditions so only `High` or `Disaster` severity triggers from the `Production` host group match.
3. Create a maintenance window for a host group covering 02:00–04:00 UTC on the first Sunday of each month, using `With data collection` mode. Verify that an active trigger on a host in that group does not generate a notification during the window, but data is still visible in **Monitoring → Latest data**.


---

### Quick Checks

4. Evaluate a simple Zabbix trigger threshold. Run: `python3 -c "cpu=85; threshold=80; print('PROBLEM' if cpu > threshold else 'OK')"`

```expected_output
PROBLEM
```

hint: Think about how Python can be used directly from the command line to evaluate conditional logic.
hint: Use python3 -c to run an inline script that compares a cpu variable against a threshold value using an if/else expression with print().

5. Count Zabbix trigger severity levels. Run: `printf 'Not classified\nInformation\nWarning\nAverage\nHigh\nDisaster\n' | wc -l`

```expected_output
6
```

hint: Think about how you can count the number of lines produced by a command's output.
hint: Use a pipe to send the printed lines into `wc -l`, which counts the total number of newline-terminated lines.

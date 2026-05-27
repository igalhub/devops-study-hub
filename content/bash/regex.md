---
title: Regex
module: bash
duration_min: 20
difficulty: intermediate
tags: [bash, regex, grep, egrep, sed, patterns, ERE, BRE]
exercises: 4
---

## Overview

Regular expressions are a universal language for describing text patterns. In DevOps work you will use them daily: grepping application logs for errors, extracting IPs from access logs, validating configuration values in deployment scripts, filtering `kubectl` output, writing nginx location blocks, and building alerting pipelines that classify log lines. Knowing regex well separates engineers who write precise, fast one-liners from those who pipe through ten extra `awk` calls.

The core design principle behind regex is declarative pattern matching — you describe the shape of the text you want, and the engine finds it. Most tools you already use (grep, sed, awk, Python, Go, JavaScript, Terraform, GitHub Actions) share a common regex vocabulary with minor dialect differences. Mastering the POSIX ERE dialect plus Perl-compatible extensions gives you coverage across nearly every tool in the DevOps toolchain.

Regex fits into DevOps in several layers: interactive shell work (grep, awk), scripted automation (bash `=~`, sed in pipelines), log aggregation (Fluentd, Logstash, Promtail `pipeline_stages`), and platform configuration (nginx `location ~`, Kubernetes admission webhooks, OPA policies). The investment in learning regex has one of the highest returns of any technical skill at this level.

---

## Concepts

### Two Flavors: BRE and ERE

Every POSIX tool implements one of two regex dialects. Knowing which dialect a tool defaults to prevents maddening "why doesn't my `+` work?" bugs.

| Feature | BRE (grep default) | ERE (grep -E, egrep) |
|---|---|---|
| Grouping | `\(abc\)` | `(abc)` |
| Alternation | `\|` | `\|` |
| One-or-more | `\+` | `+` |
| Zero-or-one | `\?` | `?` |
| Repetition | `\{3\}` | `{3}` |
| Backreferences | `\1` | `\1` |

**Rule of thumb:** always use `grep -E` (ERE). The syntax is cleaner, less backslash-heavy, and matches what most other tools expect. Use `grep -P` for Perl-compatible regex (PCRE) when you need lookaheads, lookbehinds, `\d`, `\s`, or `\K` (match-reset). PCRE is not available on all systems — macOS ships without it in grep by default.

```bash
# BRE — clunky
grep "^\(ERROR\|WARN\)\{1,\}" app.log

# ERE — equivalent, readable
grep -E "^(ERROR|WARN)+" app.log

# PCRE — when you need lookahead or \d
grep -P "(?<=\[)\d{4}-\d{2}-\d{2}" app.log
```

**`sed` uses BRE by default.** Use `sed -E` (GNU) or `sed -r` (older GNU) to switch to ERE. `awk` uses its own ERE-like dialect and does not need a flag.

---

### Character Classes

Character classes define a set of acceptable characters at a single position.

```
.          any character except newline
[abc]      literal a, b, or c
[^abc]     anything except a, b, or c
[a-z]      lowercase letters a through z
[A-Z]      uppercase letters
[0-9]      digits 0–9
[a-zA-Z0-9_]  word characters (same as \w in PCRE)
```

**POSIX named classes** are portable across locales and available in both BRE and ERE inside `[...]`:

| Class | Meaning |
|---|---|
| `[:alpha:]` | Letters (locale-aware) |
| `[:digit:]` | `0-9` |
| `[:alnum:]` | Letters and digits |
| `[:space:]` | Whitespace including tab, newline |
| `[:upper:]` | Uppercase letters |
| `[:lower:]` | Lowercase letters |
| `[:punct:]` | Punctuation characters |

```bash
# POSIX class usage — note the double brackets: one for the class, one for the character class
grep "[[:digit:]]\{3\}-[[:digit:]]\{4\}" contacts.txt   # BRE phone pattern
grep -E "[[:alpha:]][[:digit:]]+" codes.txt              # ERE: letter then digits
```

**PCRE shorthand classes** (require `grep -P` or Python/Go/JavaScript/etc.):

| Shorthand | Equivalent |
|---|---|
| `\d` | `[0-9]` |
| `\D` | `[^0-9]` |
| `\w` | `[a-zA-Z0-9_]` |
| `\W` | `[^a-zA-Z0-9_]` |
| `\s` | `[ \t\r\n\f]` |
| `\S` | `[^ \t\r\n\f]` |

**`.` matches everything except newline.** A common mistake is using `.` when you mean a literal dot — for example, in IP address patterns. `192.168.1.1` as a regex matches `192X168Y1Z1`. Always escape literal dots: `192\.168\.1\.1`.

**Locale gotcha:** POSIX classes like `[:alpha:]` are locale-aware. In a `C` locale they match only ASCII. In a `UTF-8` locale they may match accented characters. For infrastructure scripting, set `LC_ALL=C` at the top of scripts to get deterministic behavior: `export LC_ALL=C`.

---

### Anchors and Boundaries

Anchors match a position in the string, not a character. They consume zero width.

| Anchor | Meaning | Notes |
|---|---|---|
| `^` | Start of line | Matches after `\n` in multiline mode |
| `$` | End of line | Matches before `\n` |
| `\b` | Word boundary | PCRE (`grep -P`) or ERE on GNU grep |
| `\<` | Start of word | GNU grep BRE/ERE |
| `\>` | End of word | GNU grep BRE/ERE |

```bash
# Only lines that are ONLY an IP address (nothing else on the line)
grep -E "^([0-9]{1,3}\.){3}[0-9]{1,3}$" ips.txt

# Match "error" as a whole word — not "errors" or "terror"
grep -P "\berror\b" app.log
grep -w "error" app.log       # -w is equivalent for simple words

# Lines that are blank
grep "^$" file.txt            # truly empty
grep -E "^\s*$" file.txt      # empty or whitespace-only (GNU ERE supports \s)

# Lines that do NOT start with a comment or blank (common config parsing pattern)
grep -E "^[^#[:space:]]" config.conf
```

**`^` and `$` inside `[...]` mean something different.** `[^abc]` means "not a, b, or c". `^` only means start-of-line when it is the first character of the overall pattern or a group, not inside a character class.

**`$` matches before a trailing newline.** In a file, `grep "end$"` matches lines ending in "end" even though the actual last byte on the line is `\n`. This is intentional POSIX behavior — the newline is the line terminator, not part of the content.

---

### Quantifiers

Quantifiers apply to the preceding atom (character, class, or group).

| Quantifier | Meaning | Dialect |
|---|---|---|
| `*` | Zero or more (greedy) | BRE + ERE |
| `+` | One or more (greedy) | ERE (BRE: `\+`) |
| `?` | Zero or one (greedy) | ERE (BRE: `\?`) |
| `{n}` | Exactly n | ERE (BRE: `\{n\}`) |
| `{n,}` | n or more | ERE |
| `{n,m}` | Between n and m (inclusive) | ERE |
| `*?` `+?` `??` | Non-greedy variants | PCRE only |

**Greedy vs. non-greedy:** standard regex is greedy — it matches as much as possible while still allowing the overall pattern to succeed. This matters when extracting content between delimiters.

```bash
# Greedy: matches from FIRST < to LAST > on the line — often wrong
echo "<b>bold</b> and <i>italic</i>" | grep -oP "<.+>"
# Output: <b>bold</b> and <i>italic</i>  (one match, entire span)

# Non-greedy (PCRE only): matches each tag independently
echo "<b>bold</b> and <i>italic</i>" | grep -oP "<.+?>"
# Output: <b>  </b>  <i>  </i>  (four separate matches)
```

**`{n,m}` has no spaces.** `{3, 5}` is treated as a literal string in most engines, not a quantifier. Write `{3,5}`.

**`*` on an empty match loops forever in some engines.** `(a*)*` is a pathological pattern that causes catastrophic backtracking. In log processing pipelines, a runaway regex can pin a CPU core. Keep quantifiers specific.

---

### Groups and Alternation

Groups serve two purposes: scoping quantifiers and capturing submatches for backreferences or extraction.

```bash
# Alternation scoped to a group — match lines with any of three severity levels
grep -E "^(ERROR|WARN|FATAL): " app.log

# Repeat a multi-character sequence — match an IPv4 address
grep -E "^([0-9]{1,3}\.){3}[0-9]{1,3}$" ips.txt
# The group ([0-9]{1,3}\.) matches one octet+dot, repeated exactly 3 times

# Non-capturing group (PCRE) — group for scoping, without storing the match
grep -P "(?:ERROR|WARN): (.+)" app.log
# Only the content after ": " is captured in group \1
```

**Backreferences** let you reference a previously captured group within the same pattern. In `sed`, they enable field rearrangement:

```bash
# Swap first and last name: "Smith, John" → "John Smith"
echo "Smith, John" | sed -E 's/([A-Za-z]+), ([A-Za-z]+)/\2 \1/'

# Reformat a date: "2024-01-15" → "15/01/2024"
echo "2024-01-15" | sed -E 's/([0-9]{4})-([0-9]{2})-([0-9]{2})/\3\/\2\/\1/'

# Detect a doubled word in a line (classic backreference demo)
grep -E "\b([a-z]+) \1\b" document.txt
```

**Alternation binds loosely — this is a common bug.** `cat|dog food` matches "cat" OR "dog food", not "cat food" OR "dog food". Always use groups to scope alternation: `(cat|dog) food`.

**Capture group numbering** follows left-parenthesis order, left to right. In `(a(b))(c)`: group 1 = `ab`, group 2 = `b`, group 3 = `c`. Non-capturing groups `(?:...)` do not consume a number.

---

### grep in Practice

`grep` is the primary tool for searching logs and command output. Know these flags by heart.

| Flag | Effect |
|---|---|
| `-E` | Use ERE dialect |
| `-P` | Use PCRE dialect |
| `-i` | Case-insensitive |
| `-v` | Invert match (lines NOT matching) |
| `-o` | Print only the matched portion, one match per line |
| `-c` | Count matching lines (not occurrences) |
| `-n` | Show line numbers |
| `-l` | Show only filenames with at least one match |
| `-L` | Show only filenames with no match |
| `-r` / `-R` | Recursive (`-R` follows symlinks) |
| `-w` | Whole-word match |
| `-A n` | n lines of context after match |
| `-B n` | n lines of context before match |
| `-C n` | n lines before and after |
| `--include` | Restrict recursive search to filename glob |
| `--exclude` | Exclude filenames matching glob |

```bash
# Recursive, case-insensitive, line numbers, suppress permission errors
grep -rniE "password|secret|token" /etc/ 2>/dev/null

# Extract only matching text: pull all IPv4 addresses from an access log
grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" access.log | sort -u

# Multi-stage pipeline: count HTTP 5xx codes by type
grep -E '" 5[0-9]{2} ' access.log | grep -oE '5[0-9]{2}' | sort | uniq -c | sort -rn

# Context for incident debugging: show what happened around a FATAL
grep -C5 "FATAL" app.log | less

# Count errors per log file across a directory, sorted by frequency
grep -rc "ERROR" /var/log/myapp/ 2>/dev/null | sort -t: -k2 -rn

# Search only .conf files recursively
grep -rE "listen\s+443" /etc/nginx/ --include="*.conf"

# Find files that do NOT contain a required setting
grep -rL "set -euo pipefail" scripts/
```

**`grep -o` is underused.** It changes grep from a line filter into a field extractor. Combined with `sort | uniq -c`, it produces frequency tables from raw logs without needing awk. Combined with `-P`, it can extract named capture groups from structured log lines.

**Performance tip:** when searching large log archives, put the most specific literal string first in your pattern. `grep "ERROR" | grep -E "db_conn|timeout"` is faster than a single complex alternation on gigabyte files because the first grep eliminates most lines cheaply.

---

### sed with Regex

`sed` is the standard tool for in-place substitution and stream transformation. Its most-used command is `s/pattern/replacement/flags`.

```bash
# Basic substitution: replace first occurrence per line
sed 's/foo/bar/' file.txt

# Global substitution (all occurrences per line)
sed 's/foo/bar/g' file.txt

# ERE syntax — use -E (GNU) or -r (older systems)
sed -E 's/(ERROR|WARN)/[\0]/' app.log   # & = entire matched text (in GNU sed)
sed -E 's/(ERROR|WARN)/[&]/' app.log    # & is the portable form for full match

# Delete lines matching a pattern
sed '/^#/d' config.txt                   # remove comment lines
sed '/^[[:space:]]*$/d' file.txt         # remove blank/whitespace-only lines

# In-place edit with backup — always use a suffix so you can recover
sed -i.bak 's/localhost/db.internal/g' config.ini

# Extract and restructure fields using capture groups
echo "2024-01-15T10:23:45 ERROR db timeout" \
  | sed -E 's/([^ ]+) ([^ ]+) (.+)/\1 | \2 | \3/'
# Output: 2024-01-15T10:23:45 | ERROR | db timeout

# Strip ANSI color codes from captured log files
sed -E 's/\x1B\[[0-9;]*[mK]//g' colored.log

# Comment out a specific line by content
sed -E 's/^(MaxConnections=.*)/#\1/' database.conf
```

**`sed -i` differs between GNU and BSD (macOS).** On GNU/Linux: `sed -i.bak`. On macOS: `sed -i '' 's/old/new/' file` (the suffix is required, even if empty). Scripts that work on Linux will silently break on macOS CI runners. Use `sed -i.bak` everywhere — it works on both and gives you a safety net.

**The replacement string is not a regex.** You cannot use quantifiers, character classes, or anchors in the replacement side of `s/pattern/replacement/`. Only literal text, `&` (full match), and `\1`–`\9` (capture groups) are valid. A `+` in the replacement is a literal plus sign.

**`sed` address ranges** allow you to limit substitutions to specific lines:

```bash
# Only substitute between lines matching start and end markers
sed '/BEGIN_CONFIG/,/END_CONFIG/ s/debug/info/g' app.conf

# Only process lines 10 through 20
sed '10,20 s/old/new/g' file.txt

# Delete from a pattern to end of file
sed '/^-- DEPRECATED/,$d' schema.sql
```

---

### Bash `=~` Operator

The `=~` operator in `[[ ... ]]` tests a string against an ERE pattern without spawning a subprocess. Use it in scripts where you need to validate input or branch on string content — it is significantly faster than calling grep in a loop.

```bash
STRING="Error: disk full at 2024-01-15"

if [[ "$STRING" =~ Error:\ (.+)\ at\ ([0-9-]+) ]]; then
    echo "Message: ${BASH_REMATCH[1]}"   # "disk full"
    echo "Date:    ${BASH_REMATCH[2]}"   # "2024-01-15"
fi
```

`BASH_REMATCH[0]` holds the entire match. `BASH_REMATCH[1]`, `[2]`, etc. hold capture groups in left-parenthesis order.

```bash
# Validate a semantic version string before deployment
VERSION="v1.14.3"
if [[ "$VERSION" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "Major: ${BASH_REMATCH[1]}"
    echo "Minor: ${BASH_REMATCH[2]}"
    echo "Patch: ${BASH_REMATCH[3]}"
else
    echo "Invalid semver: $VERSION" >&2
    exit 1
fi

# Validate that a config value is a valid port number (1–65535)
PORT="8443"
if [[ "$PORT" =~ ^([1-9][0-9]{0,4})$ ]] && (( PORT <= 65535 )); then
    echo "Valid port"
else
    echo "Invalid port" >&2; exit 1
fi

# Branch on log level extracted from a structured log line
LOG_LINE="2024-01-15T10:23:45 WARN  connection pool at 90%"
if [[ "$LOG_LINE" =~ [[:space:]](ERROR|FATAL)[[:space:]] ]]; then
    alert_oncall "${BASH_REMATCH[1]}: $LOG_LINE"
fi
```

**Do not quote the pattern on the right side of `=~`.** Quoting forces a literal string comparison — regex metacharacters stop working.

```bash
PATTERN="^[0-9]+"
[[ "123abc" =~ $PATTERN ]]     # correct — variable reference, no quotes on RHS
[[ "123abc" =~ "^[0-9]+" ]]   # WRONG — matches the literal string "^[0-9]+"
```

**`=~` uses ERE, not PCRE.** Features like `\d`, `\s`, lookaheads, and `\K` are unavailable. Use POSIX classes (`[[:digit:]]`) or explicit ranges (`[0-9]`).

**`BASH_REMATCH` is a global array** — it gets overwritten by every `=~` test. Save values to named variables immediately if you need them after another conditional.

---

### Common Real-World Patterns

A reference of patterns that appear repeatedly in DevOps work. Understanding the structure matters more than memorizing the strings — build them from components.

```bash
# IPv4 address — structural match (does not validate 0-255 range)
[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}

# IPv4 with line anchors for validation
^([0-9]{1,3}\.){3}[0-9]{1,3}$

# CIDR notation
^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[1-2][0-9]|3[0-2])$

# ISO 8601 timestamp (date + time)
[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}

# ISO 8601 with optional timezone offset
[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)?

# Nginx combined log format — extract status code and response time
"[A-Z]+ [^ ]+ HTTP/[0-9.]+" ([0-9]{3}) [0-9]+

# Semantic version (with optional leading v)
v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?

# Docker image tag: name:tag or registry/name:tag or registry:port/name:tag
([a-z0-9.-]+/)?[a-z0-9._-]+(:[a-zA-Z0-9._-]+)?

# Kubernetes resource name (lowercase alphanumeric and hyphens, must start/end with alnum)
^[a-z0-9]([a-z0-9-]*[a-z0-9])?$

# Environment variable assignment in shell or .env files
^[A-Z_][A-Z0-9_]*=.*$

# Email address (pragmatic — not RFC-complete, sufficient for input validation)
^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$

# AWS ARN
arn:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:[a-zA-Z0-9/_:-]+

# URL with protocol
https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/[^[:space:]]*)?
```

**IP validation gotcha:** the structural IPv4 pattern matches `999.999.999.999`. If you need true validation, use a more constrained pattern or validate numerically after extraction. For most log analysis, the structural pattern is sufficient — invalid IPs don't appear in real traffic.

---

## Examples

### Example 1: Incident Triage — Extracting Error Rates from Nginx Logs

**Scenario:** Production nginx logs are in combined log format. You need to quickly answer: how many 5xx responses in the last hour, what are they, and which upstream paths are generating them?

```bash
# Setup: generate a sample access log (or use /var/log/nginx/access.log)
LOGFILE="/var/log/nginx/access.log"

# Step 1: Count all HTTP status codes — frequency table
# -oE extracts only the status code field; sort+uniq builds the table
grep -oE '"[A-Z]+ [^ ]+ HTTP/[0-9.]+" [0-9]{3}' "$LOGFILE" \
  | grep -oE '[0-9]{3}$' \
  | sort | uniq -c | sort -rn

# Step 2: Show only 5xx lines with 5 lines of context for triage
grep -E '"[A-Z]+ [^ ]+ HTTP/[0-9.]+" 5[0-9]{2}' "$LOGFILE" | tail -50

# Step 3: Extract unique request paths that returned 5xx
# Nginx combined format: <ip> - - [timestamp] "METHOD /path HTTP/x.x" STATUS bytes
grep -oP '"[A-Z]+ \K/[^ ]+(?= HTTP/[0-9.]+)" 5[0-9]{2}' "$LOGFILE" \
  | sort | uniq -c | sort -rn | head -20
# \K resets the match start — only the path is captured in -o output
# The (?=...) lookahead ensures the path is followed by HTTP/version

# Step 4: Check if 5xx rate is above threshold in a monitoring script
TOTAL=$(grep -c "" "$LOGFILE")           # total lines = total requests
ERRORS=$(grep -cE '" 5[0-9]{2} ' "$LOGFILE")
echo "5xx rate: $ERRORS / $TOTAL"

# Verify: the counts should add up
grep -oE '" [0-9]{3} ' "$LOGFILE" | grep -oE '[0-9]{3}' | sort | uniq -c
```

---

### Example 2: Deployment Script — Validating and Transforming a Config File

**Scenario:** A deployment script receives a config file that may have localhost references, debug log levels, and commented-out lines. You need to validate required fields exist, promote log level to info, and rewrite the DB host before deploying.

```bash
#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

CONFIG_FILE="${1:?Usage: $0 <config-file>}"
BACKUP="${CONFIG_FILE}.bak.$(date +%Y%m%d%H%M%S)"

# Step 1: Validate required keys are present
REQUIRED_KEYS=(db_host db_port app_port log_level)
for key in "${REQUIRED_KEYS[@]}"; do
    # Match key= at the start of a non-commented line
    if ! grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$CONFIG_FILE"; then
        echo "ERROR: required key '${key}' missing from ${CONFIG_FILE}" >&2
        exit 1
    fi
done

# Step 2: Validate port numbers are numeric and in valid range
while IFS='=' read -r key value; do
    [[ "$key" =~ _port$ ]] || continue
    # Strip whitespace around value
    value="${value//[[:space:]]/}"
    if ! [[ "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
        echo "ERROR: invalid port value for '${key}': '${value}'" >&2
        exit 1
    fi
done < <(grep -E "^[[:space:]]*[a-z_]+_port[[:space:]]*=" "$CONFIG_FILE")

# Step 3: Transform the config — make a backup first
cp "$CONFIG_FILE" "$BACKUP"

# Replace localhost/127.0.0.1 DB host with production hostname
sed -i.tmp -E \
    's/^(db_host[[:space:]]*=[[:space:]]*)(localhost|127\.0\.0\.1)/\1db.prod.internal/g' \
    "$CONFIG_FILE"

# Promote log_level from debug to info
sed -i.tmp -E \
    's/^(log_level[[:space:]]*=[[:space:]]*)debug/\1info/g' \
    "$CONFIG_FILE"

# Remove comment lines and blank lines (produces a clean deployed config)
sed -i.tmp -E '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$CONFIG_FILE"

# Remove sed's temp file (GNU sed -i creates .tmp, not all versions do)
rm -f "${CONFIG_FILE}.tmp"

echo "Config transformed. Backup at: ${BACKUP}"
# Verify: show the diff
diff "$BACKUP" "$CONFIG_FILE" || true
```

---

### Example 3: Log Classifier — Tagging Lines by Severity in a Pipeline

**Scenario:** A CI pipeline produces mixed output. You want to summarize it: count errors, extract failed test names, and exit non-zero if any errors were found.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Read pipeline output from stdin or a file
INPUT="${1:-/dev/stdin}"

# Temp files for classification
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

ERRORS_FILE="$TMPDIR/errors.txt"
FAILED_TESTS="$TMPDIR/tests.txt"

# Classify lines while streaming — avoids reading the file multiple times
while IFS= read -r line; do
    # Match ERROR or FATAL at the start of the line (case-insensitive)
    if [[ "$line" =~ ^[[:space:]]*(ERROR|FATAL|CRITICAL)[[:space:]:] ]]; then
        echo "$line" >> "$ERRORS_FILE"
    fi
    # Extract failed test names — pattern: "FAILED tests/test_db.py::test_connection"
    if [[ "$line" =~ FAILED[[:space:]]+(tests/[^[:space:]]+) ]]; then
        echo "${BASH_REMATCH[1]}" >> "$FAILED_TESTS"
    fi
done < "$INPUT"

# Summarize
ERROR_COUNT=0
if [[ -s "$ERRORS_FILE" ]]; then
    ERROR_COUNT=$(wc -l < "$ERRORS_FILE")
    echo "=== Errors ($ERROR_COUNT) ==="
    cat "$ERRORS_FILE"
fi

if [[ -s "$FAILED_TESTS" ]]; then
    echo "=== Failed tests ==="
    sort -u "$FAILED_TESTS"
fi

# Exit non-zero if any errors found — triggers CI failure
if (( ERROR_COUNT > 0 )); then
    echo "Pipeline FAILED with $ERROR_COUNT error(s)" >&2
    exit 1
fi

echo "Pipeline PASSED"
```

---

### Example 4: Promtail / Logstash Pattern — Parsing Structured App Logs

**Scenario:** Your application emits logs like:
```
2024-01-15T10:23:45.123Z [ERROR] (db_pool) Failed to acquire connection after 30s | request_id=abc-123 user_id=42
```
You need to write the regex for Promtail's `regex` pipeline stage and verify it locally with grep before deploying.

```bash
# The log line structure:
# TIMESTAMP [LEVEL] (COMPONENT) MESSAGE | key=value pairs

LOG_LINE='2024-01-15T10:23:45.123Z [ERROR] (db_pool) Failed to acquire connection after 30s | request_id=abc-123 user_id=42'

# Step 1: build the pattern incrementally and test each piece

# Timestamp
echo "$LOG_LINE" | grep -oP '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z'

# Level
echo "$LOG_LINE" | grep -oP '(?<=\[)[A-Z]+(?=\])'

# Component
echo "$LOG_LINE" | grep -oP '(?<=\()[^)]+(?=\))'

# Full named-capture pattern for Promtail/Python/Go
PATTERN='^(?P<timestamp>\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(?P<level>[A-Z]+)\] \((?P<component>[^)]+)\) (?P<message>[^|]+)\|(?P<labels>.+)$'

# Test the full pattern with grep -P (named groups print with -o in GNU grep 2.34+)
echo "$LOG_LINE" | grep -P "$PATTERN"

# Step 2: extract individual key=value pairs from the labels section
echo "$LOG_LINE" \
  | grep -oP '(?<=\| ).*' \
  | grep -oP '[a-z_]+=\S+'
# Output:
# request_id=abc-123
# user_id=42

# Step 3: equivalent Promtail pipeline_stages regex block (YAML, for reference)
cat <<'EOF'
pipeline_stages:
  - regex:
      expression: '^(?P<timestamp>\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(?P<level>[A-Z]+)\] \((?P<component>[^)]+)\) (?P<message>[^|]+)\|'
  - labels:
      level:
      component:
  - timestamp:
      source: timestamp
      format: RFC3339Nano
EOF

# Verify the pattern handles multiline edge cases (missing labels section)
echo '2024-01-15T10:23:45.000Z [INFO] (api) Health check OK |' \
  | grep -P '^[\d-]+T[\d:.]+Z \[[A-Z]+\] \([^)]+\) [^|]+\|'
```

---

## Exercises

### Exercise 1: Log Analysis Pipeline

You have an nginx access log at `/var/log/nginx/access.log` (or generate one with the command below). Write a single pipeline — no Python, no awk — that:
1. Extracts only lines from the last hour (timestamp format: `15/Jan/2024:10:`)
2. From those lines, counts unique client IPs that received a 4xx response
3. Prints the top 5 IPs sorted by request count

```bash
# Generate a synthetic log to work with if needed
for i in $(seq 1 200); do
    printf '10.0.%d.%d - - [15/Jan/2024:%02d:%02d:%02d +0000] "GET /api/v%d HTTP/1.1" %d 512\n' \
        $((RANDOM % 10)) $((RANDOM % 255)) \
        $((RANDOM % 24)) $((RANDOM % 60)) $((RANDOM % 60)) \
        $((RANDOM % 3 + 1)) \
        "$(echo '200 200 200 404 403 500' | tr ' ' '\n' | shuf -n1)"
done > /tmp/access.log
```

**Concepts tested:** `-o` extraction, `-E` ERE patterns, anchoring, pipeline composition.

---

### Exercise 2: Config Validation Script

Write a bash script `validate_env.sh` that reads a `.env` file (key=value format) and:
1. Rejects any line where the key contains lowercase letters (all env var keys must be `UPPER_CASE`)
2. Rejects any value that contains unquoted whitespace
3. Warns (but does not fail) on any value that looks like it contains a plaintext password (heuristic: value longer than 16 characters with mixed case and digits)
4. Prints a summary: N valid, N errors, N warnings

Use only `bash =~` and `BASH_REMATCH` — no grep, no sed.

**Concepts tested:** `=~` operator, `BASH_REMATCH`, ERE inside bash, character classes, anchors.

---

### Exercise 3: sed Field Transformation

You receive a CSV export from a legacy system with this format:
```
last_name,first_name,email,phone,department
Smith,John,jsmith@example.com,555-0101,Engineering
O'Brien,Mary,mobrien@example.com,555-0202,DevOps
```

Write a `sed` one-liner (you may chain `-e` expressions or pipe multiple `sed` calls) that:
1. Transforms the header line to uppercase
2. Reformats names to `first_name last_name` order
3. Masks the phone number: `555-0101` → `555-XXXX`
4. Removes the department column entirely

Output should be:
```
LAST_NAME,FIRST_NAME,EMAIL,PHONE,DEPARTMENT
John Smith,jsmith@example.com,555-XXXX
Mary O'Brien,mobrien@example.com,555-XXXX
```

**Hint:** `y/abcdefghijklmnopqrstuvwxyz/ABCDEFGHIJKLMNOPQRSTUVWXYZ/` is sed's transliterate command.

**Concepts tested:** capture groups, backreferences, `y` command, ERE in sed, multiple substitutions.

---

### Exercise 4: Regex Debugging — Fix the Broken Patterns

Each of the following commands has a bug. Identify the bug, explain why it is wrong, and write the corrected version. Test each fix.

```bash
# 1. Intended: match lines containing an IPv4 address
grep -E "[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}" /etc/hosts

# 2. Intended: replace only the word "log" (not "logging", not "catalog")
sed 's/log/LOG/g' app.conf

# 3. Intended: in bash, check if VERSION matches semver format
VERSION="2.0.1"
PATTERN="^[0-9]+\.[0-9]+\.[0-9]+$"
if [[ "$VERSION" =~ "$PATTERN" ]]; then
    echo "valid"
fi

# 4. Intended: extract email addresses from a file, one per line
grep -oE "[a-zA-Z0-9]+@[a-zA-Z0-9]+.[a-zA-Z]{2,}" contacts.txt
```

For each: name the specific rule or concept it violates, then write the corrected command.

**Concepts tested:** literal dot escaping, whole-word matching (`-w` or `\b`), unquoted `=~` RHS, character class completeness.
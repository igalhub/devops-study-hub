---
title: Regex
module: bash
duration_min: 20
difficulty: intermediate
tags: [bash, regex, grep, egrep, sed, patterns, ERE, BRE]
exercises: 4
---

## Overview
Regular expressions appear in grep, sed, awk, Python, Kubernetes label selectors, nginx config, and virtually every log-processing tool. DevOps engineers use regex to parse log files, extract IPs and timestamps, validate config, and filter command output. This lesson covers the subset that matters most in practice.

## Concepts

### Two Flavors: BRE and ERE
| Feature | BRE (grep default) | ERE (grep -E, egrep) |
|---|---|---|
| Groups | `\(abc\)` | `(abc)` |
| Alternation | `\|` | `\|` |
| One-or-more | `\+` | `+` |
| Zero-or-one | `\?` | `?` |
| Repetition | `\{3\}` | `{3}` |

In practice: always use `grep -E` (ERE) — cleaner syntax. Use `grep -P` for Perl-compatible regex (lookaheads, `\d`, `\s`, etc.) when available.

### Character Classes
```
.          any character except newline
\d         digit [0-9]  (with grep -P)
\w         word char [a-zA-Z0-9_]  (with grep -P)
\s         whitespace  (with grep -P)
[abc]      any of a, b, c
[^abc]     anything except a, b, c
[a-z]      lowercase letter
[0-9]      digit
[:alpha:]  POSIX: letters (inside []: [[:alpha:]])
[:digit:]  POSIX: digits
```

### Anchors and Boundaries
```
^          start of line
$          end of line
\b         word boundary (with grep -P or grep -E)
\<         start of word (grep BRE/ERE)
\>         end of word
```

### Quantifiers
```
*          zero or more (greedy)
+          one or more (ERE)
?          zero or one (ERE)
{n}        exactly n
{n,}       n or more
{n,m}      between n and m
```

### Groups and Alternation
```
(abc)      capture group (ERE)
(a|b)      alternation — a or b
```

### grep in Practice
```bash
# Basic match
grep "error" /var/log/syslog

# Case-insensitive
grep -i "error" /var/log/syslog

# Extended regex
grep -E "ERROR|CRITICAL|FATAL" /var/log/app.log

# Invert match (lines NOT matching)
grep -v "DEBUG" app.log

# Print only the matching part (not the whole line)
grep -oE "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" access.log   # extract IPs

# Count matching lines
grep -c "ERROR" app.log

# Show line numbers
grep -n "CRITICAL" app.log

# Recursive search across files
grep -r "password" /etc/ 2>/dev/null

# Match whole words only
grep -w "bin" /etc/passwd

# Files that match (not the lines)
grep -l "TODO" src/*.py

# Context: 3 lines before and after
grep -B3 -A3 "FATAL" app.log
```

### Anchored Patterns — Common Examples
```bash
# Lines starting with #
grep "^#" config.txt

# Blank lines
grep "^$" file.txt

# Lines ending with .conf
grep "\.conf$" file.txt

# IPv4 address (simplified)
grep -E "^([0-9]{1,3}\.){3}[0-9]{1,3}$" ips.txt

# Valid email (simplified)
grep -E "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$" emails.txt
```

### Bash =~ Operator
Test a string against a regex in a script without spawning grep:
```bash
STRING="Error: disk full at 2024-01-15"

if [[ "$STRING" =~ Error:\ (.+)\ at\ ([0-9-]+) ]]; then
    echo "Message: ${BASH_REMATCH[1]}"   # "disk full"
    echo "Date: ${BASH_REMATCH[2]}"      # "2024-01-15"
fi
```

`BASH_REMATCH[0]` is the full match; `[1]`, `[2]` ... are capture groups.

### Real-World Regex Patterns
```bash
# Extract HTTP status codes from nginx access log
grep -oE '" [0-9]{3} ' access.log | grep -oE '[0-9]{3}' | sort | uniq -c

# Find lines with timestamps between 10:00 and 10:59
grep -E "10:[0-5][0-9]:[0-5][0-9]" app.log

# Find kubernetes pod names (namespace/pod pattern)
grep -oE "[a-z0-9-]+/[a-z0-9-]+-[a-z0-9]+" kubectl_output.txt

# Validate that a variable looks like a semantic version
if ! [[ "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Invalid version: $VERSION" >&2
    exit 1
fi

# Find all TODO comments in shell scripts
grep -rn "# TODO\|# FIXME\|# HACK" scripts/
```

## Examples

### Parse Failed SSH Logins
```bash
#!/usr/bin/env bash
# Extract IPs attempting failed SSH logins and count them
LOG="/var/log/auth.log"
[ -r "$LOG" ] || LOG="/var/log/secure"   # RHEL/CentOS

grep -E "Failed password|Invalid user" "$LOG" \
    | grep -oP "from \K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -20
```

### Validate Config Values
```bash
#!/usr/bin/env bash
validate_ip() {
    local ip="$1"
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS='.' read -r a b c d <<< "$ip"
    [[ $a -le 255 && $b -le 255 && $c -le 255 && $d -le 255 ]]
}

for IP in 192.168.1.1 256.0.0.1 10.0.0.300 172.16.0.5; do
    if validate_ip "$IP"; then
        echo "Valid: $IP"
    else
        echo "Invalid: $IP"
    fi
done
```

## Exercises

1. Write a script that reads an nginx access log and extracts all unique URLs (field 7) that returned a 5xx status code (field 9). Output sorted by frequency.
2. Write a bash function `valid_semver <version>` that returns 0 if the string matches semantic versioning (`v1.2.3` or `1.2.3`), non-zero otherwise.
3. Parse the following log format and extract the timestamp and error message: `2024-01-15T10:23:45.123Z ERROR [myapp] Connection refused: db.internal:5432`. Use `grep -oP` or `=~`.
4. Write a script that scans all `.yaml` files in a directory for any hardcoded IP addresses (matching the IPv4 pattern) and prints filename + line number for each match.

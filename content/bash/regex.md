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

**Rule of thumb:** always use `grep -E` (ERE). The syntax is cleaner, less backslash-heavy, and matches what most other tools expect. Use `grep -P` for Perl-compatible regex (PCRE) when you need lookaheads, lookbehinds, `\d`, `\s`, or `\K` (match-reset). PCRE is not available on all systems (notably macOS ships without it by default in grep).

```bash
# BRE — clunky
grep "^\(ERROR\|WARN\)\{1,\}" app.log

# ERE — equivalent, readable
grep -E "^(ERROR|WARN)+" app.log

# PCRE — when you need lookahead or \d
grep -P "(?<=\[)\d{4}-\d{2}-\d{2}" app.log
```

**sed uses BRE by default.** Use `sed -E` (GNU) or `sed -r` (older GNU) to switch to ERE. `awk` uses its own ERE-like dialect and does not need a flag.

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

**POSIX named classes** (portable across locales, available in BRE and ERE inside `[...]`):

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
# POSIX class usage — note the double brackets
grep "[[:digit:]]\{3\}-[[:digit:]]\{4\}" contacts.txt   # BRE phone pattern
grep -E "[[:alpha:]][[:digit:]]+" codes.txt              # ERE: letter then digits
```

**PCRE shorthand classes** (require `grep -P` or Python/Go/etc.):

| Shorthand | Equivalent |
|---|---|
| `\d` | `[0-9]` |
| `\D` | `[^0-9]` |
| `\w` | `[a-zA-Z0-9_]` |
| `\W` | `[^a-zA-Z0-9_]` |
| `\s` | `[ \t\r\n\f]` |
| `\S` | `[^ \t\r\n\f]` |

**`.` matches everything except newline.** A common mistake is using `.` when you mean a literal dot (e.g., in IP address patterns). Always escape literal dots: `192\.168\.1\.1`.

---

### Anchors and Boundaries

Anchors match a position in the string, not a character.

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

# Match "error" as a whole word, not "errors" or "terror"
grep -P "\berror\b" app.log
grep -w "error" app.log       # -w is equivalent for simple words

# Lines that are blank (only whitespace counts as non-blank)
grep "^$" file.txt            # truly empty
grep -E "^\s*$" file.txt      # empty or whitespace-only (requires -P or GNU ERE)
```

**`^` and `$` inside `[...]` mean something different.** `[^abc]` means "not a, b, or c". This is a very common source of confusion.

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
| `{n,m}` | Between n and m | ERE |
| `*?` `+?` `??` | Non-greedy variants | PCRE only |

**Greedy vs. non-greedy:** standard regex is greedy — it matches as much as possible. This matters when extracting content between delimiters.

```bash
# Greedy: matches from FIRST <tag> to LAST </tag> — probably not what you want
echo "<b>bold</b> and <i>italic</i>" | grep -oP "<.+>"

# Non-greedy (PCRE only): matches each tag pair independently
echo "<b>bold</b> and <i>italic</i>" | grep -oP "<.+?>"
```

**`{n,m}` has no spaces.** `{3, 5}` is treated as a literal string in many engines, not a quantifier. Write `{3,5}`.

---

### Groups and Alternation

Groups serve two purposes: scoping quantifiers and capturing submatches.

```bash
# Alternation scoped to a group
grep -E "(ERROR|WARN|FATAL): " app.log

# Repeat a multi-character pattern
grep -E "^([0-9]{1,3}\.){3}[0-9]{1,3}$" ips.txt
# The group ([0-9]{1,3}\.) is repeated 3 times

# Non-capturing group (PCRE) — group without storing the match
grep -P "(?:ERROR|WARN): (.+)" app.log
```

**Backreferences** let you reference a captured group within the same pattern — useful in sed for rearranging fields:

```bash
# Swap first and last name: "Smith, John" → "John Smith"
echo "Smith, John" | sed -E 's/([A-Za-z]+), ([A-Za-z]+)/\2 \1/'
```

**Alternation binds loosely.** `cat|dog food` matches "cat" OR "dog food", not "cat food" OR "dog food". Use groups to scope it: `(cat|dog) food`.

---

### grep in Practice

`grep` is the primary tool for searching logs and command output. Know these flags by heart.

| Flag | Effect |
|---|---|
| `-E` | Use ERE dialect |
| `-P` | Use PCRE dialect |
| `-i` | Case-insensitive |
| `-v` | Invert match (lines NOT matching) |
| `-o` | Print only the matched portion |
| `-c` | Count matching lines |
| `-n` | Show line numbers |
| `-l` | Show only filenames |
| `-r` / `-R` | Recursive (R follows symlinks) |
| `-w` | Whole-word match |
| `-A n` | n lines of context after match |
| `-B n` | n lines of context before match |
| `-C n` | n lines before and after |
| `--color` | Highlight match (usually default) |

```bash
# Combine flags: recursive, case-insensitive, line numbers, no permission errors
grep -rniE "password|secret|token" /etc/ 2>/dev/null

# Extract only the matching text: pull all IPv4 addresses from a log
grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" access.log

# Multi-stage pipeline: HTTP 5xx status lines, then extract just the code
grep -E '" 5[0-9]{2} ' access.log | grep -oE '5[0-9]{2}' | sort | uniq -c | sort -rn

# Context for incident debugging: show what happened around a FATAL
grep -C5 "FATAL" app.log | less

# Count errors per log file across a directory
grep -rc "ERROR" /var/log/myapp/ 2>/dev/null | sort -t: -k2 -rn
```

**`grep -o` is underused.** It changes grep from a line filter into a field extractor. Combined with `sort | uniq -c`, it produces frequency tables from raw logs without needing awk.

---

### sed with Regex

`sed` is the standard tool for in-place substitution and stream transformation. Its most-used command is `s/pattern/replacement/flags`.

```bash
# Basic substitution: replace first occurrence per line
sed 's/foo/bar/' file.txt

# Global substitution (all occurrences per line)
sed 's/foo/bar/g' file.txt

# ERE syntax (GNU sed -E or -r)
sed -E 's/(ERROR|WARN)/[&]/' app.log   # & = entire matched text

# Delete lines matching a pattern
sed '/^#/d' config.txt           # remove comment lines
sed '/^[[:space:]]*$/d' file.txt # remove blank/whitespace-only lines

# In-place edit with backup (critical: always use a backup suffix)
sed -i.bak 's/localhost/db.internal/g' config.ini

# Extract a field using capture groups
echo "2024-01-15T10:23:45 ERROR db timeout" | sed -E 's/([^ ]+) ([^ ]+) (.+)/\1 | \2 | \3/'

# Strip ANSI color codes from log files
sed -E 's/\x1B\[[0-9;]*[mK]//g' colored.log
```

**`sed -i` without a backup suffix on macOS requires `sed -i ''`.** On GNU/Linux it's `sed -i`. Scripts that work on Linux will silently break on macOS CI runners unless you handle this.

**The replacement string is not a regex.** You cannot use quantifiers or character classes in the replacement — only literal text, `&` (full match), and `\1`–`\9` (capture groups).

---

### Bash `=~` Operator

The `=~` operator in `[[ ... ]]` tests a string against an ERE pattern without spawning a subprocess. Use it in scripts where you need to validate input or branch on string content.

```bash
STRING="Error: disk full at 2024-01-15"

if [[ "$STRING" =~ Error:\ (.+)\ at\ ([0-9-]+) ]]; then
    echo "Message: ${BASH_REMATCH[1]}"   # "disk full"
    echo "Date:    ${BASH_REMATCH[2]}"   # "2024-01-15"
fi
```

`BASH_REMATCH[0]` holds the full match. `BASH_REMATCH[1]`, `[2]`, etc. hold capture groups in order.

```bash
# Validate a semantic version string
VERSION="v1.14.3"
if [[ "$VERSION" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "Major: ${BASH_REMATCH[1]}"
    echo "Minor: ${BASH_REMATCH[2]}"
    echo "Patch: ${BASH_REMATCH[3]}"
else
    echo "Not a valid semver" >&2
    exit 1
fi
```

**Do not quote the pattern on the right side of `=~`.** Quoting it forces literal string comparison — the regex metacharacters stop working.

```bash
PATTERN="^[0-9]+"
[[ "123abc" =~ $PATTERN ]]    # correct — store pattern in variable, no quotes on RHS
[[ "123abc" =~ "^[0-9]+" ]]  # WRONG — matches literal string "^[0-9]+"
```

**`=~` uses ERE, not PCRE.** Features like `\d`, `\s`, lookaheads, and `\K` are not available. Use POSIX character classes (`[[:digit:]]`) or explicit ranges (`[0-9]`).

---

### Common Real-World Patterns

A reference of patterns that appear repeatedly in DevOps work. Understanding the structure is more valuable than memorizing the strings.

```bash
# IPv4 address (structural match — does not validate 0-255 range)
[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}

# IPv4 with strict anchoring (for validation)
^([0-9]{1,3}\.){3}[0-9]{1,3}$

# CIDR notation
^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[1-2][0-9]|3[0-2])$

# ISO 8601 timestamp
[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}

# Nginx access log timestamp
\[([0-9]{2}/[A-Za-z]{3}/[0-9]{4}:[0-9]{2}:[0-9]{2}:[0-9]{2} [+-][0-9]{4})\]

# Semantic version
v?[0-
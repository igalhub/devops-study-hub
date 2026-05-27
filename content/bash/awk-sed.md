---
title: awk & sed
module: bash
duration_min: 20
difficulty: intermediate
tags: [bash, awk, sed, text-processing, pipelines]
exercises: 4
---

## Overview

`awk` and `sed` are the workhorses of Unix text processing, and for a DevOps engineer they are as fundamental as knowing how to write a loop. Almost every system you operate emits text: log files, config files, command output, CSV exports, YAML fragments. The ability to reshape that text on the fly — without writing a Python script, without installing a dependency, without leaving the terminal — is what separates engineers who can debug production incidents in minutes from those who need to set up a notebook first.

`sed` (stream editor) applies editing commands to a stream of text line by line. Its sweet spot is substitution, deletion, and insertion: patching a config value across a fleet, stripping comment lines before piping output, or toggling a flag from `true` to `false` across a directory of files. `awk` is a full programming language disguised as a field processor. It splits each line into columns, lets you filter on field values, accumulate totals, and format reports — making it the right tool for anything involving structured text: access logs, `ps` output, CSV data, or the output of any command that prints in columns.

In the DevOps toolchain these two tools appear constantly in CI/CD pipeline scripts, Dockerfile `RUN` layers, Ansible tasks, Kubernetes init containers, and monitoring dashboards generated from log data. They run everywhere without installation, execute in microseconds on files that would choke a naive Python script, and compose naturally with `sort`, `uniq`, `grep`, and `xargs` in pipelines. Mastering them means you can solve the majority of text-manipulation problems with a single line rather than a dedicated script.

---

## Concepts

### sed — Stream Editor

#### How sed Processes Input

`sed` reads input one line at a time into a **pattern space**, applies your commands to that space, then prints the result (unless you suppress output with `-n`). Understanding this model explains several non-obvious behaviors: commands operate on the already-modified pattern space, so two substitutions on the same line are cumulative.

```bash
echo "foo foo foo" | sed 's/foo/bar/; s/bar/baz/'
# Output: baz bar bar
# The first s// changes the first "foo" to "bar",
# then the second s// changes the first "bar" to "baz".
```

**Key flags:**

| Flag | Meaning |
|------|---------|
| `-n` | Suppress automatic print; only print explicitly with `p` |
| `-e` | Add an expression (allows multiple commands) |
| `-i` | Edit file in place |
| `-i.bak` | Edit in place, save original with `.bak` suffix |
| `-E` / `-r` | Use extended regex (ERE) — allows `+`, `?`, `\|`, `()` without backslash |

**macOS vs Linux gotcha:** On macOS (BSD sed), `-i` *requires* a suffix argument — even an empty one: `sed -i '' 's/a/b/' file`. On GNU sed (Linux), `-i` alone works. For portable scripts, always provide a suffix or detect the OS.

#### Substitution

The `s` command is the one you will use 80% of the time.

```bash
# Basic form: s/PATTERN/REPLACEMENT/FLAGS
sed 's/old/new/'            # first match per line
sed 's/old/new/g'           # all matches per line (global)
sed 's/old/new/2'           # second match only
sed 's/old/new/gi'          # global + case-insensitive

# Capture groups (with -E for extended regex)
sed -E 's/(ERROR|WARN)/[\1]/g' app.log   # wrap severity in brackets

# Alternate delimiters — use any char when pattern contains /
sed 's|/usr/local|/opt|g' paths.txt
sed 's@http://old.host@https://new.host@g' urls.txt

# In-place substitution — the most common DevOps use
sed -i.bak 's/debug: true/debug: false/' config.yaml
sed -i 's/localhost/db.prod.internal/g' app.conf
```

**Backreference tip:** `&` in the replacement refers to the entire matched text, saving you a capture group when you just want to wrap something.

```bash
echo "192.168.1.1" | sed 's/[0-9.]*/[&]/'
# Output: [192.168.1.1]
```

#### Addressing — Targeting Specific Lines

Without an address, a sed command applies to every line. Addresses let you narrow scope.

| Address syntax | Meaning |
|----------------|---------|
| `5` | Line 5 only |
| `3,7` | Lines 3 through 7 |
| `$` | Last line |
| `/pattern/` | Lines matching regex |
| `/start/,/end/` | From first line matching `start` to next matching `end` |
| `~N` (GNU) | Every Nth line: `0~2` = even lines, `1~2` = odd lines |

```bash
sed '3s/old/new/'             # substitution on line 3 only
sed '3,7s/old/new/'           # lines 3–7
sed '$d'                      # delete last line
sed '/ERROR/s/$/  <--/g'      # append marker to ERROR lines
sed '/^#/d'                   # delete comment lines
sed '/^$/d'                   # delete blank lines
sed '/START/,/END/d'          # delete blocks between markers (inclusive)
```

**Range gotcha:** `/START/,/END/` is greedy per-block — it matches the *next* occurrence of END after each START. If END never appears, it consumes to end of file. Use this to your advantage when deleting stanzas from config files.

#### Delete, Print, Insert

```bash
# Delete
sed '5d'                      # delete line 5
sed '/pattern/d'              # delete matching lines
sed '/^#/d; /^$/d'            # strip comments and blank lines

# Print (use -n to suppress default output)
sed -n '10,20p' file.txt      # print lines 10–20
sed -n '/ERROR/p' app.log     # equivalent to: grep ERROR app.log

# Insert before / append after
sed '2i\--- inserted line ---'       # insert before line 2
sed '/pattern/a\  new_key: value'    # append YAML key after a matching line
sed '/\[section\]/a\key=value' cfg   # add key under a config section header
```

#### Multiple Expressions and Scripts

```bash
# Multiple -e flags
sed -e 's/foo/bar/' -e '/^$/d' -e 's/baz/qux/' file.txt

# Semicolon-separated (same effect)
sed 's/foo/bar/; /^$/d; s/baz/qux/' file.txt

# Multi-line script file for complex edits
cat > fix.sed <<'EOF'
s/debug: true/debug: false/
s/log_level: info/log_level: warn/
/^#.*TODO/d
EOF
sed -i -f fix.sed config.yaml
```

---

### awk — Field Processor

#### Execution Model

`awk` programs consist of `pattern { action }` rules. For each input line:
1. The line is split into fields `$1`, `$2`, ... `$NF` using `FS`.
2. Each rule is evaluated: if the pattern matches (or is absent), the action runs.
3. `BEGIN` and `END` blocks run once before and after all input, respectively.

```
awk 'BEGIN { setup } pattern { action } END { teardown }' file
```

This is fundamentally different from sed: awk is stateful across lines, can do arithmetic, has arrays, and supports full control flow (`if/else`, `for`, `while`).

#### Built-in Variables Reference

| Variable | Default | Meaning |
|----------|---------|---------|
| `$0` | — | Full current line |
| `$1`…`$NF` | — | Individual fields |
| `NF` | — | Number of fields on current line |
| `NR` | — | Current record (line) number, across all files |
| `FNR` | — | Record number within the current file |
| `FS` | `" "` | Input field separator (space/tab) |
| `OFS` | `" "` | Output field separator |
| `RS` | `"\n"` | Input record separator |
| `ORS` | `"\n"` | Output record separator |
| `FILENAME` | — | Name of current input file |

**`FS=" "` special behavior:** a single space (the default) means "split on any run of whitespace and strip leading/trailing whitespace." This is different from `FS="\t"` or `FS=" "` set explicitly via `-v`. Set `FS="\t"` explicitly for TSV files.

#### Field Separators and Output Formatting

```bash
# Set FS at invocation
awk -F: '{print $1, $7}' /etc/passwd          # colon-delimited
awk -F'\t' '{print $2, $4}' report.tsv        # tab-delimited
awk -F'[,;]' '{print $1}' mixed.csv           # regex separator: comma or semicolon

# OFS controls what print $1,$2 puts between fields
awk 'BEGIN {OFS=","} {print $1,$3,$5}' data.txt     # produces CSV
awk 'BEGIN {OFS="\t"} {print $2,$4}' data.txt       # produces TSV

# printf for fixed-width, aligned output
awk '{printf "%-30s %8.2f MB\n", $1, $2/1024}' sizes.txt
```

#### Patterns: Filtering Lines

```bash
# Regex pattern
awk '/ERROR/'  app.log                    # print lines matching ERROR
awk '!/DEBUG/' app.log                    # print lines NOT matching DEBUG

# Field comparison
awk '$9 >= 500'           access.log      # HTTP 5xx
awk '$3 == "CRITICAL"'    syslog          # exact field match
awk '$5 > 1000'           metrics.txt     # numeric comparison
awk 'NR > 1'              file.txt        # skip header line
awk 'NR==1 || $5 > 80'    df_output.txt  # header + high-usage rows

# Compound conditions
awk '$9 >= 500 && $9 < 600' access.log   # 5xx only (not 6xx if it existed)
awk '/ERROR/ || /FATAL/'    app.log       # either pattern
awk 'NR>=10 && NR<=20'      file.txt     # line range (alternative to sed)
```

#### Aggregation and Counters

```bash
# Sum a column
awk '{sum += $5} END {print "Total:", sum}' data.txt

# Count occurrences
awk '/ERROR/ {count++} END {print "Errors:", count+0}' app.log

# Frequency map using an associative array
awk '{freq[$1]++} END {for (ip in freq) print freq[ip], ip}' access.log \
  | sort -rn | head -10

# Multiple counters
awk '
  {total++}
  $9 ~ /^2/ {ok++}
  $9 ~ /^4/ {client_err++}
  $9 ~ /^5/ {server_err++}
  END {
    printf "Total: %d\n2xx: %d\n4xx: %d\n5xx: %d\n",
           total, ok+0, client_err+0, server_err+0
  }
' access.log
```

**Uninitialized variable gotcha:** In awk, uninitialized numeric variables are `0` and uninitialized strings are `""`. The `count+0` pattern forces numeric context so you print `0` instead of an empty string when no lines matched.

#### Arrays

awk arrays are associative (hash maps) — keys can be strings or numbers.

```bash
# Build a map of status codes to counts
awk '{codes[$9]++} END {
    for (code in codes)
        printf "%s: %d\n", code, codes[code]
}' access.log | sort

# Two-dimensional key (awk simulates with SUBSEP)
awk '{count[$1][$9]++}' access.log    # syntax error — not valid
awk '{count[$1 SUBSEP $9]++}' access.log  # correct: use SUBSEP
```

#### Multi-file Processing and FNR vs NR

```bash
# NR: global line number across all input files
# FNR: line number within the current file — use this for per-file headers

awk 'FNR==1 {print "--- File:", FILENAME} {print NR, $0}' file1.txt file2.txt

# Process header from first file only
awk 'FNR==1 && NR==1 {print; next} FNR==1 {next} {print}' *.csv
# Prints header from first CSV, skips headers from subsequent CSVs — useful for concatenation
```

---

### Combining sed and awk in Pipelines

The real power is composition. Use each tool for what it does best:

- **sed** for line-level editing: strip noise, normalize delimiters, fix encoding artifacts
- **awk** for field-level analysis: extract columns, aggregate, report
- **sort / uniq** between them for ranking

```bash
# Pattern: normalize → extract → aggregate → sort → limit
sed '/^#/d; /^$/d' access.log \          # strip comments and blanks
  | awk '{print $1, $9}' \              # extract IP and status code
  | sort \                              # sort for uniq
  | uniq -c \                           # count unique pairs
  | sort -rn \                          # rank by frequency
  | head -20                            # top 20
```

**Performance note:** For files under a few hundred MB, awk is fast enough that optimization rarely matters. For multi-GB log files, consider filtering with `grep` first to reduce input volume before piping to awk — `grep` is highly optimized and often 5–10× faster for simple pattern matching.

---

### In-Place Editing Safety Patterns

In-place editing with `sed -i` is destructive. Follow these patterns in production scripts:

```bash
# Always create a backup
sed -i.bak 's/old/new/g' critical.conf

# Verify before applying (dry run: print to stdout)
sed 's/old/new/g' critical.conf | diff critical.conf -

# Apply only if diff shows expected changes
sed 's/old/new/g' critical.conf | diff critical.conf - && \
  sed -i.bak 's/old/new/g' critical.conf

# Use a temp file for complex multi-step edits
tmp=$(mktemp)
sed 's/foo/bar/g' original.conf | awk '...' > "$tmp"
mv "$tmp" original.conf
```

**`mv` atomicity:** On the same filesystem, `mv` is atomic (a rename syscall). Writing to a temp file then `mv`-ing it over the target is safer than in-place editing — the target is never partially written if your pipeline crashes midway.

---

## Examples

### Example 1: nginx Access Log Analysis Script

Parse a standard nginx combined log format and produce an operations summary.

```bash
#!/usr/bin/env bash
# analyze_access_log.sh — nginx access log report
# Usage: ./analyze_access_log.sh /var/log/nginx/access.log

LOG="${1:-/var/log/nginx/access.log}"

if [[ ! -f "$LOG" ]]; then
  echo "ERROR: Log file not found: $LOG" >&2
  exit 1
fi

echo "========================================"
echo " nginx Access Log Report"
echo " File: $LOG"
echo " Lines: $(wc -l < "$LOG")"
echo "========================================"

echo ""
echo "--- HTTP Status Code Distribution ---"
# Field 9 in combined log is the status code
awk '{codes[$9]++}
     END {
       for (c in codes)
         printf "%5d  %s\n", codes[c], c
     }'
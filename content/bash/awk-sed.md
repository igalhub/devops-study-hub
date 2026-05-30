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
| `-e` | Add an expression (allows multiple commands inline) |
| `-i` | Edit file in place |
| `-i.bak` | Edit in place, save original with `.bak` suffix |
| `-E` / `-r` | Use extended regex (ERE) — allows `+`, `?`, `\|`, `()` without backslash |
| `-f script` | Read commands from a file instead of inline |

**macOS vs Linux gotcha:** On macOS (BSD sed), `-i` *requires* a suffix argument — even an empty one: `sed -i '' 's/a/b/' file`. On GNU sed (Linux), `-i` alone works. For portable scripts, always provide a suffix or detect the OS. Omitting the suffix on macOS produces a cryptic error about a missing input file, not a helpful message about the flag.

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

**Backreference tip:** `&` in the replacement refers to the entire matched text, saving you a capture group when you just want to wrap or prefix something.

```bash
echo "192.168.1.1" | sed 's/[0-9.]*/[&]/'
# Output: [192.168.1.1]

# Prefix every non-blank line with a timestamp placeholder
sed '/./s/^/2024-01-01 /' file.txt
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
| `0,/pattern/` (GNU) | From line 0 to first match — matches line 1 if it matches |
| `~N` (GNU) | Every Nth line: `0~2` = even lines, `1~2` = odd lines |
| `addr!` | Negation: apply to lines that do NOT match addr |

```bash
sed '3s/old/new/'             # substitution on line 3 only
sed '3,7s/old/new/'           # lines 3–7
sed '$d'                      # delete last line
sed '/ERROR/s/$/  <--/g'      # append marker to ERROR lines
sed '/^#/d'                   # delete comment lines
sed '/^$/d'                   # delete blank lines
sed '/START/,/END/d'          # delete blocks between markers (inclusive)
sed '/pattern/!d'             # delete lines that do NOT match pattern
```

**Range gotcha:** `/START/,/END/` is greedy per-block — it matches the *next* occurrence of END after each START. If END never appears after a START, the range consumes to end of file. This is useful when deleting stanzas from config files, but can silently delete more than intended if your END pattern is absent or misspelled. Always diff before committing an in-place edit.

#### Delete, Print, Insert, and Append

```bash
# Delete
sed '5d'                      # delete line 5
sed '/pattern/d'              # delete matching lines
sed '/^#/d; /^$/d'            # strip comments and blank lines in one pass

# Print (use -n to suppress default output — otherwise each line prints twice)
sed -n '10,20p' file.txt      # print lines 10–20
sed -n '/ERROR/p' app.log     # equivalent to: grep ERROR app.log
sed -n '/START/,/END/p' file  # print a named block

# Insert before / append after a line
sed '2i\--- inserted line ---'       # insert before line 2
sed '/pattern/a\  new_key: value'    # append YAML key after a matching line
sed '/\[section\]/a\key=value' cfg   # add key under a config section header

# Change a line entirely
sed '/^version:/c\version: "2.0"' config.yaml
```

**`-n` with `p` is the correct grep alternative** when you need line numbers or surrounding context without installing GNU grep on a minimal container image: `sed -n '/ERROR/{=;p}' app.log` prints the line number (`=`) then the line (`p`).

#### Multiple Expressions and Script Files

```bash
# Multiple -e flags — readable for 2–3 commands
sed -e 's/foo/bar/' -e '/^$/d' -e 's/baz/qux/' file.txt

# Semicolon-separated (same effect, more compact)
sed 's/foo/bar/; /^$/d; s/baz/qux/' file.txt

# Script file — the right approach for production automation
cat > fix.sed <<'EOF'
s/debug: true/debug: false/
s/log_level: info/log_level: warn/
/^#.*TODO/d
EOF
sed -i.bak -f fix.sed config.yaml
```

Script files make complex edits auditable and version-controllable — commit `fix.sed` to your repo alongside the Ansible playbook or CI script that calls it.

---

### awk — Field Processor

#### Execution Model

`awk` programs consist of `pattern { action }` rules. For each input line:
1. The line is split into fields `$1`, `$2`, ... `$NF` using `FS`.
2. Each rule is evaluated in order: if the pattern matches (or is absent), the action runs.
3. `BEGIN` and `END` blocks run once before and after all input, respectively.

```
awk 'BEGIN { setup } pattern { action } END { teardown }' file
```

This is fundamentally different from sed: awk is stateful across lines, can do arithmetic, has arrays, and supports full control flow (`if/else`, `for`, `while`). Think of it as a row-oriented database query engine where each line is a row and each field is a column.

#### Built-in Variables Reference

| Variable | Default | Meaning |
|----------|---------|---------|
| `$0` | — | Full current line |
| `$1`…`$NF` | — | Individual fields |
| `NF` | — | Number of fields on current line |
| `NR` | — | Current record (line) number, across all files |
| `FNR` | — | Record number within the current file |
| `FS` | `" "` | Input field separator |
| `OFS` | `" "` | Output field separator |
| `RS` | `"\n"` | Input record separator |
| `ORS` | `"\n"` | Output record separator |
| `FILENAME` | — | Name of current input file |

**`FS=" "` special behavior:** a single space (the default) means "split on any run of whitespace and strip leading/trailing whitespace." This is different from `FS="\t"` or `FS=" "` set explicitly via `-v`. This default is why `awk '{print $1}'` works on `ps`, `df`, and `ls -l` output without any flag. Set `FS="\t"` explicitly for TSV files where a field may be empty.

**Modifying fields:** Assigning to `$1` or any field causes `$0` to be reconstructed using `OFS` as the delimiter. This is how you reformat a line: set `OFS`, modify a field, print `$0`.

```bash
# Change the 3rd field and reprint the whole line
awk 'BEGIN{OFS=":"} {$3="REDACTED"; print $0}' /etc/passwd
```

#### Field Separators and Output Formatting

```bash
# Set FS at invocation
awk -F: '{print $1, $7}' /etc/passwd          # colon-delimited
awk -F'\t' '{print $2, $4}' report.tsv        # tab-delimited
awk -F'[,;]' '{print $1}' mixed.csv           # regex separator: comma or semicolon

# OFS controls what print $1,$2 puts between fields
# Note: comma in print → OFS; space in print → literal space
awk 'BEGIN {OFS=","} {print $1,$3,$5}' data.txt     # produces CSV
awk 'BEGIN {OFS="\t"} {print $2,$4}' data.txt       # produces TSV

# printf for fixed-width, aligned output
awk '{printf "%-30s %8.2f MB\n", $1, $2/1024}' sizes.txt

# printf format reference
# %-30s  left-aligned string, 30 chars wide
# %8.2f  right-aligned float, 8 chars wide, 2 decimal places
# %05d   zero-padded integer
```

#### Patterns: Filtering Lines

```bash
# Regex pattern
awk '/ERROR/'  app.log                    # print lines matching ERROR
awk '!/DEBUG/' app.log                    # print lines NOT matching DEBUG
awk '$0 ~ /pattern/'  file               # explicit match operator (same as /pattern/)
awk '$3 !~ /SKIP/'    file               # field 3 does not match regex

# Field comparison
awk '$9 >= 500'           access.log      # HTTP 5xx
awk '$3 == "CRITICAL"'    syslog          # exact field match
awk '$5 > 1000'           metrics.txt     # numeric comparison
awk 'NR > 1'              file.txt        # skip header line
awk 'NR==1 || $5 > 80'    df_output.txt  # header + high-usage rows

# Compound conditions
awk '$9 >= 500 && $9 < 600' access.log   # 5xx only
awk '/ERROR/ || /FATAL/'    app.log       # either pattern
awk 'NR>=10 && NR<=20'      file.txt     # line range — sometimes cleaner than sed

# Range pattern (stateful — no braces needed between start and end)
awk '/BEGIN_BLOCK/,/END_BLOCK/' file.txt
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

# Average
awk '{sum += $3; count++} END {printf "Average: %.2f\n", sum/count}' metrics.txt

# Min/max
awk 'NR==1 {min=max=$1} {if($1<min)min=$1; if($1>max)max=$1}
     END {print "min:", min, "max:", max}' values.txt

# Multiple counters — HTTP status breakdown
awk '
  {total++}
  $9 ~ /^2/ {ok++}
  $9 ~ /^4/ {client_err++}
  $9 ~ /^5/ {server_err++}
  END {
    printf "Total:  %d\n2xx:    %d\n4xx:    %d\n5xx:    %d\n",
           total, ok+0, client_err+0, server_err+0
  }
' access.log
```

**Uninitialized variable gotcha:** In awk, uninitialized numeric variables are `0` and uninitialized strings are `""`. The `count+0` pattern forces numeric context so you print `0` instead of an empty string when no lines matched. This is especially important in `END` blocks where a counter may never have been incremented.

#### Arrays

awk arrays are associative (hash maps) — keys can be strings or numbers, and they spring into existence on first assignment.

```bash
# Build a map of status codes to counts
awk '{codes[$9]++} END {
    for (code in codes)
        printf "%s: %d\n", code, codes[code]
}' access.log | sort

# Check if a key exists before using it
awk '{
    if ($1 in seen) { print "duplicate:", $1 }
    else seen[$1] = 1
}' ids.txt

# Delete a key
awk '{delete seen[$1]}' file.txt

# Multi-dimensional simulation with SUBSEP
# awk does not support true multi-dim arrays; use SUBSEP as a compound key
awk '{count[$1 SUBSEP $9]++}
     END {
       for (key in count) {
         split(key, parts, SUBSEP)
         printf "IP: %-15s  Status: %s  Count: %d\n",
                parts[1], parts[2], count[key]
       }
     }' access.log
```

**`for (key in array)` order is undefined.** awk does not guarantee iteration order over array keys. Always pipe to `sort` if order matters in your output.

#### Multi-file Processing and FNR vs NR

```bash
# NR: global line number across all input files
# FNR: line number within the current file

# Print filename header at start of each file
awk 'FNR==1 {print "--- File:", FILENAME} {print NR, $0}' file1.txt file2.txt

# Merge CSVs: print header from first file, skip headers from rest
awk 'FNR==1 && NR==1 {print; next} FNR==1 {next} {print}' *.csv

# Cross-reference two files: load file1 into array, look up in file2
awk 'NR==FNR {allowed[$1]=1; next}   # runs for first file only
     $1 in allowed {print}' \         # runs for second file
     whitelist.txt access.log
```

The `NR==FNR` idiom is one of the most useful awk patterns for DevOps work — it lets you join two files without sort or a database.

---

### Combining sed and awk in Pipelines

The real power is composition. Use each tool for what it does best:

- **sed** for line-level editing: strip noise, normalize delimiters, fix encoding artifacts
- **awk** for field-level analysis: extract columns, aggregate, report
- **sort / uniq** between them for ranking and deduplication

```bash
# Pattern: normalize → extract → aggregate → sort → limit
sed '/^#/d; /^$/d' access.log \          # strip comments and blanks
  | awk '{print $1, $9}' \              # extract IP and status code
  | sort \                              # sort for uniq
  | uniq -c \                           # count unique pairs
  | sort -rn \                          # rank by frequency
  | head -20                            # top 20
```

**Pipeline tool selection guide:**

| Task | Best tool |
|------|-----------|
| Find lines matching a pattern | `grep` |
| Edit/replace text in lines | `sed` |
| Extract and reformat fields | `awk` |
| Count occurrences | `awk` or `sort \| uniq -c` |
| Sort output | `sort` |
| Remove duplicates | `sort -u` or `uniq` |
| Aggregate across lines | `awk` |
| Structured formats (JSON, XML) | `jq`, `xmllint` |

**Performance note:** For files under a few hundred MB, awk is fast enough that optimization rarely matters. For multi-GB log files, filter with `grep` first to reduce input volume before piping to awk — `grep` uses highly optimized Boyer-Moore matching and is often 5–10× faster for simple pattern matching than an awk regex on the same data.

---

### In-Place Editing Safety Patterns

In-place editing with `sed -i` is destructive. Production scripts must handle failures gracefully.

```bash
# Always create a backup on first use in a script
sed -i.bak 's/old/new/g' critical.conf

# Verify before applying (dry run: diff stdout vs original)
sed 's/old/new/g' critical.conf | diff critical.conf -

# Abort if diff finds unexpected changes
expected_changes=1
actual_changes=$(sed 's/old/new/g' critical.conf | diff critical.conf - | grep '^[<>]' | wc -l)
[[ "$actual_changes" -eq "$expected_changes" ]] || { echo "Unexpected diff"; exit 1; }

# Use a temp file for multi-step edits — safer than chained -i
tmp=$(mktemp /tmp/config.XXXXXX)
sed 's/foo/bar/g' original.conf \
  | awk '/\[section\]/{found=1} found && /^key=/{$0="key=newvalue"; found=0} {print}' \
  > "$tmp"
mv "$tmp" original.conf  # atomic on same filesystem
```

**`mv` atomicity:** On the same filesystem, `mv` is a single `rename(2)` syscall — atomic. The target file is never partially written if your pipeline crashes midway. Writing to a temp file then `mv`-ing it over the target is always safer than in-place editing for critical config files.

**Verify your changes were applied:**
```bash
grep -c 'new_value' critical.conf || { echo "Edit failed to apply"; exit 1; }
```

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
# Field 9 in nginx combined log is the status code
awk '{codes[$9]++}
     END {
       for (c in codes)
         printf "%5d  %s\n", codes[c], c
     }' "$LOG" | sort -rn

echo ""
echo "--- Top 10 Client IPs ---"
# Field 1 is the client IP
awk '{ips[$1]++}
     END {for (ip in ips) print ips[ip], ip}' "$LOG" \
  | sort -rn | head -10 \
  | awk '{printf "%5d requests  %s\n", $1, $2}'

echo ""
echo "--- Top 10 Requested URLs ---"
# Field 7 is the request path (strip query string with sed)
awk '{print $7}' "$LOG" \
  | sed 's/?.*$//' \          # strip query strings for grouping
  | sort | uniq -c \
  | sort -rn | head -10 \
  | awk '{printf "%5d  %s\n", $1, $2}'

echo ""
echo "--- 5xx Errors (last 20) ---"
# Show recent server errors with timestamp and URL
awk '$9 >= 500 && $9 < 600 {print $4, $7, $9}' "$LOG" \
  | sed 's/\[//' \            # strip the [ from timestamp field
  | tail -20

echo ""
echo "--- Traffic by Hour ---"
# Field 4 looks like: [01/Jan/2024:14:32:01
awk '{
    # Extract hour from timestamp field: [DD/Mon/YYYY:HH
    match($4, /:[0-9]{2}:/, arr)
    hour = substr($4, RSTART+1, 2)
    hourly[hour]++
}
END {
    for (h in hourly)
        printf "%s:00  %d requests\n", h, hourly[h]
}' "$LOG" | sort
```

**Verify it works:**
```bash
chmod +x analyze_access_log.sh
# Use a sample log if you don't have nginx running:
curl -s https://raw.githubusercontent.com/elastic/examples/master/Common%20Data%20Formats/nginx_logs/nginx_logs \
  -o sample_nginx.log
./analyze_access_log.sh sample_nginx.log
```

---

### Example 2: Config File Patching Across a Fleet

A common CI/CD task: update a version string and toggle a feature flag in config files before deployment.

```bash
#!/usr/bin/env bash
# patch_configs.sh — update app configs for a new release
# Usage: ./patch_configs.sh <new_version> <config_dir>

NEW_VERSION="${1:?Usage: $0 <version> <config_dir>}"
CONFIG_DIR="${2:?Usage: $0 <version> <config_dir>}"

# Build a sed script — easier to maintain than multiple -e flags
PATCH_SCRIPT=$(mktemp /tmp/patch.XXXXXX.sed)
cat > "$PATCH_SCRIPT" <<EOF
# Update version string
s/^app_version=.*/app_version=${NEW_VERSION}/

# Enable maintenance mode during deploy
s/^maintenance_mode=false/maintenance_mode=true/

# Rotate to new log path
s|log_path=/var/log/app/old|log_path=/var/log/app/current|g

# Remove deprecated keys (lines starting with legacy_)
/^legacy_/d
EOF

echo "Applying patch to configs in: $CONFIG_DIR"
patched=0
failed=0

for cfg in "$CONFIG_DIR"/*.conf; do
  [[ -f "$cfg" ]] || continue

  # Dry run: count changed lines
  changes=$(sed -f "$PATCH_SCRIPT" "$cfg" | diff "$cfg" - | grep -c '^[<>]')

  if [[ "$changes" -gt 0 ]]; then
    sed -i.bak -f "$PATCH_SCRIPT" "$cfg"
    echo "  PATCHED ($changes changes): $cfg"
    ((patched++))
  else
    echo "  SKIPPED (no changes): $cfg"
  fi
done

rm -f "$PATCH_SCRIPT"
echo ""
echo "Done. Patched: $patched configs."

# Verify: no file should still contain legacy_ keys
legacy_count=$(grep -rl '^legacy_' "$CONFIG_DIR"/*.conf 2>/dev/null | wc -l)
if [[ "$legacy_count" -gt 0 ]]; then
  echo "WARNING: $legacy_count files still contain legacy_ keys" >&2
  exit 1
fi
```

---

### Example 3: Kubernetes Pod Resource Report

Extract CPU and memory requests from `kubectl` output and produce a formatted summary.

```bash
#!/usr/bin/env bash
# pod_resources.sh — summarize resource requests by namespace
# Requires: kubectl configured with cluster access

NAMESPACE="${1:---all-namespaces}"
KUBECTL_ARGS=("--all-namespaces")
[[ "$NAMESPACE" != "--all-namespaces" ]] && KUBECTL_ARGS=("-n" "$NAMESPACE")

# kubectl top pods output format:
# NAMESPACE   NAME                          CPU(cores)   MEMORY(bytes)
# default     nginx-7d6b84c9f5-xk9p2        2m           18Mi

kubectl top pods "${KUBECTL_ARGS[@]}" 2>/dev/null \
  | awk '
    NR == 1 { next }   # skip header

    {
      ns   = $1
      name = $2
      cpu  = $3
      mem  = $4

      # Strip units: "42m" → 42 (millicores), "128Mi" → 128
      sub(/m$/, "", cpu)
      sub(/Mi$/, "", mem)

      # Accumulate per-namespace
      ns_cpu[ns]  += cpu
      ns_mem[ns]  += mem
      ns_pods[ns]++

      total_cpu += cpu
      total_mem += mem
      total_pods++
    }

    END {
      printf "%-20s  %6s  %8s  %8s\n", "NAMESPACE", "PODS", "CPU(m)", "MEM(Mi)"
      printf "%-20s  %6s  %8s  %8s\n", "---", "---", "---", "---"
      for (ns in ns_pods)
        printf "%-20s  %6d  %8d  %8d\n", ns, ns_pods[ns], ns_cpu[ns], ns_mem[ns]
      printf "%-20s  %6d  %8d  %8d\n", "TOTAL", total_pods, total_cpu, total_mem
    }
  ' | sort -k1

# Also flag any pod using more than 500m CPU
echo ""
echo "--- High CPU Pods (>500m) ---"
kubectl top pods "${KUBECTL_ARGS[@]}" 2>/dev/null \
  | awk 'NR>1 { cpu=$3; sub(/m$/,"",cpu); if(cpu+0 > 500) print $1, $2, $3, $4 }' \
  | awk '{printf "  %-20s %-40s CPU: %s  MEM: %s\n", $1, $2, $3, $4}'
```

---

### Example 4: Log Anomaly Detection with awk

Detect bursts of errors within a rolling time window — a pattern used in alerting scripts before a full monitoring stack is available.

```bash
#!/usr/bin/env bash
# error_burst.sh — alert if error rate exceeds threshold in any 60-second window
# Usage: ./error_burst.sh /var/log/app/app.log
# Log format: 2024-01-15T14:32:01 ERROR [module] message

LOG="${1:-/var/log/app/app.log}"
THRESHOLD=10   # errors per 60-second window
WINDOW=60      # seconds

awk -v threshold="$THRESHOLD" -v window="$WINDOW" '
# Parse ISO 8601 timestamp into epoch seconds (GNU awk only — uses mktime)
function parse_ts(ts,    parts, t) {
    # ts format: 2024-01-15T14:32:01
    gsub(/[-T:]/, " ", ts)
    split(ts, parts, " ")
    t = mktime(parts[1] " " parts[2] " " parts[3] " " \
               parts[4] " " parts[5] " " parts[6])
    return t
}

/ERROR/ {
    epoch = parse_ts($1)
    # Slide a window: keep only errors within last `window` seconds
    times[NR] = epoch
    error_count++

    # Expire old entries outside the window
    for (i in times) {
        if (epoch - times[i] > window) {
            delete times[i]
            error_count--
        }
    }

    # Check threshold
    if (error_count >= threshold) {
        printf "ALERT: %d errors in %d seconds ending at %s (line %d)\n",
               error_count, window, $1, NR
        # Reset to avoid repeated alerts for the same burst
        delete times
        error_count = 0
    }
}
' "$LOG"
```

---

## Exercises

### Exercise 1: Parsing df Output

The command `df -h` prints filesystem usage in human-readable form. Its output includes a header line and columns for filesystem, size, used, available, use%, and mount point.

**Task:** Write a single `awk` command that:
1. Skip the header line
2. Print only filesystems where usage exceeds 80%
3. Output: `MOUNT_POINT  USE%  AVAILABLE` in a formatted table using `printf`
4. Add a final `END` block that prints a count of how many filesystems are over the threshold

The use% field contains a `%` character — you will need to strip it before numeric comparison. Use `sub(/%/, "", $5)` or string slicing.

**Verify:** Run `df -h | your_command` and confirm that only high-usage mounts appear. On a clean system, fake the data: `echo -e "Filesystem Size Used Avail Use% Mount\n/dev/sda1 20G 17G 2G 86% /\ntmpfs 2G 100M 1.9G 5% /tmp" | your_command`

---

### Exercise 2: Config File Normalization

You have a legacy config file with inconsistent formatting: some keys use spaces around `=`, some use tabs, comment lines start with `#` or `;`, and there are blank lines throughout.

**Setup:**
```bash
cat > legacy.conf <<'EOF'
; old comment style
# new comment style

  host = localhost
port=5432
  db_name   =   myapp
  ssl = true

; deprecated
old_key = ignored
EOF
```

**Task:** Using `sed` (not awk), produce a normalized version that:
1. Remove all comment lines (starting with `;` or `#`, possibly with leading whitespace)
2. Remove blank lines
3. Strip all whitespace around the `=` sign (so `  host = localhost` becomes `host=localhost`)
4. Write the result to `normalized.conf` using a temp file + mv pattern (not `-i`)

**Verify:** `cat normalized.conf` should produce exactly:
```
host=localhost
port=5432
db_name=myapp
ssl=true
old_key=ignored
```

---

### Exercise 3: Log Join Across Two Files

You have two files: `requests.log` (request ID and URL) and `errors.log` (request ID and error message). You need to find which URLs produced errors.

**Setup:**
```bash
cat > requests.log <<'EOF'
req001 /api/users
req002 /api/orders
req003 /healthz
req004 /api/users/42
req005 /api/payments
EOF

cat > errors.log <<'EOF'
req002 "database connection timeout"
req005 "payment gateway unreachable"
req004 "user not found"
EOF
```

**Task:** Using a single `awk` command with both files as input, print lines in the format:
```
req002  /api/orders  "database connection timeout"
```
Only request IDs that appear in `errors.log` should be printed. Use the `NR==FNR` idiom to load one file into an array, then look up from the second.

**Stretch goal:** Sort the output by request ID and add a count at the end: `Total errors: N`.

---

### Exercise 4: Rolling Metric Summarizer

You have a metrics dump where each line contains a Unix timestamp and a response time in milliseconds:

```bash
# Generate sample data
awk 'BEGIN {
    srand(42)
    ts = 1700000000
    for (i = 0; i < 200; i++) {
        ts += int(rand() * 10) + 1
        ms = int(rand() * 500) + 10
        print ts, ms
    }
}' > metrics.txt
```

**Task:** Write an `awk` script (not a one-liner — use a file) that:
1. Group response times into 30-second buckets based on the timestamp field
2. For each bucket, prints: `BUCKET_START  COUNT  AVG_MS  MAX_MS`
3. Flag any bucket where average response time exceeds 250ms with `[SLOW]` at the end of the line
4. At the end, prints the overall average across all samples

**Hint:** Compute bucket start with `bucket = int($1 / 30) * 30`. Use separate arrays for count, sum, and max keyed by bucket. Iterate over buckets in sorted order in the `END` block — collect keys into an array and use `asort()` (GNU awk) or pipe the output to `sort -n`.

---

### Quick Checks

5. Using `awk`, sum the values piped from `printf '10\n20\n30\n40\n'` and print the total. Write a one-liner: `printf '10\n20\n30\n40\n' | awk ...`

```expected_output
100
```

hint: Think about how awk can accumulate a running total across all input lines using a variable.
hint: Use an awk pattern with a variable like `sum += $1` in the main block and an END rule to print the accumulated total.

6. Using `sed`, replace every space in the string `"the quick brown fox"` with a hyphen and print the result. Write a one-liner: `echo "the quick brown fox" | sed ...`

```expected_output
the-quick-brown-fox
```
hint: Think about how sed can be used to find and replace characters using a substitution pattern.
hint: Use sed's substitution command in the form s/old/new/g, where the g flag applies the replacement to every occurrence on the line.

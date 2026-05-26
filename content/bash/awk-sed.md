---
title: awk & sed
module: bash
duration_min: 20
difficulty: intermediate
tags: [bash, awk, sed, text-processing, pipelines]
exercises: 4
---

## Overview
`awk` and `sed` are the workhorses of Unix text processing. `sed` edits streams — find-and-replace, delete lines, insert text. `awk` processes structured data — extracts fields, computes sums, generates reports. Together they handle 90% of log parsing and config manipulation tasks without a scripting language.

## Concepts

### sed — Stream Editor

#### Substitution
```bash
# s/pattern/replacement/flags
sed 's/old/new/'          # replace first occurrence on each line
sed 's/old/new/g'         # replace all occurrences (global)
sed 's/old/new/2'         # replace second occurrence only
sed 's/old/new/gi'        # global + case-insensitive

# In-place edit (modifies the file directly)
sed -i 's/localhost/db.prod.internal/g' app.conf

# In-place with backup (safer — keeps original as .bak)
sed -i.bak 's/debug: true/debug: false/' config.yaml

# Use different delimiter when pattern contains /
sed 's|/opt/old|/opt/new|g' paths.txt
```

#### Addressing — Which Lines to Act On
```bash
# Line number
sed '3s/old/new/'         # only line 3
sed '3,7s/old/new/'       # lines 3 through 7
sed '$s/old/new/'         # only last line

# Pattern match
sed '/ERROR/s/old/new/'   # only lines matching ERROR
sed '/^#/d'               # delete comment lines (starting with #)

# Range by pattern
sed '/START/,/END/s/old/new/'   # between START and END
sed '/^BEGIN/,/^END/d'          # delete between markers
```

#### Delete, Print, Append
```bash
# Delete lines
sed '5d'                  # delete line 5
sed '/^$/d'               # delete blank lines
sed '/^#/d'               # delete comment lines

# Print specific lines (with -n to suppress default print)
sed -n '10,20p' file.txt  # print lines 10-20
sed -n '/ERROR/p' log     # print only error lines (like grep)

# Insert / append text
sed '2i\inserted line'    # insert before line 2
sed '2a\appended line'    # append after line 2
sed '/pattern/a\new line' # append after matching line
```

#### Multiple Expressions
```bash
sed -e 's/foo/bar/' -e 's/baz/qux/' file.txt
# Or with semicolons:
sed 's/foo/bar/; s/baz/qux/' file.txt
```

### awk — Field Processor
awk processes text line by line. Each line is split into fields (`$1`, `$2`, ...). `$0` is the full line. The default field separator is whitespace.

#### Basic Structure
```bash
awk 'pattern { action }' file
# If pattern is omitted: action runs on every line
# If action is omitted: print lines matching pattern
```

#### Built-in Variables
```bash
$1, $2, ... $NF    # fields ($NF = last field)
$0                 # full line
NF                 # number of fields
NR                 # record number (line number)
FS                 # field separator (default: whitespace)
OFS                # output field separator (default: space)
RS                 # record separator (default: newline)
```

#### Common Patterns
```bash
# Print specific fields
awk '{print $1, $3}' access.log

# Print last field
awk '{print $NF}' file.txt

# Use custom field separator
awk -F: '{print $1, $7}' /etc/passwd        # colon-delimited
awk -F, '{print $2}' data.csv               # CSV (simple, no quoted commas)
awk -F'\t' '{print $3}' data.tsv            # tab-delimited

# Filter lines by field value
awk '$9 >= 500' access.log                  # HTTP 5xx responses
awk '$3 == "root"' /etc/passwd              # lines where field 3 is "root"
awk 'NR > 1' file.txt                       # skip header line

# Sum a column
awk '{sum += $5} END {print sum}' data.txt

# Count lines matching a pattern
awk '/ERROR/ {count++} END {print count}' app.log

# Print line number with line
awk '{print NR": "$0}' file.txt
```

#### BEGIN and END Blocks
```bash
awk '
    BEGIN { print "Starting..." }
    /ERROR/ { errors++ }
    /WARN/  { warns++ }
    END {
        print "Errors:", errors+0
        print "Warnings:", warns+0
    }
' app.log
```

#### Formatting Output
```bash
# printf for formatted output
awk '{printf "%-20s %5d\n", $1, $2}' data.txt

# Output field separator
awk 'BEGIN {OFS=","} {print $1,$3,$5}' data.txt   # produce CSV
```

## Examples

### Parse nginx Access Log
```bash
#!/usr/bin/env bash
LOG="/var/log/nginx/access.log"

echo "=== Top 10 IPs by request count ==="
awk '{print $1}' "$LOG" | sort | uniq -c | sort -rn | head -10

echo "=== HTTP Status Code Distribution ==="
awk '{print $9}' "$LOG" | sort | uniq -c | sort -rn

echo "=== Top 10 Slowest Requests ==="
awk '{print $NF, $7}' "$LOG" | sort -rn | head -10
```

### Edit Config In Place
```bash
#!/usr/bin/env bash
# Update an nginx upstream port
OLD_PORT="8080"
NEW_PORT="9090"

sed -i.bak "s/server 127\.0\.0\.1:${OLD_PORT}/server 127.0.0.1:${NEW_PORT}/g" \
    /etc/nginx/conf.d/upstream.conf

nginx -t && systemctl reload nginx
```

### Extract Column with Header
```bash
#!/usr/bin/env bash
# Print the "Memory" column from `free -m`
free -m | awk 'NR==1 {
    for (i=1; i<=NF; i++) {
        if ($i == "total") col=i+1
    }
} NR==2 { print "Total memory:", $col, "MB" }'
```

### Disk Usage Report
```bash
df -h | awk 'NR==1 || $5+0 >= 80 {printf "%-20s %5s %5s %5s %s\n", $1,$2,$3,$4,$5}'
# Prints header + any filesystem using 80%+ capacity
```

## Exercises

1. Parse `/etc/passwd` with awk: print a table showing username (field 1) and home directory (field 6), only for users whose shell (field 7) is `/bin/bash` or `/bin/sh`.
2. Use `sed` to comment out (prepend `#`) all lines in a config file that contain the word `debug`. Do it in-place with a `.bak` backup.
3. Write an awk script that reads an nginx access log and prints a summary: total requests, total 2xx, total 4xx, total 5xx, and average response size.
4. Write a pipeline using awk and sort to find the top 5 directories consuming the most disk space under `/var` (`du -sh /var/*/`), formatted as a table.

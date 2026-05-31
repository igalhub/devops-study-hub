# Bash / Shell — Quick Reference

## awk

| Command | Description |
|---------|-------------|
| `awk '{print $1}' file` | Print first field of each line |
| `awk '{print $NF}' file` | Print last field |
| `awk 'NR>1' file` | Skip header line |
| `awk -F: '{print $1}' /etc/passwd` | Custom field delimiter |
| `awk '$3 > 100' file` | Print lines where field 3 > 100 |
| `awk '{sum+=$1} END{print sum}' file` | Sum a column |
| `awk '/pattern/' file` | Print lines matching pattern |
| `awk 'NR==2,NR==5' file` | Print lines 2–5 |
| `awk '{gsub(/old/,"new"); print}' file` | Global in-place substitution |
| `awk '{printf "%-10s %s\n",$1,$2}' file` | Formatted output |

## sed

| Command | Description |
|---------|-------------|
| `sed 's/old/new/' file` | Replace first match per line |
| `sed 's/old/new/g' file` | Replace all matches per line |
| `sed -i 's/old/new/g' file` | Edit file in-place |
| `sed -n '5,10p' file` | Print lines 5–10 |
| `sed '/pattern/d' file` | Delete matching lines |
| `sed -n '/pattern/p' file` | Print only matching lines |
| `sed '3i\new line' file` | Insert before line 3 |
| `sed '3a\new line' file` | Append after line 3 |
| `sed -n '/start/,/end/p' file` | Print between two patterns |

## grep

| Command | Description |
|---------|-------------|
| `grep 'pattern' file` | Print matching lines |
| `grep -i 'pattern' file` | Case-insensitive |
| `grep -r 'pattern' dir/` | Recursive search |
| `grep -v 'pattern' file` | Invert match |
| `grep -c 'pattern' file` | Count matches |
| `grep -n 'pattern' file` | Show line numbers |
| `grep -l 'pattern' *.log` | List matching filenames only |
| `grep -E 'a\|b' file` | Extended regex (alternation) |
| `grep -A 3 'pattern' file` | 3 lines after match |
| `grep -B 2 'pattern' file` | 2 lines before match |

## Pipes & Redirection

| Pattern | Description |
|---------|-------------|
| `cmd1 \| cmd2` | Pipe stdout of cmd1 to cmd2 |
| `cmd > file` | Redirect stdout (overwrite) |
| `cmd >> file` | Redirect stdout (append) |
| `cmd 2> file` | Redirect stderr |
| `cmd 2>&1` | Merge stderr into stdout |
| `cmd > file 2>&1` | Redirect both to file |
| `cmd < file` | Redirect file to stdin |
| `cmd1 \| tee file \| cmd2` | Tee: write to file AND pipe |
| `cmd &` | Run in background |
| `cmd1 && cmd2` | Run cmd2 only if cmd1 succeeds |
| `cmd1 \|\| cmd2` | Run cmd2 only if cmd1 fails |

## Text Processing

| Command | Description |
|---------|-------------|
| `cut -d: -f1 file` | Cut field 1 with `:` delimiter |
| `sort file` | Sort lines alphabetically |
| `sort -n file` | Sort numerically |
| `sort -k2 -n file` | Sort by second field numerically |
| `sort -u file` | Sort and deduplicate |
| `uniq file` | Remove adjacent duplicate lines |
| `uniq -c file` | Count duplicates |
| `wc -l file` | Count lines |
| `wc -w file` | Count words |
| `tr 'a-z' 'A-Z'` | Translate characters |
| `tr -d '\r'` | Delete carriage returns |
| `paste file1 file2` | Merge files side-by-side |
| `diff file1 file2` | Show differences |

## Script Patterns

| Pattern | Description |
|---------|-------------|
| `#!/usr/bin/env bash` | Portable shebang |
| `set -euo pipefail` | Exit on error, unset vars, pipe fail |
| `"${var:-default}"` | Default if var unset |
| `"${var:?error msg}"` | Error if var unset |
| `$(command)` | Command substitution |
| `$((expr))` | Arithmetic expansion |
| `[[ -f file ]]` | Test if file exists |
| `[[ -d dir ]]` | Test if directory exists |
| `[[ -z "$var" ]]` | Test if string is empty |
| `[[ -n "$var" ]]` | Test if string is non-empty |
| `for f in *.log; do ...; done` | Loop over files |
| `while IFS= read -r line; do ...; done < file` | Read file line by line |
| `trap 'cleanup' EXIT` | Run cleanup on exit |

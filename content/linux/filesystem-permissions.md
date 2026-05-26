---
title: File System & Permissions
module: linux
duration_min: 15
difficulty: intermediate
tags: [permissions, chmod, chown, filesystem]
exercises: 3
---

## Overview
Linux permissions control who can read, write, and execute files. Every file has an owner, a group, and a permission set for three categories: owner, group, and others.

## Concepts

### Permission Model
Permissions are represented as three groups of three bits: `rwx rwx rwx` (owner | group | others).

Each letter maps to a value:
- `r` = 4 (read)
- `w` = 2 (write)
- `x` = 1 (execute)

Combined into an octal number: `755` means owner=rwx (7), group=r-x (5), others=r-x (5).

### Reading Permissions
```bash
ls -la /var/www/
# -rwxr-xr-x  1 ubuntu www-data  4096 deploy.sh
# ^ file type + permissions
```

## Examples

### Changing Permissions
```bash
# Give owner full access, group and others read+execute
chmod 755 deploy.sh

# Give owner read+write, everyone else read only
chmod 644 config.yaml

# Make a script executable (symbolic mode)
chmod +x start.sh
```

### Changing Ownership
```bash
# Change owner and group
chown ubuntu:www-data /var/www/html

# Change owner only
chown ubuntu deploy.sh

# Recursive ownership change
chown -R ubuntu:www-data /var/www/
```

### Key Directories
| Path | Purpose |
|------|---------|
| `/etc` | System configuration files |
| `/var/log` | Log files |
| `/home` | User home directories |
| `/usr/bin` | User-installed binaries |
| `/proc` | Process info (virtual filesystem) |
| `/tmp` | Temporary files (world-writable) |

## Exercises

1. Create a file called `secret.txt` and set permissions so only the owner can read and write it (no access for group or others).
2. Create a script `deploy.sh` and make it executable by the owner only.
3. Find all files in `/etc` that are world-writable: `find /etc -perm -o+w 2>/dev/null`

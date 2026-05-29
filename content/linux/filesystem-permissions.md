---
title: File System & Permissions
module: linux
duration_min: 15
difficulty: intermediate
tags: [permissions, chmod, chown, acl, umask, setuid, sticky, filesystem]
exercises: 4
---

## Overview

Linux permissions are the first line of defense for every file and directory on a system. In DevOps, getting permissions wrong causes two failure modes: services that can't access their own files (too restrictive), and security vulnerabilities that let the wrong users or processes read secrets, write to config directories, or execute arbitrary code (too permissive). Understanding the full permission model — including special bits, umask, and ACLs — is a prerequisite for setting up web servers, deploying applications, managing SSH keys, and writing CI/CD pipelines that run in production.

## Concepts

### The Permission Model

Every file and directory has:
- An **owner** (a user)
- A **group** (a group of users)
- A **permission set** for three categories: owner, group, others

Permissions are displayed as a 10-character string in `ls -la` output:

```
-rwxr-xr-x  1 ubuntu www-data 4096 deploy.sh
│└──┘└──┘└──┘
│  │   │   └── others: r-x (read + execute, no write)
│  │   └────── group:  r-x (read + execute, no write)
│  └────────── owner:  rwx (read + write + execute)
└───────────── file type: - (regular file), d (directory), l (symlink)
```

Each permission letter maps to a numeric value:
- `r` = 4 (read)
- `w` = 2 (write)
- `x` = 1 (execute)
- `-` = 0 (no permission)

Summed into octal: `rwx` = 7, `r-x` = 5, `r--` = 4, `---` = 0.

So `chmod 755` means: owner=rwx (7), group=r-x (5), others=r-x (5).

### Reading Permissions

```bash
# Detailed listing: permissions, links, owner, group, size, date, name
ls -la /var/www/

# Output:
# drwxr-xr-x  4 root    www-data 4096 Jan 15 10:00 .
# -rw-r--r--  1 root    root      253 Jan 15 10:00 index.html
# -rwxr-xr-x  1 ubuntu  www-data  512 Jan 15 10:00 deploy.sh
# lrwxrwxrwx  1 root    root       12 Jan 15 10:00 logs -> /var/log/nginx

# First character indicates file type:
# -  regular file
# d  directory
# l  symbolic link
# b  block device (disks)
# c  character device (terminals)
# p  named pipe (FIFO)
# s  socket
```

On **directories**, the `x` bit means *enter* (traverse), not execute. A directory with `r--` can be listed but not entered. `--x` can be entered but not listed.

### chmod — Changing Permissions

Two modes: octal and symbolic.

**Octal mode:**
```bash
# Owner: full access | Group: read+execute | Others: read+execute
chmod 755 deploy.sh

# Owner: read+write | Group: read only | Others: read only
chmod 644 config.yaml

# Owner: full access | Group: full access | Others: none
chmod 770 shared-dir/

# Only owner can read+write, no one else can see it
chmod 600 ~/.ssh/id_ed25519     # private key MUST be 600
chmod 644 ~/.ssh/id_ed25519.pub # public key: world-readable is fine
```

**Symbolic mode — more readable for targeted changes:**
```bash
# Add execute for owner
chmod u+x script.sh

# Remove write from group and others
chmod go-w important.conf

# Give everyone execute (use carefully)
chmod a+x runme.sh

# Set exact permissions symbolically
chmod u=rwx,g=rx,o= deploy.sh

# Recursive: apply to directory and all contents
chmod -R 755 /var/www/html/
```

### chown and chgrp — Changing Ownership

```bash
# Change owner and group
chown ubuntu:www-data /var/www/html

# Change owner only (group stays the same)
chown ubuntu deploy.sh

# Change group only
chgrp www-data /var/www/html

# Recursive ownership change
chown -R ubuntu:www-data /var/www/

# Same as chown ubuntu:ubuntu (use current user's primary group)
chown ubuntu: deploy.sh

# Reference another file's ownership
chown --reference=/etc/nginx/nginx.conf target.conf
```

### Special Permission Bits

Beyond the standard rwx, three additional bits change execution behavior:

| Bit | Octal | Name | On files | On directories |
|-----|-------|------|----------|----------------|
| setuid | 4000 | SUID | Execute as the file's owner | Ignored (mostly) |
| setgid | 2000 | SGID | Execute as the file's group | New files inherit the directory's group |
| sticky | 1000 | Sticky | Ignored | Only owner can delete their own files |

**setuid (`s` in owner's execute position):**
```bash
# Programs with setuid run as their owner, not the invoking user
ls -la /usr/bin/passwd
# -rwsr-xr-x 1 root root /usr/bin/passwd
#      ^--- 's' means setuid + execute; 'S' means setuid but NOT executable

# Set setuid (add 4 to the front of octal)
chmod 4755 /usr/bin/myapp     # rwsr-xr-x
chmod u+s /usr/bin/myapp      # symbolic
```

`passwd` is owned by root but runs as root when any user executes it, allowing them to change their own password. SUID on shell scripts is ignored by Linux.

**setgid (`s` in group's execute position):**
```bash
# Set setgid on a directory — new files inherit the directory's group
mkdir /shared
chgrp devs /shared
chmod 2775 /shared            # rwxrwsr-x
chmod g+s /shared             # symbolic

# Now any file created in /shared gets group 'devs', regardless of creator's primary group
touch /shared/newfile
ls -la /shared/newfile
# -rw-rw-r-- 1 ubuntu devs newfile     ← group is 'devs', not ubuntu's primary group
```

Useful for shared project directories where multiple developers need to access each other's files.

**sticky bit (`t` in others' execute position):**
```bash
# Classic example: /tmp is world-writable but sticky
ls -ld /tmp
# drwxrwxrwt 20 root root /tmp
#          ^--- 't' means sticky + execute; 'T' means sticky but NOT executable

# In a sticky directory, you can only delete files you own
# (even if you have write permission on the directory)
chmod 1777 /tmp          # standard /tmp permissions
chmod o+t /shared-dir    # symbolic
```

The sticky bit prevents users from deleting each other's files in shared directories.

**Finding files with special bits:**
```bash
# Find all setuid files (potential security concern — audit these)
find / -perm -4000 -type f 2>/dev/null

# Find all setgid files
find / -perm -2000 -type f 2>/dev/null

# Find world-writable files (excluding /proc, /sys)
find / -perm -o+w -not \( -path /proc -prune -o -path /sys -prune \) 2>/dev/null
```

### umask — Default Permissions for New Files

`umask` defines which permission bits are **removed** from new files and directories. It's a mask: bits in the umask are OFF.

```bash
# Check current umask
umask         # e.g., 0022
umask -S      # symbolic: u=rwx,g=rx,o=rx

# Default umask is 022:
# New file max:       666 (files can't start executable)
# minus umask:       -022
# Result:             644 → owner rw, group r, others r

# New directory max:  777
# minus umask:       -022
# Result:             755 → owner rwx, group rx, others rx
```

```bash
# Change umask for current session
umask 027     # files: 640, dirs: 750 (group can read, others get nothing)
umask 077     # files: 600, dirs: 700 (only owner)
```

To make permanent: add `umask 027` to `/etc/profile` (system-wide) or `~/.bashrc` (per user).

**Why it matters:** if your CI/CD user creates log files with umask 022, those logs are world-readable. If your app creates config files with umask 000, they're world-writable. Set umask explicitly for service accounts.

### ACLs — Access Control Lists

Standard Unix permissions only allow one owner, one group, and one "everyone else". ACLs extend this to grant specific permissions to additional users or groups without changing ownership.

```bash
# Check if ACL support is available
mount | grep acl
# Or check filesystem mount options: defaults,acl

# View ACLs on a file
getfacl /var/www/html/
# file: var/www/html/
# owner: root
# group: www-data
# user::rwx
# group::r-x
# other::r-x

# Grant a specific user read+write access
setfacl -m u:appuser:rw /var/www/html/config.json

# Grant a specific group execute on a directory
setfacl -m g:deploy:rx /var/www/html/

# Set default ACL on a directory (inherited by new files/subdirs)
setfacl -d -m u:appuser:rw /var/www/html/

# Remove a specific ACL entry
setfacl -x u:appuser /var/www/html/config.json

# Remove all ACLs, revert to standard permissions
setfacl -b /var/www/html/config.json
```

When an ACL is set, `ls -la` shows a `+` after the permission string:
```
-rw-rw-r--+ 1 root www-data config.json
#         ^--- + means ACL is set
```

### File Attributes — chattr and lsattr

Beyond permissions, Linux filesystems (ext4, xfs) support per-file attributes that control how the kernel itself handles the file:

```bash
# View attributes
lsattr /etc/resolv.conf
# ----i--------e-- /etc/resolv.conf
#     ^--- 'i' means immutable

# Make a file immutable (even root can't modify or delete it)
chattr +i /etc/resolv.conf

# Remove immutable attribute
chattr -i /etc/resolv.conf

# Append-only (useful for log files — can grow but not be truncated)
chattr +a /var/log/audit/audit.log

# Useful attributes:
# i  immutable — no writes, no deletion, no rename, no hard links
# a  append-only — only append writes allowed
# e  extent format — informational, set automatically
```

`chattr +i` is used by security-hardening tools to protect critical config files like `/etc/passwd` or `/etc/resolv.conf`. It's one of the few controls that survives `rm -rf` as root.

### Privilege Escalation — sudo and su

```bash
# Run a single command as root
sudo apt update

# Open a root shell (prefer -i over -s for a login shell)
sudo -i

# Run as another user
sudo -u www-data /usr/bin/php artisan migrate

# Check what sudo privileges you have
sudo -l

# Switch to root (requires root password, or don't use on cloud VMs)
su -

# Switch to another user
su - www-data
```

`/etc/sudoers` controls who can run what as whom. Always edit with `visudo` (syntax-checks before saving):
```
# /etc/sudoers
# Format: who  where=(as_whom) commands
ubuntu  ALL=(ALL:ALL) NOPASSWD: /usr/bin/systemctl restart nginx
deploy  ALL=(ALL) NOPASSWD: /usr/local/bin/deploy.sh
```

`NOPASSWD:` is common for CI/CD service accounts that need to restart services without interactive password prompts.

### Finding Files by Permission

```bash
# Files world-writable
find /etc -perm -o+w 2>/dev/null

# Files with exact permissions 777
find /var/www -perm 777

# Files where group has write (regardless of other bits)
find /home -perm -g+w 2>/dev/null

# Find all SUID binaries (audit these — common attack vector)
find / -perm -4000 -type f 2>/dev/null | sort

# Files NOT owned by any current user (orphaned — clean these up)
find / -nouser 2>/dev/null

# Files modified in the last 24 hours
find /etc -mtime -1 -type f

# Find SSH authorized_keys files (check for unauthorized entries)
find /home -name authorized_keys 2>/dev/null -exec ls -la {} \;
```

## Examples

### Web Server Setup (nginx + application)

```bash
# Standard web server permission layout
chown -R www-data:www-data /var/www/myapp      # nginx process owns files
find /var/www/myapp -type d -exec chmod 755 {} \;  # directories: traverse+list
find /var/www/myapp -type f -exec chmod 644 {} \;  # files: read-only for group/others

# Application writes to a specific subdir (uploads, cache)
mkdir -p /var/www/myapp/storage/uploads
chown -R www-data:www-data /var/www/myapp/storage
chmod 775 /var/www/myapp/storage/uploads   # www-data can write here

# Config files with secrets — restrict to owner only
chmod 600 /var/www/myapp/.env
chown www-data:www-data /var/www/myapp/.env
```

### CI/CD Deployment Permissions

```bash
#!/usr/bin/env bash
# Deploy as 'deploy' user, nginx runs as 'www-data'
# Both should be able to read the files; only deploy can write

# Shared group between deploy user and www-data
usermod -a -G www-data deploy

# Set group ownership and setgid so new files inherit
chown -R deploy:www-data /var/www/myapp
chmod -R 2750 /var/www/myapp    # setgid + owner rwx, group rx, others none

# Verify the setup
ls -la /var/www/myapp
stat /var/www/myapp
```

### SSH Key Permission Requirements

SSH is strict about private key file permissions — it refuses to use keys that are too open:

```bash
# Correct SSH directory and key permissions
chmod 700 ~/.ssh                  # only owner can enter
chmod 600 ~/.ssh/id_ed25519       # private key: owner read+write only
chmod 644 ~/.ssh/id_ed25519.pub   # public key: world-readable is fine
chmod 600 ~/.ssh/authorized_keys  # authorized_keys: owner only
chmod 644 ~/.ssh/known_hosts      # known_hosts: readable is ok
chmod 600 ~/.ssh/config           # config may contain sensitive paths

# Fix permissions if you cloned a repo and keys got wrong permissions
find ~/.ssh -type f -exec chmod 600 {} \;
chmod 700 ~/.ssh
```

### Security Audit Script

```bash
#!/usr/bin/env bash
# Quick permission audit — run regularly on production servers

echo "=== World-writable files (excluding /proc /sys /dev) ==="
find / -perm -o+w -type f \
    \( -path /proc -o -path /sys -o -path /dev \) -prune \
    -o -print 2>/dev/null | head -30

echo ""
echo "=== SUID binaries ==="
find / -perm -4000 -type f 2>/dev/null | sort

echo ""
echo "=== Files with no owner ==="
find / -nouser -type f 2>/dev/null | head -20

echo ""
echo "=== /tmp contents with permissions ==="
ls -la /tmp/ | head -20
```

## Exercises

1. Create a directory `/tmp/shared`, set it up so that: (a) the group `staff` owns it, (b) all new files created inside inherit group `staff` (use setgid), (c) any user can create files but only the file's owner can delete them (sticky bit). Verify by creating two files as two different users and trying to delete each other's files.

2. A Python web application needs to read a secret at `/etc/myapp/secret.key`. The app runs as user `appuser` (not root, not in any privileged group). Using `setfacl`, grant `appuser` read-only access to the file without changing the file's owner or group. Verify with `getfacl` and by running `sudo -u appuser cat /etc/myapp/secret.key`.

3. Write a bash script called `audit-permissions.sh` that: scans `/var/www` and `/etc` for files that are world-writable, reports them with their permissions and owner, and exits with code 1 if any are found (suitable for use as a CI gate). Test by creating a world-writable file and confirming the script catches it.

4. Find all SUID and SGID binaries on your system with `find / -perm -4000 -o -perm -2000`. For each binary, explain in one sentence WHY it needs the elevated bit (use `man <binary>` or research). Identify any that look suspicious or unnecessary.

---

### Quick Checks

1. Print the permission bits of `/etc/passwd`.

   ```bash
   ls -l /etc/passwd | awk '{print $1}'
   ```

   ```expected_output
   -rw-r--r--
   ```

hint: Think about which command displays detailed file metadata, including permissions, in a long-format listing.
hint: Use ls with the -l flag on the target file, then consider how to isolate just the first field showing the permission bits.

2. Print the permission bits of `/tmp` (sticky bit expected).

   ```bash
   ls -ld /tmp | awk '{print $1}'
   ```

   ```expected_output
   drwxrwxrwt
   ```

hint: Think about which Linux command displays file and directory metadata, including permission bits.
hint: Use ls with the -ld flags targeting /tmp, which shows the directory entry itself along with its permission string.

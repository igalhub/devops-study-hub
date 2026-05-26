---
title: Package Managers (apt/yum)
module: linux
duration_min: 10
difficulty: beginner
tags: [apt, yum, dnf, dpkg, rpm, packages]
exercises: 3
---

## Overview
Package managers install, update, and remove software along with their dependencies. Knowing both `apt` (Debian/Ubuntu family) and `yum`/`dnf` (RHEL/CentOS/Fedora family) is essential — most DevOps work spans both ecosystems. Cloud instances often run Ubuntu (apt) or Amazon Linux / RHEL (yum/dnf).

## Concepts

### The Two Ecosystems

| Distro Family | Package Manager | Package Format | Low-level Tool |
|---------------|----------------|----------------|----------------|
| Debian, Ubuntu | `apt` (or `apt-get`) | `.deb` | `dpkg` |
| RHEL, CentOS, Amazon Linux | `yum` or `dnf` | `.rpm` | `rpm` |
| Fedora (38+) | `dnf` | `.rpm` | `rpm` |

`apt` and `yum`/`dnf` are high-level wrappers — they resolve dependencies and talk to remote repositories. `dpkg`/`rpm` are low-level and install individual files directly.

### Repositories
Packages come from repos — collections of packages hosted on servers. Repo config lives in:
- apt: `/etc/apt/sources.list` and `/etc/apt/sources.list.d/`
- yum/dnf: `/etc/yum.repos.d/`

Third-party software (Docker, Kubernetes, Datadog) always instructs you to add their repo before installing.

## Examples

### apt (Debian/Ubuntu)

```bash
# Always update the package list first
apt update

# Install a package
apt install nginx
apt install -y nginx            # -y skips the "Do you want to continue?" prompt

# Remove a package (keeps config files)
apt remove nginx

# Remove package + config files
apt purge nginx

# Upgrade all installed packages
apt upgrade

# Full upgrade — also removes packages if needed to resolve deps
apt full-upgrade

# Search for a package
apt search "web server"

# Show package info (version, dependencies, description)
apt show nginx

# List installed packages
apt list --installed
apt list --installed | grep nginx

# Clean up packages that were installed as dependencies but are no longer needed
apt autoremove

# Download package list without installing
apt update --dry-run
```

### Holding a Package Version (preventing accidental upgrades)
```bash
# Pin to current version
apt-mark hold nginx

# Unhold
apt-mark unhold nginx

# Show held packages
apt-mark showhold
```

### dpkg — inspect and install .deb files directly
```bash
# Install a local .deb file
dpkg -i package.deb

# List all installed packages
dpkg -l

# Find which package owns a file
dpkg -S /usr/bin/curl

# List files installed by a package
dpkg -L curl
```

### yum / dnf (RHEL/CentOS/Fedora)
`dnf` is the modern replacement for `yum` — same commands, better dependency resolution.

```bash
# Install
yum install nginx -y
dnf install nginx -y

# Remove
yum remove nginx
dnf remove nginx

# Update all packages
yum update
dnf update

# Update a specific package
yum update nginx
dnf update nginx

# Search
yum search nginx
dnf search nginx

# Show package info
yum info nginx
dnf info nginx

# List installed packages
yum list installed
dnf list installed

# Find which package provides a command
yum provides /usr/bin/curl
dnf provides /usr/bin/curl

# Clean cached metadata
yum clean all
dnf clean all
```

### rpm — inspect and install .rpm files directly
```bash
# Install a local .rpm file
rpm -ivh package.rpm

# Find which package owns a file
rpm -qf /usr/bin/curl

# List files installed by a package
rpm -ql curl

# List all installed packages
rpm -qa
```

### Adding Third-Party Repos (Common Pattern)

**apt** (e.g., Docker):
```bash
# Add GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Add repo
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt update && apt install docker-ce
```

**yum/dnf** (e.g., Docker):
```bash
yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
yum install docker-ce
```

## Exercises

1. Find which package provides the `ss` command on your system (hint: use `dpkg -S` or `rpm -qf`).
2. Install `tree`, list your home directory with it, then remove it cleanly.
3. Check what packages were most recently installed on your system: `grep " install " /var/log/dpkg.log | tail -20` (Debian/Ubuntu) or `rpm -qa --last | head -20` (RHEL).

---
title: Package Managers (apt/yum)
module: linux
duration_min: 10
difficulty: beginner
tags: [apt, yum, dnf, dpkg, rpm, packages]
exercises: 3
---

## Overview

Package managers are the primary mechanism for installing, updating, and removing software on Linux systems. Rather than manually downloading tarballs and managing dependencies by hand, package managers resolve the full dependency graph, handle version conflicts, verify cryptographic signatures, and provide a clean upgrade and rollback path. For DevOps work, fluency with package managers is non-negotiable — every provisioning script, Dockerfile, Ansible playbook, and CI pipeline you write will invoke one.

Two ecosystems dominate in practice: the **Debian/Ubuntu family** uses `apt` and `.deb` packages, while the **RHEL/CentOS/Amazon Linux/Fedora family** uses `yum` or `dnf` and `.rpm` packages. Cloud environments make both unavoidable: Ubuntu is common on GCP and general AWS workloads; Amazon Linux 2/2023 and RHEL are standard in enterprise AWS and on-prem environments. You will write scripts that must work on both.

The guiding design principle behind both systems is separation between the **high-level tool** (`apt`, `dnf`) and the **low-level tool** (`dpkg`, `rpm`). The high-level tool talks to remote repositories, resolves dependencies, and orchestrates installs. The low-level tool deals with individual package files on disk. Understanding this split matters because you'll encounter both layers — the high-level tool when provisioning servers, and the low-level tool when debugging what's actually installed or manually installing an offline `.deb`/`.rpm` file.

---

## Concepts

### The Two Ecosystems

| Distro Family | Package Manager | Package Format | Low-level Tool | Config Location |
|---|---|---|---|---|
| Debian, Ubuntu | `apt` / `apt-get` | `.deb` | `dpkg` | `/etc/apt/` |
| RHEL, CentOS 7, Amazon Linux 2 | `yum` | `.rpm` | `rpm` | `/etc/yum.repos.d/` |
| CentOS 8+, Amazon Linux 2023, Fedora | `dnf` | `.rpm` | `rpm` | `/etc/yum.repos.d/` |

`apt` and `yum`/`dnf` are **high-level wrappers**. They handle dependency resolution, contact remote repositories over HTTPS, verify package signatures, and manage the transaction as a whole. `dpkg` and `rpm` are **low-level tools** — they install or query individual package files but do not fetch dependencies automatically.

**`dnf` vs `yum`:** `dnf` is the direct successor to `yum` and accepts all the same commands. On systems where both are present, `yum` is often a symlink to `dnf`. Prefer `dnf` in new scripts; use `yum` only when targeting older RHEL 7 / Amazon Linux 2 systems where `dnf` isn't available.

**`apt` vs `apt-get`:** `apt` is the modern frontend and the right choice for interactive use. `apt-get` is older, less readable, but more stable for scripting — its output format is guaranteed not to change, which matters if you're parsing it. In practice, `apt` is fine for both interactive and scripted use in modern environments.

---

### Repositories and Package Sources

Packages come from **repositories** — curated collections of packages hosted on remote servers. The package manager fetches a metadata index from each configured repo, then uses that index to locate and download packages.

**apt repo config:**
```
/etc/apt/sources.list          # main sources file
/etc/apt/sources.list.d/       # drop-in directory — one file per third-party repo
```

A `sources.list` entry looks like:
```
deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable
#  ^type ^options                                         ^base URL                              ^codename ^component
```

- `deb` = binary packages; `deb-src` = source packages
- `signed-by` = path to the GPG public key used to verify packages from this repo (modern format; replaces the deprecated `apt-key` approach)
- codename (`jammy`, `focal`, `bookworm`) pins the repo to your distro release

**yum/dnf repo config:**
```
/etc/yum.repos.d/          # one .repo file per repository
```

A `.repo` file looks like:
```ini
[docker-ce-stable]
name=Docker CE Stable - $basearch
baseurl=https://download.docker.com/linux/centos/$releasever/$basearch/stable
enabled=1
gpgcheck=1
gpgkey=https://download.docker.com/linux/centos/gpg
```

**`$releasever` and `$basearch`** are variables automatically substituted by dnf/yum — they expand to the OS major version and CPU architecture of the running system.

**Important:** `apt update` (or `dnf makecache`) does not install anything — it only refreshes the local metadata index from all configured repos. You must run this before installing packages on a fresh system or after adding a new repo, otherwise the package manager is working from a stale index and may report packages as not found or install outdated versions.

**Gotcha: never run `apt upgrade` without `apt update` first in automation.** The upgrade will silently operate on the cached (possibly months-old) metadata. In Dockerfiles and provisioning scripts, always pair them:

```bash
apt-get update && apt-get install -y package-name
```

---

### Installing, Removing, and Upgrading Packages

The day-to-day commands you'll use in scripts and on live servers:

**apt:**
```bash
apt-get update                          # refresh repo metadata
apt-get install -y nginx                # install; -y skips confirmation prompt
apt-get install -y nginx=1.24.0-1       # install specific version
apt-get remove nginx                    # remove binary, keep config files
apt-get purge nginx                     # remove binary AND config files
apt-get autoremove                      # remove unused dependency packages
apt-get upgrade                         # upgrade all packages to latest available
apt-get dist-upgrade                    # upgrade + resolve new/removed dependencies
apt-get install --only-upgrade nginx    # upgrade a single package, don't install if missing
```

**dnf/yum:**
```bash
dnf install -y nginx                    # install
dnf install -y nginx-1.24.0            # install specific version
dnf remove nginx                        # remove package and dependents
dnf autoremove                          # remove unneeded dependencies
dnf upgrade                             # upgrade all packages
dnf upgrade nginx                       # upgrade a single package
dnf downgrade nginx                     # roll back to previous version
dnf reinstall nginx                     # reinstall current version (useful if files are corrupted)
```

**`remove` vs `purge` (apt):** `remove` leaves config files behind, which is useful if you plan to reinstall — the config will be restored. `purge` is the clean slate option. In automated environments, prefer `purge` to avoid config drift between deploys.

**`remove` vs `autoremove`:** When you install package A and it pulls in packages B and C as dependencies, those are marked as "automatically installed." When you remove A, B and C are orphaned. `autoremove` cleans them up. In long-lived servers, running `apt autoremove` periodically keeps the system lean.

---

### Querying and Searching Packages

Querying is as important as installing — you need to audit what's on a server, find which package provides a binary, and verify installs succeeded.

**apt / dpkg queries:**
```bash
apt-cache search nginx              # search by name or description
apt-cache show nginx                # full metadata: version, deps, description
apt-cache policy nginx              # installed version vs available version + priority
apt list --installed                # all installed packages
apt list --installed | grep nginx   # grep for specific package
dpkg -l                             # low-level: all installed packages + status codes
dpkg -l nginx                       # status of a specific package
dpkg -S /usr/sbin/nginx             # which package owns this file?
dpkg -L nginx                       # which files did this package install?
dpkg -p nginx                       # package metadata from dpkg database
```

**dnf / rpm queries:**
```bash
dnf search nginx                    # search by name or description
dnf info nginx                      # full metadata
dnf list installed                  # all installed packages
dnf list installed | grep nginx
dnf provides /usr/sbin/nginx        # which package provides this file/command?
rpm -qa                             # all installed packages (low-level)
rpm -q nginx                        # is this specific package installed?
rpm -qi nginx                       # package info
rpm -ql nginx                       # files installed by package
rpm -qf /usr/sbin/nginx             # which package owns this file?
rpm -qa --last | head -20           # most recently installed packages, newest first
```

**`apt-cache policy` is one of the most useful diagnostic commands in apt.** It shows you exactly which version is installed, which version is available in the repos, and why a particular version was chosen (repository priority):

```bash
$ apt-cache policy nginx
nginx:
  Installed: 1.24.0-1~jammy
  Candidate: 1.24.0-1~jammy
  Version table:
 *** 1.24.0-1~jammy 500
        500 https://nginx.org/packages/ubuntu jammy/nginx amd64 Packages
     1.18.0-6ubuntu14.4 500
        500 http://archive.ubuntu.com/ubuntu jammy-updates/main amd64 Packages
```

This tells you the package is installed from the nginx.org repo, not the Ubuntu default repo — critical to know when debugging version mismatches.

---

### Version Pinning and Holds

In production, you often need to lock a package to a specific version to prevent an `apt upgrade` or `dnf update` from pulling in a breaking change.

**apt — hold a package:**
```bash
apt-mark hold nginx           # prevent upgrade/removal
apt-mark unhold nginx         # release the hold
apt-mark showhold             # list all held packages
```

**apt — pin via preferences (more powerful, file-based):**

Create `/etc/apt/preferences.d/nginx`:
```
Package: nginx
Pin: version 1.24.0-1~jammy
Pin-Priority: 1001
```

Priority > 1000 means "hold at this version even if a newer one is available." This approach survives reimaging and can be checked into version control.

**dnf/yum — version locking:**
```bash
dnf install 'dnf-command(versionlock)'   # install the plugin first
dnf versionlock add nginx                # lock nginx at current version
dnf versionlock list                     # show all locks
dnf versionlock delete nginx             # remove lock
```

Or specify the version explicitly in a lock file at `/etc/dnf/plugins/versionlock.list`:
```
nginx-1:1.24.0-1.el9.ngx.x86_64
```

**Pinning gotcha:** Held packages still receive security metadata updates — you'll see security advisories in `apt upgrade` output but the package won't actually be upgraded. This is intentional, but it means you're responsible for manually evaluating and applying security patches to pinned packages. Don't set-and-forget a hold.

---

### Adding Third-Party Repositories

Most DevOps tooling (Docker, Kubernetes, Datadog, HashiCorp, etc.) is not in the default OS repositories. The standard pattern for adding a third-party repo has three steps: import the GPG key, add the repo definition, update the metadata index.

**apt — modern GPG key + repo pattern:**
```bash
# 1. Create the keyrings directory if it doesn't exist
install -m 0755 -d /etc/apt/keyrings

# 2. Download and store the GPG key (dearmored = binary format apt expects)
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# 3. Add the repository, referencing the key
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

# 4. Update and install
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io
```

**`dpkg --print-architecture`** dynamically emits `amd64`, `arm64`, etc. — use this instead of hardcoding `amd64` so the script works on ARM instances (e.g., AWS Graviton).

**Deprecated pattern to avoid:** `apt-key add` — this adds the key to a global trusted keyring, meaning the key is trusted for all repositories, not just the one you added it for. The `signed-by=` approach in the repo definition scopes trust correctly.

**dnf — repo file approach:**
```bash
# Option 1: use dnf config-manager (requires dnf-plugins-core)
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce

# Option 2: write the .repo file directly (more portable in scripts)
cat > /etc/yum.repos.d/docker-ce.repo << 'EOF'
[docker-ce-stable]
name=Docker CE Stable - $basearch
baseurl=https://download.docker.com/linux/centos/$releasever/$basearch/stable
enabled=1
gpgcheck=1
gpgkey=https://download.docker.com/linux/centos/gpg
EOF

dnf install -y docker-ce
```

**GPG check warning:** Never set `gpgcheck=0` in a `.repo` file in production — this disables signature verification and allows installation of tampered packages. If you're seeing GPG errors, the correct fix is to import the key properly, not to disable checking.

---

### Working with Local Package Files

Sometimes you need to install a `.deb` or `.rpm` that isn't in any repo — an internally built artifact, a vendor-provided package, or a specific binary downloaded from GitHub releases.

**dpkg — install a local .deb:**
```bash
dpkg -i ./mypackage_1.0.0_amd64.deb
```

**The critical limitation:** `dpkg` does not resolve dependencies. If the package requires `libssl3` and it's not installed, `dpkg` will install the package in a broken state and you'll see:

```
dpkg: dependency problems prevent configuration of mypackage
```

Fix with:
```bash
apt-get install -f    # -f = fix broken; fetches and installs missing deps
```

A cleaner approach that handles dependencies automatically:
```bash
apt-get install -y ./mypackage_1.0.0_amd64.deb   # apt can install local .deb files directly
```

**rpm — install a local .rpm:**
```bash
rpm -ivh ./mypackage-1.0.0.x86_64.rpm   # i=install, v=verbose, h=hash progress bar
rpm -Uvh ./mypackage-1.0.0.x86_64.rpm   # U=upgrade (installs if not present, upgrades if present)
```

Same limitation — `rpm` won't fetch dependencies. Use `dnf` instead:
```bash
dnf install -y ./mypackage-1.0.0.x86_64.rpm   # dnf resolves deps even for local files
```

---

### Package Manager Behavior in Dockerfiles

Dockerfiles run `apt-get` and `dnf` non-interactively in ephemeral containers. Several conventions exist to make this reliable:

```dockerfile
# Always combine update + install in one RUN to prevent stale layer cache issues
RUN apt-get update && apt-get install -y \
    nginx \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*   # delete apt cache to shrink image layer

# Set DEBIAN_FRONTEND to avoid interactive prompts (e.g., timezone selection in tzdata)
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y tzdata

#
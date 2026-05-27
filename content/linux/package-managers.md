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

**`dnf` vs `yum`:** `dnf` is the direct successor to `yum` and accepts nearly identical commands. On systems where both are present, `yum` is often a symlink to `dnf`. Prefer `dnf` in new scripts; use `yum` only when targeting older RHEL 7 / Amazon Linux 2 systems where `dnf` isn't available.

**`apt` vs `apt-get`:** `apt` is the modern frontend and the right choice for interactive use. `apt-get` is older and less readable, but its output format is guaranteed stable — which matters if you're parsing output in a script. In practice, `apt` is fine for both interactive and scripted use in modern environments.

---

### Repositories and Package Sources

Packages come from **repositories** — curated collections of packages hosted on remote servers. The package manager fetches a metadata index from each configured repo, then uses that index to locate and download packages on demand.

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
- codename (`jammy`, `focal`, `bookworm`) pins the repo to your specific distro release — using the wrong codename is a frequent source of "package not found" errors

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

**`$releasever` and `$basearch`** are variables automatically substituted by dnf/yum at runtime — they expand to the OS major version (e.g., `9`) and CPU architecture (e.g., `x86_64`) of the running system. This makes a single `.repo` file portable across versions and architectures.

**Important:** `apt update` (or `dnf makecache`) does not install anything — it only refreshes the local metadata index from all configured repos. You must run this before installing packages on a fresh system or after adding a new repo, otherwise the package manager works from a stale index and may report packages as not found or install outdated versions.

**Gotcha: never run `apt upgrade` without `apt update` first in automation.** The upgrade will silently operate on the cached (possibly months-old) metadata. In Dockerfiles and provisioning scripts, always pair them on the same line:

```bash
apt-get update && apt-get install -y package-name
```

Separating them into two `RUN` layers in a Dockerfile is a well-known antipattern — Docker may cache the `apt-get update` layer and skip it on subsequent builds, leaving the install step working from stale metadata.

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
dnf downgrade nginx                     # roll back to the previous available version
dnf reinstall nginx                     # reinstall current version (useful if files are corrupted)
```

**`remove` vs `purge` (apt):** `remove` leaves config files behind, which is useful if you plan to reinstall — your existing config will be preserved. `purge` is the clean slate option. In automated environments and Dockerfiles, prefer `purge` to avoid config drift between deploys.

**`upgrade` vs `dist-upgrade` (apt):** `upgrade` will never remove an installed package. `dist-upgrade` is smarter — it can remove packages if that's what the dependency resolution requires (e.g., a package was renamed or split). Use `dist-upgrade` when upgrading a system to a new release. On day-to-day servers, `upgrade` is the safer default.

**`remove` vs `autoremove`:** When you install package A and it pulls in packages B and C as dependencies, those are marked "automatically installed." When you remove A, B and C become orphaned. `autoremove` cleans them up. On long-lived servers, running `apt autoremove` periodically prevents package accumulation.

---

### Querying and Searching Packages

Querying is as important as installing — you need to audit what's on a server, find which package provides a binary, and verify that installs succeeded.

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
dnf provides /usr/sbin/nginx        # which package provides this file or command?
rpm -qa                             # all installed packages (low-level)
rpm -q nginx                        # is this specific package installed?
rpm -qi nginx                       # detailed package info
rpm -ql nginx                       # files installed by this package
rpm -qf /usr/sbin/nginx             # which package owns this file?
rpm -qa --last | head -20           # most recently installed packages, newest first
```

**`apt-cache policy` is one of the most useful diagnostic commands in apt.** It shows exactly which version is installed, which version is available in the repos, and which repository each version comes from — critical for debugging version mismatches when multiple repos provide the same package:

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

This output tells you the installed package came from the nginx.org upstream repo, not the Ubuntu default — which explains why you're on 1.24 rather than 1.18.

**`dpkg -S` and `rpm -qf` are indispensable on production systems** when you find an unknown file and need to know which package placed it there. This is the correct way to audit unexpected binaries on a compromised or misconfigured host.

---

### Version Pinning and Holds

In production, you often need to lock a package to a specific version to prevent `apt upgrade` or `dnf update` from pulling in a breaking change during routine maintenance.

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

Priority semantics:

| Priority | Behavior |
|----------|----------|
| < 0 | Never install this package |
| 1–99 | Install only if no other version is available |
| 100 | Default for already-installed packages |
| 500 | Default for repo packages |
| 990 | Preferred for packages matching the target release |
| > 1000 | Install even if it means downgrading; pin holds at this version |

The file-based approach survives reimaging when baked into a config management tool, and can be checked into version control — prefer this over `apt-mark hold` for anything managed at scale.

**dnf/yum — version locking:**
```bash
dnf install -y 'dnf-command(versionlock)'   # install the plugin
dnf versionlock add nginx                    # lock nginx at current installed version
dnf versionlock list                         # show all locks
dnf versionlock delete nginx                 # remove a lock
```

The lock is stored in `/etc/dnf/plugins/versionlock.list` in a format like:
```
nginx-1:1.24.0-1.el9.ngx.x86_64
```

**Pinning gotcha:** Held packages still receive security metadata updates — you'll see security advisories in `apt upgrade` output, but the package won't be upgraded. This is intentional, but it means you are now manually responsible for evaluating and applying security patches to all pinned packages. Never pin a package and forget about it — build a process to review holds regularly.

---

### Adding Third-Party Repositories

Most DevOps tooling (Docker, Kubernetes, Datadog, HashiCorp, etc.) is not in the default OS repositories. The standard pattern for adding a third-party repo has three steps: import the GPG key, add the repo definition, update the metadata index.

**apt — modern GPG key + repo pattern:**
```bash
# 1. Create the keyrings directory if it doesn't exist
install -m 0755 -d /etc/apt/keyrings

# 2. Download and store the GPG key
#    --dearmor converts ASCII-armored PGP to binary format that apt expects
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# 3. Add the repository definition, referencing the key via signed-by
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

# 4. Update metadata and install
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io
```

**`dpkg --print-architecture`** dynamically emits `amd64`, `arm64`, etc. — use this instead of hardcoding `amd64` so the script works transparently on ARM instances (e.g., AWS Graviton, Apple Silicon dev machines).

**Deprecated pattern to avoid:** `apt-key add` adds the GPG key to a single global trusted keyring, meaning that key is trusted to sign packages from *any* repository. The `signed-by=` field in the repo definition correctly scopes trust to that specific repository only. Never use `apt-key add` in new scripts.

**dnf — adding a repo:**
```bash
# Option 1: use dnf config-manager (cleaner, requires dnf-plugins-core)
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce

# Option 2: write the .repo file directly — more portable, no plugin dependency
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

**GPG check warning:** Never set `gpgcheck=0` in a `.repo` file in production. This disables signature verification entirely, allowing installation of tampered or malicious packages. If you're seeing GPG errors, the correct fix is to import the vendor's key properly — not to disable checking.

---

### Working with Local Package Files

Sometimes you need to install a `.deb` or `.rpm` that isn't in any remote repo — an internally built artifact, a vendor-provided package, or a specific binary from GitHub releases.

**dpkg — install a local .deb:**
```bash
dpkg -i ./mypackage_1.0.0_amd64.deb
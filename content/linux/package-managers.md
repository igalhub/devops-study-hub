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
apt-get install -y nginx=1.24.0-1~jammy # install specific version
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
# dpkg -i installs the package but will FAIL if dependencies are missing
dpkg -i ./mypackage_1.0.0_amd64.deb

# If dpkg reports unmet dependencies, fix them immediately with:
apt-get install -f        # -f = --fix-broken; resolves and installs missing deps

# Inspect a .deb without installing it
dpkg-deb --info ./mypackage_1.0.0_amd64.deb     # shows control metadata
dpkg-deb --contents ./mypackage_1.0.0_amd64.deb  # lists files inside

# Modern alternative: apt handles deps automatically even for local files
apt-get install -y ./mypackage_1.0.0_amd64.deb   # note the ./ prefix — required
```

**The `./` prefix on `apt install` is mandatory** when installing a local file. Without it, apt treats the argument as a package name to look up in the repos, not a file path. This is a common source of confusion.

**rpm / dnf — install a local .rpm:**
```bash
# rpm -i installs but does NOT resolve dependencies
rpm -ivh ./mypackage-1.0.0.x86_64.rpm   # -i install, -v verbose, -h progress hash marks

# dnf localinstall handles dependency resolution for local files
dnf install -y ./mypackage-1.0.0.x86_64.rpm   # dnf is smart enough to detect local file

# Inspect an .rpm without installing
rpm -qip ./mypackage-1.0.0.x86_64.rpm   # metadata: -q query, -i info, -p from file (not DB)
rpm -qlp ./mypackage-1.0.0.x86_64.rpm   # file list: -l list, -p from file
```

**`rpm -ivh` vs `dnf install` for local files:** `rpm -ivh` is lower-level and will not resolve missing dependencies — the install will error out with a list of unmet deps. `dnf install ./file.rpm` will attempt to satisfy dependencies from configured repos automatically. Always prefer `dnf` when repos are available; fall back to `rpm` only in fully air-gapped environments where you're manually staging all dependencies.

**Extracting files from a package without installing:**
```bash
# From a .deb — extract to a temp directory
dpkg-deb -x ./mypackage_1.0.0_amd64.deb /tmp/extracted/

# From an .rpm — requires cpio; rpm2cpio converts rpm to cpio archive
rpm2cpio ./mypackage-1.0.0.x86_64.rpm | cpio -idmv -D /tmp/extracted/
```

This technique is useful when you need a single binary from a package without installing the whole thing, or when auditing what a package would place on disk before committing to the install.

---

### Non-Interactive Use and Scripting Best Practices

Package manager commands in automation behave differently from interactive use. Getting this wrong causes pipelines to hang waiting for input or produces unreproducible builds.

**Essential flags for scripted use:**

| Flag | Tool | Purpose |
|------|------|---------|
| `-y` / `--yes` | apt, dnf | Auto-confirm all prompts |
| `-q` / `--quiet` | apt-get | Reduce output verbosity |
| `--no-install-recommends` | apt-get | Skip recommended (non-required) packages — reduces image size |
| `DEBIAN_FRONTEND=noninteractive` | apt | Suppress interactive ncurses dialogs (e.g., tzdata prompts) |
| `--assumeyes` | dnf | Equivalent to `-y` |
| `--setopt=install_weak_deps=False` | dnf | Skip weak dependencies — equivalent of `--no-install-recommends` |

**Dockerfile best practice — full pattern:**
```dockerfile
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      nginx \
      curl \
      ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
```

- All in one `RUN` layer: prevents stale cache bugs, minimizes layer count
- `DEBIAN_FRONTEND=noninteractive`: prevents package post-install scripts from launching interactive dialogs (e.g., `tzdata` asking for timezone)
- `--no-install-recommends`: avoids pulling in optional packages — can save 50–200MB in images
- `apt-get clean && rm -rf /var/lib/apt/lists/*`: removes downloaded `.deb` files and the repo index from the image layer — no point shipping them in a container

**`DEBIAN_FRONTEND` scope:** Set it as a `RUN` env var, not a persistent `ENV` instruction. Making it persistent in the image can suppress prompts in legitimate interactive sessions inside the container during debugging.

**dnf equivalent for containers:**
```dockerfile
RUN dnf install -y --setopt=install_weak_deps=False \
      nginx \
      curl \
 && dnf clean all \
 && rm -rf /var/cache/dnf
```

**Checking exit codes:** Package manager commands return non-zero on failure. In bash scripts, use `set -e` at the top or check `$?` explicitly. A failed `apt-get install` that isn't caught will silently allow the rest of your provisioning script to continue against an incomplete system state.

---

## Examples

### Example 1: Bootstrap a New Ubuntu Server for a Web Application

This is the kind of provisioning script you'd run via cloud-init, Ansible's `raw` module on a fresh host, or a Packer build.

```bash
#!/usr/bin/env bash
set -euo pipefail   # exit on error, treat unset vars as errors, propagate pipe failures

# Refresh metadata first — always. On a new instance this may be days stale.
apt-get update

# Install base packages non-interactively
# --no-install-recommends keeps installs lean on servers (no GUI deps, etc.)
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  nginx \
  postgresql-client \
  python3 \
  python3-pip \
  curl \
  gnupg \
  ca-certificates \
  lsb-release

# Add the Node.js 20.x repo from NodeSource (not in Ubuntu default repos)
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] \
  https://deb.nodesource.com/node_20.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

# Update again to pull in the new repo's metadata, then install Node
apt-get update
apt-get install -y --no-install-recommends nodejs

# Verify installs — script will exit here if any binary is missing
nginx -v
node --version
python3 --version

echo "Provisioning complete."
```

**Verify it worked:**
```bash
dpkg -l nginx nodejs python3 | grep '^ii'
# '^ii' status means: desired=Install, status=Installed, error=none
# Any line not starting with 'ii' indicates a problem
```

---

### Example 2: Install a Pinned Version of Terraform on Amazon Linux 2023

HashiCorp packages are not in Amazon Linux repos. Infrastructure tooling must be pinned to avoid surprise upgrades breaking Terraform state compatibility.

```bash
#!/usr/bin/env bash
set -euo pipefail

TERRAFORM_VERSION="1.7.5"

# Install dnf-plugins-core for config-manager subcommand
dnf install -y dnf-plugins-core

# Add HashiCorp's official repo
dnf config-manager --add-repo https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo

# Install the exact version we want
dnf install -y "terraform-${TERRAFORM_VERSION}"

# Pin it so routine dnf upgrade doesn't change it
dnf install -y 'dnf-command(versionlock)'
dnf versionlock add terraform

# Verify
terraform version
dnf versionlock list | grep terraform
```

**Expected output from `dnf versionlock list`:**
```
terraform-1.7.5-1.x86_64
```

**If you need to upgrade later:**
```bash
dnf versionlock delete terraform
dnf upgrade terraform
dnf versionlock add terraform   # re-lock at the new version
```

---

### Example 3: Audit and Clean Up a Long-Running Server

Production servers accumulate package debt. This workflow audits what's installed, finds orphaned packages, and identifies packages held back from upgrades.

```bash
#!/usr/bin/env bash
# Run on an Ubuntu/Debian server to produce an audit report

echo "=== Held packages (will not be upgraded) ==="
apt-mark showhold

echo ""
echo "=== Packages with available security updates ==="
# unattended-upgrades dry-run lists what would be updated
apt-get -s dist-upgrade | grep "^Inst" | grep -i security

echo ""
echo "=== Orphaned packages (safe to remove) ==="
apt-get --dry-run autoremove | grep "^Remv"

echo ""
echo "=== Manually installed packages (excluding base system) ==="
# comm compares two sorted lists; -23 shows lines only in the first file
comm -23 \
  <(apt-mark showmanual | sort) \
  <(gzip -dc /var/log/installer/initial-status.gz 2>/dev/null \
    | grep "^Package:" | awk '{print $2}' | sort) \
  2>/dev/null || apt-mark showmanual | sort

echo ""
echo "=== 20 most recently installed packages ==="
grep " install " /var/log/dpkg.log | tail -20
```

**After reviewing the output, clean up:**
```bash
apt-get autoremove -y      # remove orphaned packages
apt-get clean              # remove cached .deb files from /var/cache/apt/archives
apt-get autoclean          # remove cached .debs for packages no longer in repos
```

---

### Example 4: Install an Offline .rpm in an Air-Gapped Environment

In secure or air-gapped environments, packages must be pre-staged. This pattern downloads everything needed on a connected machine, then transfers and installs on the target.

```bash
# --- ON THE CONNECTED MACHINE (same OS and arch as target) ---

# Download the package and ALL its dependencies without installing
# --downloadonly + --destdir stages everything into a local directory
dnf install -y --downloadonly --destdir=/tmp/nginx-offline nginx

# List what was downloaded
ls -lh /tmp/nginx-offline/
# nginx-1.24.0-1.el9.ngx.x86_64.rpm
# openssl-libs-3.0.7-18.el9.x86_64.rpm  (example dependency)
# ... etc

# Transfer the directory to the air-gapped host
rsync -av /tmp/nginx-offline/ airgapped-host:/tmp/nginx-offline/

# --- ON THE AIR-GAPPED HOST ---

# Install from the local directory; dnf resolves deps across local files
dnf install -y /tmp/nginx-offline/*.rpm

# Verify
rpm -q nginx
nginx -v

# Clean up staged files
rm -rf /tmp/nginx-offline/
```

**Why `dnf install *.rpm` over `rpm -ivh *.rpm` here:** Even with all rpms present locally, `rpm -ivh` requires you to specify them in dependency order. `dnf` handles the ordering automatically by reading the dependency metadata embedded in each `.rpm` file.

---

## Exercises

### Exercise 1: Cross-Ecosystem Command Mapping

On both an Ubuntu instance and an Amazon Linux 2023 instance (or using Docker containers: `docker run -it ubuntu:22.04 bash` and `docker run -it amazonlinux:2023 bash`):

1. Install `curl` and `wget` using the appropriate package manager for each system.
2. Confirm both are installed using the **low-level tool** (`dpkg` or `rpm`) — not the high-level tool.
3. Find which package owns the file `/usr/bin/curl` on each system using the appropriate query command.
4. Remove `wget` on each system. After removal, verify it's gone using the low-level tool.

**Goal:** You should be able to recite the install, verify, ownership-query, and remove commands for both ecosystems from memory without looking them up.

---

### Exercise 2: Repository Debugging

This exercise simulates a common production scenario: a package install fails because of a repo configuration problem.

1. On an Ubuntu system, intentionally add a broken repo entry:
   ```bash
   echo "deb https://packages.example-nonexistent.io/ubuntu jammy main" \
     > /etc/apt/sources.list.d/broken.list
   ```
2. Run `apt-get update` and observe the error output.
3. Use `apt-cache policy curl` to verify that the broken repo doesn't affect your ability to see and install packages from working repos.
4. Now add a real third-party repo: install the GitHub CLI by following [https://cli.github.com/](https://cli.github.com/) Linux install instructions for Debian/Ubuntu. Do **not** use `apt-key add` — use the `signed-by=` pattern.
5. After successfully installing `gh`, use `apt-cache policy gh` to confirm which repository the installed version came from.

**Goal:** Understand how repo errors are isolated, how to trace package origins, and how to correctly add a third-party repo using the modern GPG scoping approach.

---

### Exercise 3: Version Pinning and Upgrade Simulation

This exercise builds the muscle memory for managing pinned packages — a critical production skill.

1. On an Ubuntu or Debian system, install `nginx` and record the installed version:
   ```bash
   apt-get install -y nginx
   dpkg -l nginx | grep '^ii'
   ```
2. Place nginx on hold using `apt-mark`. Confirm the hold is registered.
3. Run `apt-get upgrade --dry-run` (dry-run makes no changes). Observe whether nginx appears in the upgrade list. It should not.
4. Now release the hold, and instead create a file-based pin at `/etc/apt/preferences.d/nginx` using `Pin-Priority: 1001` for the currently installed version.
5. Add the official nginx.org repository for your Ubuntu release (https://nginx.org/en/linux_packages.html#Ubuntu). After `apt-get update`, run `apt-cache policy nginx`. You should see two candidate versions — your pinned version from the Ubuntu repo and the newer version from nginx.org.
6. Confirm that `apt-get install nginx` does not upgrade to the nginx.org version because your pin overrides it.

**Goal:** Understand the difference between `apt-mark hold` (imperative, not version-controlled) and file-based pins (declarative, version-controllable), and be able to explain pin priorities under interview conditions.

---

### Exercise 4: Package Archaeology on a Running System

This exercise develops the auditing skills needed when inheriting a system you didn't provision.

On any Linux system you have access to (your laptop, a VM, a container):

1. List the 10 most recently installed packages. On Debian/Ubuntu, parse `/var/log/dpkg.log`. On RHEL/Amazon Linux, use `rpm -qa --last`.
2. Find every package installed on the system that is not a dependency of any other installed package — these are the "leaf" packages that were manually installed. On apt systems, `apt-mark showmanual` gives this. On dnf systems, use `dnf leaves` (requires the `dnf-plugins-extras-leaves` package).
3. Pick any binary on the system — for example `/usr/bin/git`, `/usr/bin/python3`, or `/usr/sbin/sshd`. Use the appropriate low-level tool to find which package owns it, then list every other file that same package installed.
4. Identify any packages that have available updates but are currently held back. On apt: `apt list --upgradable`. On dnf: `dnf check-update`. Cross-reference with `apt-mark showhold` or `dnf versionlock list` to see if the held-back status is intentional.

**Goal:** Be able to walk into any Linux system and produce a clear picture of what's installed, why it's there, and what state it's in — the foundation of both incident response and compliance auditing.
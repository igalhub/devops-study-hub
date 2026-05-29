---
title: SSH & Key Management
module: linux
duration_min: 15
difficulty: beginner
tags: [ssh, scp, keys, authorized_keys, ssh-keygen, agent]
exercises: 3
---

## Overview

SSH (Secure Shell) is the standard protocol for encrypted remote access to Linux systems. In DevOps you'll use it constantly — connecting to servers, running remote commands, copying files, and tunneling traffic. Understanding SSH deeply matters because it underpins almost every other tool in the stack: Ansible uses it as its transport layer, CI/CD pipelines authenticate to repos and deployment targets with SSH keys, container registries and cloud providers use key-based auth for automation, and `git push` to GitHub typically goes over SSH. A misconfigured key or a missing `known_hosts` entry can silently break a deployment pipeline at 2 AM.

The core design principle of SSH is asymmetric cryptography: a mathematically linked key pair where anything encrypted with one key can only be decrypted by the other. You keep the private key secret and distribute the public key freely. The server never learns your private key — it only ever sees you prove you possess it. This is fundamentally more secure than passwords: no credential is transmitted over the wire, brute-forcing is computationally infeasible, and keys can be revoked per-server without changing a shared password everywhere.

In the DevOps toolchain SSH sits at the infrastructure access layer. Above it you have configuration management (Ansible), secrets management (Vault), and orchestration (Kubernetes). Below it is the network and the OS. Getting SSH right — key hygiene, agent usage, host verification, hardened server config — is table stakes before you touch any of those higher layers.

---

## Concepts

### How Key Authentication Works

The handshake involves four distinct steps. Understanding them helps you debug failures instead of guessing.

1. **TCP connection** — your SSH client opens a connection to port 22 (or custom) on the server. Both sides negotiate a protocol version and agree on symmetric encryption algorithms for the session.
2. **Host verification** — the server presents its *host key* (its own key pair, stored in `/etc/ssh/ssh_host_*`). Your client checks `~/.ssh/known_hosts` for a matching fingerprint. If none exists, you're prompted to accept it. If it exists but doesn't match, SSH halts — this is the man-in-the-middle protection.
3. **User authentication** — the server looks up your public key in `~/.ssh/authorized_keys`. It generates a random challenge, encrypts it with your public key, and sends it to you. Your client decrypts it with your private key, combines it with the session ID, hashes the result, and sends it back.
4. **Session begins** — the server verifies the hash. If correct, you're in. No password, no secret transmitted.

```
Client                          Server
  |                               |
  |------- TCP SYN -------------> |
  |<------ Server Host Key ------ |   ← you verify this against known_hosts
  |                               |
  |------- Public Key ID -------> |   ← "I want to auth with this key"
  |<------ Encrypted Challenge -- |   ← encrypted with YOUR public key
  |                               |
  |------- Signed Response -----> |   ← proves you hold the private key
  |<------ Auth Success --------- |
```

**Host key gotcha:** when a server is rebuilt (new AMI, new VM), its host key changes. SSH will refuse to connect and print a scary `REMOTE HOST IDENTIFICATION HAS CHANGED` warning. Fix it by removing the stale entry:

```bash
ssh-keygen -R hostname          # removes all entries for that hostname from known_hosts
ssh-keygen -R 203.0.113.50      # also works with IP addresses
```

Reconnect and accept the new fingerprint. **Never** disable `StrictHostKeyChecking` globally — it defeats MITM protection entirely. In automation where you genuinely cannot pre-populate `known_hosts`, use `ssh-keyscan` to fetch and record fingerprints ahead of time rather than turning off verification.

```bash
# Pre-populate known_hosts in a CI pipeline before using the host
ssh-keyscan -H 203.0.113.50 >> ~/.ssh/known_hosts

# Hash the hostname so the file doesn't leak your infrastructure topology
# -H hashes entries; the IP/hostname is not readable in plaintext
ssh-keyscan -H bastion.example.com >> ~/.ssh/known_hosts
```

---

### Key Types

| Type | Flag | Key size | Security | When to use |
|------|------|----------|----------|-------------|
| **Ed25519** | `-t ed25519` | 256-bit (fixed) | Excellent | Default choice — any modern system |
| **RSA** | `-t rsa -b 4096` | 4096-bit | Good | Legacy systems, FIPS environments |
| **ECDSA** | `-t ecdsa -b 521` | 256–521-bit | Good | Rarely needed; Ed25519 is better |
| **DSA** | `-t dsa` | 1024-bit (fixed) | Broken | Never use — deprecated since OpenSSH 7.0 |

**Ed25519 is the right answer** for any system running OpenSSH 6.5+ (released 2014). The keys are shorter, the math is faster, and the implementation has a smaller attack surface than RSA. RSA at 4096 bits is acceptable when you're dealing with GitHub Enterprise, older network appliances, or FIPS-compliant environments that haven't approved Ed25519 curves.

```bash
# Generate an Ed25519 key — preferred
ssh-keygen -t ed25519 -C "user@workstation"

# Generate RSA 4096 for legacy compatibility
ssh-keygen -t rsa -b 4096 -C "user@workstation"

# Generate a named key for a specific purpose (never clobber your default)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -C "github-personal"

# Change the passphrase on an existing key (does not change the key itself)
ssh-keygen -p -f ~/.ssh/id_ed25519

# Display the fingerprint of a key — useful for verifying identity before trusting
ssh-keygen -lf ~/.ssh/id_ed25519.pub
# 256 SHA256:abc123xyz... user@workstation (ED25519)
```

**Key size vs. passphrase:** a 4096-bit RSA key without a passphrase is less secure than a 256-bit Ed25519 key with a strong passphrase. The passphrase encrypts the private key file at rest using AES-256. Without it, anyone who reads the file can impersonate you everywhere that key is authorized. The passphrase never leaves your machine — it only unlocks the local file.

**Comment field (`-C`) best practice:** use `user@machine` or a purpose descriptor like `ci-deploy-prod`. The comment appears in `authorized_keys` on every server you add the key to, making audits and revocations tractable. If you have 40 servers and need to rotate a key, the comment is how you find which entries to replace.

---

### Key Files and Permissions

SSH is strict about file permissions. Wrong permissions = silent authentication failure. This is one of the most common beginner gotchas and one of the most common interview topics.

```
~/.ssh/
├── id_ed25519              # private key         — chmod 600
├── id_ed25519.pub          # public key          — chmod 644
├── id_ed25519_github       # named private key   — chmod 600
├── id_ed25519_github.pub   # named public key    — chmod 644
├── authorized_keys         # server-side: who may log in — chmod 600
├── known_hosts             # trusted server fingerprints — chmod 644
└── config                  # client config       — chmod 600
```

The `~/.ssh/` directory itself must be `chmod 700`. If it is group- or world-writable, SSH will refuse to use the keys inside — it treats that as evidence that someone else may have tampered with the files.

```bash
# Fix permissions after copying keys between machines
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
chmod 600 ~/.ssh/authorized_keys
chmod 600 ~/.ssh/config

# Verify with ls -la
ls -la ~/.ssh/
```

**`authorized_keys` on the server:** this is where you deposit users' public keys to grant access. One public key per line. You can also prefix a key with options that restrict how it may be used — this is powerful for automation:

```
# ~/.ssh/authorized_keys on the server

# Standard entry — unrestricted
ssh-ed25519 AAAA...base64... user@workstation

# Deployment key — can only run one specific script, no interactive terminal
command="/usr/local/bin/deploy.sh",no-pty,no-agent-forwarding,no-x11-forwarding ssh-ed25519 AAAA...base64... ci-deploy-key

# Restrict to specific source IP range — access denied from anywhere else
from="203.0.113.0/24" ssh-ed25519 AAAA...base64... restricted-user

# Restrict to a single command AND a single IP — belt and suspenders for sensitive automation
from="10.0.0.5",command="/usr/bin/rsync --server -vlogDtpre.iLsfxC . /var/www/",no-pty ssh-ed25519 AAAA...base64... rsync-deploy
```

**Adding a public key to a remote server safely:**

```bash
# ssh-copy-id handles permissions automatically — prefer this over manual pasting
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@server

# If the server uses a non-standard port
ssh-copy-id -i ~/.ssh/id_ed25519.pub -p 2222 user@server

# Manual equivalent when ssh-copy-id is unavailable
cat ~/.ssh/id_ed25519.pub | ssh user@server \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

**Ownership matters too:** if `~/.ssh/authorized_keys` is owned by root on a non-root account, or vice versa, SSH ignores it entirely. After copying keys as a different user (e.g., via `sudo`), always verify ownership with `ls -la ~/.ssh/` and fix with `chown` if needed.

---

### SSH Config File

`~/.ssh/config` is one of the highest-leverage files in a DevOps engineer's toolkit. Every `ssh`, `scp`, `rsync`, and `git` command reads it automatically. A well-built config eliminates long command lines, documents your infrastructure topology, and makes bastion-hop setups completely transparent.

```
# ~/.ssh/config

# ── Global defaults ─────────────────────────────────────────────────────────
Host *
    ServerAliveInterval 60        # keepalive every 60s — prevents idle connection drops
    ServerAliveCountMax 3         # drop connection after 3 missed keepalives
    AddKeysToAgent yes            # auto-add to agent on first use
    IdentitiesOnly yes            # only offer keys listed in this file; don't dump entire agent

# ── Production web server ────────────────────────────────────────────────────
Host prod-web
    HostName 203.0.113.50
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519_prod
    Port 22

# ── AWS bastion host ─────────────────────────────────────────────────────────
Host bastion
    HostName 203.0.113.10
    User ec2-user
    IdentityFile ~/.ssh/id_ed25519_aws

# ── Private DB reachable only through bastion ────────────────────────────────
Host prod-db
    HostName 10.0.1.20
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519_aws
    ProxyJump bastion             # SSH opens bastion first, then forwards to this host

# ── GitHub (useful when managing multiple GitHub accounts) ───────────────────
Host github-work
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_github_work

Host github-personal
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_github_personal
```

With this config in place:
- `ssh prod-web` — full connection with correct user, key, and host
- `ssh prod-db` — automatically tunnels through bastion transparently
- `git clone github-work:myorg/repo.git` — uses the work key without any flags

**`IdentitiesOnly yes` gotcha:** without this directive, SSH offers *every* key loaded in your agent plus all default key filenames (`id_rsa`, `id_ed25519`, etc.) in sequence. Many servers lock the connection after a small number of failed auth attempts (`MaxAuthTries 3` is a common hardening setting). With 5+ keys loaded, you may be locked out before SSH even tries the right one. Set `IdentitiesOnly yes` globally and specify `IdentityFile` per host to prevent this.

**Config file precedence:** SSH reads `~/.ssh/config` first, then `/etc/ssh/ssh_config`. The first matching `Host` block wins for each directive — more specific entries should appear before broader `Host *` blocks. This is the opposite of how most people expect it to work.

---

### SSH Agent

The agent is a background process that holds your decrypted private keys in memory. You type your passphrase once when you add the key; thereafter every tool that uses SSH — `ssh`, `scp`, `git`, Ansible, Terraform — authenticates without prompting.

```bash
# Start the agent (desktop environments usually start it automatically at login)
eval "$(ssh-agent -s)"
# Output: Agent pid 12345

# Add default key — prompts for passphrase once
ssh-add ~/.ssh/id_ed25519

# Add with a time limit — auto-removed after 4 hours
# Useful for production keys you don't want resident all day
ssh-add -t 4h ~/.ssh/id_ed25519_prod

# List keys currently loaded in the agent
ssh-add -l
# 256 SHA256:abc123... user@workstation (ED25519)
# 3072 SHA256:def456... user@workstation (RSA)

# Show full public key of a loaded key (useful for adding to authorized_keys)
ssh-add -L

# Remove one key from the agent
ssh-add -d ~/.ssh/id_ed25519_github

# Remove all keys
ssh-add -D
```

**Agent forwarding vs. ProxyJump:** when you SSH into a bastion and then need to reach an internal host, you have two options. Understand the difference — this is a common interview topic.

| Feature | `ProxyJump` | `ForwardAgent` |
|---------|-------------|----------------|
| Your private key stays on your machine | ✅ | ✅ |
| Agent socket exposed on the relay host | ❌ | ✅ ← security risk |
| Root on relay host can abuse your agent | ❌ | ✅ |
| Works without shell on relay host | ✅ (TCP only) | ❌ |
| Requires explicit trust in relay host | No | Yes |
| Recommended default | ✅ | Only for fully trusted hosts |

**`ForwardAgent` security warning:** with `ForwardAgent yes`, any user with root on the bastion can attach to your agent's Unix socket (`SSH_AUTH_SOCK`) and authenticate as you to every server your key is authorized on — for the duration of your session. Use `ProxyJump` by default. Reserve `ForwardAgent` for hosts you fully control.

```bash
# Agent forwarding — explicit per-session (never set globally)
ssh -A user@bastion

# ProxyJump — preferred; key never leaves your machine
ssh -J ec2-user@bastion ubuntu@10.0.1.20

# Multi-hop ProxyJump
ssh -J user@jump1,user@jump2 user@final-destination
```

**The `SSH_AUTH_SOCK` environment variable** points to the Unix socket the agent listens on. When you `sudo` or switch users, this variable often doesn't carry over — which is why `sudo ansible-playbook` sometimes fails with key errors even though your agent is running. Fix with `sudo SSH_AUTH_SOCK=$SSH_AUTH_SOCK ansible-playbook ...` or configure `Defaults env_keep += "SSH_AUTH_SOCK"` in `/etc/sudoers`.

---

### Port Forwarding and Tunneling

SSH can forward TCP ports between your machine and remote networks. This is how you reach private services (databases, internal dashboards, admin UIs) without exposing them to the internet.

| Tunnel type | Flag | Direction | Typical use |
|-------------|------|-----------|-------------|
| **Local** | `-L` | Remote service → local port | Access private DB from your laptop |
| **Remote** | `-R` | Local service → remote port | Expose local dev server to a remote machine |
| **Dynamic** | `-D` | SOCKS5 proxy on local port | Route browser traffic through a server |

```bash
# ── Local forwarding ─────────────────────────────────────────────────────────
# Access RDS (port 5432) in a private VPC via localhost:5433
# Syntax: -L local_port:target_host:target_port jump_host
ssh -L 5433:my-rds.cluster-xyz.us-east-1.rds.amazonaws.com:5432 ec2-user@bastion
# Now connect your DB client to localhost:5433

# ── Remote forwarding ────────────────────────────────────────────────────────
# Expose your local dev server (port 3000) on the remote server's port 8080
# Useful for sharing dev work or testing webhooks from GitHub
ssh -R 8080:localhost:3000 user@remote-server

# ── Dynamic (SOCKS5) ─────────────────────────────────────────────────────────
# Create a SOCKS5 proxy — configure your browser to use localhost:1080
ssh -D 1080 user@server

# ── Background persistent tunnel ─────────────────────────────────────────────
# -N: don't start a shell   -f: fork to background
ssh -fN -L 5432:my-rds.cluster-xyz.us-east-1.rds.amazonaws.com:5432 ec2-user@bastion

# Find and kill the background tunnel when done
ps aux | grep ssh
kill <pid>
```

**`-N` vs. interactive:** omitting `-N` opens a shell on the jump host in addition to establishing the tunnel. Adding `-N` means SSH connects, sets up the port forward, and does nothing else — no shell prompt, no resource waste on the remote side. Always use `-N` for pure tunneling.

**`GatewayPorts` for remote forwarding:** by default, `-R` only binds on `127.0.0.1` of the remote server — only processes on that host can use it. To bind on `0.0.0.0` (all interfaces) so external clients can reach it, the server needs `GatewayPorts yes` in `/etc/ssh/sshd_config`. This is disabled by default for security reasons.

---

### Hardening the SSH Server

A default `sshd` installation is functional but not hardened. Changing these settings in `/etc/ssh/sshd_config` is standard practice for any production host. After edits, always validate config before reloading — a typo can lock you out.

```bash
# ── /etc/ssh/sshd_config — production hardening ───────────────────────────

# Disable password login entirely — keys only
PasswordAuthentication no
ChallengeResponseAuthentication no

# Disable root login — use a named user, escalate with sudo
PermitRootLogin no

# Restrict which users may log in at all
AllowUsers ubuntu deploy-user

# Reduce the window for unauthenticated connections (default is 120s)
LoginGraceTime 30

# Limit auth attempts per connection — important against key-stuffing
MaxAuthTries 3

# Disable unused features that expand attack surface
X11Forwarding no
AllowAgentForwarding no        # re-enable per-user if needed
AllowTcpForwarding no          # re-enable if you use tunnels intentionally

# Only listen on specific interface if the host is multi-homed
ListenAddress 0.0.0.0

# Use only modern key exchange and cipher algorithms
KexAlgorithms curve25519-sha256,diffie-hellman-group16-sha512
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com
```

```bash
# Validate sshd_config syntax before reloading — catches typos that would lock you out
sshd -t

# Reload without dropping existing sessions
systemctl reload sshd

# Verify the daemon is running after reload
systemctl status sshd
```

**Lock-out prevention:** always keep one active SSH session open while testing a new `sshd_config`. If your reload produces an error or the config is wrong, your existing session stays alive and you can fix it. Opening a fresh connection to verify access before closing the old one is a hard-won rule in production ops.

**Port 22 vs. non-standard port:** changing SSH to a non-standard port (e.g., 2222) reduces noise from automated scanners but provides no real security — port scans find it in seconds. It's a minor operational inconvenience for attackers and a regular inconvenience for your team. Prefer `AllowUsers`, key-only auth, and a firewall over security-through-obscurity port changes.

---

### Copying Files with SCP and Rsync over SSH

Both tools use SSH as the transport layer and respect your `~/.ssh/config` aliases.

```bash
# ── scp — simple file copy ────────────────────────────────────────────────────
# Local → remote
scp ./app.tar.gz ubuntu@prod-web:/tmp/

# Remote → local
scp ubuntu@prod-web:/var/log/app.log ./

# Recursive directory copy
scp -r ./dist/ ubuntu@prod-web:/var/www/html/

# Use a non-default key
scp -i ~/.ssh/id_ed25519_prod ./config.yml ubuntu@prod-web:/etc/app/

# ── rsync — efficient incremental sync ───────────────────────────────────────
# -a: archive mode (preserves permissions, timestamps, symlinks)
# -v: verbose   -z: compress in transit   --delete: remove files deleted locally
rsync -avz --delete ./dist/ ubuntu@prod-web:/var/www/html/

# rsync over a custom SSH port
rsync -avz -e "ssh -p 2222" ./dist/ ubuntu@prod-web:/var/www/html/

# Dry run first — shows what would change without doing it
rsync -avz --dry-run --delete ./dist/ ubuntu@prod-web:/var/www/html/

# Use your ssh config alias — rsync reads it automatically
rsync -avz ./dist/ prod-web:/var/www/html/
```

**scp vs. rsync:** use `scp` for quick one-off transfers of individual files. Use `rsync` for directories, deployments, or anything you run repeatedly — it sends only changed bytes after the first transfer. On a slow link or large codebase, `rsync` can be 100x faster than `scp` for incremental updates.

**`scp` deprecation note:** OpenSSH 9.0+ deprecated the legacy `scp` protocol by default, switching to SFTP internally. The command still works but you may see warnings on older servers. For scripted transfers, `rsync` or `sftp` are preferable.

---

## Examples

### Example 1: Set Up Key-Based Access to a New Server from Scratch

**Scenario:** you've just launched a fresh Ubuntu EC2 instance. AWS gave you a `.pem` file. You want to convert to your standard Ed25519 workflow and disable password auth.

```bash
# Step 1 — Connect with the AWS-provided PEM key (RSA format)
chmod 400 ~/Downloads/my-instance.pem
ssh -i ~/Downloads/my-instance.pem ubuntu@203.0.113.50

# Step 2 — On the server, add your Ed25519 public key
# (run this from your laptop, not the server)
ssh-copy-id -i ~/.ssh/id_ed25519.pub -o "IdentityFile=~/Downloads/my-instance.pem" ubuntu@203.0.113.50

# Step 3 — Verify the new key works BEFORE disabling password/pem access
ssh -i ~/.ssh/id_ed25519 ubuntu@203.0.113.50
# Confirm you get a shell

# Step 4 — Harden sshd (on the server)
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl reload sshd

# Step 5 — Add to your local ~/.ssh/config for convenience
cat >> ~/.ssh/config <<'EOF'

Host my-ec2
    HostName 203.0.113.50
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
EOF

# Step 6 — Verify the alias works
ssh my-ec2
```

**Verification:** `ssh my-ec2` connects without a password prompt. Attempting `ssh -o PasswordAuthentication=yes ubuntu@203.0.113.50` should return `Permission denied`.

---

### Example 2: Reach a Private Database Through a Bastion Host

**Scenario:** your PostgreSQL database lives in a private subnet (10.0.1.50:5432). It has no public IP. A bastion host at 203.0.113.10 is the only way in.

```bash
# Step 1 — Add both hosts to ~/.ssh/config
cat >> ~/.ssh/config <<'EOF'

Host bastion-prod
    HostName 203.0.113.10
    User ec2-user
    IdentityFile ~/.ssh/id_ed25519_aws
    IdentitiesOnly yes

Host prod-db
    HostName 10.0.1.50
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519_aws
    IdentitiesOnly yes
    ProxyJump bastion-prod        # transparent hop through bastion
EOF

# Step 2 — Verify SSH connectivity to the DB (no special tunnel needed for shells)
ssh prod-db
# You should get a shell on 10.0.1.50 — SSH handled the bastion hop silently

# Step 3 — Open a local port tunnel to reach the DB with psql or a GUI client
# Forwards localhost:5433 → 10.0.1.50:5432 through bastion, runs in background
ssh -fN -L 5433:10.0.1.50:5432 bastion-prod

# Step 4 — Connect with psql
psql -h localhost -p 5433 -U appuser -d mydb

# Step 5 — Verify the tunnel is active
ss -tlnp | grep 5433
# LISTEN  0  128  127.0.0.1:5433  ...

# Kill the tunnel when done
pkill -f "ssh.*5433"
```

**Why `ProxyJump` here instead of `ForwardAgent`:** the bastion never sees your private key. SSH on your laptop opens a raw TCP channel to 10.0.1.50 through the bastion, then performs the full key authentication handshake directly with the destination. The bastion is just a pipe.

---

### Example 3: Deploy a Web App via CI/CD Using a Restricted Deploy Key

**Scenario:** your GitHub Actions pipeline needs to `rsync` built assets to a production server. You want to scope the key so it can only run the deploy script — nothing else.

```bash
# Step 1 — Generate a dedicated deploy key with no passphrase
# (CI runners can't type passphrases; use the agent or a keyless key scoped tightly)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_ci_deploy -N "" -C "ci-deploy-prod"
# -N "": empty passphrase — acceptable because the key is locked down server-side

# Step 2 — On the production server, add the key with command restriction
# Only allows running /usr/local/bin/deploy.sh — nothing else
echo 'command="/usr/local/bin/deploy.sh",no-pty,no-agent-forwarding,no-x11-forwarding,no-port-forwarding ssh-ed25519 AAAA...pubkey... ci-deploy-prod' \
  >> ~/.ssh/authorized_keys

# Step 3 — Write the deploy script on the server
sudo tee /usr/local/bin/deploy.sh > /dev/null <<'SCRIPT'
#!/bin/bash
set -euo pipefail
rsync -a --delete /tmp/deploy_staging/ /var/www/html/
systemctl reload nginx
echo "Deploy complete: $(date)"
SCRIPT
sudo chmod +x /usr/local/bin/deploy.sh

# Step 4 — Store the private key in GitHub Actions secrets as CI_DEPLOY_KEY

# Step 5 — GitHub Actions workflow
# .github/workflows/deploy.yml
```

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build assets
        run: npm ci && npm run build

      - name: Install SSH key
        run: |
          install -m 600 -D /dev/null ~/.ssh/id_ed25519_deploy
          echo "${{ secrets.CI_DEPLOY_KEY }}" > ~/.ssh/id_ed25519_deploy
          # Pre-populate known_hosts — never use StrictHostKeyChecking=no
          ssh-keyscan -H 203.0.113.50 >> ~/.ssh/known_hosts

      - name: Copy assets to server
        run: |
          rsync -az ./dist/ ubuntu@203.0.113.50:/tmp/deploy_staging/

      - name: Trigger deploy script
        run: |
          # The server ignores this argument — it runs deploy.sh regardless
          # but sending *something* keeps the command readable in logs
          ssh -i ~/.ssh/id_ed25519_deploy ubuntu@203.0.113.50 deploy

      - name: Clean up key
        if: always()
        run: rm -f ~/.ssh/id_ed25519_deploy
```

**Verification:** SSHing manually with the deploy key should run the script and exit — no shell prompt, no other commands possible. Attempt `ssh -i ~/.ssh/id_ed25519_ci_deploy ubuntu@203.0.113.50 "cat /etc/passwd"` — the server ignores the argument and runs `deploy.sh` instead.

---

### Example 4: Audit and Rotate Keys Across Multiple Servers

**Scenario:** a team member left. You need to remove their key from all servers and verify no access remains.

```bash
# Step 1 — Identify the key to remove (get the fingerprint or comment)
# If you have their public key file:
ssh-keygen -lf /tmp/departed-user.pub
# 256 SHA256:xK9mN2... alice@laptop (ED25519)

# Step 2 — On each server, remove the matching line from authorized_keys
# Match by comment (last field) — safe because it's human-readable
ssh prod-web "sed -i '/alice@laptop/d' ~/.ssh/authorized_keys"
ssh prod-db  "sed -i '/alice@laptop/d' ~/.ssh/authorized_keys"

# Step 3 — Verify the key is gone
ssh prod-web "grep -c 'alice@laptop' ~/.ssh/authorized_keys || echo 'Key not found — clean'"

# Step 4 — Check for the key in other locations (some automation puts keys in /root)
ssh prod-web "sudo grep -r 'alice@laptop' /home /root /etc/ssh/ 2>/dev/null"

# Step 5 — Audit who currently has access (list all authorized keys on a host)
ssh prod-web "cat ~/.ssh/authorized_keys"

# Step 6 — If you manage many servers with Ansible, do this at scale
ansible all -m shell -a "sed -i '/alice@laptop/d' ~/.ssh/authorized_keys" \
  --become -i inventory/production
ansible all -m shell -a "grep 'alice@laptop' ~/.ssh/authorized_keys && echo FOUND || echo clean" \
  -i inventory/production
```

**Key rotation vs. key revocation:** SSH has no built-in certificate revocation like TLS. Revocation means manually removing the public key from every `authorized_keys` file on every server. This is why key hygiene (one key per person per purpose, meaningful comments, centralised inventory) matters — and why larger organisations move toward SSH Certificate Authorities (OpenSSH has `ssh-keygen -s` for this) or tools like HashiCorp Vault's SSH secrets engine, which issue short-lived certificates instead of long-lived keys.

---

## Exercises

### Exercise 1: Generate, Deploy, and Restrict a Key

**Goal:** practice the full key lifecycle with server-side restrictions.

1. Generate a new Ed25519 key pair named `id_ed25519_exercise` with the comment `exercise-key`. Give it a passphrase.
2. Add the public key to a test server (or a second user account on your local machine via `ssh localhost`) using `ssh-copy-id`.
3. Verify you can SSH using only this key by passing `-i ~/.ssh/id_ed25519_exercise` and `-o IdentitiesOnly=yes`.
4. On the server, edit `authorized_keys` to restrict the key: prepend `command="echo hello-from-restricted-key",no-pty` before the key entry.
5. SSH again with the same command. Confirm it prints `hello-from-restricted-key` and immediately exits instead of giving a shell.
6. Try running `ssh -i ~/.ssh/id_ed25519_exercise user@host "cat /etc/hostname"` — observe that the server ignores your command and runs the forced command instead.

**What to understand:** `authorized_keys` command restrictions override whatever the client requests. This is the mechanism that makes deploy keys safe.

---

### Exercise 2: Build a Multi-Host SSH Config with a Bastion Jump

**Goal:** configure transparent multi-hop SSH entirely through `~/.ssh/config`.

You need access to two hosts: a "bastion" at one IP and a "private" host that is only reachable through the bastion. You can simulate this locally with Docker or two VMs, or use any two servers you have access to where one can reach the other but your laptop cannot reach the second directly.

1. Add both hosts to `~/.ssh/config` — one as `Host lab-bastion`, one as `Host lab-private` with `ProxyJump lab-bastion`.
2. Set `IdentitiesOnly yes` globally and specify `IdentityFile` for each host.
3. Set `ServerAliveInterval 30` globally.
4. Run `ssh lab-private` and confirm you land on the private host (not the bastion).
5. Run `ssh -v lab-private 2>&1 | grep -E "proxy|jump|connect"` to observe in the verbose output that SSH is making a proxied connection.
6. Without modifying the command, run `scp /etc/hostname lab-private:/tmp/from-laptop.txt` — verify the file appears on the private host, demonstrating that `scp` reads your config automatically.

**What to understand:** `ProxyJump` is transparent to all tools that invoke SSH under the hood. The config file is the central place to encode your infrastructure topology.

---

### Exercise 3: Diagnose and Fix a Broken SSH Setup

**Goal:** develop the debugging instincts needed to fix SSH failures fast.

Set up a working SSH key login to a test host, then intentionally break it in the following ways — one at a time — and practice diagnosing each without looking at this lesson:

1. **Permissions break:** run `chmod 644 ~/.ssh/id_ed25519` (private key world-readable). Attempt to connect. Read the error. Fix it. Understand why SSH refuses.
2. **Wrong authorized_keys permissions:** on the server, run `chmod 644 ~/.ssh/authorized_keys`. Attempt to connect. SSH will fall back to password auth (or fail if passwords are disabled). Fix it.
3. **Stale known_hosts:** delete the server's entry from `known_hosts` and regenerate the server's host key with `sudo ssh-keygen -A && sudo systemctl restart sshd`. Attempt to connect — read the MITM warning. Use `ssh-keyscan` to correctly update `known_hosts` rather than deleting the entry.
4. **Key not in agent:** run `ssh-add -D` to clear the agent. Then attempt `ssh -o IdentitiesOnly=yes user@host` *without* specifying `-i` and without any `IdentityFile` in config. Observe the failure. Add the key with `ssh-add` and retry.

For each failure, run `ssh -v user@host` before fixing it and identify the exact log line that indicates the cause. `-v` (verbose), `-vv`, and `-vvv` are your primary SSH debugging tools.

**What to understand:** SSH fails silently or with generic `Permission denied` messages. The verbose flag reveals exactly which step failed — host verification, key offer, auth method negotiation. Real-world SSH debugging is almost always about reading `-v` output carefully.

---

### Exercise 4: Set Up a Persistent Local Port Tunnel and Connect Through It

**Goal:** practice SSH tunneling for database access — a daily task in many DevOps roles.

1. Choose a service running on a remote host that listens on a non-default port — for example, a web server on port 8080, or start a simple one with `python3 -m http.server 8080` on the remote host.
2. Open a background tunnel: `ssh -fN -L 9090:localhost:8080 user@remote-host`
3. Verify the tunnel is listening locally: `ss -tlnp | grep 9090`
4. Access the service through the tunnel: `curl http://localhost:9090`
5. Find the background SSH process with `ps aux | grep ssh` and kill it.
6. Verify the tunnel is gone: `ss -tlnp | grep 9090` should return nothing. Confirm `curl http://localhost:9090` now fails.
7. **Bonus:** add a `LocalForward 9090 localhost:8080` directive under the host in `~/.ssh/config`, then use `ssh -fN remote-host` and confirm the same tunnel opens without `-L` on the command line.

**What to understand:** port forwarding is how you safely expose private services for local tooling — database GUIs, internal dashboards, admin panels — without opening firewall rules. The pattern is identical whether the target is a local port on the jump host or a hostname in a private VPC.

---

### Quick Checks

1. Generate a temporary Ed25519 key pair and print the key type from the public key.

   ```bash
   ssh-keygen -t ed25519 -f /tmp/sshtest -N "" -q 2>/dev/null; awk '{print $1}' /tmp/sshtest.pub; rm -f /tmp/sshtest /tmp/sshtest.pub
   ```

   ```expected_output
   ssh-ed25519
   ```

hint: Look into the SSH key generation tool that comes with OpenSSH and supports modern key types like Ed25519.
hint: Use ssh-keygen -t ed25519 with a temporary output file, then extract the first field from the public key file using awk '{print $1}'.

2. Parse a `HostName` value from a formatted SSH config block.

   ```bash
   printf 'Host myserver\n  HostName 10.0.0.1\n  User devops\n' | awk '/HostName/{print $2}'
   ```

   ```expected_output
   10.0.0.1
   ```
hint: Think about how you can search for a specific keyword in a file and then isolate just the value that follows it.
hint: Use grep to find the HostName line, then pipe it to awk '{print $2}' to extract the second field.

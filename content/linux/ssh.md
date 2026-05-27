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
ssh-keygen -t ed25519 -C "igal@work-laptop"

# Generate RSA 4096 for legacy compatibility
ssh-keygen -t rsa -b 4096 -C "igal@work-laptop"

# Generate a named key for a specific purpose (never clobber your default)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -C "github-personal"

# Change the passphrase on an existing key (does not change the key itself)
ssh-keygen -p -f ~/.ssh/id_ed25519
```

**Key size vs. passphrase:** a 4096-bit RSA key without a passphrase is less secure than a 256-bit Ed25519 key with a strong passphrase. The passphrase encrypts the private key file at rest using AES-256. Without it, anyone who reads the file can impersonate you everywhere that key is authorized. The passphrase never leaves your machine — it only unlocks the local file.

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
ssh-ed25519 AAAA...base64... igal@work-laptop

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
cat ~/.ssh/id_ed25519.pub | ssh user@server "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

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

# ── Private DB reachable only through bastion ─────────────────────────────────
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
# 256 SHA256:abc123... igal@work-laptop (ED25519)
# 3072 SHA256:def456... igal@work-laptop (RSA)

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

---

### Port Forwarding and Tunneling

SSH can forward TCP ports between your machine and remote networks. This is how you reach private services (databases, internal dashboards, admin UIs) without exposing them to the internet.

| Tunnel type | Direction | Typical use |
|-------------|-----------|-------------|
| **Local** (`-L`) | Remote service → local port | Access private DB from your laptop |
| **Remote** (`-R`) | Local service → remote port | Expose local dev server to a remote machine |
| **Dynamic** (`-D`) | SOCKS5 proxy | Route browser traffic through a server |

```bash
# ── Local forwarding ─────────────────────────────────────────────────────────
# Access RDS (port 5432) in a private VPC via localhost:5433
ssh -L 5433:my-rds.cluster-xyz.us-east-1.rds.amazonaws.com:5432 ec2-user@bastion
# Now connect your DB client to localhost:5433

# ── Remote forwarding ────────────────────────────────────────────────────────
# Expose your local dev server (port 3000) on the remote server's port 8080
# Useful for sharing dev work or webhook testing
ssh -R 8080:localhost:3000 user@remote-server

# ── Dynamic (SOCKS5) ─────────────────────────────────────────────────────────
# Create a SOCKS5 proxy — configure your browser to use localhost:1080
ssh -D 1080 user@server

# ── Background persistent tunnel ─────────────────────────────────────────────
# -N: don't start a shell   -f: fork to background
ssh -fN -L 5432:my-rds.cluster-xyz.us-east-1.r
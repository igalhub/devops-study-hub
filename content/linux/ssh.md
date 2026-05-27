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

The core design principle of SSH is asymmetric cryptography: a mathematically linked key pair where anything encrypted with one key can only be decrypted by the other. You keep the private key secret, distribute the public key freely. The server never learns your private key — it only ever sees you prove you possess it. This is fundamentally more secure than passwords: no credential is transmitted over the wire, brute-forcing is computationally infeasible, and keys can be revoked per-server without changing a shared password everywhere.

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

**Host key gotcha:** when a server is rebuilt (new AMI, new VM), its host key changes. SSH will refuse to connect and print a scary warning. Fix: `ssh-keygen -R hostname` to remove the old entry, then reconnect. **Never** disable `StrictHostKeyChecking` globally in production — it defeats the MITM protection.

---

### Key Types

| Type | Flag | Key size | Security | When to use |
|------|------|----------|----------|-------------|
| **Ed25519** | `-t ed25519` | 256-bit (fixed) | Excellent | Default choice — modern systems |
| **RSA** | `-t rsa -b 4096` | 4096-bit | Good | Legacy systems, old SSH servers |
| **ECDSA** | `-t ecdsa -b 521` | 256–521-bit | Good | Rarely needed; Ed25519 is better |
| **DSA** | `-t dsa` | 1024-bit (fixed) | Broken | Never use — deprecated since OpenSSH 7.0 |

**Ed25519 is the right answer** for any system running OpenSSH 6.5+ (released 2014). The keys are shorter, the math is faster, and the implementation has a smaller attack surface than RSA. RSA at 4096 bits is acceptable when you're dealing with GitHub Enterprise, older network appliances, or FIPS-compliant environments that haven't approved Ed25519 curves.

**Key size vs. passphrase:** a 4096-bit RSA key without a passphrase is less secure than a 256-bit Ed25519 key with a strong passphrase. The passphrase encrypts the private key file at rest using AES-256. Without it, anyone who reads the file (`~/.ssh/id_ed25519`) can impersonate you everywhere that key is authorized.

---

### Key Files and Permissions

SSH is strict about file permissions. Wrong permissions = silent authentication failure. This is one of the most common beginner gotchas.

```
~/.ssh/
├── id_ed25519           # private key    — chmod 600  (owner read/write only)
├── id_ed25519.pub       # public key     — chmod 644  (world-readable is fine)
├── id_ed25519_github    # named key for GitHub
├── id_ed25519_github.pub
├── authorized_keys      # server-side: who can log in — chmod 600
├── known_hosts          # fingerprints of servers you've trusted — chmod 644
└── config               # per-host settings — chmod 600
```

The `~/.ssh/` directory itself must be `chmod 700`. If it's group- or world-writable, SSH will refuse to use the keys inside.

```bash
# Fix permissions if you've copied keys around and they got mangled
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
chmod 600 ~/.ssh/authorized_keys
chmod 600 ~/.ssh/config
```

**`authorized_keys` on the server:** this is where you paste users' public keys. One public key per line. Comments after the key are ignored. You can also prefix a key with options:

```
# ~/.ssh/authorized_keys on the server

# Standard entry
ssh-ed25519 AAAA...base64... igal@work-laptop

# Restrict to specific commands (useful for deployment keys)
command="/usr/local/bin/deploy.sh",no-pty,no-agent-forwarding ssh-ed25519 AAAA...base64... ci-deploy-key

# Restrict to specific source IP
from="203.0.113.0/24" ssh-ed25519 AAAA...base64... restricted-user
```

---

### SSH Config File

`~/.ssh/config` is one of the highest-leverage files in a DevOps engineer's toolkit. Every `ssh`, `scp`, and `rsync` command reads it. A well-built config file eliminates long command lines, prevents errors, and documents your infrastructure.

```
# ~/.ssh/config
# Global defaults (apply to all hosts unless overridden)
Host *
    ServerAliveInterval 60        # send keepalive every 60s — prevents dropped idle connections
    ServerAliveCountMax 3         # disconnect after 3 missed keepalives
    AddKeysToAgent yes            # automatically add keys to ssh-agent on first use
    IdentitiesOnly yes            # only use keys specified in this config, not all agent keys

# Production web server
Host prod-web
    HostName 203.0.113.50
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519_prod
    Port 22

# AWS bastion host
Host bastion
    HostName 203.0.113.10
    User ec2-user
    IdentityFile ~/.ssh/id_ed25519_aws

# Private server reachable only through bastion (ProxyJump)
Host prod-db
    HostName 10.0.1.20
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519_aws
    ProxyJump bastion             # SSH to bastion first, then jump to this host

# GitHub (useful if you have multiple GitHub accounts)
Host github-work
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_github_work
```

With this config:
- `ssh prod-web` — connects with all the right settings
- `ssh prod-db` — automatically tunnels through bastion, no manual steps
- `git clone github-work:org/repo` — uses the work GitHub key

**`IdentitiesOnly yes` gotcha:** without this, SSH will offer *all* keys loaded in your agent, plus all default key files. If you have 5 keys loaded, some servers will lock you out after too many failed attempts before reaching the right key. Set `IdentitiesOnly yes` globally and explicitly set `IdentityFile` per host.

---

### SSH Agent

The agent is a background process that holds your decrypted private keys in memory. You type your passphrase once when you add the key; after that, `ssh`, `scp`, `git`, Ansible, and everything else can authenticate without prompting.

```bash
# Start the agent (if not already running — most desktop environments start it automatically)
eval "$(ssh-agent -s)"
# Output: Agent pid 12345

# Add your default key (prompts for passphrase once)
ssh-add ~/.ssh/id_ed25519

# Add a named key
ssh-add ~/.ssh/id_ed25519_github

# Add with a time limit — key is removed from agent after 4 hours
ssh-add -t 4h ~/.ssh/id_ed25519_prod

# List currently loaded keys
ssh-add -l
# Output: 256 SHA256:abc123... igal@work-laptop (ED25519)

# Remove a specific key from the agent
ssh-add -d ~/.ssh/id_ed25519_github

# Remove all keys
ssh-add -D
```

**Agent forwarding:** when you SSH into a bastion host and then need to SSH to an internal host, you normally can't — your private key is on your laptop, not the bastion. Agent forwarding solves this: requests are tunneled back to your local agent.

```bash
# Enable forwarding for a single session
ssh -A user@bastion

# Or in ~/.ssh/config (prefer per-host, not global)
Host bastion
    ForwardAgent yes
```

**Agent forwarding security warning:** with `ForwardAgent yes`, anyone with root on the bastion host can use your agent socket to authenticate as you to any server your key is authorized on — for the duration of your session. Only forward to hosts you fully trust. Use `ProxyJump` instead when possible — it achieves the same network routing without exposing your agent to the intermediate host.

| Feature | `ProxyJump` | `ForwardAgent` |
|---------|-------------|----------------|
| Your key stays on your machine | ✅ | ✅ |
| Agent socket exposed on relay host | ❌ | ✅ ← security risk |
| Works for arbitrary hops | ✅ | ✅ |
| Requires relay host to trust you | Only for TCP forward | Yes, needs shell |
| Recommended | ✅ | Only for trusted hosts |

---

### Port Forwarding and Tunneling

SSH can forward TCP ports — this is useful for accessing services that aren't exposed to the internet (databases, internal dashboards, dev servers).

```bash
# Local forwarding: access remote service on a local port
# Access a database on prod-db (port 5432) via localhost:5433
ssh -L 5433:prod-db:5432 bastion
# Now: psql -h localhost -p 5433

# Remote forwarding: expose your local service on a remote port
# Make your local dev server (port 3000) accessible on the remote server (port 8080)
ssh -R 8080:localhost:3000 user@remote-server

# Dynamic forwarding: SOCKS5 proxy — route browser traffic through the server
ssh -D 1080 user@server
# Then configure your browser to use SOCKS5 proxy at localhost:1080

# Persistent tunnel in background (add -N to not start a shell, -f to background)
ssh -fN -L 5433:prod-db:5432 bastion
```

**Practical DevOps use case:** your RDS database is in a private VPC, accessible only from your EC2 instances. You want to run a migration from your laptop.

```bash
# In ~/.ssh/config:
# Host bastion -> your EC2 bastion
# prod-db resolves to the RDS private hostname

ssh -fN -L 5432:my-rds.cluster-xyz.us-east-1.rds.amazonaws.com:5432 bastion
# Now run migrations pointing at localhost:5432
DATABASE_URL=postgres://user:pass@localhost:5432/mydb rails db:migrate
```

---

### File Transfer: SCP vs rsync

Both use SSH as transport. Choose based on what you're transferring.

| Feature | `scp` | `rsync` |
|---------|-------|---------|
| Simple file copy | ✅ | ✅ |
| Resumable transfers | ❌ | ✅ |
| Skip unchanged files | ❌ | ✅ |
| Progress bar | `-v` (verbose only) | `--progress` |
| Preserve permissions/timestamps | Limited | ✅ (`-a` flag) |
| Bandwidth limiting | ❌ | `--bwlimit` |
| Delete files removed from source | ❌ | `--delete` |
| Best for | Quick one-off copies | Syncing directories, large transfers |

```bash
# scp — simple cases
scp localfile.txt user@server:/tmp/
scp user@server:/var/log/app.log ./
scp -r ./configs/ user@server:/etc/myapp/    # -r for directories
scp -P 2222 file.txt user@server:/tmp/       # note: capital -P for port (unlike ssh -p)

# rsync — directory sync
rsync -avz ./app/ user@server:/var/www/app/
#  -a  archive mode: recursive + preserve permissions, timestamps, symlinks
#  -v  verbose
#  -z  compress during transfer

# Dry run first — shows what would change without doing it
rsync -avzn ./app/ user@server:/var/www/app/

# Sync and delete files on remote that no longer exist locally
rsync -avz --delete ./app/ user@server:/var/www/app/

# Use rsync with a specific SSH key
rsync -avz -e "ssh -i ~/.ssh/id_ed25519_prod" ./app/ user@server:/var/www/app/

# Limit bandwidth (useful on slow links) — value in KB/s
rsync -avz --bwlimit=5000 large-dataset/ user@server:/data/
```

---

### Server Hardening (`sshd_config`)

When you control the server, hardening SSH is one of the first things you do. The defaults allow password authentication, which means the server is exposed to brute-force attacks the moment it's reachable.

```
# /etc/ssh/sshd_config — key hardening directives

# Disable password auth entirely — keys only
PasswordAuthentication no

# Disable root login — log in as a regular user, sudo to root
PermitRootLogin no

# Only allow public key auth
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys

# Disable legacy auth methods
ChallengeResponseAuthentication no
UsePAM no                          # Set to yes if your distro requires PAM for other reasons

# Restrict which users can SSH in
AllowUsers ubuntu deploy ci-user   # whitelist approach — ignore all others

# Reduce attack surface
X11Forwarding no
AllowTcpForwarding no              # set to yes only if you need tunneling
MaxAuthTries 3                     # lock out after 3 failed attempts per connection
LoginGraceTime 20                  # disconnect if auth not completed in 20 seconds

# Change default port (security through obscurity — reduces log noise, not real security)
# Port 2222
```

After editing:
```bash
# Always validate config before restarting — a syntax error locks you out
sshd -t                     # test config, exit 0 if valid
systemctl restart sshd      # or
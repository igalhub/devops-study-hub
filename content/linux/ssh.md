---
title: SSH & Key Management
module: linux
duration_min: 15
difficulty: beginner
tags: [ssh, scp, keys, authorized_keys, ssh-keygen, agent]
exercises: 3
---

## Overview
SSH (Secure Shell) is the standard protocol for encrypted remote access to Linux systems. In DevOps you'll use it constantly — connecting to servers, running remote commands, copying files, and tunneling traffic. Key-based authentication replaces passwords and is required by most production environments and CI/CD pipelines.

## Concepts

### How Key Authentication Works
1. You generate a key pair: a **private key** (stays on your machine, never shared) and a **public key** (placed on any server you want to access).
2. When you connect, the server checks if your public key is in `~/.ssh/authorized_keys`.
3. The server sends a challenge encrypted with your public key — only your private key can decrypt it.
4. No password ever travels over the wire.

### Key Types
| Type | Flag | Notes |
|------|------|-------|
| Ed25519 | `-t ed25519` | Recommended — modern, fast, short keys |
| RSA | `-t rsa -b 4096` | Still widely supported — use 4096 bits minimum |
| ECDSA | `-t ecdsa` | Acceptable but Ed25519 is preferred |

### Key Files
```
~/.ssh/
├── id_ed25519          # your private key — chmod 600, never share
├── id_ed25519.pub      # your public key — safe to share
├── authorized_keys     # public keys allowed to log in as this user
├── known_hosts         # fingerprints of servers you've connected to
└── config              # per-host connection settings
```

### ssh_config
`~/.ssh/config` lets you define shortcuts and per-host settings — eliminates typing long ssh commands.

## Examples

### Generating a Key Pair
```bash
# Generate Ed25519 key (recommended)
ssh-keygen -t ed25519 -C "user@workstation"

# Generate RSA key (if the server requires it)
ssh-keygen -t rsa -b 4096 -C "user@workstation"

# Specify output file (useful for per-project keys)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github
```
Always set a passphrase — it encrypts your private key at rest. Use `ssh-agent` so you only type it once per session.

### Copying Your Public Key to a Server
```bash
# Easiest way — appends to ~/.ssh/authorized_keys on the remote
ssh-copy-id user@server-ip

# With a specific key
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@server-ip

# Manual (when ssh-copy-id isn't available)
cat ~/.ssh/id_ed25519.pub | ssh user@server-ip "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

### Connecting
```bash
# Basic connection
ssh user@192.168.1.100

# Specify port (default is 22)
ssh -p 2222 user@server

# Specify key file
ssh -i ~/.ssh/id_ed25519_prod user@server

# Run a single command remotely without interactive shell
ssh user@server "df -h && uptime"

# With verbose output for debugging connection issues
ssh -v user@server
```

### ~/.ssh/config — Stop Typing Long Commands
```
# ~/.ssh/config

Host prod
    HostName 203.0.113.50
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519_prod
    Port 22

Host bastion
    HostName 203.0.113.10
    User ec2-user
    IdentityFile ~/.ssh/id_ed25519_aws

Host internal
    HostName 10.0.0.50
    User ubuntu
    ProxyJump bastion          # tunnel through bastion host
    IdentityFile ~/.ssh/id_ed25519_aws
```

Now just: `ssh prod`, `ssh internal` — no flags needed.

### Copying Files
```bash
# Copy file to remote
scp localfile.txt user@server:/remote/path/

# Copy file from remote
scp user@server:/remote/path/file.txt ./local/

# Copy directory recursively
scp -r ./mydir user@server:/home/user/

# rsync — preferred for large transfers (resumable, skips unchanged files)
rsync -avz ./mydir/ user@server:/home/user/mydir/
```

### SSH Agent — Type Your Passphrase Once
```bash
# Start agent and add your key
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# List loaded keys
ssh-add -l

# Agent forwarding — use your local keys on a remote server (for Git, etc.)
ssh -A user@server
# Or in ~/.ssh/config: ForwardAgent yes
```

### Security Hardening (`/etc/ssh/sshd_config`)
For servers you manage — disable password auth once keys are set up:
```
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
```
After editing: `systemctl restart sshd`

## Exercises

1. Generate an Ed25519 key pair with the comment "devops-practice". Inspect both files — note the difference in size between the public and private key.
2. Set up `~/.ssh/config` with an entry called `localvm` pointing to `localhost` on port 22 (or any accessible host). Test with `ssh localvm`.
3. Using only `ssh`, run `uptime && free -h` on a remote host without opening an interactive shell.

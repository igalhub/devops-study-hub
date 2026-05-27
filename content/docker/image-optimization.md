---
title: Image Optimization
module: docker
duration_min: 15
difficulty: intermediate
tags: [docker, optimization, size, security, layers, slim, distroless]
exercises: 4
---

## Overview

Large Docker images are a compounding problem in production DevOps workflows. A 1 GB image takes significantly longer to pull on cold nodes during an incident, burns bandwidth costs on every CI push to a registry, and increases the attack surface exposed to a potential container escape. In a Kubernetes environment where pods are scheduled across nodes that may not have a local image cache, pull latency directly affects how fast you can respond to a scale event or a rolling deployment. Optimizing images is not aesthetic work — it has measurable impact on deployment speed, infrastructure cost, and security posture.

The core principle behind Docker image optimization is understanding the union filesystem model. Every `FROM`, `RUN`, `COPY`, and `ADD` instruction writes a new read-only layer. These layers are stacked at runtime to create the container's filesystem view. Crucially, data deleted in layer N is not removed from the image — it is still present in layer N-1 and contributes to the total compressed image size. This means optimization is not just about what ends up in the final image conceptually, but what ends up written into any layer at any point during the build. Multi-stage builds, combined `RUN` commands, and `.dockerignore` files all exist to manage this constraint.

In the broader DevOps toolchain, image optimization sits at the intersection of CI/CD, security, and platform engineering. A well-optimized image is the artifact that travels from `git push` through the pipeline, into a registry, and onto production nodes. Vulnerability scanning, non-root users, and minimal base images are practices that harden that artifact before it ever reaches runtime. Teams that treat image quality as a first-class concern — scanning in CI, enforcing size budgets, pinning digests — reduce the operational risk carried by every deployment.

## Concepts

### Measure First

Before changing anything, establish a baseline. Optimization without measurement is guesswork.

```bash
# List all local images sorted by size (largest first)
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | sort -k3 -rh

# Show layer-by-layer breakdown: each instruction, size added, and the command
docker history myapp:latest

# Show uncompressed cumulative size per layer (more precise than docker history alone)
docker history --no-trunc --format "{{.Size}}\t{{.CreatedBy}}" myapp:latest

# Dive: interactive TUI — shows layer diffs, what files changed, wasted space
# Install: https://github.com/wagoodman/dive
dive myapp:latest

# Or run via Docker without installing:
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  wagoodman/dive myapp:latest
```

**Dive's "wasted space" metric** shows bytes that exist in a lower layer but are hidden (deleted or overwritten) by a higher layer. This is the clearest signal of fixable layer hygiene problems.

To track size over time in CI, emit image size as a metric:

```bash
# Output image size in bytes — pipe to your metrics system or fail on threshold
docker inspect myapp:latest --format='{{.Size}}'

# Compare against a threshold (500 MB = 524288000 bytes)
SIZE=$(docker inspect myapp:latest --format='{{.Size}}')
if [ "$SIZE" -gt 524288000 ]; then
  echo "Image exceeds 500 MB limit: $SIZE bytes" && exit 1
fi
```

Pair this with `docker history` to identify which layer is responsible for a size spike after a change lands. Fix the layer before it reaches the main branch, not after.

### Base Image Choice

The base image is the single highest-leverage decision in the entire Dockerfile. It determines the starting layer count, installed packages, system utilities, and often the CVE count before you write a single application line.

| Base | Compressed size | Shell | Package manager | Notes |
|---|---|---|---|---|
| `ubuntu:22.04` | ~29 MB | bash | apt | Full Ubuntu userland, large CVE surface |
| `debian:bookworm-slim` | ~30 MB | bash | apt | Stripped Debian, good general default |
| `alpine:3.19` | ~3.5 MB | sh (ash) | apk | musl libc — test C extension compatibility |
| `python:3.12` | ~350 MB | bash | apt + pip | Full Debian + Python — almost never needed |
| `python:3.12-slim` | ~55 MB | bash | apt + pip | Debian slim + Python — most practical Python base |
| `python:3.12-alpine` | ~20 MB | sh | apk + pip | Smallest Python, musl caveats apply |
| `gcr.io/distroless/python3` | ~20 MB | none | none | No shell, no package manager, security-focused |
| `gcr.io/distroless/static` | ~2 MB | none | none | For fully static Go/Rust binaries |
| `scratch` | 0 B | none | none | Empty filesystem — static binaries only |

**Alpine caveat:** Alpine uses musl libc instead of glibc. Many Python packages with C extensions (numpy, cryptography, psycopg2) either require Alpine-specific build dependencies or publish separate musl wheels. Always test the full application stack — not just `docker build` — before adopting Alpine in production. A successful build does not guarantee correct runtime behavior.

**Distroless images** are purpose-built for production runtime. They contain the language runtime and its direct dependencies, but no shell (`/bin/sh`, `/bin/bash`), no package manager, and no coreutils. This means:
- An attacker who achieves code execution cannot drop into an interactive shell
- `docker exec myapp bash` will fail — use an ephemeral debug container (`kubectl debug`) for troubleshooting
- The CVE count is typically far lower than a Debian-based image

**Pinning by digest vs tag:** Tags are mutable — `python:3.12-slim` can be silently updated on Docker Hub without any change to your Dockerfile. In production, pin to an immutable content digest:

```dockerfile
# Mutable — tag can be updated without your knowledge
FROM python:3.12-slim

# Immutable — always resolves to this exact image layer set
FROM python:3.12-slim@sha256:a8140b04080d12f1af61b48f1a1534c4f1e2afec0b4edcfdd36e59af6c8d1e11
```

To get a digest:

```bash
docker pull python:3.12-slim
docker inspect python:3.12-slim --format='{{index .RepoDigests 0}}'
```

### Multi-Stage Builds

Multi-stage builds are the most impactful structural technique for compiled languages and applications with separate build and runtime dependencies. Docker executes every `FROM` as a named stage; the final image contains only the artifacts you explicitly copy forward. All intermediate stages are discarded, including every compiler, build tool, and header file they installed.

```dockerfile
# Stage 1: builder — contains compilers, build tools, dev headers
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build-time dependencies (not needed at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Install into an isolated prefix so we can copy just the packages
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# Stage 2: runtime — lean final image
FROM python:3.12-slim

WORKDIR /app

# Install only the runtime shared libraries (not compilers or headers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled packages from builder — no gcc, no build headers
COPY --from=builder /install /usr/local

# Create and switch to non-root user before copying app code
RUN groupadd -r app && useradd -r -g app app
COPY --chown=app:app . .

USER app
CMD ["python", "main.py"]
```

`gcc` and `libpq-dev` never appear in the final image. They exist only in the `builder` stage, which is discarded after the build. The final image gets only the compiled `.so` files and Python packages.

For Go, this pattern is even more powerful because Go produces statically linked binaries with `CGO_ENABLED=0`:

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0: fully static binary — no libc dependency at runtime
# -ldflags="-s -w": strip debug symbols and DWARF info (~30% smaller binary)
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app ./cmd/server

# scratch has no filesystem at all — no shell, no libc, nothing
FROM scratch
# TLS certificates are required for outbound HTTPS calls
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app /app
ENTRYPOINT ["/app"]
```

A Go service that was 800 MB with `golang:1.22` as the runtime image becomes ~10–15 MB with this pattern. The entire runtime image is the binary plus certificates.

**`--from` can reference external images too**, not just earlier stages in the same Dockerfile:

```dockerfile
# Copy a compiled tool from an official image instead of installing it
COPY --from=golang:1.22-alpine /usr/local/go/bin/go /usr/local/bin/go
```

### Layer Hygiene

#### Combine RUN commands

Every `RUN` instruction commits a filesystem snapshot as a new immutable layer. Files deleted in a later `RUN` are hidden by the union filesystem but still stored in the earlier layer — they are counted in the compressed image size and transferred on every pull.

```dockerfile
# BAD — three layers; apt cache persists in layer 2 even though layer 3 removes it
RUN apt-get update
RUN apt-get install -y curl nginx
RUN rm -rf /var/lib/apt/lists/*

# GOOD — one layer; the cache is written and deleted within the same filesystem snapshot
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*
```

The hidden-file problem is directly measurable:

```bash
# This image contains a hidden 8 MB file in its first RUN layer
printf 'FROM alpine\nRUN dd if=/dev/zero of=/bigfile bs=1M count=8\nRUN rm /bigfile\n' | \
  docker build -t test-hidden -
docker history test-hidden
# OUTPUT: one layer shows ~8 MB despite the file being "deleted"

# This image has the same net result with no wasted bytes
printf 'FROM alpine\nRUN dd if=/dev/zero of=/bigfile bs=1M count=8 && rm /bigfile\n' | \
  docker build -t test-clean -
docker history test-clean
# OUTPUT: the RUN layer adds ~0 net bytes
```

#### Pin package versions

```dockerfile
# Unpinned: whatever is current on the apt mirror at build time
RUN apt-get install -y nginx

# Pinned: reproducible builds, explicit upgrade decisions
RUN apt-get install -y nginx=1.24.0-2ubuntu7
```

Find the exact version string without leaving Docker:

```bash
docker run --rm debian:bookworm-slim apt-cache policy nginx
```

**Unpinned packages silently break builds** when a new version ships an incompatible configuration format or a dependency changes. Pinning converts silent breakage into an explicit `apt-get` error that demands a decision.

#### Exclude development dependencies

```dockerfile
# Node.js: devDependencies are test/lint tools — omit from the production image
RUN npm ci --omit=dev

# Python: maintain separate requirement files per environment
# requirements.txt       → production packages only
# requirements-dev.txt   → pytest, black, mypy, etc.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Never copy requirements-dev.txt into the production image
```

### .dockerignore

The `.dockerignore` file controls what the Docker CLI sends to the daemon as the build context. Without it, `COPY . .` sends your entire working directory — `.git` history, test fixtures, local `.env` files, `node_modules`, build artifacts, coverage reports. This inflates build context transfer time and, critically, can leak secrets into image layers.

```
# .dockerignore
.git
.gitignore
.github
**/__pycache__
**/*.pyc
**/*.pyo
*.egg-info
.env
.env.*
tests/
docs/
*.md
node_modules/
.pytest_cache
.mypy_cache
dist/
build/
coverage/
*.log
*.swp
Dockerfile*
docker-compose*
```

**Security boundary:** a `.env` file containing database credentials that is `COPY`-ed into an image layer is baked in permanently. Even if a later `RUN rm .env` removes it from the filesystem view, the credentials remain in the layer history and are readable via `docker history --no-trunc` or by extracting the image tarball. `.dockerignore` prevents the file from ever entering the build context — it is a security control, not just a performance optimization.

Verify what is being sent as context before building:

```bash
# BuildKit prints the context size at the start of every build
DOCKER_BUILDKIT=1 docker build .
# [+] Building — transferring context: 1.23MB

# If context is unexpectedly large, list what's included
tar -czh . | wc -c        # approximate context size
tar -czh . | tar -tzv | sort -k5 -rn | head -20  # largest files in context
```

### Build Cache Strategy

Docker's layer cache is content-addressed: if a layer's inputs — the instruction text plus every file it reads — are identical to a previous build, Docker reuses the cached layer without re-executing the command. Once any layer is invalidated, all subsequent layers must be rebuilt from scratch.

**The rule: order instructions from least-frequently-changed to most-frequently-changed.**

```dockerfile
FROM python:3.12-slim

# Layer 1: system packages — changes only when you explicitly update them
# (rarely, perhaps monthly)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Layer 2: dependency manifest — changes when you add/remove packages
# (occasionally, not on every commit)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Layer 3: application code — changes on every commit
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

If layers 2 and 3 are reversed, every code change invalidates the pip install step, adding minutes to every CI build. The cache hit rate on dependencies drops to zero.

**Remote cache for ephemeral CI runners:** CI nodes are typically stateless and have no local cache. Use `--cache-from` to pull a previously built image as the cache source:

```bash
# Pull the cache image first, then build using it as a layer source
docker build \
  --cache-from myrepo/myapp:cache \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  -t myrepo/myapp:latest \
  -t myrepo/myapp:cache \
  .

# Push the cache tag so the next CI run can use it
docker push myrepo/myapp:cache
docker push myrepo/myapp:latest
```

`BUILDKIT_INLINE_CACHE=1` embeds cache metadata directly in the image manifest, enabling `--cache-from` to work without a separate cache registry.

**BuildKit cache mounts** provide a more efficient alternative — a persistent cache volume that is never written into any image layer:

```dockerfile
# pip's HTTP cache is written to /root/.cache/pip but never committed to a layer
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt
```

This gives you the speed benefit of a local pip cache on every build without inflating image size.

### Non-Root User

Containers run as root (`uid=0`) by default. In a standard (non-rootless) Docker setup, a container escape with a root process grants the attacker root privileges on the host. Running as a non-root user eliminates this escalation path and is a baseline hardening requirement in most compliance frameworks (CIS Docker Benchmark, NIST SP 800-190).

```dockerfile
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Create a system user before copying application files
# -r: system account (no aging, no home dir by default)
# --no-create-home: explicitly no home directory
RUN groupadd -r appuser && useradd -r -g appuser --no-create-home appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --chown sets ownership atomically in the same layer as the COPY
COPY --chown=appuser:appuser . .

# All subsequent instructions (including CMD and ENTRYPOINT) run as this user
USER appuser

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Port caveat:** unprivileged users cannot bind to ports below 1024 without `CAP_NET_BIND_SERVICE`. Run your application on port 8000 or 8080 and map it to 80/443 at the load balancer or Kubernetes Service level. This is the correct pattern regardless of whether you use non-root containers.

Verify the running user:

```bash
docker run --rm myapp:latest whoami   # appuser
docker run --rm myapp:latest id       # uid=999(appuser) gid=999(appuser) groups=999(appuser)
```

In Kubernetes, enforce this at the platform level so no single Dockerfile can bypass it:

```yaml
# PodSecurityContext — applies to all containers in the pod
securityContext:
  runAsNonRoot: true       # kubelet rejects the pod if the image runs as uid 0
  runAsUser: 999
  runAsGroup: 999
  fsGroup: 999
  seccompProfile:
    type: RuntimeDefault
```

### Vulnerability Scanning

Reducing image size almost always reduces the CVE count — fewer packages means fewer vulnerabilities. But scanning should be an explicit, automated gate in CI rather than a manual step.

```bash
# Trivy: most widely adopted open-source scanner
trivy image myapp:latest

# CI mode: non-zero exit code if HIGH or CRITICAL findings exist
trivy image --exit-code 1 --severity HIGH,CRITICAL myapp:latest

# Scan a tarball (useful before the image is pushed to a registry)
docker save myapp:latest | trivy image --input /dev/stdin

# Docker Scout (native Docker CLI integration)
docker scout cves myapp:latest
docker scout compare myapp:v1 myapp:v2   # diff CVEs between two versions

# Grype (alternative with SBOM-native support)
grype myapp:latest

# Generate an SBOM (Software Bill of Materials) with Syft, then scan it
syft myapp:latest -o cyclonedx-json > sbom.json
grype sbom:./sbom.json
```

| Scanner | Strengths | Integration |
|---|---|---|
| Trivy | Fast, broad database, SBOM, secrets detection | CLI, GitHub Actions, GitLab CI, Harbor |
| Grype | SBOM-native, Syft integration, offline mode | CLI, GitHub Actions |
| Docker Scout | Native Docker Hub integration, policy enforcement | Docker CLI, GitHub Actions |
| Snyk | Developer-focused, fix suggestions, IaC scanning | CLI, IDE plugins, GitHub Actions |

**Governance pattern:** integrate scanning at two gates. First as a non-blocking warning on every pull request (inform the developer, don't block the branch). Second as a hard block before promotion to a production registry — if a CRITICAL CVE is present the image does not ship. This pattern avoids alert fatigue while maintaining a meaningful production gate.

```yaml
# Example GitHub Actions integration
- name: Scan image for vulnerabilities
  run: |
    trivy image \
      --exit-code 0 \
      --severity LOW,MEDIUM,HIGH \
      --format table \
      myapp:${{ github.sha }}

- name: Block on CRITICAL findings
  run: |
    trivy image \
      --exit-code 1 \
      --severity CRITICAL \
      myapp:${{ github.sha }}
```

**Keep your scanner's database fresh.** Trivy and Grype both cache a local vulnerability database. In CI, pull an updated database at the start of each scan run:

```bash
trivy image --download-db-only   # refresh before scanning
```

A stale database misses CVEs published after the last update — a false sense of security is worse than no scanning.

## Examples

### Example 1: Optimizing a Python Flask API from 900 MB to ~80 MB

**Setup:** a naive Dockerfile that uses the full `python:3.12` base image and installs everything in a single stage.

```dockerfile
# BEFORE: naive Dockerfile
FROM python:3.12

WORKDIR /app
COPY . .
RUN pip install -r requirements.txt

EXPOSE 5000
CMD ["flask", "run", "--host=0.0.0.0"]
```

```bash
# Build and measure the naive version
docker build -t flask-app:naive .
docker images flask-app:naive
# REPOSITORY   TAG     IMAGE ID       SIZE
# flask-app    naive   abc123...      ~900MB
```

**Optimized Dockerfile** with multi-stage build, slim base, layer hygiene, non-root user:

```dockerfile
# Stage 1: install dependencies (includes gcc for any C-extension packages)
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# --prefix=/install isolates packages for clean COPY --from
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# Stage 2: lean runtime image
FROM python:3.12-slim

WORKDIR /app

# Copy only installed packages from the builder — no gcc
COPY --from=builder /install /usr/local

# Non-root user
RUN groupadd -r flask && useradd -r -g flask --no-create-home flask

# .dockerignore excludes .git, tests/, .env, __pycache__, etc.
COPY --chown=flask:flask . .

USER flask

EXPOSE 8000
# Use gunicorn instead of Flask dev server in production
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "app:app"]
```

```
# .dockerignore
.git
**/__pycache__
**/*.pyc
.env
tests/
*.md
.pytest_cache
```

```bash
# Build and compare
docker build -t flask-app:optimized .
docker images | grep flask-app
# flask-app   optimized   ~80MB
# flask-app   naive       ~900MB

# Verify non-root user
docker run --rm flask-app:optimized whoami
# flask

# Scan the optimized image
trivy image --severity HIGH,CRITICAL flask-app:optimized
```

---

### Example 2: Go Microservice — golang:1.22 to scratch (~12 MB)

**Setup:** a Go HTTP service with no CGO dependencies.

```dockerfile
# Stage 1: compile
FROM golang:1.22-alpine AS builder

WORKDIR /src

# Download modules in a separate layer — cached until go.mod/go.sum change
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static binary: no libc, no external shared libraries required at runtime
# -ldflags="-s -w": strip symbol table and debug info — reduces binary ~30%
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o /bin/server ./cmd/server


# Stage 2: scratch — the smallest possible runtime
FROM scratch

# Without these, HTTPS calls to external services will fail at runtime
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# If your app reads timezone data (time.LoadLocation), include this too
# COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

COPY --from=builder /bin/server /server

# scratch has no /etc/passwd — run as a fixed UID without a named user
USER 10001

ENTRYPOINT ["/server"]
```

```bash
docker build -t go-service:latest .

# Verify the final size
docker images go-service:latest
# REPOSITORY   TAG      SIZE
# go-service   latest   ~12MB

# Confirm there is no shell (expected: error)
docker run --rm go-service:latest sh
# docker: Error response from daemon: failed to create shim: ... no such file or directory

# Check the binary runs correctly
docker run --rm -p 8080:8080 go-service:latest &
curl -s http://localhost:8080/healthz
```

---

### Example 3: Enforcing a Size Budget in GitHub Actions CI

This workflow builds the image, enforces a 150 MB size limit, and runs a vulnerability scan — all before any push to the registry.

```yaml
# .github/workflows/docker-build.yml
name: Build and validate Docker image

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build image (no push yet)
        run: |
          docker build \
            --cache-from myrepo/myapp:cache \
            --build-arg BUILDKIT_INLINE_CACHE=1 \
            -t myrepo/myapp:${{ github.sha }} \
            -t myrepo/myapp:cache \
            .

      - name: Enforce size budget (150 MB)
        run: |
          SIZE=$(docker inspect myrepo/myapp:${{ github.sha }} --format='{{.Size}}')
          LIMIT=157286400   # 150 MB in bytes
          echo "Image size: $SIZE bytes (limit: $LIMIT)"
          if [ "$SIZE" -gt "$LIMIT" ]; then
            echo "FAIL: image exceeds 150 MB size budget"
            exit 1
          fi

      - name: Install Trivy
        run: |
          curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
            | sh -s -- -b /usr/local/bin v0.50.0

      - name: Scan — warn on HIGH
        run: |
          trivy image --exit-code 0 --severity HIGH \
            myrepo/myapp:${{ github.sha }}

      - name: Scan — block on CRITICAL
        run: |
          trivy image --exit-code 1 --severity CRITICAL \
            myrepo/myapp:${{ github.sha }}

      - name: Push image and cache (main branch only)
        if: github.ref == 'refs/heads/main'
        run: |
          docker push myrepo/myapp:${{ github.sha }}
          docker push myrepo/myapp:cache
```

---

### Example 4: Node.js Application with BuildKit Cache Mounts

BuildKit cache mounts keep `node_modules` cached between builds without ever writing them into an image layer.

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:20-slim AS builder

WORKDIR /build

# Layer 1: package manifests (cached until package-lock.json changes)
COPY package.json package-lock.json ./

# --mount=type=cache: npm's cache dir is reused across builds, never in the image
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Layer 2: application source
COPY . .

RUN npm run build   # compile TypeScript, bundle, etc.


FROM node:20-slim

WORKDIR /app

RUN groupadd -r node-app && useradd -r -g node-app --no-create-home node-app

# Copy only what the runtime needs: built output and production node_modules
COPY --from=builder --chown=node-app:node-app /build/dist ./dist
COPY --from=builder --chown=node-app:node-app /build/node_modules ./node_modules
COPY --chown=node-app:node-app package.json .

USER node-app

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

```bash
# First build — npm downloads packages, populates cache
docker build -t node-app:latest .

# Second build after a source-only change — npm cache is reused (fast)
echo "// change" >> src/server.ts
docker build -t node-app:latest .
# The npm ci layer is served from cache; only the COPY and downstream layers rebuild

# Verify production dependencies only (no devDependencies)
docker run --rm node-app:latest node -e "require('jest')"
# Error: Cannot find module 'jest'  ← correct; jest is a devDependency
```

## Exercises

### Exercise 1: Layer Archaeology

Build the following intentionally bad Dockerfile, then diagnose and fix it.

```dockerfile
FROM ubuntu:22.04
RUN apt-get update
RUN apt-get install -y curl wget git python3 python3-pip build-essential
RUN pip3 install requests flask sqlalchemy psycopg2-binary
RUN apt-get remove -y build-essential
RUN apt-get autoremove -y
RUN rm -rf /var/lib/apt/lists/*
COPY . /app
WORKDIR /app
CMD ["python3", "app.py"]
```

1. Build it: `docker build -t bad-image .`
2. Run `docker history bad-image` and `dive bad-image` — identify which layers hold wasted bytes.
3. Record the total image size.
4. Rewrite the Dockerfile to eliminate the layer waste: combine all `RUN` commands that should be atomic, use `--no-install-recommends`, and choose a more appropriate base image.
5. Rebuild as `docker build -t good-image .` and compare sizes. Explain, in one or two sentences per change, why each modification reduced the size.

---

### Exercise 2: Multi-Stage Conversion

You are given a single-stage Python Dockerfile that builds a package with a C extension (use `cryptography` as the example):

```dockerfile
FROM python:3.12
WORKDIR /app
RUN apt-get update && apt-get install -y gcc libssl-dev libffi-dev
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["python", "main.py"]
```

Where `requirements.txt` contains: `cryptography==42.0.5`

1. Convert this to a multi-stage Dockerfile: a `builder` stage that handles compilation and a `runtime` stage based on `python:3.12-slim` that contains no compilers.
2. Build both versions and record the size difference.
3. Verify the `cryptography` package is functional in the final image: `docker run --rm yourimage python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key())"`.
4. Explain why `libssl-dev` does not need to be in the runtime stage but `libssl3` (or equivalent) might.

---

### Exercise 3: .dockerignore Audit

This exercise demonstrates how missing `.dockerignore` entries can silently leak secrets.

1. Create a project directory with the following files:
   - `app.py` (any content)
   - `requirements.txt` (any content)
   - `.env` containing `DATABASE_URL=postgres://admin:supersecret@db:5432/prod`
   - A `Dockerfile` with `COPY . .`
2. Build the image **without** a `.dockerignore` file.
3. Extract the `.env` file from the built image to prove it is present:
   ```bash
   docker create --name audit-test yourimage
   docker cp audit-test:/app/.env ./extracted.env
   cat extracted.env
   docker rm audit-test
   ```
4. Add a `.dockerignore` that excludes `.env` and all `.env.*` files. Rebuild and repeat the extraction — confirm the file is absent.
5. Now add a layer that removes the file (`RUN rm /app/.env`) instead of using `.dockerignore`, and use `docker history --no-trunc` to show that the secret is still recoverable from the layer below the deletion. Document what you find.

---

### Exercise 4: Scan, Compare, and Harden

This exercise connects base image choice directly to CVE counts.

1. Build the same minimal application (a single `CMD ["sleep", "infinity"]` is sufficient) using three different base images:
   - `ubuntu:22.04`
   - `debian:bookworm-slim`
   - `alpine:3.19`
2. Scan all three with Trivy:
   ```bash
   for tag in ubuntu debian-slim alpine; do
     trivy image --severity HIGH,CRITICAL --format table myapp:$tag 2>&1 | \
       grep -E "(Total:|CRITICAL|HIGH)" | tail -5
   done
   ```
3. Record the HIGH and CRITICAL CVE counts for each base image in a table.
4. Pick the image with the lowest CVE count. Add a non-root user and pin the base image to its digest. Rebuild and re-scan to confirm the CVE count did not increase.
5. Answer: if `alpine:3.19` has the fewest CVEs but your application uses a Python package with a C extension, what is the recommended approach and why?
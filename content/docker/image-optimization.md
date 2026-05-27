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

**Dive's "wasted space" metric** shows bytes that exist in a lower layer but are then hidden (deleted or overwritten) by a higher layer. This is the clearest signal of fixable layer hygiene problems.

To track size over time in CI, emit image size as a metric:

```bash
# Output image size in bytes — pipe to your metrics system or fail on threshold
docker inspect myapp:latest --format='{{.Size}}' 
# Compare against a threshold (500MB = 524288000 bytes)
SIZE=$(docker inspect myapp:latest --format='{{.Size}}')
if [ "$SIZE" -gt 524288000 ]; then
  echo "Image exceeds 500MB limit: $SIZE bytes" && exit 1
fi
```

### Base Image Choice

The base image is the single highest-leverage decision. It determines the starting layer count, installed packages, system utilities, and often the CVE count before you write a single application line.

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

**Alpine caveat:** Alpine uses musl libc instead of glibc. Many Python packages with C extensions (numpy, cryptography, psycopg2) either require Alpine-specific build dependencies or publish separate musl wheels. Always test the full application stack, not just `docker build`, before adopting Alpine in production.

**Distroless images** are purpose-built for production runtime. They contain the language runtime and its direct dependencies, but no shell (`/bin/sh`, `/bin/bash`), no package manager, no coreutils. This means:
- An attacker who achieves code execution cannot drop into an interactive shell
- `docker exec myapp bash` will fail — use an ephemeral debug container (`kubectl debug`) for troubleshooting
- The CVE count is typically much lower than a Debian-based image

**Pinning by digest vs tag:** Tags are mutable — `python:3.12-slim` can be updated by Docker Hub. In production, pin to an immutable digest:

```dockerfile
# Mutable (tag can be updated without your knowledge)
FROM python:3.12-slim

# Immutable (will always be this exact image)
FROM python:3.12-slim@sha256:a8140b04080d12f1af61b48f1a1534c4f1e2afec0b4edcfdd36e59af6...
```

### Multi-Stage Builds

Multi-stage builds are the most impactful structural technique for compiled languages and applications that have separate build and runtime dependencies. The final image contains only the last `FROM` stage (or a named stage referenced with `--from`).

```dockerfile
# Stage 1: builder — contains compilers, build tools, dev headers
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build-time dependencies only (not needed at runtime)
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

# Install only the runtime shared libraries (not compilers)
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

**Key insight:** the `gcc` and `libpq-dev` build tools never appear in the final image. They exist only in the `builder` stage, which is discarded. The final image gets only the compiled `.so` files and Python packages.

For Go, this pattern is even more powerful because Go produces statically linked binaries:

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0 produces a fully static binary — no libc dependency
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app ./cmd/server

# Final image: scratch has no filesystem at all
FROM scratch
# Copy only the binary and any required files (TLS certs, timezone data)
COPY --from=builder /app /app
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENTRYPOINT ["/app"]
```

A Go application that was 800 MB with `golang:1.22` as the runtime image becomes ~10–15 MB with this pattern.

### Layer Hygiene

#### Combine RUN commands

Every `RUN` instruction commits a snapshot of the filesystem as a new layer. Files deleted in a subsequent `RUN` are not removed from the image — they are hidden by the union filesystem but still stored in the lower layer and counted in the compressed image size.

```dockerfile
# BAD — three layers, apt cache persists in layer 2 even after layer 3 deletes it
RUN apt-get update
RUN apt-get install -y curl nginx
RUN rm -rf /var/lib/apt/lists/*

# GOOD — one layer, cache is never written to any persistent layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*
```

**The hidden-file problem is measurable.** Write a file, delete it in a separate `RUN`, and inspect:

```bash
# Bad Dockerfile creates an 8 MB hidden file
printf 'FROM alpine\nRUN dd if=/dev/zero of=/bigfile bs=1M count=8\nRUN rm /bigfile\n' | \
  docker build -t test-hidden -
docker history test-hidden  # bigfile bytes are in the first RUN layer

# Good Dockerfile: same net result, no wasted layer
printf 'FROM alpine\nRUN dd if=/dev/zero of=/bigfile bs=1M count=8 && rm /bigfile\n' | \
  docker build -t test-clean -
docker history test-clean   # no extra bytes
```

#### Pin package versions

```dockerfile
# Unpinned: picks up whatever is current on the mirror at build time
RUN apt-get install -y nginx

# Pinned: reproducible builds, explicit upgrade decisions
RUN apt-get install -y nginx=1.24.0-2ubuntu7
```

Find the exact version string:

```bash
# Run in a container to check available versions
docker run --rm debian:bookworm-slim apt-cache policy nginx
```

#### Exclude development dependencies

```dockerfile
# Node.js: omit devDependencies from production image
RUN npm ci --omit=dev

# Python: maintain separate requirements files
RUN pip install --no-cache-dir -r requirements.txt
# requirements.txt = production only; requirements-dev.txt = lint, test, type check
```

### .dockerignore

The `.dockerignore` file controls what the Docker build context sends to the daemon. Without it, `COPY . .` sends everything — `.git`, test fixtures, local `.env` files, `node_modules`, build artifacts. This inflates build time and can leak secrets into the image.

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
node_modules/       # if managed inside Dockerfile
.pytest_cache
.mypy_cache
dist/
build/
coverage/
```

**Security note:** a `.env` file containing database credentials copied into an image is baked into the layer permanently. Even if a subsequent instruction removes it, the credentials exist in the build history. Treat `.dockerignore` as a security boundary, not just a performance optimization.

### Build Cache Strategy

Docker's layer cache is content-addressed: if a layer's input (the instruction + all files it reads) is identical to a previous build, Docker reuses the cached layer. Once any layer is invalidated, all subsequent layers are rebuilt.

The rule: **order instructions by rate of change, slowest to fastest.**

```dockerfile
FROM python:3.12-slim

# Layer 1: system packages — changes only when you explicitly update them
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Layer 2: dependency manifest — changes when you add/remove packages (not every commit)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Layer 3: application code — changes on every commit
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

If you reverse layers 2 and 3, every code change invalidates the pip install layer, adding minutes to every CI build.

**Cache busting in CI:** use `--cache-from` to pull a remote cache layer when building on ephemeral CI runners:

```bash
docker build \
  --cache-from myrepo/myapp:cache \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  -t myrepo/myapp:latest \
  -t myrepo/myapp:cache \
  .
```

### Non-Root User

Containers run as root by default. In a non-rootless Docker setup, a container escape with a root process gives the attacker root on the host. Running as a non-root user is a fundamental hardening step.

```dockerfile
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Create system user (no home dir, no login shell) before copying files
RUN groupadd -r appuser && useradd -r -g appuser --no-create-home appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --chown sets file ownership in the same layer as the copy
COPY --chown=appuser:appuser . .

# All instructions after USER run as this user — including CMD and ENTRYPOINT
USER appuser

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Port caveat:** unprivileged users cannot bind to ports below 1024 without `CAP_NET_BIND_SERVICE`. Run your application on port 8000/8080 and map it to 80/443 at the load balancer or Kubernetes Service level.

Verify the running user:

```bash
docker run --rm myapp:latest whoami         # should print: appuser
docker run --rm myapp:latest id             # uid=999(appuser) gid=999(appuser)
```

### Vulnerability Scanning

Reducing image size almost always reduces the CVE count — fewer packages means fewer vulnerabilities. But scanning should be an explicit, automated gate in CI.

```bash
# Trivy: most widely adopted open-source scanner
# Install: https://github.com/aquasecurity/trivy

# Scan with all severity levels
trivy image myapp:latest

# CI mode: fail the build on HIGH or CRITICAL findings
trivy image --exit-code 1 --severity HIGH,CRITICAL myapp:latest

# Scan a tarball (useful when image isn't pushed yet)
docker save myapp:latest | trivy image --input /dev/stdin

# Docker Scout (available in Docker Desktop and Docker Hub)
docker scout cves myapp:latest
docker scout compare myapp:v1 myapp:v2  # diff CVEs between versions

# Grype (alternative scanner with SBOM support)
grype myapp:latest
```

| Scanner | Strengths | Integration |
|---|---|---|
| Trivy | Fast, broad database, SBOM, secrets | CLI, GitHub Actions, GitLab CI |
| Grype | SBOM-native, Syft integration | CLI, GitHub Actions |
| Docker Scout | Native Docker Hub integration, policy | Docker CLI, GitHub Actions |
| Snyk | Developer-focused, fix suggestions | CLI, IDE, GitHub Actions |

**Governance pattern:** integrate scanning as a non-blocking step early (warn on HIGH) and a blocking step before production promotion (fail on CRITICAL
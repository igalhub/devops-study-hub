---
title: Image Optimization
module: docker
duration_min: 15
difficulty: intermediate
tags: [docker, optimization, size, security, layers, slim, distroless]
exercises: 4
---

## Overview
Large Docker images slow down deployments, increase attack surface, consume more storage, and cost more to transfer. Optimizing images is both a performance concern and a security practice. This lesson covers the techniques that actually move the needle — base image choice, layer hygiene, and build cache strategy.

## Concepts

### Measure First
```bash
# List images with sizes
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

# Analyze layer-by-layer breakdown
docker history myapp:latest

# Detailed layer analysis with dive (third-party tool)
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock wagoodman/dive myapp:latest
```

### Base Image Choice
This single decision often has the largest impact:

| Base | Typical size | Use case |
|---|---|---|
| `ubuntu:22.04` | ~80 MB | General purpose, apt available |
| `debian:bookworm-slim` | ~75 MB | Debian without extras |
| `alpine:3.19` | ~7 MB | Minimal, musl libc — check compatibility |
| `python:3.12-slim` | ~130 MB | Python, Debian slim base |
| `python:3.12-alpine` | ~50 MB | Python, Alpine base |
| `distroless/python3` | ~50 MB | No shell, no package manager |
| `scratch` | 0 B | Fully static binaries only |

**Alpine caveat:** uses musl libc instead of glibc. Some Python C extensions and compiled binaries don't work with musl without recompilation. Always test before switching.

**Distroless** (Google): no shell, no package manager, no utilities. Excellent security posture — attacker can't drop into a shell. Good for production Go and Java apps.

### Layer Hygiene

#### Combine RUN commands
Every `RUN` creates a layer. Layers are union-mounted, so deleted files in a later layer don't actually reduce image size — they're just hidden.

```dockerfile
# BAD: cache bloat in intermediate layers
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*   # this does NOT remove bytes from the install layer

# GOOD: single layer, apt cache cleaned in the same step
RUN apt-get update && apt-get install -y \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*
```

#### Pin package versions
```dockerfile
RUN apt-get update && apt-get install -y \
    nginx=1.24.0-2ubuntu7 \
    && rm -rf /var/lib/apt/lists/*
```

Prevents builds from silently picking up a newer (potentially breaking) version.

#### Don't install recommended packages
```dockerfile
RUN apt-get install -y --no-install-recommends nginx
```

`--no-install-recommends` can cut 30–50% of the install size for many packages.

### Minimize What You Copy
```dockerfile
# .dockerignore is essential — exclude everything not needed at runtime
# .git, tests/, docs/, *.md, .env, node_modules (if handled in Dockerfile)
```

```dockerfile
# Install only production dependencies
RUN npm ci --omit=dev
RUN pip install --no-cache-dir -r requirements.txt
```

### Use Non-Root User
Running as root inside a container is a security risk — a container escape gives root on the host (in non-rootless setups).

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser appuser

COPY --chown=appuser:appuser requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=appuser:appuser . .

# Switch to non-root user
USER appuser

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Build Cache Strategy
Cache layers that change rarely at the top; layers that change often at the bottom:

```dockerfile
# Rarely changes: base image, system packages
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev && rm -rf /var/lib/apt/lists/*

# Changes when dependencies change (not every commit)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Changes most often: application code
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0"]
```

### Scan for Vulnerabilities
```bash
# Built-in Docker Scout (Docker Desktop)
docker scout cves myapp:latest

# Trivy (open source, widely used in CI)
trivy image myapp:latest
trivy image --severity HIGH,CRITICAL myapp:latest

# Grype
grype myapp:latest
```

Add vulnerability scanning to CI — fail the build on CRITICAL findings.

### Labels and Metadata
```dockerfile
LABEL org.opencontainers.image.source="https://github.com/org/repo"
LABEL org.opencontainers.image.revision="${GIT_SHA}"
LABEL org.opencontainers.image.version="${APP_VERSION}"
```

Standard OCI labels enable container registries to link images to source repos automatically.

## Examples

### Before and After
```dockerfile
# BEFORE: 1.1 GB
FROM python:3.12
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
CMD ["python", "app.py"]

# AFTER: ~130 MB
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
RUN groupadd -r app && useradd -r -g app app
COPY --from=builder /install /usr/local
COPY --chown=app:app . .
USER app
CMD ["python", "app.py"]
```

### CI Scan Step
```yaml
# GitHub Actions: scan before push
- name: Scan image
  run: |
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin
    trivy image --exit-code 1 --severity CRITICAL myapp:latest
```

## Exercises

1. Take any existing Dockerfile and reduce its image size by: choosing a slim/alpine base, combining RUN commands, adding `--no-install-recommends`, and adding a `.dockerignore`. Measure before/after with `docker images`.
2. Add a non-root user to an existing Dockerfile. Use `--chown` on `COPY` instructions and `USER` before `CMD`. Verify with `docker run --rm myapp whoami`.
3. Run `trivy image` (or `docker scout cves`) against a common base image (`nginx:latest` vs `nginx:1.25-alpine`). Compare the vulnerability counts and identify at least one CRITICAL finding.
4. Write a Dockerfile that demonstrates bad layer hygiene (deleting files in a separate RUN step) and calculate that the file is still in the image with `docker history`. Fix it with a combined RUN and verify the image is smaller.

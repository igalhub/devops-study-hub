---
title: Multi-stage Builds
module: docker
duration_min: 15
difficulty: intermediate
tags: [docker, multi-stage, dockerfile, optimization, build]
exercises: 4
---

## Overview

Multi-stage builds solve one of the oldest tensions in containerization: the tools you need to *build* software are almost never the tools you need to *run* it. Before multi-stage builds, teams used separate Dockerfiles for CI and production, or shell-scripted their way around the problem by building outside Docker and copying artifacts in. Both approaches broke reproducibility. Multi-stage builds collapse the entire pipeline — dependency installation, compilation, testing, and packaging — into a single Dockerfile with a clean separation between build-time and runtime concerns.

The guiding principle is **artifact promotion**: each stage produces something, and later stages cherry-pick only what they need via `COPY --from`. The intermediate layers — compilers, test frameworks, downloaded source tarballs, intermediate object files — are discarded automatically. The final image is exactly what you declare it to be. This matters for security as much as size: a production image without a shell, a package manager, or source code has a dramatically smaller attack surface.

In the broader DevOps toolchain, multi-stage builds sit at the intersection of CI/CD and container security. They enable a single `docker build` call to serve as a full pipeline step: install, compile, test, package. The `--target` flag lets CI systems stop at any stage — run tests in one job, push the production image in the next — without maintaining separate Dockerfiles. Combined with layer caching and build arguments, they make image builds both fast and auditable.

---

## Concepts

### The Problem Multi-stage Solves

Without multi-stage builds, a naive Dockerfile bundles everything that touched the build process into the final image.

```dockerfile
# Single-stage: everything ends up in the image
FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm ci                  # installs devDependencies too
COPY . .
RUN npm run build
# Image contains: Node.js runtime, npm, ALL node_modules (including dev),
# source code, TypeScript compiler, test runners, build output
# Typical size: 1.0–1.4 GB
```

Multi-stage builds isolate each concern into its own `FROM` block. Only deliberate `COPY --from` instructions move data between stages.

```dockerfile
# Stage 1: build — has everything the compiler needs
FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: production — starts from scratch, takes only the output
FROM nginx:1.25-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Image contains: nginx + static files only
# Typical size: 20–30 MB
```

**The intermediate stages never appear in the final image.** Docker builds them in order, uses them as sources for `COPY --from`, then discards their layers from the final output.

---

### Syntax and Stage Referencing

```dockerfile
# Name a stage with AS <name> — names are lowercase by convention
FROM golang:1.24-alpine AS builder

# Reference a previous stage by name
COPY --from=builder /app/binary /binary

# Reference a previous stage by zero-based index (fragile — avoid)
COPY --from=0 /app/binary /binary

# Reference an external image directly — no prior stage needed
# Docker pulls the image just to copy files from it
COPY --from=alpine:3.19 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
```

| Reference style | Example | When to use |
|---|---|---|
| Named stage | `--from=builder` | Always prefer — readable and refactor-safe |
| Index | `--from=0` | Avoid — breaks when stages are reordered |
| External image | `--from=alpine:3.19` | Copying well-known files (certs, binaries) without defining a stage |

**Stage names are scoped to the Dockerfile.** Two Dockerfiles can both have a stage named `builder` without conflict. Names must be valid identifiers (alphanumeric + hyphens).

---

### Build Arguments Across Stages

`ARG` values do not automatically propagate between stages. Each stage that needs an argument must re-declare it.

```dockerfile
# Declare at the top: available before the first FROM
ARG BUILD_VERSION=dev

FROM node:20-alpine AS builder
# Re-declare to pull the value into this stage's scope
ARG BUILD_VERSION
RUN echo "Building version: $BUILD_VERSION" \
    && echo "$BUILD_VERSION" > /app/version.txt

FROM node:20-alpine AS runner
# Re-declare again — each stage is isolated
ARG BUILD_VERSION
ENV APP_VERSION=$BUILD_VERSION
COPY --from=builder /app/version.txt ./version.txt
```

```bash
# Pass the argument at build time
docker build --build-arg BUILD_VERSION=1.4.2 -t myapp:1.4.2 .
```

**ARG vs ENV across stages:** `ARG` values exist only at build time. `ENV` values persist into the running container. If you need a value both at build time *and* runtime, assign it to an `ENV` inside the stage: `ENV APP_VERSION=$BUILD_VERSION`.

**Security note:** `ARG` values (including secrets like API keys) are visible in `docker history`. Never pass secrets via `ARG`. Use Docker BuildKit secret mounts (`--mount=type=secret`) instead.

---

### Targeting a Specific Stage

The `--target` flag stops the build at a named stage and exports that image. Every stage before the target is built normally; every stage after is skipped.

```bash
# Build only the 'builder' stage — useful for caching dependency layers in CI
docker build --target builder -t myapp:deps .

# Build the 'test' stage — runs tests, fails the build if they fail
docker build --target test -t myapp:test .

# Build the final production image
docker build --target production -t myapp:latest .
```

This pattern maps cleanly to CI pipeline stages:

```yaml
# Conceptual CI pipeline (GitLab CI style)
stages:
  - test
  - build

run-tests:
  script:
    - docker build --target test -t $CI_PROJECT_NAME:test .

build-image:
  script:
    - docker build --target production -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
  needs: [run-tests]
```

**If you don't use `--target`, Docker builds all stages but only outputs the final one.** Intermediate stages are still cached, so subsequent builds reuse layers even from stages you never explicitly target.

---

### The Test Stage Pattern

Embedding tests inside the Dockerfile guarantees tests run in the same environment as the build. If tests fail, the image is never produced.

```dockerfile
FROM python:3.12-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM base AS test
# Install dev/test deps on top of base — not in production
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY . .
RUN pytest --tb=short -q   # RUN fails the layer if pytest exits non-zero

FROM base AS production
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
# In CI — fail fast if tests fail
docker build --target test .

# If the above succeeds, build the production image
docker build --target production -t myapp:latest .
```

**`RUN pytest` failing causes the entire `docker build` to exit non-zero.** Your CI system sees a failed build and stops the pipeline. The production image is never tagged or pushed. This is the intended behavior — it's not an error to be worked around.

---

### Layer Caching Strategy

Multi-stage builds interact with Docker's layer cache the same way single-stage builds do: a layer is invalidated when its instruction or any preceding instruction changes. Good cache discipline matters especially in multi-stage builds because you typically have more layers.

```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /app

# Copy dependency manifests FIRST — these change rarely
# Docker caches the `go mod download` layer until go.mod/go.sum change
COPY go.mod go.sum ./
RUN go mod download

# Copy source AFTER — this layer invalidates on every code change,
# but the dependency layer above stays cached
COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server
```

**Common cache-busting mistake:** `COPY . .` before installing dependencies. Changing *any* source file invalidates the dependency install layer, forcing a full `npm ci` or `go mod download` on every build.

| What changes | Layers rebuilt |
|---|---|
| Source code only | `COPY . .` and everything after |
| `go.sum` / `package-lock.json` | Dependency install + all subsequent layers |
| Base image updated | All layers in that stage |
| Instruction text changes | That layer and all subsequent |

---

### Base Image Selection for Final Stages

The choice of final-stage base image determines the security footprint, image size, and operational characteristics of your container.

| Base image | Typical size | Shell | Package manager | Use case |
|---|---|---|---|---|
| `scratch` | 0 MB | No | No | Fully static Go/Rust binaries |
| `alpine:3.x` | ~7 MB | sh (busybox) | apk | Small images that still need a shell |
| `debian:bookworm-slim` | ~75 MB | bash | apt | Apps needing glibc or common libs |
| `ubuntu:24.04` | ~80 MB | bash | apt | Familiarity, large ecosystem |
| `distroless/base` | ~20 MB | No | No | Non-Go apps without a shell (gcr.io) |
| Language `-slim` variants | Varies | bash | apt (limited) | Python/Ruby/Node with minimal OS |

**`scratch` gotcha:** a binary in `scratch` must be completely statically linked. Any dynamic library dependency (including glibc) causes a runtime error: `no such file or directory`. For Go, set `CGO_ENABLED=0`. For Rust, use `musl` target. For compiled languages that link against glibc (C, C++, default Rust), use `distroless/base` or `alpine` instead.

**`alpine` gotcha:** Alpine uses `musl` libc, not `glibc`. Most Go and Rust binaries work fine, but Python C extensions and some Node.js native modules may behave differently or require recompilation. If you see mysterious runtime errors that only appear in Alpine, suspect musl/glibc incompatibility.

---

## Examples

### Example 1: Go REST API to `scratch`

A complete example for a Go HTTP server that makes outbound HTTPS calls. The final image is ~8 MB.

```dockerfile
# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS builder
WORKDIR /app

# Download dependencies with cache mount (BuildKit)
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=0: static binary, no C dependencies
# -ldflags="-s -w": strip debug symbols (~30% smaller binary)
# -trimpath: remove local build paths from binary (reproducibility + security)
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -trimpath -o /server ./cmd/server

# ---- Test stage ----
FROM builder AS test
RUN go test ./... -v

# ---- Final stage ----
FROM scratch AS production
# CA certificates from Alpine — required for TLS verification in outbound HTTPS calls
COPY --from=alpine:3.19 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# /etc/passwd: needed if your app calls os/user or reads current user
COPY --from=alpine:3.19 /etc/passwd /etc/passwd
COPY --from=builder /server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
```

```bash
# Build and verify
docker build --target test .                            # run tests
docker build --target production -t goapi:latest .     # build final image
docker images goapi                                     # check size

# Run and verify HTTPS works
docker run -d -p 8080:8080 --name goapi goapi:latest
curl -s http://localhost:8080/healthz                  # health check endpoint
docker exec goapi /server --version 2>/dev/null || echo "no shell — expected"
```

---

### Example 2: Java / Maven Spring Boot

Separates Maven dependency caching from source compilation. Reduces CI rebuild time significantly when only source changes.

```dockerfile
FROM maven:3.9-eclipse-temurin-21 AS deps
WORKDIR /app
# Copy only the POM first — `mvn dependency:go-offline` caches .m2
# This layer is reused as long as pom.xml doesn't change
COPY pom.xml .
RUN mvn dependency:go-offline -q

FROM deps AS builder
# Now copy source — invalidates only the compile layer, not the dep layer
COPY src ./src
RUN mvn package -DskipTests -q

FROM deps AS test
COPY src ./src
RUN mvn test -q   # full test suite; fails build if tests fail

FROM eclipse-temurin:21-jre-alpine AS production
WORKDIR /app
# Copy only the fat jar — no Maven, no JDK, no source
COPY --from=builder /app/target/*.jar app.jar
EXPOSE 8080
# Use exec form so the JVM receives SIGTERM directly (graceful shutdown)
ENTRYPOINT ["java", \
  "-XX:+UseContainerSupport", \
  "-XX:MaxRAMPercentage=75.0", \
  "-jar", "app.jar"]
```

```bash
docker build --target test -t myapp:test .
docker build --target production -t myapp:latest .

# Verify JRE image, not JDK
docker run --rm myapp:latest java -version   # shows JRE
docker run --rm myapp:latest mvn -version    # fails — Maven not present
docker images myapp                          # ~130 MB vs ~660 MB for full Maven image
```

| Stage | Base image | Approximate size | Purpose |
|---|---|---|---|
| `deps` | `maven:3.9-eclipse-temurin-21` | ~660 MB | Dependency cache layer |
| `builder` | inherits `deps` | ~660 MB + jar | Compile source |
| `test` | inherits `deps` | ~660 MB + test results | Run tests |
| `production` | `eclipse-temurin:21-jre-alpine` | ~130 MB | Runtime only |

---

### Example 3: Node.js Three-Stage Build (deps / build / production)

Demonstrates separating production dependency install, transpilation, and the final runtime image to minimize what enters production.

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# --omit=dev: only production dependencies
# These are stable; this layer caches well
RUN npm ci --omit=dev

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# Full install including devDependencies for TypeScript, bundler, etc.
RUN npm ci
COPY . .
# Produces /app/dist — compiled JS output
RUN npm run build

FROM node:20-alpine AS test
WORKDIR /app
# Reuse the full install from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY . .
RUN npm test

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# Production deps only — no TypeScript, no Jest, no webpack
COPY --from=deps /app/node_modules ./node_modules
# Compiled output only — no TypeScript source
COPY --from=builder /app/dist ./dist
COPY package.json .
EXPOSE 3000
# Use node directly — avoid npm as PID 1 (signal handling issues)
CMD ["node", "dist/server.js"]
```

```bash
docker build --target test -t myapp:test .          # verify tests
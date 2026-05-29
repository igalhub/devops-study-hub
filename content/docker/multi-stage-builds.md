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

**The intermediate stages never appear in the final image.** Docker builds them in order, uses them as sources for `COPY --from`, then discards their layers from the final output. This is not a compression trick — those layers are simply never written to the output image.

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
| Index | `--from=0` | Avoid — breaks silently when stages are reordered |
| External image | `--from=alpine:3.19` | Copying well-known files (certs, binaries) without defining a stage |

**Stage names are scoped to the Dockerfile.** Two Dockerfiles can both have a stage named `builder` without conflict. Names must be valid identifiers (alphanumeric + hyphens, no underscores by convention).

**You can have multiple `FROM` instructions referencing the same base image with different names.** This is intentional and common — for example, a `test` stage and a `builder` stage both starting from the same `deps` stage to share a cached dependency layer.

---

### Build Arguments Across Stages

`ARG` values do not automatically propagate between stages. Each stage that needs an argument must re-declare it.

```dockerfile
# Declare at the top: available before the first FROM (e.g., to pin base image versions)
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

**ARG vs ENV across stages:** `ARG` values exist only at build time and are not present in the running container. `ENV` values persist into the running container. If you need a value both at build time *and* runtime, assign it to an `ENV` inside the stage: `ENV APP_VERSION=$BUILD_VERSION`.

**Security note:** `ARG` values (including secrets like API keys) are visible in `docker history`. Never pass secrets via `ARG`. Use Docker BuildKit secret mounts (`--mount=type=secret`) instead.

```bash
# Correct pattern for secrets with BuildKit
# In Dockerfile:
# RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
docker build --secret id=npmrc,src=$HOME/.npmrc -t myapp .
```

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
# GitLab CI — test and build as separate jobs sharing the registry cache
stages:
  - test
  - build

run-tests:
  stage: test
  script:
    - docker build --target test -t $CI_REGISTRY_IMAGE:test-$CI_COMMIT_SHA .

build-image:
  stage: build
  script:
    - docker build --target production -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
  needs: [run-tests]
```

**If you don't use `--target`, Docker builds all stages but only outputs the final one.** Intermediate stages are still cached, so subsequent builds reuse layers even from stages you never explicitly target. This is why a targeted `--target test` build followed by a `--target production` build is fast — the shared layers are already cached.

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

**The test stage shares layers with the production stage via the `base` stage.** `pip install -r requirements.txt` runs once and is cached. Only the dev dependencies and the test execution are unique to the test stage. This keeps CI fast without duplicating work.

---

### Layer Caching Strategy

Multi-stage builds interact with Docker's layer cache the same way single-stage builds do: a layer is invalidated when its instruction or any preceding instruction changes. Good cache discipline matters especially in multi-stage builds because you typically have more layers and more opportunities to accidentally bust the cache.

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
| Base image updated upstream | All layers in that stage |
| Any instruction text changes | That layer and all subsequent layers |
| Nothing | Full cache hit — near-instant build |

**BuildKit cache mounts** persist a directory across builds without baking it into a layer. This is ideal for package manager caches:

```dockerfile
# --mount=type=cache persists /root/.cache across builds
# The cache is never written into the image layer
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt
```

---

### Base Image Selection for Final Stages

The choice of final-stage base image determines the security footprint, image size, and operational characteristics of your container.

| Base image | Typical size | Shell | Package manager | Use case |
|---|---|---|---|---|
| `scratch` | 0 MB | No | No | Fully static Go/Rust binaries |
| `alpine:3.x` | ~7 MB | sh (busybox) | apk | Small images that still need a shell |
| `debian:bookworm-slim` | ~75 MB | bash | apt | Apps needing glibc or common libs |
| `ubuntu:24.04` | ~80 MB | bash | apt | Familiarity, large ecosystem |
| `gcr.io/distroless/base` | ~20 MB | No | No | Non-Go apps without a shell |
| `gcr.io/distroless/java21` | ~220 MB | No | No | Java apps, minimal JRE, no shell |
| Language `-slim` variants | Varies | bash | apt (limited) | Python/Ruby/Node with minimal OS |

**`scratch` gotcha:** a binary in `scratch` must be completely statically linked. Any dynamic library dependency (including glibc) causes a runtime error: `no such file or directory` — not a meaningful error message for what is actually a missing shared library. For Go, set `CGO_ENABLED=0`. For Rust, use the `musl` target. For compiled languages that link against glibc (C, C++, default Rust), use `distroless/base` or `alpine` instead.

**`alpine` gotcha:** Alpine uses `musl` libc, not `glibc`. Most Go and Rust binaries work fine, but Python C extensions and some Node.js native modules may behave differently or require recompilation. If you see mysterious runtime errors that only appear in Alpine, suspect musl/glibc incompatibility. The fix is to switch to a `debian-slim` or `distroless` base.

**Distroless images** contain no shell, no package manager, no coreutils — only the language runtime and its dependencies. This reduces the attack surface significantly (no `sh` means no shell injection pivot), but it also means `docker exec` for debugging is limited. Use a sidecar debug container or `docker debug` (Docker Desktop 4.27+) in those cases.

---

### Signal Handling and PID 1

A subtle but operationally important detail: the process started by `CMD` or `ENTRYPOINT` in exec form becomes PID 1 in the container. PID 1 receives signals (SIGTERM for graceful shutdown) directly. When you use shell form, a shell process becomes PID 1 and may not forward signals to your application.

```dockerfile
# Shell form — sh becomes PID 1, your app is a child process
# SIGTERM goes to sh, not your app; graceful shutdown may not work
CMD uvicorn main:app --host 0.0.0.0 --port 8000

# Exec form — your app is PID 1, receives SIGTERM directly
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Always use exec form (`["cmd", "arg"]`) in the final stage of multi-stage builds.** This is especially important in Kubernetes, where pod termination sends SIGTERM and waits for `terminationGracePeriodSeconds` before SIGKILL.

---

## Examples

### Example 1: Go REST API to `scratch`

A complete example for a Go HTTP server that makes outbound HTTPS calls. The final image is ~8 MB.

```dockerfile
# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS builder
WORKDIR /app

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
# CA certificates — required for TLS verification in outbound HTTPS calls
# scratch has no filesystem at all, so we pull certs from Alpine
COPY --from=alpine:3.19 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# /etc/passwd — needed if your app calls os/user or reads the current user
COPY --from=alpine:3.19 /etc/passwd /etc/passwd
COPY --from=builder /server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
```

```bash
# Run tests first — build fails here if any test fails
docker build --target test .

# Build the production image
docker build --target production -t goapi:latest .

# Verify size
docker images goapi
# REPOSITORY   TAG       IMAGE ID       CREATED         SIZE
# goapi        latest    a3f9b2c1d4e7   3 seconds ago   8.12MB

# Run and verify
docker run -d -p 8080:8080 --name goapi goapi:latest
curl -s http://localhost:8080/healthz

# Confirm there is no shell — expected behavior for scratch images
docker exec goapi sh 2>&1
# OCI runtime exec failed: exec: "sh": executable file not found in $PATH

# Clean up
docker stop goapi && docker rm goapi
```

---

### Example 2: Java / Maven Spring Boot

Separates Maven dependency caching from source compilation. Reduces CI rebuild time significantly when only source changes.

```dockerfile
# syntax=docker/dockerfile:1

FROM maven:3.9-eclipse-temurin-21 AS deps
WORKDIR /app
# Copy only the POM first — `mvn dependency:go-offline` downloads all deps
# This layer is reused as long as pom.xml doesn't change
COPY pom.xml .
RUN mvn dependency:go-offline -q

FROM deps AS builder
# Source copy invalidates only compile layers, not the dep download layer
COPY src ./src
RUN mvn package -DskipTests -q

FROM deps AS test
COPY src ./src
# Full test suite — fails the build if any test fails
RUN mvn test -q

FROM eclipse-temurin:21-jre-alpine AS production
WORKDIR /app
# Copy only the fat jar — no Maven, no JDK, no source code
COPY --from=builder /app/target/*.jar app.jar
EXPOSE 8080
# Exec form for correct signal handling
# UseContainerSupport: JVM reads cgroup memory limits (not host memory)
# MaxRAMPercentage: use 75% of container memory limit for heap
ENTRYPOINT ["java", \
  "-XX:+UseContainerSupport", \
  "-XX:MaxRAMPercentage=75.0", \
  "-jar", "app.jar"]
```

```bash
# Run tests
docker build --target test -t myapp:test .

# Build production image
docker build --target production -t myapp:latest .

# Verify JRE only — no JDK, no Maven
docker run --rm myapp:latest java -version    # JRE present
docker run --rm myapp:latest mvn -version 2>&1 | grep -i "not found"
# sh: mvn: not found

# Size comparison
docker images myapp
# myapp   latest   ...   ~130 MB   (vs ~660 MB for full Maven image)
```

| Stage | Base image | Purpose |
|---|---|---|
| `deps` | `maven:3.9-eclipse-temurin-21` | Cached dependency download layer |
| `builder` | inherits `deps` | Compile source into fat jar |
| `test` | inherits `deps` | Run full test suite |
| `production` | `eclipse-temurin:21-jre-alpine` | Runtime only (~130 MB) |

---

### Example 3: Node.js Three-Stage Build (deps / build / production)

Demonstrates separating production dependency install, transpilation, and the final runtime image to minimize what enters production.

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# --omit=dev: install only production dependencies
# This layer is stable — only changes when production deps change
RUN npm ci --omit=dev

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# Full install including devDependencies (TypeScript, bundler, etc.)
RUN npm ci
COPY . .
# Produces /app/dist — compiled and bundled JS output
RUN npm run build

FROM node:20-alpine AS test
WORKDIR /app
# Reuse the full node_modules from builder — no reinstall needed
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY . .
RUN npm test

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# Production deps only — no TypeScript, Jest, webpack, or source maps
COPY --from=deps /app/node_modules ./node_modules
# Compiled output only — no .ts source files
COPY --from=builder /app/dist ./dist
COPY package.json .
EXPOSE 3000
# node directly as PID 1 — avoid npm as PID 1 (npm does not forward SIGTERM)
CMD ["node", "dist/server.js"]
```

```bash
# Run the full pipeline
docker build --target test -t myapp:test .
docker build --target production -t myapp:latest .

# Verify no dev dependencies shipped
docker run --rm myapp:latest node -e "require('typescript')" 2>&1
# Error: Cannot find module 'typescript' — correct, TypeScript is not in production

# Check size difference
docker images myapp
# myapp   latest   ...   ~120 MB   (vs ~1.1 GB with all dev deps)

# Run the service
docker run -d -p 3000:3000 --name nodeapp myapp:latest
curl -s http://localhost:3000/healthz
docker stop nodeapp && docker rm nodeapp
```

---

### Example 4: Static Frontend (React) Served by Nginx

Builds a React application and serves only the compiled static assets behind Nginx, with a custom config baked in.

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# VITE_API_URL is a build-time variable baked into the JS bundle
ARG VITE_API_URL=http://localhost:8080
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build   # outputs to /app/dist

FROM node:20-alpine AS test
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN npm run test -- --run   # Vitest: --run exits after one pass

FROM nginx:1.25-alpine AS production
# Remove the default nginx config
RUN rm /etc/nginx/conf.d/default.conf
# Copy custom config — handles SPA routing (try_files fallback to index.html)
COPY nginx.conf /etc/nginx/conf.d/app.conf
# Copy compiled assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
# Nginx default CMD runs as PID 1 in foreground — correct behavior
```

```nginx
# nginx.conf — placed at repo root alongside Dockerfile
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing: unknown paths fall back to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets aggressively — Vite adds content hashes to filenames
    location ~* \.(js|css|png|jpg|svg|ico|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

```bash
# Build with a specific API URL
docker build \
  --target test . &&
docker build \
  --build-arg VITE_API_URL=https://api.example.com \
  --target production \
  -t frontend:latest .

# Verify the bundle references the correct API URL
docker run --rm frontend:latest grep -r "api.example.com" /usr/share/nginx/html/assets/

# Run and test SPA routing
docker run -d -p 8080:80 --name frontend frontend:latest
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/some/nested/route
# 200 — nginx returns index.html for all unmatched paths

docker stop frontend && docker rm frontend
```

---

## Exercises

### Exercise 1: Measure the Impact of Multi-stage Builds

**Goal:** Quantify the size and content difference between single-stage and multi-stage builds for a real application.

1. Pick a language you are comfortable with (Node.js, Python, or Go). Write a minimal but working HTTP server that serves a `/healthz` endpoint.
2. Write a **single-stage Dockerfile** that installs all dependencies (including dev) and runs the server. Build it and record the image size with `docker images`.
3. Write a **multi-stage Dockerfile** with at least a `builder` stage and a minimal final stage. Build it and record the image size.
4. Use `docker history <image>` on both images to inspect the layer breakdown.
5. Run `docker run --rm <image> sh -c "find / -name '*.ts' 2>/dev/null | head -20"` (or equivalent for your language's source extension) on the production image. Confirm no source files are present.

**Deliverable:** A written comparison of image sizes and a list of what was eliminated from the production image.

---

### Exercise 2: Embed Tests in the Build Pipeline

**Goal:** Use the test stage pattern to make a failing test block image production.

1. Take an existing project or create a new one with at least one unit test.
2. Write a multi-stage Dockerfile with a `test` stage that runs the test suite. Ensure the `RUN` command for tests exits non-zero on failure.
3. Intentionally break a test (introduce a bug in the source code).
4. Run `docker build --target test .` and confirm the build fails with a non-zero exit code.
5. Fix the bug, re-run the test build to confirm it passes, then build `--target production`.
6. **Bonus:** Wire this into a simple shell script that runs both steps sequentially and only tags the production image if the test build succeeds.

**Deliverable:** The Dockerfile and the shell script. Be prepared to explain why `RUN pytest` failing is more reliable than checking test output in a subsequent step.

---

### Exercise 3: Optimize Cache Ordering for a Slow Dependency Install

**Goal:** Demonstrate the practical build time difference between cache-friendly and cache-hostile layer ordering.

1. Create a project with a `package.json` (or `requirements.txt`) that has at least 10 dependencies. Include a trivial source file.
2. Write a **cache-hostile Dockerfile** that does `COPY . .` before `RUN npm ci`. Build it twice, change only a comment in your source file, build again. Measure the time for the third build — notice the full `npm ci` re-runs.
3. Rewrite it with **cache-friendly ordering**: copy only the dependency manifest first, install, then copy source. Repeat the same experiment. Measure the third build time.
4. Use `docker build --progress=plain` to see per-layer timing and confirm which layers are `CACHED` in the second approach.

**Deliverable:** The two Dockerfiles and a written explanation of which layers are cached in each scenario and why.

---

### Exercise 4: Use `--target` in a Simulated CI Pipeline

**Goal:** Use `--target` to implement a two-job CI pipeline locally with shell scripts.

1. Write a multi-stage Dockerfile with at least three stages: `builder`, `test`, and `production`.
2. Write a shell script `ci-test.sh` that:
   - Builds `--target test` and tags it as `myapp:test-$GIT_SHA` (use `$(git rev-parse --short HEAD)` or a fixed string if not in a git repo).
   - Exits non-zero if the build fails.
3. Write a second shell script `ci-publish.sh` that:
   - Calls `ci-test.sh` (or assumes it has already passed).
   - Builds `--target production` and tags it as `myapp:$GIT_SHA`.
   - Runs the production image briefly (`docker run --rm -d`, waits 2 seconds, hits the health endpoint with `curl`, stops the container).
   - Exits non-zero if the health check fails.
4. Run both scripts. Then modify `ci-publish.sh` to skip re-running tests (assume they passed in a prior job) and observe that the shared cache means the production build is near-instant.

**Deliverable:** Both shell scripts. Be prepared to explain how `--target` avoids rebuilding layers that were already built in the test job, and what the implications are for CI cache warming.

---

### Quick Checks

5. Extract stage aliases from a multi-stage Dockerfile. Run: `printf 'FROM golang:1.21 AS builder\nFROM gcr.io/distroless/static AS runtime\n' | awk '/AS/{print $NF}'`

```expected_output
builder
runtime
```

hint: Think about how you can filter lines containing a specific keyword and then extract the last word from those lines.
hint: Use awk with a pattern match for 'AS' and print $NF to grab the final field on each matching line.

6. Count `FROM` instructions in a multi-stage Dockerfile stub. Run: `printf 'FROM node:20 AS deps\nFROM node:20 AS build\nFROM nginx:alpine\n' | grep -c '^FROM'`

```expected_output
3
```
hint: Think about how you can filter lines that match a specific pattern and have the shell count those matches automatically.
hint: Use grep with the -c flag to count lines matching the anchored pattern ^FROM in the piped input.

---
title: Images & Containers
module: docker
duration_min: 20
difficulty: beginner
tags: [docker, images, containers, dockerfile, build, run]
exercises: 4
---

## Overview

Docker solves the "works on my machine" problem by packaging an application together with every library, config file, and runtime dependency it needs into a single artifact called an **image**. When you run that image, Docker creates a **container** — an isolated process that sees its own filesystem, network stack, and process tree. Because the image is identical regardless of the host, a container behaves the same on a developer laptop, a CI runner, or a production Kubernetes node. That reproducibility is why containers became the default unit of deployment in modern DevOps.

The design centers on two principles: **immutability** and **layering**. Images are never modified after they are built; instead, you build a new image. Layering means each build instruction adds a thin diff on top of the previous state, and Docker caches those diffs aggressively. The result is fast incremental builds and efficient storage — two images that share a base layer store that base only once on disk and in a registry.

In the broader toolchain, images sit at the handoff point between development and operations. A CI pipeline builds and tests an image, pushes it to a registry (Docker Hub, ECR, GCR, GHCR), and downstream systems — Compose, Kubernetes, ECS — pull and run it. Understanding exactly how images are built and how containers behave at runtime is prerequisite knowledge for every layer above it: you cannot meaningfully debug a crashed pod in Kubernetes without understanding what a container is and how its lifecycle works.

---

## Concepts

### Images vs Containers

| | Image | Container |
|---|---|---|
| What it is | Read-only, layered filesystem snapshot | Running (or stopped) instance of an image |
| Analogy | Class definition | Object instance |
| Created by | `docker build` | `docker run` |
| Persistence | Permanent until explicitly deleted | Ephemeral by default; writable layer lost on `docker rm` |
| State | Immutable | Has a thin, mutable writable layer on top |
| Shareable | Yes — push/pull from a registry | No — containers are local to a host |

An image is identified by a **name and tag** (`nginx:1.25`) or by a **content-addressed SHA-256 digest** (`nginx@sha256:abc123...`). Tags are mutable pointers; digests are not. In production pipelines, pinning by digest gives you stronger guarantees than pinning by tag — a tag can be silently overwritten by a publisher; a digest cannot.

**Gotcha:** `docker run nginx` silently pulls `nginx:latest` if the image is not present locally. `latest` is just a tag — it is not guaranteed to be the most recent published version and it is not updated automatically on the host. Always specify an explicit tag in Dockerfiles and automation.

Multiple containers can run from the same image simultaneously. Each gets its own isolated writable layer; they do not share state unless you deliberately connect them via volumes or networks.

---

### Dockerfile Fundamentals

A Dockerfile is a sequence of instructions that Docker executes top-to-bottom to produce an image. Each instruction that writes to the filesystem creates a new **layer**.

```dockerfile
# Base image — always start from a known, minimal image
# Prefer specific tags over :latest for reproducibility
FROM ubuntu:22.04

# Metadata label — useful for tooling, auditing, and registry UIs
LABEL maintainer="developer@example.com" \
      version="1.0"

# Combine RUN commands to minimize layers and clean up in the same layer.
# apt cache must be deleted in the same RUN step or it persists in the layer
# and inflates the image size with no benefit at runtime.
RUN apt-get update && apt-get install -y \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*

# WORKDIR creates the directory if it doesn't exist.
# Affects all subsequent COPY, RUN, CMD, ENTRYPOINT instructions.
# Prefer WORKDIR over RUN cd — it is explicit and restores between layers.
WORKDIR /opt/app

# COPY files from the build context (your local directory) into the image
COPY nginx.conf /etc/nginx/nginx.conf
COPY ./app .

# ENV sets environment variables available at build time and runtime
ENV APP_ENV=production \
    PORT=80

# ARG is only available during the build, not at runtime
ARG APP_VERSION=unknown
RUN echo "Building version $APP_VERSION"

# EXPOSE documents which port the container listens on.
# It does NOT publish the port — that happens with -p at runtime.
EXPOSE 80

# CMD provides the default command when the container starts.
# Exec form (JSON array) is preferred over shell form — see next table.
CMD ["nginx", "-g", "daemon off;"]
```

**Shell form vs exec form:**

| Form | Example | Behavior |
|------|---------|----------|
| Shell form | `CMD nginx -g "daemon off;"` | Runs via `/bin/sh -c`; PID 1 is `sh`, not `nginx` |
| Exec form | `CMD ["nginx", "-g", "daemon off;"]` | Runs directly; PID 1 is `nginx` |

**Always use exec form for CMD and ENTRYPOINT.** With shell form, signals like `SIGTERM` (sent by `docker stop`) go to the shell process, not your application. The app never receives the shutdown signal, Docker waits the full 10-second timeout, then sends `SIGKILL`. This causes slow, ungraceful shutdowns — a common source of dropped requests and failed health checks in Kubernetes rolling deployments.

---

### COPY vs ADD

| Instruction | Copies local files | Extracts `.tar` archives | Fetches URLs |
|------------|-------------------|--------------------------|--------------|
| `COPY` | ✅ | ❌ | ❌ |
| `ADD` | ✅ | ✅ | ✅ |

**Always prefer `COPY`.** Its behavior is explicit and predictable. `ADD` with a URL bypasses the build cache (the remote file could change between builds producing different results), skips security scanning, and cannot be verified by digest. If you need to fetch something during a build, use `RUN curl` or `RUN wget` so the step is auditable and cacheable.

The only legitimate use of `ADD` over `COPY` is extracting a local `.tar.gz` directly into the image:

```dockerfile
# Acceptable ADD usage: extracts archive in one step and preserves permissions.
# Equivalent to: COPY + RUN tar xz, but in a single layer.
ADD app-release.tar.gz /opt/app/
```

---

### CMD vs ENTRYPOINT

These two instructions are frequently confused in interviews and in practice. The mental model:

- **ENTRYPOINT** — the fixed executable. Treat the container as a command.
- **CMD** — default arguments passed to that executable. Easily overridden at runtime without `--entrypoint`.

```dockerfile
# Pattern 1: CMD alone — entire command is replaceable at runtime
CMD ["nginx", "-g", "daemon off;"]
# docker run myimage              → runs nginx
# docker run myimage /bin/bash    → runs bash instead (useful for debugging)

# Pattern 2: ENTRYPOINT alone — extra args are appended, command is not replaceable
ENTRYPOINT ["nginx"]
# docker run myimage -t           → runs: nginx -t  (config test)
# docker run myimage /bin/bash    → runs: nginx /bin/bash (probably wrong)

# Pattern 3: ENTRYPOINT + CMD — recommended for tools and well-behaved services
ENTRYPOINT ["python3", "app.py"]
CMD ["--port", "8080"]
# docker run myimage                → python3 app.py --port 8080
# docker run myimage --port 9090   → python3 app.py --port 9090
# docker run --entrypoint /bin/sh myimage → override entrypoint explicitly
```

**When to use which pattern:**

| Use case | Recommendation |
|----------|---------------|
| General-purpose service (nginx, app server) | `CMD` alone — makes it easy to override for debugging |
| CLI tool wrapped in a container | `ENTRYPOINT` + `CMD` — container behaves like the tool |
| Init/entrypoint scripts that configure then exec | `ENTRYPOINT ["./entrypoint.sh"]` + `CMD` for the main process |

---

### Building Images

```bash
# Build using the Dockerfile in the current directory.
# -t sets the name and tag: name:tag
docker build -t myapp:1.0 .

# Use a different Dockerfile (useful for multi-environment or multi-arch builds)
docker build -f Dockerfile.prod -t myapp:prod .

# Pass build-time arguments (must be declared with ARG in the Dockerfile)
docker build --build-arg APP_VERSION=1.2.3 -t myapp:1.2.3 .

# Bypass the layer cache — forces every instruction to re-execute.
# Use in CI when you suspect stale cache behavior or want guaranteed freshness.
docker build --no-cache -t myapp:latest .

# Target a specific stage in a multi-stage build (useful for debugging builders)
docker build --target builder -t myapp:debug .

# Tag an existing image with an additional name (no rebuild, just a pointer)
docker tag myapp:1.0 myregistry.io/team/myapp:1.0

# Inspect layers, their sizes, and the command that created each
docker history myapp:1.0

# Full JSON metadata: config, layers, env vars, exposed ports, entrypoint
docker image inspect myapp:1.0
```

**Build context:** the `.` at the end of `docker build` is the **build context** — the directory whose contents are tarred and sent to the Docker daemon before the Dockerfile is read. Docker sends the entire context first. A large context (containing `node_modules`, `.git`, or large binary assets) makes every build slow regardless of what is actually `COPY`ed. Use `.dockerignore` to control what is included.

---

### Running Containers

```bash
# Interactive terminal — useful for debugging base images and one-off tasks
docker run -it ubuntu:22.04 /bin/bash

# Detached (background) mode with a human-readable name for log/exec commands
docker run -d --name nginx nginx:1.25

# Publish ports: HOST_PORT:CONTAINER_PORT
# Container port 80 becomes accessible on host port 8080
docker run -d -p 8080:80 nginx:1.25

# Bind to loopback only — more secure, not reachable from external hosts
docker run -d -p 127.0.0.1:8080:80 nginx:1.25

# Pass environment variables (one -e per variable)
docker run -d -e DB_HOST=db.internal -e DB_PORT=5432 myapp:1.0

# Load env vars from a file — keeps secrets out of shell history and ps output
docker run -d --env-file .env myapp:1.0

# Bind mount: maps a host directory into the container in real time.
# Changes are immediately visible in both directions.
docker run -d -v /data/nginx:/etc/nginx/conf.d nginx:1.25

# Named volume: Docker manages the storage location on the host.
# Survives container removal; preferred for databases.
docker run -d -v myapp_data:/var/lib/postgresql/data postgres:16

# Auto-remove container when it exits — great for one-off scripts and CI steps
docker run --rm -it ubuntu:22.04 bash

# Resource limits — prevent a single container from starving the host
docker run -d --memory=512m --cpus=0.5 myapp:1.0

# Override the default user — never run production containers as root
docker run -d --user 1001:1001 myapp:1.0
```

**Port mapping gotcha:** `EXPOSE 80` in a Dockerfile is documentation only. The port is not reachable from the host until you pass `-p` at runtime. Conversely, you can publish any port with `-p` whether or not it appears in `EXPOSE`. These two mechanisms are completely independent.

**Bind mount vs named volume:**

| | Bind Mount | Named Volume |
|---|---|---|
| Path on host | Explicit path you specify | Docker-managed (`/var/lib/docker/volumes/`) |
| Portability | Host-path-dependent | Works on any Docker host |
| Use case | Dev config files, source code | Persistent data (DBs, uploads) |
| Initialized from image | No | Yes — on first use, Docker seeds from image |

---

### Managing Containers and Images

```bash
# --- Container lifecycle ---
docker ps                          # running containers
docker ps -a                       # all containers including stopped
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

docker stop nginx                  # sends SIGTERM, waits 10s, then SIGKILL
docker kill nginx                  # sends SIGKILL immediately — no grace period
docker start nginx                 # restart a stopped container (keeps its config)
docker restart nginx               # stop + start in one command

# --- Logs ---
docker logs nginx
docker logs -f nginx               # follow (like tail -f)
docker logs --tail 50 nginx        # last 50 lines
docker logs --since 5m nginx       # output from the last 5 minutes

# --- Exec into a running container ---
docker exec -it nginx /bin/bash
docker exec nginx nginx -t         # run a one-off command (test nginx config)

# --- Inspect ---
docker inspect nginx               # full JSON metadata
docker inspect -f '{{.NetworkSettings.IPAddress}}' nginx  # Go template extraction

# --- Remove containers ---
docker rm nginx                    # must be stopped first
docker rm -f nginx                 # force-remove a running container
docker container prune             # remove all stopped containers

# --- Images ---
docker images
docker images --filter "dangling=true"    # untagged (<none>:<none>) images

docker rmi myapp:old
docker image prune                 # remove dangling images only
docker image prune -a              # remove all images not used by any container

# --- System-wide cleanup ---
docker system df                   # disk usage: images, containers, volumes, cache
docker system prune                # containers, networks, dangling images
docker system prune -a --volumes   # nuclear option — removes everything unused
```

**Dangling images** are layers that were previously tagged but have since been replaced by a newer build with the same tag. They appear as `<none>:<none>` in `docker images`. They accumulate rapidly on CI build machines and can fill a disk. Add `docker image prune -f` to your CI post-build cleanup step.

---

### Image Layers and Caching

Docker builds images by executing each instruction and snapshotting the filesystem diff. That snapshot is a **layer**, identified by a SHA-256 hash of its contents and the instruction that produced it. On the next build, if a layer's instruction and all its inputs are byte-for-byte identical, Docker reuses the cached layer — skipping execution entirely.

**Cache invalidation rules:**
- A `RUN` layer is invalidated if its command string changes.
- A `COPY` or `ADD` layer is invalidated if any copied file's content or metadata changes.
- Once any layer is invalidated, **all subsequent layers are also invalidated** — even if their own inputs haven't changed. Cache invalidation cascades downward.

This makes instruction order a direct performance variable:

```dockerfile
# ❌ Inefficient: all source code is copied before dependencies are installed.
# Any single-line source change invalidates the pip install layer on the next build.
COPY . /app
RUN pip install -r /app/requirements.txt

# ✅ Efficient: dependency manifest copied first.
# The pip install layer is only invalidated when requirements.txt changes.
# Source changes only invalidate the final COPY — pip install stays cached.
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY . /app
```

The same principle applies to every ecosystem with a separate dependency manifest:

| Ecosystem | Copy first | Then install |
|-----------|-----------|--------------|
| Python | `requirements.txt` | `pip install` |
| Node.js | `package.json`, `package-lock.json` | `npm ci` |
| Go | `go.mod`, `go.sum` | `go mod download` |
| Ruby | `Gemfile`, `Gemfile.lock` | `bundle install` |

```bash
# See all layers, their sizes, and the full command that created each
docker history myapp:1.0 --no-trunc

# Sample output:
# IMAGE         CREATED       CREATED BY                                      SIZE
# a1b2c3d4e5f6  2 min ago     CMD ["python3" "-m" "uvicorn" "main:app"]       0B
# b2c3d4e5f6a1  2 min ago     COPY . .                                        48kB
# c3d4e5f6a1b2  10 min ago    RUN pip install -r requirements.txt             42MB  ← cached
# d4e5f6a1b2c3  10 min ago    COPY requirements.txt /app/                     812B  ← cached
```

**Multi-stage builds** let you use one image to compile or package (with compilers and dev tools) and a separate, minimal image to run. Only the final stage is shipped to a registry:

```dockerfile
# Stage 1: build — full Go toolchain, source code, build cache
FROM golang:1.22 AS builder
WORKDIR /src
# Dependencies first — cached unless go.mod/go.sum change
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0 produces a fully static binary with no libc dependency
RUN CGO_ENABLED=0 GOOS=linux go build -o /app ./cmd/server

# Stage 2: run — scratch has no OS, no shell, minimal attack surface
# The final image contains only the compiled binary: typically 5-15MB
FROM scratch
COPY --from=builder /app /app
ENTRYPOINT ["/app"]
```

The final image contains only the compiled binary. No Go toolchain, no source code, no shell, no package manager. This reduces attack surface and image size simultaneously.

---

### .dockerignore

The `.dockerignore` file controls what the Docker CLI includes in the build context tarball sent to the daemon. It uses the same glob syntax as `.gitignore`. It is evaluated before the Dockerfile is parsed.

```
# Version control — never needed inside the image
.git
.gitignore

# Dependencies — rebuilt from the manifest inside the image
node_modules/
vendor/
.venv/

# Build artifacts — rebuilt inside the image
dist/
build/
*.pyc
__pycache__/
.pytest_cache/
.mypy_cache/

# Local environment — CRITICAL: secrets must not enter the image
.env
.env.*
*.local
secrets/

# Logs and temp files
*.log
tmp/
coverage/

# IDE and OS metadata
.DS_Store
.idea/
.vscode/
Thumbs.db
```

**Why this matters beyond speed:** accidentally `COPY`ing `.env` into an image means secrets are baked into the image filesystem. They are visible to anyone who runs `docker inspect`, runs the container interactively, or pulls the image from a registry. Every layer of a Docker image is readable. `.dockerignore` is a security boundary, not just a performance optimization.

---

### Image Naming and Registries

A fully-qualified image reference has four parts:

```
registry/namespace/name:tag
│         │         │    └── mutable pointer to a specific digest (e.g. 1.25, latest)
│         │         └── repository name (e.g. nginx, myapp)
│         └── namespace / organization / username (e.g. library, myteam)
└── registry hostname (e.g. docker.io, ghcr.io, 123456789.dkr.ecr.us-east-1.amazonaws.com)
```

When the registry is omitted, Docker defaults to `docker.io`. When the namespace is omitted for `docker.io`, it defaults to `library` — the namespace for official images. So `nginx:1.25` resolves to `docker.io/library/nginx:1.25`.

**Common registries:**

| Registry | URL | Notes |
|----------|-----|-------|
| Docker Hub | `docker.io` | Default; rate-limited for unauthenticated pulls |
| GitHub Container Registry | `ghcr.io` | Tied to GitHub packages; free for public repos |
| AWS ECR | `*.dkr.ecr.*.amazonaws.com` | IAM-authenticated; no rate limits within AWS |
| Google Artifact Registry | `*.pkg.dev` | Replaced GCR; multi-format support |
| Self-hosted | any hostname | Harbor, Nexus, Gitea — full control over data residency |

```bash
# Authenticate to a registry
docker login ghcr.io -u USERNAME --password-stdin < token.txt

# Push an image (image must be tagged with the registry prefix first)
docker tag myapp:1.0 ghcr.io/myorg/myapp:1.0
docker push ghcr.io/myorg/myapp:1.0

# Pull explicitly by digest — guarantees bit-for-bit identical image
docker pull nginx@sha256:a484819eb60efa4ef...

# List local images with their digests
docker images --digests
```

**Tag mutability risk:** if your CI pipeline pushes `myapp:latest` on every main branch merge, any `docker pull myapp:latest` in the future gets a different image than the one tested last week. In production, tag images with the Git commit SHA (`myapp:a3f9c12`) and treat `latest` as a human-readable convenience alias only.

---

## Examples

### Example 1: Containerize a Python FastAPI Application

**Setup:** A FastAPI app with external dependencies. Goal is a small, cache-friendly image.

```
myapp/
├── app/
│   └── main.py
├── requirements.txt
├── Dockerfile
└── .dockerignore
```

**`.dockerignore`:**
```
.git
.venv
__pycache__
*.pyc
.env
.pytest_cache
```

**`Dockerfile`:**
```dockerfile
FROM python:3.12-slim

# Non-root user for security — create before switching
RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /home/appuser/app

# Dependencies layer — cached unless requirements.txt changes
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Source code — cache-busted on any source change (expected)
COPY app/ ./app/

# Switch to non-root after installation (pip requires write access during install)
USER appuser

EXPOSE 8000

# Exec form — uvicorn receives SIGTERM directly for graceful shutdown
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Build and verify:**
```bash
# Build the image
docker build -t fastapi-app:1.0 .

# Verify size and layers
docker image inspect fastapi-app:1.0 --format '{{.Size}}' | numfmt --to=iec
docker history fastapi-app:1.0

# Run the container, mapping host 8000 to container 8000
docker run -d --name fastapi -p 8000:8000 fastapi-app:1.0

# Verify it is running and responding
docker ps
curl http://localhost:8000/health

# Check logs
docker logs fastapi
```

---

### Example 2: Multi-Stage Go Build for a Minimal Production Image

**Goal:** ship only the static binary; no toolchain, no shell.

```dockerfile
# ---- Stage 1: Build ----
FROM golang:1.22-alpine AS builder

WORKDIR /src

# Cache module downloads separately from source
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# -ldflags strips debug symbols to reduce binary size further
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-w -s" \
    -o /out/server \
    ./cmd/server

# ---- Stage 2: Minimal runtime ----
# distroless/static has no shell, no package manager, but has CA certs and tzdata
FROM gcr.io/distroless/static:nonroot

COPY --from=builder /out/server /server

# distroless nonroot runs as UID 65532 by default
USER nonroot

EXPOSE 8080

ENTRYPOINT ["/server"]
```

**Build, compare, and run:**
```bash
# Build the final image
docker build -t go-server:1.0 .

# Build just the builder stage for debugging
docker build --target builder -t go-server:debug .

# Compare sizes — final should be ~10-15MB, builder ~400MB
docker images | grep go-server

# Run with resource limits appropriate for production
docker run -d \
  --name go-server \
  --memory=128m \
  --cpus=0.25 \
  -p 8080:8080 \
  go-server:1.0

# Verify binary is the only thing in the image (no shell to exec into)
docker inspect go-server:1.0 --format '{{json .Config.Entrypoint}}'
curl http://localhost:8080/ping
```

---

### Example 3: CI-Style Build-Tag-Push Workflow

**Goal:** simulate the image lifecycle in a CI pipeline — build, test, tag with git SHA, push.

```bash
# Simulate CI environment variables
export GIT_SHA=$(git rev-parse --short HEAD)
export REGISTRY=ghcr.io
export IMAGE_NAME=myorg/myapp

# Authenticate to the registry (in CI, use a secret token)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin

# Build with both a version tag and a latest alias
docker build \
  --build-arg BUILD_SHA="$GIT_SHA" \
  -t "$REGISTRY/$IMAGE_NAME:$GIT_SHA" \
  -t "$REGISTRY/$IMAGE_NAME:latest" \
  .

# Smoke test before pushing — run the image and hit the health endpoint
CONTAINER_ID=$(docker run -d -p 8080:8080 "$REGISTRY/$IMAGE_NAME:$GIT_SHA")
sleep 2  # allow startup
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health)

if [ "$HTTP_STATUS" != "200" ]; then
  echo "Health check failed: $HTTP_STATUS"
  docker logs "$CONTAINER_ID"
  docker rm -f "$CONTAINER_ID"
  exit 1
fi

docker rm -f "$CONTAINER_ID"

# Push both tags — the SHA tag is immutable; latest is the convenience alias
docker push "$REGISTRY/$IMAGE_NAME:$GIT_SHA"
docker push "$REGISTRY/$IMAGE_NAME:latest"

echo "Pushed $REGISTRY/$IMAGE_NAME:$GIT_SHA"

# Clean up local images to keep the CI runner's disk free
docker image prune -f
```

---

### Example 4: Debugging a Running Container

**Goal:** investigate a misbehaving container without modifying the image.

```bash
# Start a container that has a deliberately broken config
docker run -d --name broken-nginx -p 9090:80 nginx:1.25

# First check: is it actually running?
docker ps -a --filter name=broken-nginx

# Second check: what does it say?
docker logs broken-nginx
docker logs --tail 30 broken-nginx

# Third check: exec in and inspect the filesystem directly
docker exec -it broken-nginx /bin/bash
# Inside the container:
nginx -t                          # test nginx config syntax
cat /etc/nginx/nginx.conf         # read the actual config
ls -la /var/log/nginx/            # check log files
exit

# Fourth check: inspect the container's full configuration
docker inspect broken-nginx | jq '.[0].HostConfig'   # host config (ports, mounts)
docker inspect broken-nginx | jq '.[0].State'         # exit code, OOMKilled flag

# Fifth check: copy a file out of the container for analysis without exec
docker cp broken-nginx:/etc/nginx/nginx.conf ./extracted-nginx.conf

# Sixth check: run a one-off diagnostic container sharing the same network
# (useful when exec is unavailable — e.g., distroless images with no shell)
docker run --rm -it \
  --network container:broken-nginx \  # join the container's network namespace
  nicolaka/netshoot \                  # image packed with network debugging tools
  curl -v http://localhost:80

# Clean up
docker rm -f broken-nginx
```

---

## Exercises

### Exercise 1: Optimize a Slow Dockerfile with Layer Caching

You are given this inefficient Dockerfile for a Node.js application:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["node", "server.js"]
```

**Tasks:**
1. Identify which instruction causes the longest cache misses and explain why.
2. Rewrite the Dockerfile so that `npm install` is only re-executed when `package.json` or `package-lock.json` changes.
3. Add a `.dockerignore` file that prevents `node_modules` and any `.env` files from entering the build context.
4. Build the image twice — first with a source file change only (e.g., add a comment to `server.js`). Confirm that the `npm install` layer shows `CACHED` in the second build output.

**Verification:** Run `docker history <your-image>:latest` and confirm the `npm install` layer has a much larger size than the `COPY . .` layer (dependency layers are almost always the largest).

---

### Exercise 2: ENTRYPOINT + CMD Pattern for a CLI Tool

Create a Dockerfile that wraps the `curl` command so the container behaves like a pre-configured `curl` with a default target URL but allows the user to override flags or URL at runtime.

**Requirements:**
- `ENTRYPOINT` should be `curl`
- `CMD` should default to `--help` (so running the container with no arguments shows curl help)
- Running `docker run mycurl https://example.com -I` should execute `curl https://example.com -I`
- Running `docker run --entrypoint /bin/sh mycurl` should drop into a shell for debugging

**Verification:** Run all three invocations above and confirm the behavior matches expectations. Explain in a comment why using `CMD ["curl"]` alone would make the second requirement impossible to meet cleanly.

---

### Exercise 3: Multi-Stage Build for a Python Application

Take a Python application that has `pip install` as part of its build and create a two-stage Dockerfile:

- **Stage 1 (`builder`):** Use `python:3.12` (full image), install dependencies into `/install`
- **Stage 2 (`runtime`):** Use `python:3.12-slim`, copy only the installed packages from stage 1, copy the application source, run as a non-root user

**Hint:** You can install packages to a custom prefix with:
```bash
pip install --no-cache-dir --prefix=/install -r requirements.txt
```
And copy them to the runtime stage with:
```dockerfile
COPY --from=builder /install /usr/local
```

**Tasks:**
1. Build both the `builder` stage and the final image.
2. Compare their sizes with `docker images`.
3. Verify the final image does not contain `pip` (`docker run --rm myapp:slim pip --version` should fail).
4. Confirm the app runs correctly in the slim image.

---

### Exercise 4: Investigate Image Contents and Runtime Behavior

**Tasks:**
1. Pull `nginx:1.25` and use `docker history nginx:1.25 --no-trunc` to identify the layer that installs nginx. Note its size.
2. Run an nginx container with port 8080 mapped to container port 80. Use `docker inspect` with a Go template to extract only the container's IP address on the default bridge network.
3. Without stopping the container, use `docker exec` to create a file at `/tmp/test.txt` inside the container. Then stop and remove the container. Start a new container from `nginx:1.25`. Verify that `/tmp/test.txt` does not exist — demonstrating that the writable layer is destroyed with the container.
4. Use `docker run --rm nginx:1.25 nginx -v` to extract the nginx version without keeping the container around. Explain what `--rm` does and why it is useful for one-off inspection commands.
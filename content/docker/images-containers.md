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

In the broader toolchain, images sit at the handoff point between development and operations. A CI pipeline builds and tests an image, pushes it to a registry (Docker Hub, ECR, GCR, GHCR), and downstream systems — Compose, Kubernetes, ECS — pull and run it. Understanding exactly how images are built and how containers behave is prerequisite knowledge for every layer above it.

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

An image is identified by a **name and tag** (`nginx:1.25`) or by a **content-addressed SHA-256 digest** (`nginx@sha256:abc123...`). Tags are mutable pointers; digests are not. In production pipelines, pinning by digest gives you stronger guarantees than pinning by tag.

**Gotcha:** `docker run nginx` silently pulls `nginx:latest` if the image is not present locally. `latest` is just a tag — it is not guaranteed to be the most recent published version. Always specify an explicit tag in Dockerfiles and automation.

Multiple containers can run from the same image simultaneously. Each gets its own writable layer; they do not share state unless you deliberately connect them via volumes or networks.

---

### Dockerfile Fundamentals

A Dockerfile is a sequence of instructions that Docker executes top-to-bottom to produce an image. Each instruction that writes to the filesystem creates a new **layer**.

```dockerfile
# Base image — always start from a known, minimal image
# Prefer specific tags over :latest for reproducibility
FROM ubuntu:22.04

# Metadata label — useful for tooling and auditing
LABEL maintainer="igal@example.com" \
      version="1.0"

# Combine RUN commands to minimize layers and clean up in the same layer
# apt cache must be deleted in the same RUN step or it persists in the layer
RUN apt-get update && apt-get install -y \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*

# WORKDIR creates the directory if it doesn't exist
# Affects all subsequent COPY, RUN, CMD, ENTRYPOINT instructions
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

# EXPOSE documents which port the container listens on
# It does NOT publish the port — that happens with -p at runtime
EXPOSE 80

# CMD provides the default command when the container starts
# Exec form (JSON array) is preferred over shell form
CMD ["nginx", "-g", "daemon off;"]
```

**Shell form vs exec form:**

| Form | Example | Behavior |
|------|---------|----------|
| Shell form | `CMD nginx -g "daemon off;"` | Runs via `/bin/sh -c`; PID 1 is `sh`, not `nginx` |
| Exec form | `CMD ["nginx", "-g", "daemon off;"]` | Runs directly; PID 1 is `nginx` |

**Always use exec form for CMD and ENTRYPOINT.** With shell form, signals like `SIGTERM` (sent by `docker stop`) go to the shell process, not your application. The app never receives the shutdown signal, Docker waits the full 10-second timeout, then sends `SIGKILL`. This causes slow, ungraceful shutdowns.

---

### COPY vs ADD

| Instruction | Copies local files | Extracts `.tar` archives | Fetches URLs |
|------------|-------------------|--------------------------|--------------|
| `COPY` | ✅ | ❌ | ❌ |
| `ADD` | ✅ | ✅ | ✅ |

**Always prefer `COPY`.** Its behavior is explicit and predictable. `ADD` with a URL bypasses the build cache (the remote file could change) and skips security scanning. If you need to fetch something during a build, use `RUN curl` or `RUN wget` so the step is visible and cacheable.

The only legitimate use of `ADD` over `COPY` is extracting a local `.tar.gz` directly into the image:

```dockerfile
# Acceptable ADD usage: extracts archive and preserves permissions
ADD app-release.tar.gz /opt/app/
```

---

### CMD vs ENTRYPOINT

These two instructions are frequently confused. The mental model:

- **ENTRYPOINT** — the executable. Treat the container as a command.
- **CMD** — default arguments to that executable. Easily overridden at runtime.

```dockerfile
# Pattern 1: CMD alone (flexible — entire command is replaceable)
CMD ["nginx", "-g", "daemon off;"]
# docker run myimage              → runs nginx
# docker run myimage /bin/bash    → runs bash instead

# Pattern 2: ENTRYPOINT alone (rigid — extra args appended, command not replaceable)
ENTRYPOINT ["nginx"]
# docker run myimage -t           → runs nginx -t
# docker run myimage /bin/bash    → runs nginx /bin/bash (probably wrong)

# Pattern 3: ENTRYPOINT + CMD (recommended for tools and services)
ENTRYPOINT ["python3", "app.py"]
CMD ["--port", "8080"]
# docker run myimage              → python3 app.py --port 8080
# docker run myimage --port 9090 → python3 app.py --port 9090
# docker run --entrypoint /bin/sh myimage → override entrypoint explicitly
```

**When to use which pattern:**

| Use case | Recommendation |
|----------|---------------|
| General-purpose service (nginx, app server) | `CMD` alone — makes it easy to override for debugging |
| CLI tool wrapped in a container | `ENTRYPOINT` + `CMD` — container behaves like the tool |
| Init/entrypoint scripts | `ENTRYPOINT ["./entrypoint.sh"]` + `CMD` for the main process |

---

### Building Images

```bash
# Build using the Dockerfile in the current directory
# -t sets the name and tag: name:tag
docker build -t myapp:1.0 .

# Use a different Dockerfile (useful for multi-environment builds)
docker build -f Dockerfile.prod -t myapp:prod .

# Pass build-time arguments (must be declared with ARG in Dockerfile)
docker build --build-arg APP_VERSION=1.2.3 -t myapp:1.2.3 .

# Bypass the layer cache — forces every instruction to re-execute
# Use in CI when you suspect stale cache behavior
docker build --no-cache -t myapp:latest .

# Target a specific stage in a multi-stage build
docker build --target builder -t myapp:debug .

# Tag an existing image with an additional name (no rebuild)
docker tag myapp:1.0 myregistry.io/team/myapp:1.0

# Inspect the layers, sizes, and commands that created them
docker history myapp:1.0

# Full JSON metadata: config, layers, env vars, exposed ports
docker image inspect myapp:1.0
```

**Build context:** the `.` at the end of `docker build` is the **build context** — the directory whose contents are sent to the Docker daemon. Docker tars and sends the entire context before it reads the Dockerfile. A large context (e.g., containing `node_modules` or `.git`) makes every build slow, even if those files are never `COPY`ed. Use `.dockerignore` to control what is sent.

---

### Running Containers

```bash
# Interactive terminal — useful for debugging base images
docker run -it ubuntu:22.04 /bin/bash

# Detached (background) mode with a human-readable name
docker run -d --name nginx nginx:1.25

# Publish ports: -p HOST_PORT:CONTAINER_PORT
# Host port 8080 → container port 80
docker run -d -p 8080:80 nginx:1.25

# Bind to a specific host interface (more secure than 0.0.0.0)
docker run -d -p 127.0.0.1:8080:80 nginx:1.25

# Pass environment variables (one -e per variable)
docker run -d -e DB_HOST=db.internal -e DB_PORT=5432 myapp:1.0

# Load env vars from a file (keeps secrets out of shell history)
docker run -d --env-file .env myapp:1.0

# Bind mount: maps a host directory into the container
# Changes are reflected immediately in both directions
docker run -d -v /data/nginx:/etc/nginx/conf.d nginx:1.25

# Named volume: Docker manages the storage location
docker run -d -v myapp_data:/var/lib/postgresql/data postgres:16

# Auto-remove container when it exits (great for one-off tasks)
docker run --rm -it ubuntu:22.04 bash

# Resource limits: prevent a single container from starving the host
docker run -d --memory=512m --cpus=0.5 myapp:1.0

# Override the default user (run as non-root for security)
docker run -d --user 1001:1001 myapp:1.0
```

**Port mapping gotcha:** `EXPOSE 80` in a Dockerfile is documentation only. The port is not reachable from the host until you pass `-p` at runtime. Conversely, you can publish any port with `-p` whether or not it appears in `EXPOSE`.

---

### Managing Containers and Images

```bash
# --- Container lifecycle ---
docker ps                    # running containers
docker ps -a                 # all containers including stopped
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

docker stop nginx            # sends SIGTERM, waits 10s, then SIGKILL
docker kill nginx            # sends SIGKILL immediately
docker start nginx           # restart a stopped container
docker restart nginx         # stop + start

# --- Logs ---
docker logs nginx
docker logs -f nginx                # follow (like tail -f)
docker logs --tail 50 nginx        # last 50 lines
docker logs --since 5m nginx       # last 5 minutes

# --- Exec into running container ---
docker exec -it nginx /bin/bash
docker exec nginx nginx -t         # run a one-off command (test nginx config)

# --- Inspect ---
docker inspect nginx               # full JSON metadata
docker inspect -f '{{.NetworkSettings.IPAddress}}' nginx  # Go template query

# --- Remove containers ---
docker rm nginx                    # must be stopped first
docker rm -f nginx                 # force-remove running container
docker container prune             # remove all stopped containers

# --- Images ---
docker images
docker images --filter "dangling=true"   # untagged (<none>:<none>) images

docker rmi myapp:old
docker image prune                 # remove dangling images
docker image prune -a              # remove all images not used by a container

# --- System-wide cleanup ---
docker system df                   # disk usage breakdown
docker system prune                # containers, networks, dangling images
docker system prune -a --volumes   # nuclear option — removes everything unused
```

**Dangling images** are layers that were previously tagged but have since been replaced by a newer build with the same tag. They show up as `<none>:<none>` in `docker images`. They accumulate quickly on a build machine and can fill a disk. Add `docker image prune` to your CI cleanup step.

---

### Image Layers and Caching

Docker builds images by executing each instruction and snapshotting the filesystem diff. That snapshot is a **layer**, identified by a SHA-256 hash of its contents. On the next build, if a layer's instruction and all its inputs are identical, Docker reuses the cached layer and skips the execution entirely.

**Cache invalidation rules:**
- A `RUN` layer is invalidated if its command string changes.
- A `COPY` or `ADD` layer is invalidated if any copied file's content changes.
- Once any layer is invalidated, **all subsequent layers are also invalidated** — even if their own inputs haven't changed.

This makes instruction order a performance variable:

```dockerfile
# ❌ Inefficient: copying all source before installing dependencies
# Changing any source file invalidates the pip install layer
COPY . /app
RUN pip install -r /app/requirements.txt

# ✅ Efficient: dependencies cached unless requirements.txt changes
# Source changes only invalidate the final COPY layer
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY . /app
```

The same principle applies to Node.js (`package.json` first), Go (`go.mod`/`go.sum` first), and any ecosystem with a separate dependency manifest.

```bash
# See all layers, their sizes, and the command that created each
docker history myapp:1.0 --no-trunc

# Sample output:
# IMAGE         CREATED       CREATED BY                                SIZE
# a1b2c3d4e5f6  2 min ago     CMD ["python3" "-m" "uvicorn" ...]        0B
# b2c3d4e5f6a1  2 min ago     COPY . .                                  48kB
# c3d4e5f6a1b2  10 min ago    RUN pip install -r requirements.txt       42MB  ← cached
# ...
```

**Multi-stage builds** let you use one image to build (with compilers, dev tools) and a different, smaller image to run. Only the final stage is shipped:

```dockerfile
# Stage 1: build
FROM golang:1.22 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./cmd/server

# Stage 2: run — scratch has no OS, minimal attack surface
FROM scratch
COPY --from=builder /app /app
ENTRYPOINT ["/app"]
```

The final image contains only the compiled binary. No Go toolchain, no source code, no shell.

---

### .dockerignore

The `.dockerignore` file controls what the Docker CLI includes in the build context sent to the daemon. It uses the same syntax as `.gitignore`.

```
# Version control
.git
.gitignore

# Dependencies (rebuilt inside the image)
node_modules
vendor/

# Build artifacts
dist/
build/
*.pyc
__pycache__/
.pytest_cache/

# Local environment
.env
.env.*
*.local

# Logs and temp files
*.log
tmp/

# IDE and OS files
.DS_Store
.idea/
.vscode/
```

**Why it matters beyond speed:** accidentally copying `.env` into an image means those secrets are baked into the image filesystem and visible to anyone who can pull the image or run `docker inspect`. `.dockerignore` is a security control, not just a performance optimization.

---

### Image Naming and Registries

A fully-qualified image reference has four parts:

```
registry/namespace/name:tag
│         │         │    └── m
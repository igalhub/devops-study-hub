---
title: Images & Containers
module: docker
duration_min: 20
difficulty: beginner
tags: [docker, images, containers, dockerfile, build, run]
exercises: 4
---

## Overview
Docker packages applications and their dependencies into **images** — read-only snapshots — and runs them as **containers** — isolated, ephemeral processes. Understanding the image/container distinction and the Dockerfile build process is the foundation for everything else in the container ecosystem: Compose, Kubernetes, CI/CD pipelines.

## Concepts

### Images vs Containers
| | Image | Container |
|---|---|---|
| What it is | Read-only filesystem snapshot | Running instance of an image |
| Analogy | Class definition | Object instance |
| Persistence | Permanent (until deleted) | Ephemeral by default |
| State | Immutable | Has mutable layer on top |

An image is built from a **Dockerfile**. Running an image creates a container. Multiple containers can run from the same image simultaneously.

### Dockerfile Fundamentals
```dockerfile
# Base image — always start from a known, minimal image
FROM ubuntu:22.04

# Set maintainer metadata (optional)
LABEL maintainer="igal@example.com"

# Run commands to install dependencies
# Combine RUN commands to reduce layers
RUN apt-get update && apt-get install -y \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*

# Copy files from build context into image
COPY nginx.conf /etc/nginx/nginx.conf
COPY ./app /opt/app

# Set working directory (affects subsequent COPY, RUN, CMD)
WORKDIR /opt/app

# Expose a port (documentation only — doesn't actually publish)
EXPOSE 80

# Environment variable (available at build and runtime)
ENV APP_ENV=production

# CMD — default command when container starts
CMD ["nginx", "-g", "daemon off;"]
```

### COPY vs ADD
- `COPY` — copies files from build context. Always prefer this.
- `ADD` — same as COPY but also: extracts `.tar` archives, fetches URLs. Use only when you need those features.

### CMD vs ENTRYPOINT
```dockerfile
# CMD — default arguments, easily overridden at runtime
CMD ["nginx", "-g", "daemon off;"]
# docker run myimage /bin/bash  ← replaces CMD

# ENTRYPOINT — the executable, not replaced by runtime args
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
# docker run myimage -t  ← passes "-t" as arg to nginx

# Common pattern: ENTRYPOINT for the executable, CMD for defaults
ENTRYPOINT ["python3", "app.py"]
CMD ["--port", "8080"]
```

### Building Images
```bash
# Build from Dockerfile in current directory
docker build -t myapp:1.0 .

# Build with a different Dockerfile
docker build -f Dockerfile.prod -t myapp:prod .

# Pass build arguments (available as ARG in Dockerfile)
docker build --build-arg APP_VERSION=1.2.3 -t myapp:1.2.3 .

# No cache (force re-run all steps)
docker build --no-cache -t myapp:latest .

# See image layers and sizes
docker history myapp:latest
docker image inspect myapp:latest
```

### Running Containers
```bash
# Run interactively
docker run -it ubuntu:22.04 /bin/bash

# Run in background (detached)
docker run -d --name nginx nginx:1.25

# Port mapping: host:container
docker run -d -p 8080:80 nginx:1.25

# Environment variables
docker run -d -e DB_HOST=db.internal -e DB_PORT=5432 myapp:1.0

# Mount a volume: host_path:container_path
docker run -d -v /data/nginx:/etc/nginx/conf.d nginx:1.25

# Remove container when it exits
docker run --rm -it ubuntu:22.04 bash

# Resource limits
docker run -d --memory=512m --cpus=0.5 myapp:1.0
```

### Managing Containers and Images
```bash
# List running containers
docker ps
docker ps -a   # include stopped

# Stop / start / restart
docker stop nginx
docker start nginx
docker restart nginx

# View logs
docker logs nginx
docker logs -f nginx         # follow
docker logs --tail 50 nginx

# Execute command in running container
docker exec -it nginx /bin/bash
docker exec nginx nginx -t   # test nginx config

# Remove containers
docker rm nginx              # stopped only
docker rm -f nginx           # force-stop and remove

# List images
docker images
docker images --filter dangling=true   # untagged images

# Remove images
docker rmi myapp:old
docker image prune           # remove all dangling images
docker image prune -a        # remove all unused images
```

### Image Layers and Caching
Each `RUN`, `COPY`, `ADD` instruction creates a layer. Docker caches layers — if nothing changed in a layer or before it, the cache is used. Order matters for build speed:

```dockerfile
# Bad: requirements.txt changes → reinstall everything
COPY . /app
RUN pip install -r /app/requirements.txt

# Good: dependencies cached unless requirements.txt changes
COPY requirements.txt /app/
RUN pip install -r /app/requirements.txt
COPY . /app   # changes here don't invalidate the pip install layer
```

### .dockerignore
Like `.gitignore` but for the Docker build context — prevents sending large or sensitive files to the daemon:
```
.git
node_modules
*.log
.env
__pycache__
.pytest_cache
dist/
```

## Examples

### Python App Dockerfile
```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

ENV PORT=8000
EXPOSE 8000

CMD ["python3", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
docker build -t myapi:latest .
docker run -d -p 8000:8000 --name myapi myapi:latest
docker logs -f myapi
```

## Exercises

1. Write a Dockerfile for a simple Python script (`hello.py` that prints "Hello from Docker!"). Build it, run it, verify the output. Then add a `.dockerignore` that excludes `__pycache__` and `.env`.
2. Run an nginx container in the background, map port 8080 to container port 80, verify it responds with `curl http://localhost:8080`, then stop and remove the container.
3. Explore layer caching: build an image twice — observe which steps are cached on the second build. Then change a line in your Dockerfile after an early `COPY` instruction and rebuild — which layers were invalidated?
4. Use `docker exec` to open a shell inside a running nginx container. Find and read the default nginx configuration file. Use `docker inspect` to find the container's IP address.

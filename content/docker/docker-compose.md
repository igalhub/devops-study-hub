---
title: Docker Compose
module: docker
duration_min: 20
difficulty: intermediate
tags: [docker, compose, multi-container, networking, volumes, services]
exercises: 4
---

## Overview
Docker Compose defines and runs multi-container applications from a single YAML file. Instead of running five `docker run` commands with the right flags memorized, you declare the entire stack — app, database, cache, reverse proxy — and bring it up with one command. It's the standard tool for local development environments and simple production deployments.

## Concepts

### compose.yaml Structure
```yaml
# compose.yaml (formerly docker-compose.yml — both names work)
services:
  web:
    image: nginx:1.25
    ports:
      - "8080:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - app

  app:
    build: .                  # build from Dockerfile in current dir
    environment:
      - DB_HOST=db
      - DB_PORT=5432
      - DB_PASSWORD=${DB_PASSWORD}   # from .env file or shell env
    depends_on:
      db:
        condition: service_healthy  # wait for healthcheck to pass

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data   # named volume
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U myuser"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:   # named volumes persist across container restarts
```

### Core Commands
```bash
# Start all services (detached)
docker compose up -d

# Start and rebuild images first
docker compose up -d --build

# Stop all services (containers stay, data preserved)
docker compose stop

# Stop and remove containers (data preserved in named volumes)
docker compose down

# Stop, remove containers AND named volumes (wipes data)
docker compose down -v

# View running services
docker compose ps

# Follow logs for all services
docker compose logs -f

# Follow logs for one service
docker compose logs -f app

# Run a one-off command in a service
docker compose exec app bash
docker compose exec db psql -U myuser myapp

# Restart a single service
docker compose restart app

# Pull latest images
docker compose pull

# Scale a service (run multiple replicas)
docker compose up -d --scale app=3
```

### Networking
Compose creates a default network named `<project>_default`. All services on this network can reach each other by **service name**:

```python
# In your app code, connect to the database by service name:
import psycopg2
conn = psycopg2.connect(host="db", port=5432, dbname="myapp")
```

No IPs needed. DNS resolution is handled automatically within the Compose network.

Custom networks for isolation:
```yaml
services:
  web:
    networks: [frontend, backend]
  app:
    networks: [backend]
  db:
    networks: [backend]

networks:
  frontend:
  backend:
    internal: true   # no internet access
```

### Volumes
```yaml
services:
  app:
    volumes:
      # Named volume (managed by Docker, persists across down/up)
      - app_data:/var/app/data

      # Bind mount (host path : container path)
      - ./src:/app/src

      # Read-only bind mount
      - ./config:/etc/app/config:ro

volumes:
  app_data:
    # external: true  ← use a pre-existing volume (not created by Compose)
```

**Bind mounts** are ideal for development — code changes on your host are reflected immediately in the container without rebuilding.

### Environment Variables
```yaml
# Method 1: inline list
environment:
  - DB_HOST=db
  - APP_ENV=development

# Method 2: mapping (clearer)
environment:
  DB_HOST: db
  APP_ENV: development

# Method 3: from shell environment (no value = pass through from shell)
environment:
  - SECRET_KEY

# Method 4: env_file (load from a file)
env_file:
  - .env
  - .env.local   # overrides .env
```

`.env` file (automatically loaded if present in the same directory as `compose.yaml`):
```
DB_PASSWORD=supersecret
APP_ENV=development
```

### Profiles
```yaml
# Mark services with profiles to start them selectively
services:
  app:
    image: myapp:latest

  db:
    image: postgres:16

  pgadmin:
    image: dpage/pgadmin4
    profiles: [tools]   # only starts when --profile tools is used
```

```bash
docker compose up -d                    # starts app + db only
docker compose up -d --profile tools   # starts all including pgadmin
```

### Healthchecks and Dependencies
```yaml
db:
  image: postgres:16
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U myuser"]
    interval: 5s
    timeout: 3s
    retries: 5
    start_period: 10s   # grace period before healthcheck starts

app:
  depends_on:
    db:
      condition: service_healthy   # won't start until db is healthy
```

## Examples

### Full Dev Stack
```yaml
# compose.yaml
services:
  nginx:
    image: nginx:1.25-alpine
    ports: ["80:80"]
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on: [api]

  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
    volumes:
      - ./backend:/app   # live code reload in dev
    environment:
      - DATABASE_URL=postgresql://user:${DB_PASS}@db:5432/myapp
      - REDIS_URL=redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: ${DB_PASS}
      POSTGRES_DB: myapp
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user"]
      interval: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
```

## Exercises

1. Write a `compose.yaml` that runs a FastAPI app (build from a local Dockerfile) and a PostgreSQL database. The app should connect to the DB by service name. Start the stack and verify both containers are running.
2. Add a Redis service to the stack above. Use `depends_on` with `condition: service_started` for Redis and `condition: service_healthy` for the database.
3. Add a healthcheck to the PostgreSQL service using `pg_isready`. Verify it works by running `docker compose ps` and checking the health status column.
4. Use an `.env` file to store the database password and reference it in `compose.yaml` with `${DB_PASSWORD}`. Confirm the container receives it by running `docker compose exec db env | grep POSTGRES_PASSWORD`.

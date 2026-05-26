---
title: Multi-stage Builds
module: docker
duration_min: 15
difficulty: intermediate
tags: [docker, multi-stage, dockerfile, optimization, build]
exercises: 4
---

## Overview
A multi-stage build uses multiple `FROM` statements in one Dockerfile. Each stage is a separate build environment — you install compilers, build tools, and test dependencies in early stages, then copy only the compiled output into a minimal final image. The result: production images that contain no build tools, no source code, no test frameworks — just the binary or assets needed to run.

## Concepts

### The Problem Multi-stage Solves
Without multi-stage:
```dockerfile
FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Image contains: Node.js, npm, node_modules (dev deps), source code, build output
# Size: ~1.2 GB
```

With multi-stage:
```dockerfile
# Stage 1: build
FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: production
FROM nginx:1.25-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Image contains: nginx + built static files only
# Size: ~25 MB
```

### Syntax
```dockerfile
# Name stages with AS <name>
FROM golang:1.24 AS builder
# ...build...

FROM alpine:3.19 AS tester
COPY --from=builder /app/binary .
RUN ./binary --test

FROM scratch AS final
# COPY from a named stage
COPY --from=builder /app/binary /binary
# COPY from an image directly (no prior stage needed)
COPY --from=alpine:3.19 /etc/ssl/certs /etc/ssl/certs
ENTRYPOINT ["/binary"]
```

`COPY --from=<stage>` pulls files from any previous stage by name or index.

### Common Patterns

#### Go Binary (Minimal Final Image)
```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o server ./cmd/server

FROM scratch
# scratch = completely empty image
COPY --from=builder /app/server /server
COPY --from=builder /etc/ssl/certs /etc/ssl/certs   # for HTTPS
EXPOSE 8080
ENTRYPOINT ["/server"]
# Final image: ~10 MB (binary only)
```

`CGO_ENABLED=0` produces a fully static binary with no shared library dependencies — runs in `scratch`.

#### Python App
```dockerfile
FROM python:3.12 AS builder
WORKDIR /app
COPY requirements.txt .
# Install to a custom prefix so we can copy just the packages
RUN pip install --prefix=/install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /install /usr/local
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
# Slim = no build tools, smaller than full python image
```

#### Node.js
```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev   # production deps only

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci               # all deps (including dev)
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json .
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Build Arguments Across Stages
```dockerfile
ARG BUILD_ENV=production

FROM node:20-alpine AS builder
ARG BUILD_ENV   # ARG must be re-declared in each stage that uses it
RUN echo "Building for: $BUILD_ENV"
```

### Targeting a Specific Stage
```bash
# Build only up to the 'builder' stage (useful in CI for running tests)
docker build --target builder -t myapp:builder .

# Run tests in the builder stage, then build the final image
docker build --target builder -t myapp:test .
docker run --rm myapp:test npm test

docker build --target runner -t myapp:prod .
```

### Test Stage Pattern
```dockerfile
FROM python:3.12 AS builder
WORKDIR /app
COPY requirements*.txt ./
RUN pip install -r requirements.txt -r requirements-dev.txt

FROM builder AS test
COPY . .
RUN pytest --tb=short

FROM python:3.12-slim AS production
WORKDIR /app
COPY --from=builder /app /app
RUN pip install -r requirements.txt
CMD ["uvicorn", "main:app", "--host", "0.0.0.0"]
```

```bash
# CI pipeline:
docker build --target test -t myapp:test .     # fails build if tests fail
docker build --target production -t myapp .    # only reached if tests pass
```

## Examples

### Java / Maven
```dockerfile
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /app
# Cache dependencies separately
COPY pom.xml .
RUN mvn dependency:go-offline -q
# Build jar
COPY src ./src
RUN mvn package -DskipTests -q

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

| Stage | Size | Contents |
|---|---|---|
| maven:3.9-eclipse-temurin-21 | ~660 MB | Maven, JDK, .m2 cache |
| eclipse-temurin:21-jre-alpine | ~85 MB | JRE only, no build tools |

## Exercises

1. Write a multi-stage Dockerfile for a Go program (`main.go` with `fmt.Println("hello")`): build stage with `golang:1.24-alpine`, final stage with `alpine:3.19`. Compare `docker images` sizes before and after.
2. Add a `test` stage to an existing Dockerfile that runs `pytest` before the production build. Use `docker build --target test` to verify tests run, and `docker build --target production` to get the final image.
3. Write a multi-stage Dockerfile for a Node.js app with separate stages for: (1) installing all dependencies, (2) building/transpiling, (3) production image with only prod deps + built output.
4. Use `COPY --from=<image>` to copy SSL certificates from `alpine:3.19` into a `scratch`-based Go container, enabling HTTPS calls from the binary. Verify the container can reach an HTTPS endpoint.

---
title: Registry Management
module: docker
duration_min: 10
difficulty: beginner
tags: [docker, registry, ecr, gcr, dockerhub, push, pull, tagging]
exercises: 4
---

## Overview
A container registry stores and distributes Docker images. Docker Hub is the public default; AWS ECR, GCP Artifact Registry, and GitHub Container Registry are the dominant private options. Every CI/CD pipeline ends with a push to a registry, and every deployment starts with a pull. Understanding registries, tagging conventions, and authentication is essential plumbing for any container workflow.

## Concepts

### Image Naming
```
registry/namespace/repository:tag

docker.io/library/nginx:1.25          # Docker Hub official
docker.io/myorg/myapp:v1.2.3          # Docker Hub personal/org
123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v1.2.3   # AWS ECR
ghcr.io/myorg/myapp:sha-abc1234       # GitHub Container Registry
europe-docker.pkg.dev/project/repo/myapp:latest           # GCP Artifact Registry
```

When no registry is specified, Docker assumes `docker.io`. When no tag is specified, Docker uses `latest`.

### Tagging Strategy
`latest` is a moving target — never use it for production deployments. Use immutable tags:

```bash
# Tag by version
docker tag myapp:latest myapp:v1.2.3

# Tag by git SHA (recommended for CD pipelines — always unique, always traceable)
GIT_SHA=$(git rev-parse --short HEAD)
docker tag myapp:latest myapp:${GIT_SHA}

# Tag by both (version + SHA for traceability)
docker tag myapp:latest myapp:v1.2.3
docker tag myapp:latest myapp:v1.2.3-${GIT_SHA}

# In CI/CD:
IMAGE="123456789.dkr.ecr.us-east-1.amazonaws.com/myapp"
docker build -t "${IMAGE}:${GIT_SHA}" -t "${IMAGE}:latest" .
```

### Docker Hub
```bash
# Login
docker login   # prompts for username/password
docker login -u myuser --password-stdin <<< "$DOCKER_PASSWORD"   # non-interactive

# Push
docker push myorg/myapp:v1.2.3

# Pull
docker pull myorg/myapp:v1.2.3

# Logout
docker logout
```

### AWS ECR (Elastic Container Registry)
```bash
# Authenticate (token is valid for 12 hours)
aws ecr get-login-password --region us-east-1 \
    | docker login --username AWS --password-stdin \
      123456789.dkr.ecr.us-east-1.amazonaws.com

# Create a repository (one-time setup)
aws ecr create-repository --repository-name myapp --region us-east-1

# Tag and push
IMAGE="123456789.dkr.ecr.us-east-1.amazonaws.com/myapp"
docker tag myapp:latest "${IMAGE}:v1.2.3"
docker push "${IMAGE}:v1.2.3"

# Pull
docker pull "${IMAGE}:v1.2.3"

# List images in a repo
aws ecr list-images --repository-name myapp

# Delete an image
aws ecr batch-delete-image --repository-name myapp \
    --image-ids imageTag=v1.0.0
```

### GitHub Container Registry (GHCR)
```bash
# Login with a Personal Access Token (PAT) with read:packages + write:packages
echo "$GITHUB_TOKEN" | docker login ghcr.io -u myuser --password-stdin

# Push
docker tag myapp:latest ghcr.io/myorg/myapp:v1.2.3
docker push ghcr.io/myorg/myapp:v1.2.3
```

### GCP Artifact Registry
```bash
# Configure Docker to use gcloud auth
gcloud auth configure-docker europe-docker.pkg.dev

# Push
IMAGE="europe-docker.pkg.dev/my-project/my-repo/myapp"
docker tag myapp:latest "${IMAGE}:v1.2.3"
docker push "${IMAGE}:v1.2.3"
```

### Lifecycle Policies — Clean Up Old Images
Registries accumulate images fast. Set up automatic cleanup:

**AWS ECR lifecycle policy:**
```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 10 tagged releases",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["v"],
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Expire untagged images after 7 days",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 7
      },
      "action": { "type": "expire" }
    }
  ]
}
```

```bash
aws ecr put-lifecycle-policy \
    --repository-name myapp \
    --lifecycle-policy-text file://lifecycle.json
```

### Private Registry with Authentication in Kubernetes
When Kubernetes pulls from a private registry, it needs credentials stored as a Secret:

```bash
# Create imagePullSecret from registry credentials
kubectl create secret docker-registry ecr-secret \
    --docker-server=123456789.dkr.ecr.us-east-1.amazonaws.com \
    --docker-username=AWS \
    --docker-password=$(aws ecr get-login-password)

# Reference in a Pod spec
```
```yaml
spec:
  imagePullSecrets:
    - name: ecr-secret
  containers:
    - name: app
      image: 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v1.2.3
```

## Examples

### CI Push Script
```bash
#!/usr/bin/env bash
set -euo pipefail

REGION="us-east-1"
ACCOUNT="123456789"
REPO="myapp"
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}"
TAG=$(git rev-parse --short HEAD)

# Authenticate
aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

# Build and push with two tags: git SHA + latest
docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" .
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

echo "Pushed: ${IMAGE}:${TAG}"
```

## Exercises

1. Create a Docker Hub account (if you don't have one), tag a local image with your Docker Hub username, and push it. Then pull it on a different terminal by its full name.
2. Write a bash script that authenticates to AWS ECR, builds an image tagged with the current git SHA, pushes it, and prints the full image URI.
3. Write an ECR lifecycle policy JSON that keeps the last 20 tagged images (`v*` prefix) and expires untagged images after 1 day. Apply it with the AWS CLI.
4. Explain the difference between `docker pull nginx:latest` today vs in 3 months. What should you use instead in a production Kubernetes manifest, and why?

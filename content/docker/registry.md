---
title: Registry Management
module: docker
duration_min: 10
difficulty: beginner
tags: [docker, registry, ecr, gcr, dockerhub, push, pull, tagging]
exercises: 4
---

## Overview

A container registry is a content-addressable storage system for OCI-compliant images. When you run `docker push`, the Docker daemon uploads each layer of the image separately — layers already present in the registry are skipped, which is why layer caching matters for push speed. When you run `docker pull`, the daemon downloads only the layers not already present in its local cache. Every CI/CD pipeline ends with a push to a registry, and every deployment starts with a pull. Mastering registries means mastering the handoff point between build and deploy.

The core design principle of registries is immutability by convention, not enforcement. Nothing stops you from overwriting `latest` with a broken image five minutes before a production deploy. The guardrails are your tagging strategy and your access policies — both of which you control. This is why tagging discipline and lifecycle management are first-class DevOps concerns, not afterthoughts.

In the broader toolchain, a registry sits between CI (which builds and pushes) and CD (which pulls and deploys). Your CI system authenticates to the registry, your orchestrator (Kubernetes, ECS, Nomad) pulls from it, and your security team scans images in it. Choosing the right registry and configuring it correctly affects build speed, security posture, cost, and deployment reliability.

---

## Concepts

### Image Naming and the OCI Reference Format

Every image reference follows this structure:

```
[registry/][namespace/]repository[:tag][@digest]

docker.io/library/nginx:1.25                                          # Docker Hub official image
docker.io/myorg/myapp:v1.2.3                                          # Docker Hub org image
123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v1.2.3               # AWS ECR
ghcr.io/myorg/myapp:sha-abc1234                                       # GitHub Container Registry
europe-docker.pkg.dev/my-project/my-repo/myapp:v1.2.3                # GCP Artifact Registry
```

**When fields are omitted:**
- No registry → Docker assumes `docker.io`
- No namespace on Docker Hub → assumes `library` (official images)
- No tag → Docker uses `latest`
- `@digest` pins to an exact image hash (immutable; survives tag reassignment)

A digest reference looks like:

```bash
docker pull nginx@sha256:a3e7b5c6d9f1e2a4b7c8d0e1f3a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f234
```

**Digest vs tag:** Tags are mutable pointers. A digest is the SHA256 of the image manifest — it never changes. For maximum reproducibility, use digest pins in production manifests.

| Reference Type | Example | Mutable? | Use case |
|---|---|---|---|
| `latest` tag | `nginx:latest` | Yes | Local dev, never production |
| Semver tag | `myapp:v1.2.3` | Technically yes, by convention no | Human-readable releases |
| Git SHA tag | `myapp:abc1234` | No (unique per commit) | CI/CD traceability |
| Digest | `myapp@sha256:abc...` | No (cryptographic) | Locked production deploys |

---

### Tagging Strategy

`latest` is not a version — it is the absence of a version. Any tooling, human, or pipeline that pushes `latest` overwrites the previous image silently.

**The rule for production:** every image deployed to production must have a tag that is unique and traceable to source code. Git SHA tags satisfy both properties automatically.

```bash
# Single semver tag
docker tag myapp:latest myapp:v1.2.3

# Git SHA (short) — always unique, traceable to a commit
GIT_SHA=$(git rev-parse --short HEAD)
docker tag myapp:latest myapp:${GIT_SHA}

# Combined: semver for humans, SHA for machines
docker tag myapp:latest myapp:v1.2.3
docker tag myapp:latest myapp:v1.2.3-${GIT_SHA}

# Recommended CI pattern: build once, tag twice
IMAGE="123456789.dkr.ecr.us-east-1.amazonaws.com/myapp"
GIT_SHA=$(git rev-parse --short HEAD)

docker build \
  -t "${IMAGE}:${GIT_SHA}" \
  -t "${IMAGE}:latest" \
  .

docker push "${IMAGE}:${GIT_SHA}"
docker push "${IMAGE}:latest"
```

**`docker tag` does not copy data.** It creates a new pointer to the same image manifest. Pushing both tags uploads layers once; the second push only registers the new tag in the registry index.

**Branch-based tagging** is useful for staging environments:

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD | sed 's/[^a-zA-Z0-9._-]/-/g')
docker tag myapp:latest "${IMAGE}:${BRANCH}"
```

The `sed` strips characters that are invalid in image tags (slashes in branch names like `feature/login` become `feature-login`).

---

### Docker Hub

Docker Hub is the default public registry. Free accounts have pull rate limits (100 pulls/6h unauthenticated, 200 pulls/6h authenticated). CI systems running many parallel jobs hit these limits fast.

```bash
# Interactive login (stores credentials in ~/.docker/config.json)
docker login

# Non-interactive — safe for CI (reads password from env var, no shell history)
echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin

# Push a tagged image
docker push myorg/myapp:v1.2.3

# Pull explicitly
docker pull myorg/myapp:v1.2.3

# Inspect image metadata without pulling layers
docker manifest inspect myorg/myapp:v1.2.3

# Logout (removes token from ~/.docker/config.json)
docker logout
```

**Rate limit mitigation options:**
- Authenticate even for public pulls (raises limit to 200/6h per account)
- Use a Docker Hub paid plan for higher limits
- Mirror frequently-used base images to your private registry (ECR, Artifact Registry)
- Cache images in CI using layer caching or a pull-through cache

---

### AWS ECR (Elastic Container Registry)

ECR is the dominant private registry in AWS-native stacks. Authentication uses short-lived tokens from the AWS STS service — tokens expire after 12 hours, so CI jobs must re-authenticate per run.

```bash
# Authenticate — pipe the token directly to docker login
aws ecr get-login-password --region us-east-1 \
    | docker login --username AWS --password-stdin \
      123456789.dkr.ecr.us-east-1.amazonaws.com

# Create a repository (one-time; repositories are not auto-created on push)
aws ecr create-repository \
    --repository-name myapp \
    --region us-east-1 \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256

# Tag and push
IMAGE="123456789.dkr.ecr.us-east-1.amazonaws.com/myapp"
docker tag myapp:latest "${IMAGE}:v1.2.3"
docker push "${IMAGE}:v1.2.3"

# Pull
docker pull "${IMAGE}:v1.2.3"

# List all image tags in a repo
aws ecr list-images --repository-name myapp --region us-east-1

# Describe images with push timestamps
aws ecr describe-images --repository-name myapp \
    --query 'sort_by(imageDetails, &imagePushedAt)[-5:].[imageTags,imagePushedAt]' \
    --output table

# Delete a specific image by tag
aws ecr batch-delete-image \
    --repository-name myapp \
    --image-ids imageTag=v1.0.0

# Delete by digest (when image has no tag)
aws ecr batch-delete-image \
    --repository-name myapp \
    --image-ids imageDigest=sha256:abc123...
```

**ECR IAM:** Unlike Docker Hub, ECR access is controlled by IAM. EC2 instances and ECS tasks with the right IAM role can pull without explicit `docker login` — the AWS credential chain handles it. CI systems (GitHub Actions, GitLab CI) need explicit authentication because they run outside AWS.

**ECR Public Gallery** (`public.ecr.aws`) is AWS's answer to Docker Hub for public images. No authentication required for pulls, and no rate limits.

---

### GitHub Container Registry (GHCR)

GHCR is tightly integrated with GitHub Actions. Permissions follow the repository or organization visibility settings, making it natural for open-source projects.

```bash
# Login with a Personal Access Token (PAT)
# Required scopes: read:packages, write:packages, delete:packages
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_USER" --password-stdin

# In GitHub Actions, use the built-in GITHUB_TOKEN (no PAT needed)
echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io \
    -u "${{ github.actor }}" --password-stdin

# Tag using the standard GHCR naming convention
docker tag myapp:latest ghcr.io/myorg/myapp:v1.2.3
docker push ghcr.io/myorg/myapp:v1.2.3

# Pull (public images need no auth)
docker pull ghcr.io/myorg/myapp:v1.2.3
```

**Image visibility:** New packages default to private. You must explicitly set them to public in the GitHub package settings if you want unauthenticated pulls. **This catches people off guard** — pushing an image in a public repository does not automatically make the package public.

---

### GCP Artifact Registry

GCP Artifact Registry (the successor to Google Container Registry) uses `gcloud` as its credential helper. It supports regional endpoints for latency and data residency.

```bash
# Configure Docker to use gcloud credentials for a specific region
gcloud auth configure-docker europe-docker.pkg.dev

# For service accounts in CI, authenticate with a key file
gcloud auth activate-service-account --key-file=sa-key.json
gcloud auth configure-docker europe-docker.pkg.dev

# Create a repository (Docker format)
gcloud artifacts repositories create my-repo \
    --repository-format=docker \
    --location=europe \
    --description="Production images"

# Tag and push
IMAGE="europe-docker.pkg.dev/my-project/my-repo/myapp"
docker tag myapp:latest "${IMAGE}:v1.2.3"
docker push "${IMAGE}:v1.2.3"

# List images
gcloud artifacts docker images list \
    europe-docker.pkg.dev/my-project/my-repo/myapp
```

**`gcloud auth configure-docker`** modifies `~/.docker/config.json` to add a credential helper entry. Docker calls `gcloud` to obtain a fresh token on each operation — no manual token refresh needed.

---

### Lifecycle Policies — Controlling Registry Growth

Registries accumulate images aggressively. A team pushing on every commit generates hundreds of images per week. Without cleanup, storage costs compound and image scanning slows down.

**AWS ECR lifecycle policy example:**

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 10 versioned releases",
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
      "description": "Keep last 5 SHA-tagged builds",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["sha-"],
        "countType": "imageCountMoreThan",
        "countNumber": 5
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 3,
      "description": "Expire untagged images after 1 day",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 1
      },
      "action": { "type": "expire" }
    }
  ]
}
```

```bash
# Apply the policy
aws ecr put-lifecycle-policy \
    --repository-name myapp \
    --lifecycle-policy-text file://lifecycle.json

# Preview what would be deleted without actually deleting (dry run)
aws ecr get-lifecycle-policy-preview \
    --repository-name myapp
```

**Rules are evaluated in priority order.** Lower number = higher priority. If rule 1 matches an image, rules 2 and 3 are not evaluated for that image. Design rules from most-specific to least-specific.

**Untagged images:** When you push `myapp:latest` and overwrite the previous `latest`, the old manifest becomes untagged — it still occupies storage but has no tag pointing to it. Rule 3 above catches these.

**GCP Artifact Registry cleanup policies** use a similar JSON structure applied via `gcloud artifacts repositories set-cleanup-policies`.

---

### Registry Authentication in Kubernetes

Kubernetes nodes pull images from registries. For private registries, Kubernetes needs credentials stored as a `kubernetes.io/dockerconfigjson` Secret.

```bash
# Create an imagePullSecret from registry credentials
kubectl create secret docker-registry ecr-pull-secret \
    --docker-server=123456789.dkr.ecr.us-east-1.amazonaws.com \
    --docker-username=AWS \
    --docker-password="$(aws ecr get-login-password --region us-east-1)" \
    --namespace=production
```

Reference the secret in your Pod or Deployment spec:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      imagePullSecrets:
        - name: ecr-pull-secret          # must exist in same namespace
      containers:
        - name: app
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v1.2.3
          ports:
            - containerPort: 8080
```

**ECR token rotation problem:** ECR tokens expire after 12 hours. A static `imagePullSecret` will stop working after 12 hours unless refreshed. Solutions:

| Approach | How it works | Complexity |
|---|---|---|
| IRSA (EKS) | Node IAM role grants ECR pull access; no secret needed | Low — AWS-native |
| `amazon-ecr-credential-helper` | Credential helper auto-refreshes tokens | Medium — requires DaemonSet or node config |
| CronJob refresh | Kubernetes CronJob recreates the Secret every 6h | Medium — fragile but portable |
| External Secrets Operator | Syncs ECR token from AWS Secrets Manager | High — robust for production |

**IRSA is the recommended approach on EKS** — attach an IAM role to the node group or service account with `ecr:GetAuthorizationToken` and `ecr:BatchGetImage` permissions, and Kubernetes pulls without any Secret.

---

### Image Scanning

Modern registries offer vulnerability scanning built in. Enable it to catch CVEs before images reach production.

```bash
# ECR: enable scan-on-push for a repository
aws ecr put-image-scanning-configuration \
    --repository-name myapp \
    --image-scanning-configuration scanOnPush=true

# Retrieve scan findings for a specific image
aws ecr describe-image-scan-findings \
    --repository-name myapp \
    --image-id imageTag=v1.2.3 \
    --query 'imageScanFindings.findingSeverityCounts'
```

**In CI, fail builds on CRITICAL findings:**

```bash
CRITICAL=$(aws ecr describe-image-scan-findings \
    --repository-name myapp
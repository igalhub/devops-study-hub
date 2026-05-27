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

The core design principle of registries is immutability by convention, not enforcement. Nothing stops you from overwriting `latest` with a broken image five minutes before a production deploy. The guardrails are your tagging strategy and your access policies — both of which you control. This is why tagging discipline and lifecycle management are first-class DevOps concerns, not afterthoughts. A registry without a retention policy is a growing liability: storage costs accumulate, scan times increase, and the blast radius of a compromised image tag grows.

In the broader toolchain, a registry sits between CI (which builds and pushes) and CD (which pulls and deploys). Your CI system authenticates to the registry, your orchestrator (Kubernetes, ECS, Nomad) pulls from it, and your security team scans images in it. Choosing the right registry and configuring it correctly affects build speed, security posture, cost, and deployment reliability. For teams already invested in AWS, ECR is the natural choice; for GitHub-native workflows, GHCR reduces credential management overhead; for polyglot cloud environments, a self-hosted registry like Harbor gives maximum control.

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

| Reference Type | Example | Mutable? | Use case |
|---|---|---|---|
| `latest` tag | `nginx:latest` | Yes | Local dev, never production |
| Semver tag | `myapp:v1.2.3` | Technically yes, by convention no | Human-readable releases |
| Git SHA tag | `myapp:abc1234` | No (unique per commit) | CI/CD traceability |
| Digest | `myapp@sha256:abc...` | No (cryptographic) | Locked production deploys |

**Digest vs tag:** Tags are mutable pointers. A digest is the SHA256 of the image manifest — it never changes. For maximum reproducibility, pin to digests in production Kubernetes manifests. If a tag is later overwritten, your manifest still references the exact image you tested.

```bash
# Resolve a tag to its digest
docker inspect --format='{{index .RepoDigests 0}}' nginx:1.25
# Output: nginx@sha256:a3e7b5c6d9...

# Use the digest directly in a Kubernetes manifest
# image: nginx@sha256:a3e7b5c6d9...
```

---

### Tagging Strategy

`latest` is not a version — it is the absence of a version. Any tooling, human, or pipeline that pushes `latest` overwrites the previous image silently. Using `latest` in production deployments means you cannot reliably reproduce a deployed state.

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

# Recommended CI pattern: build once, tag twice, push both
IMAGE="123456789.dkr.ecr.us-east-1.amazonaws.com/myapp"
GIT_SHA=$(git rev-parse --short HEAD)

docker build \
  -t "${IMAGE}:${GIT_SHA}" \
  -t "${IMAGE}:latest" \
  .

docker push "${IMAGE}:${GIT_SHA}"
docker push "${IMAGE}:latest"
```

**`docker tag` does not copy data.** It creates a new pointer to the same image manifest. Pushing both tags uploads layers once; the second push only registers the new tag in the registry index. This means tagging aggressively is essentially free in terms of storage.

**Branch-based tagging** is useful for staging environments where you want the latest build from a specific branch:

```bash
# Sanitize branch name — slashes and special chars are not valid in image tags
BRANCH=$(git rev-parse --abbrev-ref HEAD | sed 's/[^a-zA-Z0-9._-]/-/g')
docker tag myapp:latest "${IMAGE}:${BRANCH}"
docker push "${IMAGE}:${BRANCH}"
# feature/login → feature-login
```

| Tag Pattern | Example | Pros | Cons |
|---|---|---|---|
| `latest` | `myapp:latest` | Easy | Not traceable, mutable |
| Semver | `myapp:v1.2.3` | Human readable | Requires release discipline |
| Git SHA | `myapp:abc1234` | Traceable, unique | Not human readable |
| Semver + SHA | `myapp:v1.2.3-abc1234` | Best of both | Verbose |
| Branch | `myapp:main` | Useful for staging | Mutable, like latest |

---

### Docker Hub

Docker Hub is the default public registry. Free accounts have pull rate limits (100 pulls/6h unauthenticated, 200 pulls/6h per authenticated user). CI systems running many parallel jobs hit these limits fast — a team of 10 engineers with parallel builds can exhaust the unauthenticated limit within minutes.

```bash
# Interactive login (stores credentials in ~/.docker/config.json)
docker login

# Non-interactive — safe for CI (reads password from env var, no shell history)
echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin

# Push a tagged image
docker push myorg/myapp:v1.2.3

# Pull explicitly
docker pull myorg/myapp:v1.2.3

# Inspect image metadata and available platforms without pulling layers
docker manifest inspect myorg/myapp:v1.2.3

# Logout (removes token from ~/.docker/config.json)
docker logout
```

**Rate limit mitigation options:**

| Option | Cost | Effort | Notes |
|---|---|---|---|
| Authenticate for public pulls | Free | Low | Raises limit to 200/6h per account |
| Docker Hub paid plan | $5-$420/mo | Low | Higher limits, team accounts |
| Mirror base images to private registry | Cloud storage | Medium | Pull once, serve internally |
| Pull-through cache (ECR, Nexus) | Minimal | Medium | Registry-level solution |

**`~/.docker/config.json` stores credentials as base64, not encrypted.** On developer machines this is acceptable. In CI, use the `--password-stdin` pattern and prefer short-lived tokens over long-lived passwords. Never log `config.json` contents in CI output.

---

### AWS ECR (Elastic Container Registry)

ECR is the dominant private registry in AWS-native stacks. Authentication uses short-lived tokens from the AWS STS service — tokens expire after 12 hours, so CI jobs must re-authenticate per run.

```bash
# Authenticate — pipe the token directly to docker login
aws ecr get-login-password --region us-east-1 \
    | docker login --username AWS --password-stdin \
      123456789.dkr.ecr.us-east-1.amazonaws.com

# Create a repository (one-time; repositories are NOT auto-created on push)
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

# Describe images sorted by push time (last 5)
aws ecr describe-images --repository-name myapp \
    --query 'sort_by(imageDetails, &imagePushedAt)[-5:].[imageTags,imagePushedAt]' \
    --output table

# Delete a specific image by tag
aws ecr batch-delete-image \
    --repository-name myapp \
    --image-ids imageTag=v1.0.0

# Delete by digest (for untagged images that have no tag pointer)
aws ecr batch-delete-image \
    --repository-name myapp \
    --image-ids imageDigest=sha256:abc123...
```

**ECR IAM:** Unlike Docker Hub, ECR access is controlled entirely by IAM. EC2 instances and ECS tasks with the correct IAM role can pull without explicit `docker login` — the AWS credential chain handles authentication transparently. CI systems (GitHub Actions, GitLab CI) need explicit authentication because they run outside the AWS trust boundary.

**Minimum IAM permissions for a CI push role:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "arn:aws:ecr:us-east-1:123456789:repository/myapp"
    }
  ]
}
```

**ECR Public Gallery** (`public.ecr.aws`) is AWS's answer to Docker Hub for public images. No authentication required for pulls, no rate limits, and images are served from AWS infrastructure globally.

---

### GitHub Container Registry (GHCR)

GHCR is tightly integrated with GitHub Actions. Permissions follow repository or organization visibility settings, making it natural for open-source and inner-source projects that already live on GitHub.

```bash
# Login with a Personal Access Token (PAT)
# Required scopes: read:packages, write:packages, delete:packages
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_USER" --password-stdin

# Tag using the standard GHCR naming convention (lowercase org/repo required)
docker tag myapp:latest ghcr.io/myorg/myapp:v1.2.3
docker push ghcr.io/myorg/myapp:v1.2.3

# Pull (public images need no auth)
docker pull ghcr.io/myorg/myapp:v1.2.3
```

In GitHub Actions, use the built-in `GITHUB_TOKEN` — no PAT required, no credential rotation:

```yaml
# .github/workflows/build.yml
jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write          # required to push to GHCR
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io \
            -u "${{ github.actor }}" --password-stdin

      - name: Build and push
        run: |
          IMAGE="ghcr.io/${{ github.repository_owner }}/myapp"
          SHA="${{ github.sha }}"
          docker build -t "${IMAGE}:${SHA:0:7}" -t "${IMAGE}:latest" .
          docker push "${IMAGE}:${SHA:0:7}"
          docker push "${IMAGE}:latest"
```

**Image visibility gotcha:** New packages default to private even if the source repository is public. You must explicitly set the package to public in GitHub Package settings or via the API. Teams frequently push a public image and are surprised when unauthenticated pulls fail.

---

### GCP Artifact Registry

GCP Artifact Registry (successor to Google Container Registry, which was deprecated in 2024) uses `gcloud` as a credential helper. It supports regional endpoints for latency optimization and data residency compliance.

```bash
# Configure Docker to use gcloud credentials for a specific region
gcloud auth configure-docker europe-docker.pkg.dev

# For service accounts in CI, authenticate with a JSON key file
gcloud auth activate-service-account --key-file=sa-key.json
gcloud auth configure-docker europe-docker.pkg.dev

# Create a repository (Docker format, EU region)
gcloud artifacts repositories create my-repo \
    --repository-format=docker \
    --location=europe \
    --description="Production images"

# Tag and push
IMAGE="europe-docker.pkg.dev/my-project/my-repo/myapp"
docker tag myapp:latest "${IMAGE}:v1.2.3"
docker push "${IMAGE}:v1.2.3"

# List images in the repository
gcloud artifacts docker images list \
    europe-docker.pkg.dev/my-project/my-repo/myapp

# List tags for a specific image
gcloud artifacts docker tags list \
    europe-docker.pkg.dev/my-project/my-repo/myapp
```

**`gcloud auth configure-docker`** modifies `~/.docker/config.json` to add a `credHelpers` entry for the specified hostname. Docker calls `gcloud` to obtain a fresh OAuth token on each operation — no manual 12-hour token refresh needed, unlike ECR.

**Workload Identity Federation** is the preferred approach for CI systems — it lets external OIDC providers (GitHub Actions, GitLab, etc.) impersonate a GCP service account without storing a key file, eliminating the secret rotation burden entirely.

---

### Lifecycle Policies — Controlling Registry Growth

Registries accumulate images aggressively. A team pushing on every commit generates hundreds of images per week. Without cleanup, storage costs compound, vulnerability scan times increase, and the list of images becomes unmanageable.

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
      "description": "Keep last 20 SHA-tagged builds for traceability",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["sha-"],
        "countType": "imageCountMoreThan",
        "countNumber": 20
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
# Apply the policy to a repository
aws ecr put-lifecycle-policy \
    --repository-name myapp \
    --lifecycle-policy-text file://lifecycle.json

# Preview what would be deleted without deleting (dry run)
aws ecr get-lifecycle-policy-preview \
    --repository-name myapp
```

**Rules are evaluated in priority order.** Lower number = higher priority. If rule 1 matches an image, rules 2 and 3 are not evaluated for that image. Design rules from most-specific (versioned releases) to least-specific (untagged cleanup).

**Untagged images** are created whenever you push a tag that already exists — the old manifest loses its tag pointer but remains in storage. Rule 3 above is the safety net for this. Without it, a high-frequency CI pipeline can accumulate gigabytes of untagged orphans within days.

**GCP Artifact Registry** cleanup policies use a similar JSON structure applied via:
```bash
gcloud artifacts repositories set-cleanup-policies my-repo \
    --location=europe \
    --policy=cleanup-policy.json
```

---

### Registry Authentication in Kubernetes

Kubernetes nodes pull images from registries at pod scheduling time. For private registries, the cluster needs credentials stored as a `kubernetes.io/dockerconfigjson` Secret called an `imagePullSecret`.

```bash
# Create an imagePullSecret from registry credentials
kubectl create secret docker-registry ecr-pull-secret \
    --docker-server=123456789.dkr.ecr.us-east-1.amazonaws.com \
    --docker-username=AWS \
    --docker-password="$(aws ecr get-login-password --region us-east-1)" \
    --namespace=production
```

Reference the secret in your Deployment spec:

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
        - name: ecr-pull-secret          # must exist in the same namespace
      containers:
        - name: app
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v1.2.3
          ports:
            - containerPort: 8080
```

**ECR token rotation problem:** ECR tokens expire after 12 hours. A static `imagePullSecret` will silently stop working after half a day unless refreshed. This is not a problem during normal deployments (new pods authenticate fresh), but it breaks pod restarts and scale-out events after 12 hours.

| Approach | How it works | Complexity |
|---|---|---|
| IRSA (EKS) | Node IAM role grants ECR pull; no secret needed | Low — AWS-native, recommended |
| `amazon-ecr-credential-helper` | Per-node credential helper auto-refreshes tokens | Medium — requires node config |
| CronJob secret refresh | K8s CronJob recreates the Secret every 6h | Medium — fragile but portable |
| External Secrets Operator | Syncs ECR token from Secrets Manager | High — robust for multi-cluster |

**IRSA (IAM Roles for Service Accounts) is the recommended approach on EKS.** Attach an IAM role to the node group or a Kubernetes service account with `ecr:GetAuthorizationToken` and `ecr:BatchGetImage` permissions. Kubernetes handles authentication automatically with no Secret management.

---

### Image Scanning

Modern registries offer built-in vulnerability scanning. Enabling it catches CVEs before images reach production and creates an audit trail of what was known at push time.

```bash
# ECR: enable scan-on-push for a repository
aws ecr put-image-scanning-configuration \
    --repository-name myapp \
    --image-scanning-configuration scanOnPush=true

# Retrieve scan findings for a specific image tag
aws ecr describe-image-scan-findings \
    --repository-name myapp \
    --image-id imageTag=v1.2.3 \
    --query 'imageScanFindings.findingSeverityCounts'
```

**Fail CI builds on CRITICAL findings:**

```bash
# Push the image first, then poll for scan completion
aws ecr wait image-scan-complete \
    --repository-name myapp \
    --image-id imageTag="${GIT_SHA}"

# Extract CRITICAL count; exit non-zero if any exist
CRITICAL=$(aws ecr describe-image-scan-findings \
    --repository-name myapp \
    --image-id imageTag="${GIT_SHA}" \
    --query 'imageScanFindings.findingSeverityCounts.CRITICAL' \
    --output text)

if [ "${CRITICAL}" != "None" ] && [ "${CRITICAL}" -gt 0 ]; then
  echo "ERROR: ${CRITICAL} CRITICAL vulnerabilities found. Failing build."
  exit 1
fi
echo "Scan passed: no CRITICAL findings."
```

**ECR Enhanced Scanning** (powered by Amazon Inspector) provides continuous re-scanning as new CVEs are published — not just at push time. Basic scanning only runs once at push. For production workloads, enable enhanced scanning to catch vulnerabilities discovered after your last push.

**Third-party scanners** (Trivy, Snyk, Grype) can be integrated directly into CI pipelines and often have broader CVE databases:

```bash
# Trivy scan in CI — fail on HIGH or CRITICAL
trivy image \
    --exit-code 1 \
    --severity HIGH,CRITICAL \
    --no-progress \
    "${IMAGE}:${GIT_SHA}"
```

---

## Examples

### Example 1: Full CI Push Pipeline to ECR (GitHub Actions)

This workflow builds on every push to `main`, scans the image with Trivy, and pushes only if the scan passes.

```yaml
# .github/workflows/build-push.yml
name: Build and Push to ECR

on:
  push:
    branches: [main]

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: 123456789.dkr.ecr.us-east-1.amazonaws.com
  ECR_REPOSITORY: myapp

jobs:
  build-scan-push:
    runs-on: ubuntu-latest
    permissions:
      id-token: write    # required for OIDC authentication to AWS
      contents: read

    steps:
      - name: Checkout source
        uses: actions/checkout@v4

      - name: Configure AWS credentials via OIDC
        # No long-lived AWS keys stored in GitHub secrets
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-ecr-push
          aws-region: ${{ env.AWS_REGION }}

      - name: Log in to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build image
        run: |
          SHA="${GITHUB_SHA::7}"
          IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}"
          docker build \
            --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --build-arg GIT_SHA="${SHA}" \
            -t "${IMAGE}:${SHA}" \
            -t "${IMAGE}:latest" \
            .
          echo "IMAGE_TAG=${SHA}" >> $GITHUB_ENV
          echo "IMAGE_URI=${IMAGE}" >> $GITHUB_ENV

      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: "${{ env.IMAGE_URI }}:${{ env.IMAGE_TAG }}"
          format: table
          exit-code: 1              # fail workflow on findings
          severity: HIGH,CRITICAL

      - name: Push to ECR
        # Only runs if Trivy scan passed (previous step did not exit 1)
        run: |
          docker push "${IMAGE_URI}:${IMAGE_TAG}"
          docker push "${IMAGE_URI}:latest"
```

**Verify:** After the workflow runs, confirm the image exists:
```bash
aws ecr describe-images --repository-name myapp \
    --query 'imageDetails[*].[imageTags,imagePushedAt]' \
    --output table
```

---

### Example 2: Apply ECR Lifecycle Policy and Preview Deletions

Setup, apply, and verify a lifecycle policy that keeps costs under control.

```bash
# 1. Save the policy file
cat > lifecycle.json << 'EOF'
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep 10 semver releases",
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
      "description": "Expire untagged after 1 day",
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
EOF

# 2. Apply the policy
aws ecr put-lifecycle-policy \
    --repository-name myapp \
    --lifecycle-policy-text file://lifecycle.json \
    --region us-east-1

# 3. Preview what the policy would delete (safe — no actual deletion)
aws ecr get-lifecycle-policy-preview \
    --repository-name myapp \
    --region us-east-1 \
    --query 'previewResults[*].[imageTags,action.type]' \
    --output table

# 4. Confirm the policy is attached
aws ecr get-lifecycle-policy \
    --repository-name myapp \
    --region us-east-1
```

---

### Example 3: Kubernetes Deployment with GHCR Private Image

Full setup from login to running pod, using a private GHCR image.

```bash
# 1. Create a namespace
kubectl create namespace staging

# 2. Create the imagePullSecret from a GitHub PAT
#    PAT must have: read:packages
kubectl create secret docker-registry ghcr-pull-secret \
    --docker-server=ghcr.io \
    --docker-username="${GITHUB_USER}" \
    --docker-password="${GITHUB_PAT}" \
    --namespace=staging

# 3. Verify the secret was created
kubectl get secret ghcr-pull-secret -n staging -o jsonpath='{.type}'
# Expected output: kubernetes.io/dockerconfigjson
```

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: staging
spec:
  replicas: 2
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      imagePullSecrets:
        - name: ghcr-pull-secret
      containers:
        - name: app
          image: ghcr.io/myorg/myapp:v1.2.3
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
```

```bash
# 4. Apply and verify
kubectl apply -f deployment.yaml
kubectl rollout status deployment/myapp -n staging

# 5. Confirm pods are running and image is correct
kubectl get pods -n staging -o wide
kubectl describe pod -l app=myapp -n staging | grep Image
```

---

### Example 4: Multi-Registry Tag and Push (Promote from ECR to GHCR)

Image promotion — pushing a build artifact from an internal registry to a public one without rebuilding.

```bash
# Scenario: image built and tested in ECR, now promote to GHCR for public release

ECR_IMAGE="123456789.dkr.ecr.us-east-1.amazonaws.com/myapp"
GHCR_IMAGE="ghcr.io/myorg/myapp"
VERSION="v1.2.3"

# 1. Authenticate to both registries
aws ecr get-login-password --region us-east-1 \
    | docker login --username AWS --password-stdin \
      123456789.dkr.ecr.us-east-1.amazonaws.com

echo "${GITHUB_TOKEN}" | docker login ghcr.io \
    -u "${GITHUB_USER}" --password-stdin

# 2. Pull the tested image from ECR
docker pull "${ECR_IMAGE}:${VERSION}"

# 3. Retag for GHCR — no rebuild, same layers
docker tag "${ECR_IMAGE}:${VERSION}" "${GHCR_IMAGE}:${VERSION}"
docker tag "${ECR_IMAGE}:${VERSION}" "${GHCR_IMAGE}:latest"

# 4. Push to GHCR
docker push "${GHCR_IMAGE}:${VERSION}"
docker push "${GHCR_IMAGE}:latest"

# 5. Verify both registries have the same digest
ECR_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${ECR_IMAGE}:${VERSION}")
GHCR_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${GHCR_IMAGE}:${VERSION}")

echo "ECR:  ${ECR_DIGEST}"
echo "GHCR: ${GHCR_DIGEST}"
# The sha256 hash portion should be identical — same image content
```

---

## Exercises

### Exercise 1: Implement a Production Tagging Pipeline

Write a shell script (`tag-and-push.sh`) that:
1. Accepts the ECR repository URI as an argument
2. Builds the image from the current directory's `Dockerfile`
3. Tags it with both the short Git SHA and the semver from a `VERSION` file at the repo root
4. Pushes both tags to ECR
5. Outputs the full image URI with digest after the push (use `docker inspect`)

The script should fail immediately (`set -euo pipefail`) if any command fails and refuse to run if the working tree has uncommitted changes (`git status --porcelain`).

---

### Exercise 2: ECR Lifecycle Policy Design

Your repository currently holds 300 images with the following tag patterns: `v*` (semver releases), `sha-*` (CI builds), `feature-*` (branch builds), and a large number of untagged images.

Design and apply a lifecycle policy JSON that:
- Keeps all semver releases from the last 90 days (not a count limit — a time-based limit)
- Keeps the 30 most recent SHA-tagged builds
- Expires feature-branch images after 7 days
- Expires untagged images after 1 day

Apply the policy and run a dry-run preview. Document which images in your repository would be affected and explain why the rule priority ordering matters for your design.

---

### Exercise 3: Debug a Kubernetes ImagePullBackOff

Create a Deployment in a `debug` namespace that references a private GHCR image. Intentionally configure it incorrectly (wrong secret name or wrong credentials), observe the `ImagePullBackOff` error, then fix it:

1. `kubectl describe pod <pod-name> -n debug` — identify the exact error message
2. Determine whether the problem is authentication (wrong credentials) or referencing (wrong secret name)
3. Correct the configuration and verify the pod reaches `Running` state
4. Verify the final image in use matches your expected digest using `kubectl get pod -o jsonpath='{.spec.containers[0].image}'`

---

### Exercise 4: Integrate Trivy Scanning into a Local Build Script

Extend the tagging pipeline from Exercise 1 to add a vulnerability scan step:

1. After building but before pushing, run `trivy image` against the local image
2. Parse the output to count HIGH and CRITICAL findings
3. If CRITICAL findings exist, abort the push and exit non-zero
4. If only HIGH findings exist, print a warning but continue the push
5. Write the scan results to a JSON file (`scan-results-${GIT_SHA}.json`) using `trivy image --format json`

Test your script against a known vulnerable image (e.g., `python:3.6-slim`) to verify the blocking behavior, then test against a recent minimal base image to verify the happy path.
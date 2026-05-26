---
title: Container Security
module: devsecops
duration_min: 25
difficulty: intermediate
tags: [devsecops, container-security, docker, kubernetes, trivy, securitycontext, admission]
exercises: 4
---

## Overview
Container security spans the entire lifecycle: what goes into the image (build-time), how the container runs (runtime), and what it can reach inside the cluster (network). A misconfigured container running as root with a privileged security context and no network policy is one compromised process away from full cluster access. This lesson covers image scanning, Dockerfile hardening, Kubernetes SecurityContext, and network policies.

## Concepts

### Image Scanning
Scan images for OS package and language dependency vulnerabilities before pushing to a registry.

#### Trivy
```bash
# Install Trivy
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Scan a local image
trivy image myapp:latest

# Fail on CRITICAL or HIGH vulnerabilities (use in CI)
trivy image --exit-code 1 --severity CRITICAL,HIGH myapp:latest

# Scan with SBOM output (Software Bill of Materials)
trivy image --format cyclonedx --output sbom.json myapp:latest

# Scan a Dockerfile for misconfigurations
trivy config ./Dockerfile

# Scan Kubernetes manifests
trivy config ./k8s/
```

#### Docker Scout (built into Docker)
```bash
# Quickview of vulnerabilities
docker scout quickview myapp:latest

# Detailed CVE list
docker scout cves myapp:latest

# Compare with a previous version
docker scout compare myapp:v1.1 --to myapp:v1.0
```

#### In CI (GitHub Actions)
```yaml
- name: Scan image with Trivy
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: myapp:${{ github.sha }}
    exit-code: '1'
    severity: 'CRITICAL,HIGH'
    format: 'sarif'
    output: 'trivy-results.sarif'

- name: Upload scan results to GitHub Security
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: 'trivy-results.sarif'
```

### Dockerfile Hardening

#### Non-Root User
```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create a non-root user and switch to it
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

#### Read-Only Filesystem
```dockerfile
# Make the filesystem read-only — app writes to tmpfs mounts only
# (configured at runtime, not in Dockerfile, but design for it)
RUN mkdir -p /tmp/uploads && chown appuser:appuser /tmp/uploads
```

#### Minimize Attack Surface
```dockerfile
# Use slim or distroless base images
FROM gcr.io/distroless/python3-debian12   # no shell, no package manager
# Or:
FROM python:3.12-slim                      # minimal Debian, no extras

# Don't install unnecessary packages
RUN apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy only what's needed (use .dockerignore)
# .dockerignore:
# .git
# .env*
# tests/
# *.md
# __pycache__
```

#### Build Secrets (don't bake credentials into layers)
```dockerfile
# Bad — token ends up in layer history even if deleted later
RUN pip install --extra-index-url https://token:$TOKEN@private.pypi.com/simple/ mypackage

# Good — use BuildKit secrets (never written to any layer)
RUN --mount=type=secret,id=pypi_token \
    pip install --extra-index-url https://token:$(cat /run/secrets/pypi_token)@private.pypi.com/simple/ mypackage
```

```bash
docker build --secret id=pypi_token,src=./pypi_token.txt .
```

### Kubernetes SecurityContext
SecurityContext controls the Linux security attributes of a pod or container:

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      # Pod-level security settings
      securityContext:
        runAsNonRoot: true           # enforce non-root at admission
        runAsUser: 1000
        runAsGroup: 3000
        fsGroup: 2000               # files created by containers belong to this group
        seccompProfile:
          type: RuntimeDefault      # enable seccomp filtering (recommended)

      containers:
        - name: app
          image: myapp:latest
          # Container-level security settings (override pod-level)
          securityContext:
            allowPrivilegeEscalation: false   # can't gain more privileges than parent
            readOnlyRootFilesystem: true       # filesystem is read-only
            capabilities:
              drop:
                - ALL                          # drop all Linux capabilities
              add:
                - NET_BIND_SERVICE             # only re-add what's actually needed

          volumeMounts:
            - name: tmp
              mountPath: /tmp                  # writable tmpfs for temp files

      volumes:
        - name: tmp
          emptyDir:
            medium: Memory   # tmpfs — not persisted
```

### PodSecurityAdmission
Kubernetes 1.25+ has built-in pod security standards enforced at the namespace level:

```yaml
# Label a namespace to enforce the restricted profile
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted     # blocks non-compliant pods
    pod-security.kubernetes.io/warn: restricted        # warns but doesn't block
    pod-security.kubernetes.io/audit: restricted       # logs violations
```

Three built-in profiles:
- `privileged` — no restrictions
- `baseline` — prevents most privilege escalations
- `restricted` — strong security; requires non-root, no privilege escalation, seccomp

### NetworkPolicy
By default, all pods in a Kubernetes cluster can communicate with all other pods. NetworkPolicy adds firewall rules:

```yaml
# Default-deny all ingress and egress for the production namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}        # applies to all pods
  policyTypes:
    - Ingress
    - Egress
---
# Allow the app to receive traffic from the ingress controller only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-to-app
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: myapp
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8000
---
# Allow the app to reach the database (egress)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-app-to-db
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: myapp
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - protocol: TCP
          port: 5432
    - to:                  # allow DNS resolution
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
```

NetworkPolicy requires a CNI that supports it (Calico, Cilium, Weave Net). The default AWS VPC CNI requires an additional network policy controller for NetworkPolicy support.

### Image Registry Security
```bash
# Sign images with cosign (Sigstore)
cosign sign --key cosign.key myregistry/myapp:v1.2.3

# Verify signature before deploying
cosign verify --key cosign.pub myregistry/myapp:v1.2.3

# Enable signature verification in cluster (Kyverno policy)
# → blocks unsigned or unverified images from running
```

```yaml
# ECR: scan on push (built-in)
aws ecr put-image-scanning-configuration \
  --repository-name myapp \
  --image-scanning-configuration scanOnPush=true

# Get scan findings
aws ecr describe-image-scan-findings \
  --repository-name myapp \
  --image-id imageTag=latest
```

## Exercises

1. Scan an existing public Docker image (e.g. `nginx:1.24`) with Trivy. Find the CVEs with CRITICAL severity. Then pull `nginx:1.25-alpine` and compare — verify the newer Alpine-based image has fewer vulnerabilities.
2. Write a Dockerfile that: uses a non-root user, copies only necessary files (add a `.dockerignore`), uses a slim base image, and avoids installing unnecessary packages. Run Trivy against it and verify it reports fewer findings than a naive Dockerfile.
3. Deploy a pod with a `securityContext` that enforces: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, and drops all capabilities. Add a `tmpfs` mount at `/tmp`. Verify the pod runs and that writing to `/` fails while writing to `/tmp` succeeds.
4. Apply a default-deny NetworkPolicy to a test namespace. Deploy two pods (app and db). Verify app cannot reach db. Then add an allow policy specifically permitting app → db on port 5432. Verify connectivity is restored.

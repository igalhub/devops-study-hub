---
title: Container Security
module: devsecops
duration_min: 25
difficulty: intermediate
tags: [devsecops, container-security, docker, kubernetes, trivy, securitycontext, admission]
exercises: 4
---

## Overview

Container security is not a single control — it is a layered defense across the full container lifecycle. At build time, you control what goes into the image: the base OS, installed packages, secrets handling, and user context. At deploy time, Kubernetes security controls determine what the container is allowed to do on the host: what Linux capabilities it holds, whether it can write to the filesystem, and whether it can escalate privileges. At runtime, network policies determine what traffic is allowed between workloads. Failing to address any one of these layers creates exploitable gaps; a vulnerability in a package combined with a privileged runtime context and no network segmentation is the recipe for full cluster compromise from a single exploited pod.

The guiding principle behind container security is the principle of least privilege: every container should have exactly the permissions it needs to do its job — no more. This means non-root users, read-only filesystems where possible, minimal base images, dropped Linux capabilities, and tightly scoped network rules. Each restriction reduces the blast radius if a container is compromised. Defense in depth means that even if an attacker exploits a CVE in your application, they are dropped into a locked-down environment with no shell, no write access, and no network path to your database.

Container security fits into the DevSecOps toolchain as a set of gates at multiple pipeline stages. Image scanning runs in CI alongside tests. Dockerfile linting and `trivy config` catch misconfigurations before the image is built. Kubernetes admission controllers (PodSecurityAdmission, OPA/Gatekeeper, Kyverno) enforce policy at deploy time and prevent non-compliant workloads from ever reaching a node. Network policies are infrastructure-as-code, versioned alongside application manifests. The result is security that is automated, auditable, and hard to bypass accidentally.

## Concepts

### Image Scanning

Image scanning inspects container images for known vulnerabilities (CVEs) in OS packages and language-level dependencies. Scanners work by extracting the image's software bill of materials (SBOM) — every installed package and its version — and matching it against CVE databases like NVD, GitHub Advisory, and OS-specific sources (Debian Security, Alpine secdb, etc.).

**Trivy** is the most widely used open-source scanner. It handles OCI images, Dockerfiles, Helm charts, Kubernetes manifests, and Terraform configs with a single tool.

```bash
# Install Trivy
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Basic image scan — shows all severities
trivy image nginx:1.24

# CI gate: exit code 1 if any CRITICAL or HIGH CVE is found
trivy image --exit-code 1 --severity CRITICAL,HIGH myapp:latest

# Ignore unfixed CVEs (no upstream patch available yet — reduces noise in CI)
trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed myapp:latest

# Generate a CycloneDX SBOM — useful for compliance and supply chain audits
trivy image --format cyclonedx --output sbom.json myapp:latest

# Scan a Dockerfile for misconfigurations (USER root, no HEALTHCHECK, etc.)
trivy config ./Dockerfile

# Scan an entire directory of Kubernetes manifests
trivy config ./k8s/
```

**Docker Scout** is built into Docker Desktop and Docker Hub. It provides continuous monitoring: once an image is pushed, Scout re-evaluates it as new CVEs are published without requiring a re-scan.

```bash
docker scout quickview myapp:latest                     # summary: critical/high/medium/low counts
docker scout cves myapp:latest                          # full CVE list with fix versions
docker scout compare myapp:v1.1 --to myapp:v1.0        # diff vulnerabilities between versions
```

#### Integrating Trivy into GitHub Actions CI

```yaml
- name: Build image
  run: docker build -t myapp:${{ github.sha }} .

- name: Scan image with Trivy
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: myapp:${{ github.sha }}
    exit-code: '1'
    severity: 'CRITICAL,HIGH'
    ignore-unfixed: true
    format: 'sarif'            # SARIF integrates with GitHub Security tab
    output: 'trivy-results.sarif'

- name: Upload scan results to GitHub Security
  uses: github/codeql-action/upload-sarif@v3
  if: always()                 # upload even if the scan step failed, so you can see results
  with:
    sarif_file: 'trivy-results.sarif'
```

**Gotcha:** `trivy image` on a locally built image scans the image in the Docker daemon. If you push first and scan the registry URL, Trivy pulls and scans the exact digest that will be deployed — these can differ if the push step re-tags or alters the image. In CI, scan the local image immediately after build, before push.

| Scanner | Where it runs | Continuous monitoring | SBOM output | Config scanning |
|---|---|---|---|---|
| **Trivy** | CLI, CI, pre-commit | No (re-run required) | Yes (CycloneDX, SPDX) | Yes |
| **Docker Scout** | CLI, Docker Hub | Yes (on push) | Yes | Limited |
| **Grype** | CLI, CI | No | Via Syft | No |
| **Snyk Container** | CLI, CI, SaaS | Yes | Yes | Yes |

---

### Dockerfile Hardening

A hardened Dockerfile reduces the attack surface of the resulting image. The goal is to produce an image that contains only what the application needs to run — nothing that helps an attacker move laterally or escalate privileges.

#### Non-Root User

Running as root inside a container is dangerous even with namespace isolation. If a container escape vulnerability exists, a root container is far more likely to achieve host root. Always create a dedicated user.

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create a system user with no home directory and no login shell
RUN groupadd -r appuser && useradd -r -g appuser --no-create-home appuser
RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Gotcha:** `EXPOSE` does not publish the port — it is documentation only. Ports below 1024 require `CAP_NET_BIND_SERVICE`. If your app binds to port 80 or 443, either change it to 8080/8443 (preferred) or grant the capability explicitly in the SecurityContext — never run the process as root just to bind a privileged port.

#### Minimal Base Images

Every package in a base image is a potential CVE. Distroless images contain only the language runtime and the application — no shell, no package manager, no `curl`.

```dockerfile
# Multi-stage build: build in a full image, copy artifacts into distroless
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM gcr.io/distroless/python3-debian12
WORKDIR /app
# Copy installed packages from build stage
COPY --from=builder /install /usr/local
COPY --from=builder /app /app
# Distroless images run as nonroot (uid 65532) by default
CMD ["/app/main.py"]
```

When distroless is too restrictive (debugging, dynamic dependencies), use `python:3.12-slim` or `alpine`-based images and strip unnecessary packages:

```dockerfile
FROM python:3.12-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*   # remove apt cache — don't leave it in the layer
```

**Gotcha:** Distroless images have no shell, which means `kubectl exec` and `docker exec` won't give you an interactive session. For debugging in non-production environments, use the `:debug` tag variant (e.g., `gcr.io/distroless/python3-debian12:debug`), which includes BusyBox. Never use `:debug` in production images.

#### .dockerignore

Everything not in `.dockerignore` is sent to the build context and can be copied into the image accidentally.

```
# .dockerignore
.git/
.env
.env.*
*.pem
*.key
tests/
docs/
__pycache__/
*.pyc
node_modules/
.DS_Store
```

**Gotcha:** `.env` files containing secrets are commonly leaked into images via `COPY . .`. Always include `.env*` in `.dockerignore`, and verify with `docker history myapp:latest` that secrets are not present in any layer. You can also use `docker save myapp:latest | tar xO --wildcards '*/layer.tar' | tar t` to inspect layer contents directly.

#### Build-Time Secrets

Docker layer history is permanent. Deleting a file in a later `RUN` step does not remove it from the layer where it was created — the secret is still extractable from the intermediate layer.

```dockerfile
# BAD — the token is baked into the layer history permanently
RUN pip install --extra-index-url https://token:$TOKEN@private.pypi.com/simple/ mypackage

# GOOD — BuildKit mounts the secret as a tmpfs; it is never written to any layer
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=pypi_token \
    pip install \
      --extra-index-url https://token:$(cat /run/secrets/pypi_token)@private.pypi.com/simple/ \
      mypackage
```

```bash
# Pass the secret at build time — file is not copied into the image
DOCKER_BUILDKIT=1 docker build --secret id=pypi_token,src=./pypi_token.txt .
```

**Gotcha:** `ARG` values are visible in `docker history` even if you never use `ENV`. Never pass secrets via `ARG TOKEN=...`. Use BuildKit secrets or multi-stage builds where the secret-consuming stage is discarded.

---

### Kubernetes SecurityContext

`SecurityContext` translates directly into Linux kernel security controls applied to the container process. There are two scopes: **pod-level** (applies to all containers in the pod) and **container-level** (overrides pod-level for that specific container).

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  template:
    spec:
      # Pod-level: applies to all containers unless overridden
      securityContext:
        runAsNonRoot: true          # admission rejects if the effective UID resolves to 0
        runAsUser: 1000             # UID the container process runs as
        runAsGroup: 3000            # GID
        fsGroup: 2000               # mounted volumes are owned by this GID
        seccompProfile:
          type: RuntimeDefault      # applies the container runtime's default seccomp filter
                                    # blocks ~300 rarely used syscalls (ptrace, mount, etc.)

      containers:
        - name: app
          image: myapp:latest
          securityContext:
            allowPrivilegeEscalation: false   # prevents setuid binaries from gaining root
            readOnlyRootFilesystem: true       # any write to / fails with EROFS
            capabilities:
              drop:
                - ALL                          # start from zero capabilities
              add:
                - NET_BIND_SERVICE             # re-add only what this container specifically needs

          volumeMounts:
            - name: tmp
              mountPath: /tmp                  # app needs a writable temp directory
            - name: varrun
              mountPath: /var/run              # some apps write PID files here

      volumes:
        - name: tmp
          emptyDir:
            medium: Memory    # backed by tmpfs — survives only for pod lifetime, not on disk
        - name: varrun
          emptyDir: {}
```

| Field | What it controls | Recommended value |
|---|---|---|
| `runAsNonRoot` | Admission rejects root-UID images | `true` |
| `runAsUser` | Process UID | Match the UID created in Dockerfile |
| `allowPrivilegeEscalation` | `no_new_privs` flag on the process | `false` |
| `readOnlyRootFilesystem` | Mount root as read-only | `true` |
| `capabilities.drop` | Linux capabilities removed | `["ALL"]` |
| `seccompProfile.type` | Syscall filtering profile | `RuntimeDefault` |
| `privileged` | Full host access — container has nearly host-root | `false` (never true in prod) |
| `hostPID` / `hostNetwork` | Share host PID namespace or network stack | `false` |

**Gotcha:** `runAsNonRoot: true` at the pod level does not prevent a root-built image from running if the container-level `runAsUser` is set to a non-zero UID. The check is on the effective UID at runtime, not the `USER` instruction in the Dockerfile. Set both for defense in depth.

**Gotcha:** `readOnlyRootFilesystem: true` will break any application that writes to `/tmp`, `/var/run`, log files in `/var/log`, or socket files without a corresponding writable volume mount. Audit your application's write paths before enabling this — run the container locally with `--read-only` and observe failures before deploying.

**Gotcha:** `capabilities.drop: [ALL]` removes `NET_RAW` by default, which breaks `ping` inside the container. This is intentional — `NET_RAW` is also used for packet crafting attacks. Only re-add capabilities you have verified are required by the application.

---

### PodSecurityAdmission

PodSecurityAdmission (PSA) replaced the deprecated PodSecurityPolicy in Kubernetes 1.25. It enforces security standards at the **namespace level** using labels — no webhook or CRD required. It is built into the kube-apiserver as an admission plugin.

PSA applies one of three profiles to pods at admission time:

| Profile | What it permits | Use case |
|---|---|---|
| `privileged` | Everything, including privileged containers and host namespaces | System components, CNI plugins, node agents |
| `baseline` | Blocks host namespaces, privileged mode, hostPath volumes with dangerous paths | General workloads migrating off legacy configs |
| `restricted` | Requires non-root, no privilege escalation, seccomp enabled, all capabilities dropped | New applications, production namespaces |

Each profile can be applied in three modes:

| Mode | Effect |
|---|---|
| `enforce` | Pod is rejected if it violates the policy |
| `warn` | Pod is admitted but a warning is printed in `kubectl` output |
| `audit` | Pod is admitted but the violation is recorded in the audit log |

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # enforce: rejects pods that violate the policy
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.29

    # warn: allows the pod but prints a warning to kubectl output
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.29

    # audit: allows the pod but logs the violation to the audit log
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.29
```

**Recommended rollout strategy:** start with `warn` and `audit` on `restricted` while leaving `enforce` on `baseline`. This lets you observe what would break without disrupting running workloads. Fix violations namespace by namespace, then promote `enforce` to `restricted`.

```bash
# Dry-run: check what pods in a namespace would be rejected by 'restricted'
# without changing any labels
kubectl label namespace production \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.29 \
  --dry-run=server

# Check events and warnings after applying warn mode
kubectl get events -n production --field-selector reason=FailedCreate
```

**Gotcha:** PSA applies to pods directly, not to Deployments or StatefulSets. A Deployment that creates a non-compliant pod will be accepted by the API server (the Deployment object itself is valid), but the ReplicaSet will fail to create pods and you will see `Error creating: pods is forbidden` in the ReplicaSet events — not on the Deployment itself. Always check ReplicaSet events when pods are missing after a deployment.

**Gotcha:** The `kube-system` namespace cannot be set to `restricted` because system components such as `kube-proxy` and `coredns` require capabilities or host access that violate the profile. Leave `kube-system` at `privileged` and enforce `restricted` on application namespaces.

#### When PSA Is Not Enough

PSA is namespace-scoped and profile-based — it cannot express fine-grained rules like "only images from our internal registry" or "no containers with `hostPath` volumes pointing to `/etc`". For those use cases, use a policy engine:

| Tool | Mechanism | Policy language | Mutating support |
|---|---|---|---|
| **OPA/Gatekeeper** | Validating/Mutating webhook | Rego | Yes |
| **Kyverno** | Validating/Mutating webhook | YAML/JMESPath | Yes |
| **Kubewarden** | Validating webhook | Wasm policies | Yes |

---

### Network Policies

By default, Kubernetes applies no network restrictions: every pod can reach every other pod across all namespaces. `NetworkPolicy` resources add firewall rules enforced by the CNI plugin. **Network policies are additive** — a pod with no NetworkPolicy selecting it has unrestricted traffic; once any policy selects a pod, only traffic explicitly permitted by a policy is allowed.

**Gotcha:** NetworkPolicy requires a CNI plugin that implements it. `kubenet` (common in basic setups) and the AWS VPC CNI (without the Network Policy Controller add-on) do not enforce NetworkPolicy objects — they are silently ignored. Verify your CNI supports it before relying on policies for security. Calico, Cilium, and Weave Net all support NetworkPolicy.

```yaml
# Step 1: Default-deny all ingress and egress for the namespace.
# This is the baseline — add explicit allow policies on top.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}     # empty selector matches all pods in the namespace
  policyTypes:
    - Ingress
    - Egress
---
# Step 2: Allow the app pods to receive traffic from the ingress controller only.
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
# Step 3: Allow the app to reach postgres on port 5432, and allow DNS.
# Without the DNS rule, service discovery breaks and the app cannot resolve
# Kubernetes service names like 'postgres.production.svc.cluster.local'.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-app-egress
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
    - ports:                  # DNS — must allow both UDP and TCP for large responses
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

**Gotcha:** Forgetting the DNS egress rule is the most common NetworkPolicy mistake. After applying a default-deny egress policy, DNS lookups fail silently, causing connection timeouts that look like application bugs. Always include port 53 UDP and TCP in egress policies.

**Gotcha:** `namespaceSelector` and `podSelector` in the same `from` entry are ANDed — both conditions must be true. If you put them in separate list items (using `-`), they are ORed. The difference is easy to miss:

```yaml
# AND — pod must be in the ingress-nginx namespace AND have label role=proxy
from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: ingress-nginx
    podSelector:
      matchLabels:
        role: proxy

# OR — pod is in ingress-nginx namespace, OR pod has label role=proxy (any namespace)
from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: ingress-nginx
  - podSelector:
      matchLabels:
        role: proxy
```

---

## Examples

### Example 1: Hardened Python API — Full Build and Scan

This example builds a hardened image, scans it, and verifies the scan result before pushing.

```dockerfile
# syntax=docker/dockerfile:1
# Dockerfile

FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
WORKDIR /app

# Install only the runtime OS dependency (no build tools in final image)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy application dependencies from builder stage — no pip in final image
COPY --from=builder /install /usr/local
COPY . .

# Create a locked-down user; no home directory, no shell
RUN groupadd -r appuser && \
    useradd -r -g appuser --no-create-home --shell /sbin/nologin appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
# Build
DOCKER_BUILDKIT=1 docker build -t myapp:latest .

# Scan — fail the build if any unfixed CRITICAL or HIGH CVE is present
trivy image \
  --exit-code 1 \
  --severity CRITICAL,HIGH \
  --ignore-unfixed \
  --format table \
  myapp:latest

# Verify the process does NOT run as root
docker run --rm myapp:latest whoami
# Expected output: appuser

# Verify root filesystem is writable by checking what happens when we try to write
# (This test is done at runtime; readOnlyRootFilesystem is set in Kubernetes, not Docker)
docker run --rm --read-only myapp:latest sh -c "touch /test" 2>&1
# Expected output: touch: /test: Read-only file system
```

---

### Example 2: Kubernetes Deployment with Full Security Hardening

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
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
      automountServiceAccountToken: false   # opt out of default SA token mount
                                             # unless the app calls the Kubernetes API
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 3000
        fsGroup: 2000
        seccompProfile:
          type: RuntimeDefault

      containers:
        - name: app
          image: myregistry.io/myapp:1.2.3  # always use a digest or immutable tag in prod
          ports:
            - containerPort: 8000
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /ready
              port: 8000
            initialDelaySeconds: 5
            periodSeconds: 10

      volumes:
        - name: tmp
          emptyDir:
            medium: Memory
```

```bash
# Apply and verify
kubectl apply -f k8s/deployment.yaml

# Confirm pods are running (not stuck in pending due to PSA violations)
kubectl get pods -n production

# Check if any PSA violations were generated
kubectl get events -n production --field-selector reason=FailedCreate

# Inspect the actual SecurityContext applied to a running pod
kubectl get pod -n production -l app=myapp -o jsonpath='{.items[0].spec.containers[0].securityContext}' | jq .
```

---

### Example 3: Namespace Isolation with PSA and NetworkPolicy

```bash
# Create the namespace with PSA labels
kubectl create namespace production
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.29 \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.29 \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=v1.29
```

```yaml
# k8s/netpol.yaml — apply after namespace creation
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-app-ingress
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
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-app-egress
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
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

```bash
kubectl apply -f k8s/netpol.yaml

# Verify NetworkPolicies are in place
kubectl get networkpolicies -n production

# Test isolation: exec into the app pod and confirm it cannot reach the internet
kubectl exec -n production deploy/myapp -- curl --max-time 5 https://example.com
# Expected: curl: (28) Connection timed out

# Confirm it CAN reach postgres (adjust IP to actual pod IP)
kubectl exec -n production deploy/myapp -- nc -zv postgres 5432
# Expected: Connection to postgres 5432 port [tcp/postgresql] succeeded!
```

---

### Example 4: Detecting Misconfigurations Before Deployment with Trivy

```bash
# Scan all Kubernetes manifests in the k8s/ directory for security misconfigurations
# This catches missing securityContext, privileged containers, hostPath volumes, etc.
trivy config \
  --severity CRITICAL,HIGH,MEDIUM \
  --exit-code 1 \
  ./k8s/

# Scan the Dockerfile itself for hardening gaps
trivy config ./Dockerfile

# Example: trivy config output will flag issues like:
# Dockerfile (dockerfile)
# Tests: 23 (SUCCESSES: 20, FAILURES: 3, EXCEPTIONS: 0)
# MEDIUM: Specify at least 1 USER command in Dockerfile
# HIGH: Do not use --privileged flag with docker run
# ...

# Generate a report in JSON format for integration with a security dashboard
trivy config --format json --output misconfig-report.json ./k8s/

# Integrate into a pre-commit hook so engineers catch issues locally
# .pre-commit-config.yaml:
# - repo: https://github.com/aquasecurity/trivy
#   rev: v0.50.0
#   hooks:
#     - id: trivy-config
#       args: ["--severity", "CRITICAL,HIGH", "--exit-code", "1"]
```

---

## Exercises

### Exercise 1: Harden a Vulnerable Dockerfile

You are given the following Dockerfile. Identify every security problem and fix it.

```dockerfile
FROM ubuntu:latest

RUN apt-get update && apt-get install -y python3 python3-pip curl wget net-tools

COPY . /app
WORKDIR /app

RUN pip3 install -r requirements.txt

ENV DB_PASSWORD=supersecret123

CMD ["python3", "app.py"]
```

Tasks:
1. Replace the base image with a minimal alternative appropriate for a Python app.
2. Remove unnecessary packages (`curl`, `wget`, `net-tools`).
3. Add a non-root user and switch to it before `CMD`.
4. Remove the hardcoded secret — use a BuildKit secret mount instead.
5. Add a `.dockerignore` that prevents `.env` files and `__pycache__` from being copied.
6. Scan the original and fixed images with `trivy image` and compare CVE counts.

---

### Exercise 2: Write a SecurityContext from Scratch

Deploy a pod running `nginx:alpine` with the following requirements enforced via SecurityContext:
- Process must not run as root.
- Filesystem must be read-only.
- All Linux capabilities must be dropped; add back only `NET_BIND_SERVICE`.
- Privilege escalation must be disabled.
- A RuntimeDefault seccomp profile must be applied.
- nginx writes to `/var/cache/nginx` and `/var/run` — add the necessary writable volume mounts.

After deploying, verify:
```bash
# The process UID should be non-zero
kubectl exec <pod-name> -- id

# Writing to / should fail
kubectl exec <pod-name> -- touch /testfile

# Writing to /var/cache/nginx should succeed
kubectl exec <pod-name> -- touch /var/cache/nginx/testfile
```

---

### Exercise 3: Apply and Test Network Policies

Set up a two-pod environment: a `frontend` pod and a `backend` pod in the same namespace.

1. Confirm that `frontend` can reach `backend` before any NetworkPolicy is applied.
2. Apply a default-deny-all NetworkPolicy to the namespace.
3. Confirm that `frontend` can no longer reach `backend`.
4. Write and apply a NetworkPolicy that allows only `frontend` to reach `backend` on port 8080.
5. Confirm the targeted traffic is allowed and that an unrelated `test` pod cannot reach `backend`.

Include the DNS egress rule and explain why omitting it would break service discovery.

---

### Exercise 4: Scan and Enforce with PSA

1. Create a namespace `test-psa` and set `warn` mode to `restricted`.
2. Apply the following pod spec and observe the warning output:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: insecure-pod
  namespace: test-psa
spec:
  containers:
    - name: app
      image: nginx:alpine
      securityContext:
        privileged: true
```

3. List every PSA violation the warning reports.
4. Fix the pod spec so it complies with the `restricted` profile (you will need to handle nginx's default root requirement — use `runAsUser: 101`, which is the `nginx` user in the Alpine image).
5. Change the namespace label from `warn` to `enforce: restricted` and verify the original insecure spec is now rejected at admission.
6. Apply the fixed spec and confirm it is accepted.

---

### Quick Checks

7. Count how many `USER` instructions appear in this Dockerfile snippet. A secure image should have at least one non-root user switch.

```bash
printf 'FROM ubuntu:20.04\nRUN apt-get update\nUSER appuser\n' | grep -c '^USER'
```

```expected_output
1
```

hint: Think about which command searches for specific text patterns within a file and can count occurrences.
hint: Use grep -c '^USER' Dockerfile to count lines that begin with the USER instruction.

8. Check whether this image reference uses a floating tag. Print `unpinned` if it does, `pinned` if it doesn't.

```bash
echo "nginx:latest" | grep -q ':latest' && echo "unpinned" || echo "pinned"
```

```expected_output
unpinned
```
hint: Think about what makes an image reference 'floating' versus 'pinned' — consider how image tags like `latest` or a version name differ from a digest-based reference.
hint: Use a shell conditional or grep to check whether the image reference string contains a digest (the `@sha256:` pattern); if it lacks one, echo the appropriate result.

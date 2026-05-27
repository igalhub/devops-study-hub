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
docker scout quickview myapp:latest          # summary: critical/high/medium/low counts
docker scout cves myapp:latest               # full CVE list with fix versions
docker scout compare myapp:v1.1 --to myapp:v1.0   # diff vulnerabilities between versions
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

**Gotcha:** `EXPOSE` does not publish the port — it is documentation only. Ports below 1024 require `CAP_NET_BIND_SERVICE`. If your app binds to port 80 or 443, either change it to 8080/8443 (preferred) or grant the capability explicitly in the SecurityContext.

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

**Gotcha:** `.env` files containing secrets are commonly leaked into images via `COPY . .`. Always include `.env*` in `.dockerignore`, and verify with `docker history myapp:latest` that secrets are not present in any layer.

#### Build-Time Secrets

Docker layer history is permanent. Deleting a file in a later `RUN` step does not remove it from the layer where it was created.

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
        runAsNonRoot: true          # admission webhook rejects if image runs as root
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

      volumes:
        - name: tmp
          emptyDir:
            medium: Memory    # backed by tmpfs — survives only for pod lifetime, not on disk
```

| Field | What it controls | Recommended value |
|---|---|---|
| `runAsNonRoot` | Admission rejects root-UID images | `true` |
| `runAsUser` | Process UID | Match the UID created in Dockerfile |
| `allowPrivilegeEscalation` | `no_new_privs` flag on the process | `false` |
| `readOnlyRootFilesystem` | Mount root as read-only | `true` |
| `capabilities.drop` | Linux capabilities removed | `["ALL"]` |
| `seccompProfile.type` | Syscall filtering profile | `RuntimeDefault` |
| `privileged` | Full host access — container has nearly host-root | `false` (never set true in prod) |

**Gotcha:** `runAsNonRoot: true` at the pod level does not prevent a root-built image from running if the container-level `runAsUser` is set to a non-zero UID. The check is on the effective UID at runtime, not the `USER` instruction in the Dockerfile. Set both for defense in depth.

**Gotcha:** `readOnlyRootFilesystem: true` will break any application that writes to `/tmp`, `/var/run`, or log files in `/var/log` without a corresponding writable volume mount. Audit your application's write paths before enabling this.

---

### PodSecurityAdmission

PodSecurityAdmission (PSA) replaced the deprecated PodSecurityPolicy in Kubernetes 1.25. It enforces security standards at the **namespace level** using labels — no webhook or CRD required.

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

| Profile | What it permits | Use case |
|---|---|---|
| `privileged` | Everything, including privileged containers | System components, CNI plugins |
| `baseline` | Blocks host namespaces, privileged mode, hostPath volumes | General workloads migrating off legacy configs |
| `restricted` | Requires non-root, no privilege escalation, seccomp enabled, all capabilities dropped | New applications, production namespaces |

**Recommended rollout strategy:** start with `warn` and `audit` on `restricted` while leaving `enforce` on `baseline`. This lets you see what would break without disrupting workloads. Fix violations, then promote `enforce` to `restricted`.

**Gotcha:** PSA applies to pods directly, not to Deployments or StatefulSets. A Deployment that creates a non-compliant pod will be accepted by the API server (Deployment is valid), but the ReplicaSet will fail to create pods and you will see `Error creating: pods is forbidden` in the ReplicaSet events — not on the Deployment itself.

---

### Network Policies

By default, Kubernetes applies no network restrictions: every pod can reach every other pod across all namespaces. `NetworkPolicy` resources add firewall rules enforced by the CNI plugin. **Network policies are additive** — a pod with no NetworkPolicy selecting it has unrestricted traffic; once any policy selects a pod, only traffic explicitly permitted by a policy is allowed.

**Gotcha:** NetworkPolicy requires a CNI plugin that implements it. `kubenet` (common in basic setups) and the AWS VPC CNI (without the Network Policy Controller add-on) do not enforce NetworkPolicy objects — they are silently ignored. Verify your CNI supports it. Calico, Cilium, and Weave Net all support NetworkPolicy.

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
# Step 3: Allow the app to reach postgres, and allow DNS (required for service discovery).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-app-eg
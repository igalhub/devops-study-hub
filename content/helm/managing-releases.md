---
title: Managing Releases
module: helm
duration_min: 15
difficulty: intermediate
tags: [helm, releases, upgrade, rollback, repositories, install]
exercises: 4
---

## Overview

A Helm **release** is a named, tracked instance of a chart deployed into a Kubernetes cluster. The same chart can be installed multiple times under different release names — one release per environment, or one per tenant in a multi-tenant system — each with its own configuration and independently managed lifecycle. Helm stores release metadata as Secrets in the target namespace (by default), which means release state is cluster-native and survives Helm client restarts without any external database.

The core design principle behind Helm's release model is atomic, revisioned deployments. Every `install` or `upgrade` creates a new revision. Helm renders the chart templates with the supplied values, applies the resulting manifests to the cluster, and either declares success (all resources healthy) or rolls back automatically if you've used `--atomic`. This is a deliberate departure from `kubectl apply`, which is stateless — Helm knows what was deployed before and can diff, upgrade, and revert it.

In the broader DevOps toolchain, Helm sits between your CI/CD pipeline and the Kubernetes API. Source code is built into images by CI; Helm is the mechanism by which a specific image version, combined with environment-specific configuration, becomes a live deployment. Tools like ArgoCD, Flux, and Spinnaker all have first-class Helm integrations, making release management a foundational Helm skill regardless of which deployment platform you ultimately use.

---

## Concepts

### What Helm Tracks Per Release

Understanding what Helm stores for each release prevents surprises when upgrading or debugging.

| Stored Data | Where | How to Access |
|---|---|---|
| Chart metadata (name, version) | Kubernetes Secret | `helm history <release>` |
| Rendered manifests | Kubernetes Secret | `helm get manifest <release>` |
| User-supplied values | Kubernetes Secret | `helm get values <release>` |
| All values (defaults + user) | Kubernetes Secret | `helm get values <release> --all` |
| NOTES.txt output | Kubernetes Secret | `helm get notes <release>` |
| Release status | Kubernetes Secret | `helm status <release>` |

Helm creates one Secret per revision. A release with 10 upgrades has 10 Secrets. By default Helm retains the last 10 revisions; you can change this with `--history-max` on `upgrade`.

**Gotcha:** if someone deletes the Helm Secrets manually (or the namespace is wiped), Helm loses all knowledge of the release even though the Kubernetes resources may still exist. In that scenario, `helm list` shows nothing but the Pods, Services, and Deployments are still running. Use `helm install` with a fresh release name, or rescue with `helm upgrade --install` which will adopt orphaned resources if the names match.

---

### Release Lifecycle Commands

Every stage of a release has an explicit command. Knowing when to use each one is a common interview topic.

```bash
# First deployment of a chart — fails if release already exists
helm install <release-name> <chart> [flags]

# Modify an existing release — fails if release does NOT exist
helm upgrade <release-name> <chart> [flags]

# Idempotent form: install if missing, upgrade if present
# Use this in CI/CD pipelines — it always does the right thing
helm upgrade --install <release-name> <chart> [flags]

# Remove a release and all of its Kubernetes resources
helm uninstall <release-name> -n <namespace>

# Remove the resources but preserve the history Secrets
# Useful for debugging or if you want to re-install without losing audit trail
helm uninstall <release-name> --keep-history -n <namespace>
```

**Gotcha — namespace is not optional in production:** Helm commands default to the `default` namespace unless `--namespace` / `-n` is specified. A missing `-n` flag against a production cluster is a common operational mistake. Always be explicit.

---

### Key Flags for install / upgrade

These flags appear in nearly every real-world Helm invocation. Know what each one does.

| Flag | Effect | When to Use |
|---|---|---|
| `--values file.yaml` / `-f` | Load values from a YAML file | Always — keep config in files, not inline |
| `--set key=value` | Override a single value inline | Image tags, secrets injected by CI |
| `--set-string key=value` | Force value to be a string | Version numbers like `"1.0"` that YAML parses as floats |
| `--namespace` / `-n` | Target namespace | Every command |
| `--create-namespace` | Create namespace if missing | First deploy to a new environment |
| `--atomic` | Auto-rollback on failure | CI/CD pipelines — prevents broken releases |
| `--wait` | Block until pods are ready | When you need a health-checked deploy |
| `--timeout 5m` | Override readiness wait | Charts with slow startup (Kafka, large DBs) |
| `--dry-run` | Render + validate without applying | Pre-flight checks, PR reviews |
| `--debug` | Print rendered manifests + verbose logs | Diagnosing template rendering issues |
| `--history-max N` | Max revisions to retain | Avoid unbounded Secret accumulation |

```bash
# Fully annotated production upgrade command
helm upgrade --install myapp ./charts/myapp \
    --namespace production \
    --create-namespace \
    --values values/base.yaml \        # shared defaults
    --values values/production.yaml \  # env-specific overrides
    --set image.tag="${GIT_SHA}" \     # injected by CI — string, not a file
    --atomic \                         # rollback automatically on failure
    --wait \                           # wait for all pods Ready
    --timeout 5m \                     # charts with longer startup times may need more
    --history-max 20                   # keep enough history for forensics
```

**`--atomic` implies `--wait`** — you do not need both, but specifying `--wait` explicitly with a custom `--timeout` alongside `--atomic` is valid and common.

---

### Values Precedence (low → high)

When multiple value sources conflict, Helm applies them in a defined order. Misunderstanding this is the #1 source of "why isn't my value taking effect?" bugs.

```
1. Chart's own values.yaml         ← lowest priority (chart defaults)
2. Parent chart's values.yaml      ← for subcharts / chart dependencies
3. --values file1.yaml             ← files are merged left to right
4. --values file2.yaml             ← file2 overrides file1 for same key
5. --set key=value                 ← highest priority (always wins)
```

```bash
# Practical example: base.yaml sets replicaCount: 1
# production.yaml sets replicaCount: 3
# --set overrides both to 5

helm upgrade myapp ./charts/myapp \
    -f values/base.yaml \
    -f values/production.yaml \
    --set replicaCount=5
# Result: replicaCount=5
```

**Deep merge vs override:** Helm does a deep merge on YAML maps. If `base.yaml` sets `resources.requests.memory: 256Mi` and `production.yaml` sets `resources.limits.memory: 512Mi`, both values survive — they are not competing at the map level. Only leaf-level key conflicts are resolved by precedence.

---

### Viewing and Inspecting Releases

Observability into what Helm has deployed is critical for debugging production issues.

```bash
# List releases — scope by namespace or all namespaces
helm list -n production
helm list -A                              # across all namespaces

# Full release status — shows deployment state and NOTES output
helm status myapp -n production

# What values are active? (only user-supplied values)
helm get values myapp -n production

# All values including chart defaults
helm get values myapp -n production --all

# The actual Kubernetes manifests that were applied
helm get manifest myapp -n production

# Parse specific resources from the manifest output
helm get manifest myapp -n production | kubectl get -f -

# History of all revisions
helm history myapp -n production
# REVISION  UPDATED               STATUS      CHART          APP VERSION  DESCRIPTION
# 1         2024-01-10 09:00:00   superseded  myapp-0.1.0    1.0.0        Install complete
# 2         2024-01-15 14:30:00   superseded  myapp-0.2.0    1.1.0        Upgrade complete
# 3         2024-01-20 16:00:00   deployed    myapp-0.2.0    1.1.0        Rollback to 2
```

**Reading `helm history` output:** the `STATUS` column tells the full story. `superseded` means this revision was replaced by a later one. `failed` means the upgrade was attempted but did not reach a healthy state. `deployed` is the currently active revision. `pending-upgrade` or `pending-install` means a deploy is in progress or was interrupted.

---

### Rollback

Helm's rollback mechanism re-applies the rendered manifests from a previous revision. It creates a **new revision** rather than deleting the current one — the history is always append-only.

```bash
# Roll back to the immediately previous revision
helm rollback myapp -n production

# Roll back to a specific revision number (from helm history)
helm rollback myapp 1 -n production

# Wait for the rollback to complete before returning
helm rollback myapp 1 -n production --wait --timeout 3m

# Dry-run a rollback to see what would change
helm rollback myapp 1 -n production --dry-run
```

**What rollback does and doesn't do:**
- ✅ Re-applies the Kubernetes manifests from revision N
- ✅ Creates a new history entry (revision N+1) with description `Rollback to N`
- ✅ Works with `--wait` for health checking
- ❌ Does **not** roll back PersistentVolumeClaims or any data stored in volumes
- ❌ Does **not** roll back external state (database migrations, secrets in Vault)

**Schema migration warning:** if revision 2 ran a database migration that is not backward-compatible with revision 1's application code, a rollback will break the application. Helm is unaware of out-of-cluster state. Design migrations to be backward-compatible with at least the previous application version.

---

### Working with Repositories

Helm repositories are HTTP(S) servers that serve an `index.yaml` (a catalog of all available charts and versions) and `.tgz` chart archives.

```bash
# Add commonly used public repositories
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add cert-manager https://charts.jetstack.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts

# Fetch updated index from all remotes — run this before searching or installing
helm repo update

# List configured repositories
helm repo list

# Search the local index cache (requires repo update first)
helm search repo postgresql
helm search repo bitnami/postgresql
helm search repo bitnami/postgresql --versions   # all published versions

# Inspect a chart before installing — critical for understanding what you're deploying
helm show chart bitnami/postgresql               # chart metadata
helm show values bitnami/postgresql              # all configurable values with defaults
helm show readme bitnami/postgresql              # full README

# Save the default values to a file, then customize
helm show values bitnami/postgresql > pg-values.yaml
# Edit pg-values.yaml, then install with -f pg-values.yaml
```

**Always `helm repo update` before installing.** The local index cache can be days or weeks old in a long-running dev environment. Installing without updating may pull an outdated chart or fail to find a newly published version.

| Command | What It Fetches | Requires `repo update`? |
|---|---|---|
| `helm search repo` | Local cache | Yes — stale cache = stale results |
| `helm show values` | Downloads from remote | No — fetches live |
| `helm install` / `upgrade` | Downloads from remote | No — fetches live |
| `helm pull` | Downloads `.tgz` to disk | No — fetches live |

---

### OCI Registries (Helm 3.8+)

OCI registries (Docker Hub, ECR, GCR, GHCR, Harbor) can host Helm charts alongside container images. This eliminates the need to maintain a separate Helm repository server and integrates chart storage into your existing image registry workflows.

```bash
# Authenticate to an OCI registry (ECR example)
aws ecr get-login-password --region us-east-1 \
    | helm registry login \
        --username AWS \
        --password-stdin \
        123456789.dkr.ecr.us-east-1.amazonaws.com

# Package a local chart into a .tgz
helm package ./mychart

# Push to OCI registry
helm push mychart-0.1.0.tgz oci://123456789.dkr.ecr.us-east-1.amazonaws.com/charts

# Install directly from OCI — version is required (no "latest" concept)
helm install myapp \
    oci://123456789.dkr.ecr.us-east-1.amazonaws.com/charts/mychart \
    --version 0.1.0 \
    -n production

# Upgrade from OCI
helm upgrade myapp \
    oci://123456789.dkr.ecr.us-east-1.amazonaws.com/charts/mychart \
    --version 0.2.0 \
    -n production --atomic

# Inspect without installing
helm show values oci://123456789.dkr.ecr.us-east-1.amazonaws.com/charts/mychart --version 0.1.0
```

**OCI vs traditional repos:**

| Feature | Traditional Repo | OCI Registry |
|---|---|---|
| Discovery | `helm search repo` | Registry UI / API only |
| Auth | Basic auth or token | Standard registry auth (OIDC, IAM) |
| Versioning | `index.yaml` | Image tags + manifest digest |
| `helm repo add` required | Yes | No |
| Works with Harbor, ECR, GHCR | Varies | Yes |

**OCI gotcha:** you cannot `helm search` an OCI registry the way you can a traditional repo. There is no `index.yaml`. You must know the chart name and version in advance — typically enforced by your CI pipeline tagging charts on publish.

---

### CI/CD Pipeline Pattern

The canonical Helm usage in a CI/CD pipeline combines several concepts into a single idempotent script.

```bash
#!/usr/bin/env bash
set -euo pipefail   # exit on error, unset variable, pipe failure

RELEASE="myapp"
NAMESPACE="production"
CHART="./charts/myapp"
# Use git SHA for exact traceability — ties the running version to a commit
VERSION=$(git rev-parse --short HEAD)

helm repo update   # refresh index if using remote charts

helm upgrade --install "$RELEASE" "$CHART" \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --values "values/base.yaml" \
    --values "values/production.yaml" \
    --set "image.tag=${VERSION}" \
    --atomic \          # rolls back automatically if pods don't become Ready
    --timeout 5m \
    --history-max 20    # avoid unbounded Secret accumulation over many deploys
```

**Why `--atomic` is non-negotiable in CI:** without it, a failed upgrade leaves the release in `failed` state. The old pods continue running (Kubernetes doesn't evict them), but Helm considers the upgrade done. The next `helm upgrade` will succeed structurally even though the application is broken. With `--atomic`, a failure automatically triggers a rollback, the pipeline exits non-zero, and the previously healthy revision stays active.

---

## Examples

### Example 1: Installing and Upgrading PostgreSQL from Bitnami

A full workflow for deploying a production-grade PostgreSQL instance using a public chart.

```bash
# Step 1: Add and update the Bitnami repo
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Step 2: Inspect default values and save as a starting point
helm show values bitnami/postgresql > pg-values.yaml

# Step 3: Edit pg-values.yaml — key overrides for a production-like setup
cat > pg-overrides.yaml <<'EOF'
auth:
  database: appdb
  username: appuser
  # passwords should come from --
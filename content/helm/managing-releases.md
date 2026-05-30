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

**Secret storage vs ConfigMap storage:** by default, Helm uses Secrets (base64-encoded) to store release data. You can switch to ConfigMaps or an SQL backend via the `HELM_DRIVER` environment variable (`secret`, `configmap`, `sql`, `memory`). Secrets are the default because they can be RBAC-restricted separately from ConfigMaps, which matters if your release values contain passwords or API keys.

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

**`helm install` vs `helm upgrade --install`:** in a fresh environment (new cluster, new namespace), `helm install` is fine. In any automated context where the environment may or may not already exist — CI/CD, GitOps reconciliation, IaC pipelines — always use `helm upgrade --install`. It is safe to run repeatedly; `helm install` is not.

---

### Key Flags for install / upgrade

These flags appear in nearly every real-world Helm invocation. Know what each one does.

| Flag | Effect | When to Use |
|---|---|---|
| `--values file.yaml` / `-f` | Load values from a YAML file | Always — keep config in files, not inline |
| `--set key=value` | Override a single value inline | Image tags, secrets injected by CI |
| `--set-string key=value` | Force value to be a string | Version numbers like `"1.0"` that YAML parses as floats |
| `--set-json key=json` | Pass a raw JSON value | Complex nested structures from CI env vars |
| `--namespace` / `-n` | Target namespace | Every command |
| `--create-namespace` | Create namespace if missing | First deploy to a new environment |
| `--atomic` | Auto-rollback on failure | CI/CD pipelines — prevents broken releases |
| `--wait` | Block until pods are ready | When you need a health-checked deploy |
| `--timeout 5m` | Override readiness wait | Charts with slow startup (Kafka, large DBs) |
| `--dry-run` | Render + validate without applying | Pre-flight checks, PR reviews |
| `--debug` | Print rendered manifests + verbose logs | Diagnosing template rendering issues |
| `--history-max N` | Max revisions to retain | Avoid unbounded Secret accumulation |
| `--force` | Force resource replacement | When strategic merge patch fails |
| `--cleanup-on-fail` | Delete new resources on failure | Keeps cluster clean when `--atomic` is not used |

```bash
# Fully annotated production upgrade command
helm upgrade --install myapp ./charts/myapp \
    --namespace production \
    --create-namespace \
    --values values/base.yaml \           # shared defaults across all envs
    --values values/production.yaml \     # env-specific overrides (replicas, resources)
    --set image.tag="${GIT_SHA}" \        # injected by CI — exact commit traceability
    --atomic \                            # rollback automatically on failure
    --timeout 5m \                        # charts with longer startup times may need more
    --history-max 20                      # keep enough history for forensics
```

**`--atomic` implies `--wait`** — you do not need both flags, but specifying `--wait` with a custom `--timeout` alongside `--atomic` is valid: `--atomic` uses the timeout for its own wait, so setting `--timeout` applies to both. Without `--timeout`, the default is 5 minutes.

**`--force` warning:** `--force` deletes and recreates resources rather than patching them. This causes downtime for Deployments and StatefulSets. Only use it when a patch genuinely cannot be applied (e.g., changing an immutable field like a Service's `clusterIP`).

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
# base.yaml sets replicaCount: 1
# production.yaml sets replicaCount: 3
# --set overrides both to 5

helm upgrade myapp ./charts/myapp \
    -f values/base.yaml \
    -f values/production.yaml \
    --set replicaCount=5
# Result: replicaCount=5
```

**Deep merge vs override:** Helm performs a deep merge on YAML maps. If `base.yaml` sets `resources.requests.memory: 256Mi` and `production.yaml` sets `resources.limits.memory: 512Mi`, both values survive — they are not competing at the map level. Only leaf-level key conflicts are resolved by precedence.

**Null overrides:** setting a key to `null` via `--set` removes it from the merged output entirely. This is useful for unsetting a default that cannot be overridden to an empty value.

```bash
# Remove a default toleration set in values.yaml
helm upgrade myapp ./charts/myapp --set tolerations=null
```

---

### Viewing and Inspecting Releases

Observability into what Helm has deployed is critical for debugging production issues.

```bash
# List releases — scope by namespace or all namespaces
helm list -n production
helm list -A                              # across all namespaces

# Filter by status (deployed, failed, superseded)
helm list -A --filter 'failed'

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
```

Example `helm history` output:
```
REVISION  UPDATED               STATUS      CHART          APP VERSION  DESCRIPTION
1         2024-01-10 09:00:00   superseded  myapp-0.1.0    1.0.0        Install complete
2         2024-01-15 14:30:00   superseded  myapp-0.2.0    1.1.0        Upgrade complete
3         2024-01-20 16:00:00   failed      myapp-0.3.0    1.2.0        Upgrade "myapp" failed: timed out
4         2024-01-20 16:05:00   deployed    myapp-0.2.0    1.1.0        Rollback to 2
```

**Reading `helm history` STATUS values:**

| Status | Meaning |
|---|---|
| `deployed` | Currently active revision |
| `superseded` | Was active, replaced by a later revision |
| `failed` | Upgrade attempted but did not reach healthy state |
| `pending-upgrade` | Upgrade in progress, or was interrupted mid-flight |
| `pending-install` | Install in progress, or was interrupted mid-flight |
| `uninstalling` | Uninstall in progress |

**`pending-*` states indicate a stuck release.** If a Helm process was killed mid-deploy, the release can be left in `pending-upgrade`. Subsequent upgrades will fail with "another operation is in progress." Fix with: `helm rollback <release> -n <namespace>` to force a state transition, or manually patch the Secret's status field if rollback itself is blocked.

---

### Rollback

Helm's rollback mechanism re-applies the rendered manifests from a previous revision. It creates a **new revision** rather than deleting the current one — the history is always append-only.

```bash
# Roll back to the immediately previous revision
helm rollback myapp -n production

# Roll back to a specific revision number (from helm history)
helm rollback myapp 2 -n production

# Wait for the rollback to complete before returning
helm rollback myapp 2 -n production --wait --timeout 3m

# Dry-run a rollback to see what would change
helm rollback myapp 2 -n production --dry-run
```

**What rollback does and doesn't do:**

| Action | Included? |
|---|---|
| Re-applies Kubernetes manifests from revision N | ✅ |
| Creates a new history entry (`Rollback to N`) | ✅ |
| Supports `--wait` for health-checking | ✅ |
| Rolls back PersistentVolumeClaims or volume data | ❌ |
| Rolls back external state (DB migrations, Vault secrets) | ❌ |
| Restores container images built at revision N | ✅ (image tag is in the manifest) |

**Schema migration warning:** if revision 3 ran a database migration that is not backward-compatible with revision 2's application code, a rollback to revision 2 will break the application. Helm is unaware of out-of-cluster state. Design migrations to be backward-compatible with at least the previous application version (expand/contract pattern).

**Automatic rollback with `--atomic`:** when you use `--atomic` on `upgrade`, Helm calls the equivalent of `helm rollback` internally if the timeout expires or a hook fails. The difference from a manual rollback is that `--atomic` rolls back to the revision immediately before the failed upgrade, not to an arbitrary revision you choose.

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

# Search the local index cache
helm search repo postgresql
helm search repo bitnami/postgresql --versions   # all published versions

# Inspect a chart before installing
helm show chart bitnami/postgresql               # chart metadata
helm show values bitnami/postgresql              # all configurable values with defaults
helm show readme bitnami/postgresql              # full README

# Save defaults to a file as a starting point for customization
helm show values bitnami/postgresql > pg-values.yaml
```

**Always `helm repo update` before installing.** The local index cache can be days or weeks old in a long-running dev environment. Installing without updating may pull an outdated chart or fail to find a newly published version.

| Command | Fetches From | Requires `repo update`? |
|---|---|---|
| `helm search repo` | Local cache | Yes — stale cache = stale results |
| `helm show values` | Downloads from remote | No — fetches live |
| `helm install` / `upgrade` | Downloads from remote | No — fetches live |
| `helm pull` | Downloads `.tgz` to disk | No — fetches live |

**`helm pull` for air-gapped environments:** in environments without internet access, use `helm pull bitnami/postgresql --version 12.5.6 --untar` on a machine with access, then transfer the chart directory and install from the local path.

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

# Inspect without installing
helm show values oci://123456789.dkr.ecr.us-east-1.amazonaws.com/charts/mychart \
    --version 0.1.0
```

**OCI vs traditional repos:**

| Feature | Traditional Repo | OCI Registry |
|---|---|---|
| Discovery | `helm search repo` | Registry UI / API only |
| Auth | Basic auth or token | Standard registry auth (OIDC, IAM) |
| `helm repo add` required | Yes | No |
| Version enumeration via CLI | Yes | No — must know version in advance |
| Works with Harbor, ECR, GHCR | Varies | Yes |
| Immutable artifact digests | No | Yes (content-addressed) |

**OCI gotcha:** you cannot `helm search` an OCI registry the way you can a traditional repo. There is no `index.yaml`. You must know the chart name and version in advance — typically enforced by your CI pipeline tagging charts on publish with the same version string used in `Chart.yaml`.

---

### CI/CD Pipeline Pattern

The canonical Helm usage in a CI/CD pipeline combines several concepts into a single idempotent, safe deployment script.

```bash
#!/usr/bin/env bash
set -euo pipefail   # exit on error, unset variable, pipe failure

RELEASE="myapp"
NAMESPACE="production"
CHART="./charts/myapp"
# Use git SHA for exact traceability — ties the running version to a specific commit
VERSION=$(git rev-parse --short HEAD)

# Refresh the repo index if using remote charts
helm repo update

helm upgrade --install "$RELEASE" "$CHART" \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --values "values/base.yaml" \
    --values "values/production.yaml" \
    --set "image.tag=${VERSION}" \
    --atomic \          # rolls back automatically if pods don't become Ready
    --timeout 5m \
    --history-max 20    # avoid unbounded Secret accumulation over many deploys

echo "Deployed $RELEASE at revision $(helm history "$RELEASE" -n "$NAMESPACE" --max 1 -o json | jq -r '.[0].revision')"
```

**Why `--atomic` is non-negotiable in CI:** without it, a failed upgrade leaves the release in `failed` state. The old pods continue running (Kubernetes doesn't evict them), but Helm considers the upgrade done. The next `helm upgrade` will succeed structurally even though the application is broken. With `--atomic`, a failure automatically triggers a rollback, the pipeline exits non-zero, and the previously healthy revision stays active.

**Verifying the deploy from CI:**

```bash
# After helm upgrade --install completes, confirm the active revision
helm history "$RELEASE" -n "$NAMESPACE" | tail -1

# Confirm the image tag is what CI injected
helm get values "$RELEASE" -n "$NAMESPACE" | grep tag
```

---

## Examples

### Example 1: Installing and Upgrading PostgreSQL from Bitnami

A full workflow for deploying a production-grade PostgreSQL instance using a public chart.

```bash
# Step 1: Add and update the Bitnami repo
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Step 2: Save default values as a starting point for customization
helm show values bitnami/postgresql > pg-values.yaml

# Step 3: Create a focused overrides file — only change what you need
cat > pg-overrides.yaml <<'EOF'
auth:
  database: appdb
  username: appuser
  # Do NOT put passwords in files committed to version control.
  # Inject via --set from a secrets manager or CI secret.

primary:
  resources:
    requests:
      memory: 512Mi
      cpu: 250m
    limits:
      memory: 1Gi
      cpu: 500m

  persistence:
    enabled: true
    size: 20Gi
    storageClass: "gp3"  # use your cluster's storage class

# Disable the read replica for dev/staging, enable for production
readReplicas:
  replicaCount: 0
EOF

# Step 4: Install with password injected from environment (set by CI/secrets manager)
helm upgrade --install postgres bitnami/postgresql \
    --namespace data \
    --create-namespace \
    --values pg-overrides.yaml \
    --set auth.password="${PG_PASSWORD}" \      # never hardcode passwords
    --set auth.postgresPassword="${PG_ADMIN_PASSWORD}" \
    --atomic \
    --timeout 8m                                # PostgreSQL takes longer than typical apps

# Step 5: Verify the release
helm status postgres -n data
helm get values postgres -n data               # confirm your overrides applied

# Step 6: Connect to verify database is up
kubectl run pg-test --rm -it --restart=Never \
    --image=bitnami/postgresql \
    --env="PGPASSWORD=${PG_PASSWORD}" \
    -- psql -h postgres-postgresql.data.svc.cluster.local -U appuser -d appdb -c "\l"

# Step 7: Simulate an upgrade (e.g., bump chart version)
helm repo update
helm upgrade postgres bitnami/postgresql \
    --namespace data \
    --values pg-overrides.yaml \
    --set auth.password="${PG_PASSWORD}" \
    --set auth.postgresPassword="${PG_ADMIN_PASSWORD}" \
    --atomic \
    --timeout 8m

# Confirm revision incremented
helm history postgres -n data
```

---

### Example 2: Multi-Environment Promotion with Values Layering

A pattern for promoting the same chart across staging and production using environment-specific value files.

```
charts/
  myapp/
values/
  base.yaml        # shared defaults
  staging.yaml     # staging-specific overrides
  production.yaml  # production-specific overrides
```

```yaml
# values/base.yaml
replicaCount: 1
image:
  repository: ghcr.io/myorg/myapp
  tag: latest        # CI will always override this with --set image.tag=$SHA
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 8080

resources:
  requests:
    memory: 128Mi
    cpu: 100m
  limits:
    memory: 256Mi
    cpu: 200m

autoscaling:
  enabled: false
```

```yaml
# values/staging.yaml
replicaCount: 1

ingress:
  enabled: true
  host: myapp.staging.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-staging
```

```yaml
# values/production.yaml
replicaCount: 3

resources:
  requests:
    memory: 256Mi
    cpu: 250m
  limits:
    memory: 512Mi
    cpu: 500m

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

ingress:
  enabled: true
  host: myapp.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

```bash
GIT_SHA=$(git rev-parse --short HEAD)

# Deploy to staging
helm upgrade --install myapp-staging ./charts/myapp \
    --namespace staging \
    --create-namespace \
    --values values/base.yaml \
    --values values/staging.yaml \
    --set image.tag="${GIT_SHA}" \
    --atomic --timeout 3m

# Verify staging — run smoke tests here before promoting

# Deploy the identical SHA to production
helm upgrade --install myapp-prod ./charts/myapp \
    --namespace production \
    --create-namespace \
    --values values/base.yaml \
    --values values/production.yaml \
    --set image.tag="${GIT_SHA}" \    # same SHA as staging — no rebuilds
    --atomic --timeout 5m

# Confirm both releases are at the same app version
helm list -A | grep myapp
```

---

### Example 3: Diagnosing and Recovering a Failed Upgrade

Simulating a broken deployment and recovering it using Helm's history and rollback tools.

```bash
# Current state: revision 3 is deployed and healthy
helm history myapp -n production

# A bad upgrade is attempted (wrong image tag, broken config, etc.)
helm upgrade myapp ./charts/myapp \
    --namespace production \
    --values values/base.yaml \
    --values values/production.yaml \
    --set image.tag="broken-sha" \
    --wait --timeout 2m
# This times out — pods never become Ready

# Check what happened
helm history myapp -n production
# REVISION  STATUS    DESCRIPTION
# 3         superseded  Upgrade complete
# 4         failed      Upgrade "myapp" failed: timed out waiting for condition

# Inspect the failed revision's values to understand what changed
helm get values myapp -n production     # shows revision 4's values (current)
helm get values myapp -n production --revision 3  # shows revision 3's values

# Confirm which revision is actually serving traffic
# (Kubernetes still runs revision 3's pods because the upgrade failed mid-way)
kubectl get pods -n production -l app.kubernetes.io/instance=myapp

# Roll back to the last known good revision
helm rollback myapp 3 -n production --wait --timeout 3m

# Verify recovery
helm history myapp -n production
# REVISION  STATUS      DESCRIPTION
# 3         superseded  Upgrade complete
# 4         failed      ...
# 5         deployed    Rollback to 3

helm status myapp -n production   # should show deployed
```

---

### Example 4: Publishing and Consuming a Chart via OCI (ECR)

End-to-end workflow for a team that stores charts in AWS ECR.

```bash
# --- Publisher side (runs in chart-release CI job) ---

REGISTRY="123456789.dkr.ecr.us-east-1.amazonaws.com"
CHART_DIR="./charts/myapp"

# Bump Chart.yaml version before packaging (or use a script to inject it)
# Chart.yaml must have version: 0.2.0 for the .tgz name to match

helm package "$CHART_DIR"   # produces myapp-0.2.0.tgz

# Authenticate and push
aws ecr get-login-password --region us-east-1 \
    | helm registry login --username AWS --password-stdin "$REGISTRY"

helm push myapp-0.2.0.tgz "oci://${REGISTRY}/helm-charts"

# --- Consumer side (runs in application deploy CI job) ---

REGISTRY="123456789.dkr.ecr.us-east-1.amazonaws.com"
GIT_SHA=$(git rev-parse --short HEAD)

aws ecr get-login-password --region us-east-1 \
    | helm registry login --username AWS --password-stdin "$REGISTRY"

# Inspect values before deploying
helm show values "oci://${REGISTRY}/helm-charts/myapp" --version 0.2.0

# Deploy — version must be explicit (no "latest" in OCI)
helm upgrade --install myapp \
    "oci://${REGISTRY}/helm-charts/myapp" \
    --version 0.2.0 \
    --namespace production \
    --create-namespace \
    --values values/production.yaml \
    --set image.tag="${GIT_SHA}" \
    --atomic \
    --timeout 5m

# Verify the chart version that was deployed
helm list -n production -o json | jq '.[].chart'
# "myapp-0.2.0"
```

---

## Exercises

### Exercise 1: Release Inspection and Values Tracing

Install the `bitnami/nginx` chart into a `lab` namespace with at least two value overrides of your choice (e.g., `replicaCount`, `service.type`). Then:

1. Use `helm get values` to confirm only your overrides appear.
2. Use `helm get values --all` to see the full merged value set.
3. Find the rendered `Service` manifest using `helm get manifest` and pipe it through `kubectl get -f -` to confirm it matches what's running.
4. Run a second `helm upgrade` that changes one value. Use `helm history` to confirm a new revision was created, then use `helm get values --revision 1` to retrieve the original values.

**Goal:** understand the difference between user-supplied and effective values, and how Helm tracks changes across revisions.

---

### Exercise 2: Values Precedence Experiment

Create two YAML files:

```yaml
# a.yaml
replicaCount: 1
image:
  tag: "v1"
  pullPolicy: IfNotPresent
```

```yaml
# b.yaml
replicaCount: 2
image:
  tag: "v2"
```

Install any simple chart (e.g., a local `helm create mytest` chart) using `--dry-run --debug` with various combinations of `-f a.yaml -f b.yaml` and `--set replicaCount=5`. Before running each command, predict the effective value of `replicaCount` and `image.pullPolicy`. Verify your prediction from the rendered YAML in the dry-run output.

**Goal:** internalize the precedence rules and deep-merge behavior without touching a live cluster.

---

### Exercise 3: Simulating a Failed Upgrade and Rolling Back

Using a locally created chart (`helm create myapp`), deploy an initial release. Then simulate a broken upgrade by setting an invalid image repository:

```bash
helm upgrade myapp ./myapp \
    --namespace lab \
    --set image.repository=does-not-exist/broken \
    --set image.tag=latest \
    --wait --timeout 90s
```

After the command fails:

1. Run `helm history` and interpret the STATUS of each revision.
2. Identify the last healthy revision number.
3. Roll back to it with `--wait` and verify the pod returns to Running.
4. Run `helm history` again and explain why the revision count increased rather than decreased.

**Goal:** practice the real incident-response workflow for a failed Helm upgrade.

---

### Exercise 4: CI Script with Idempotency and Verification

Write a shell script (not a one-liner) that:

1. Accept `NAMESPACE` and `IMAGE_TAG` as environment variables with no defaults — fail clearly if either is unset.
2. Run `helm upgrade --install` with `--atomic`, `--timeout 3m`, and `--history-max 10`.
3. After a successful deploy, print the active revision number and the image tag that is running (retrieved via `helm get values`).
4. Run a second time against the same release to confirm idempotency — the revision number should increment by 1 (because `upgrade --install` always creates a new revision even if values are unchanged), and the script should exit 0 both times.

**Goal:** build the habit of writing Helm deployments as safe, self-verifying scripts rather than ad hoc commands. Understand that `upgrade --install` always creates a revision even with no changes — plan `--history-max` accordingly.

---

### Quick Checks

5. Extract the release status from a `helm list` output stub. Run: `printf 'NAME\tSTATUS\tCHART\nmyapp\tdeployed\tmyapp-1.0.0\n' | awk '/^myapp/{print $2}'`

```expected_output
deployed
```

hint: Think about how you can filter lines by a specific field value and then print only the column you need using a text processing tool.
hint: Use awk with a regex pattern to match lines starting with 'myapp', then reference the second whitespace-separated field using $2.

6. Calculate the next revision number after three upgrades. Run: `python3 -c "current=3; print(current + 1)"`

```expected_output
4
```

hint: Think about how Helm tracks release history and increments revision numbers with each upgrade.
hint: Use a simple arithmetic expression in Python where you add 1 to the current revision count stored in a variable.

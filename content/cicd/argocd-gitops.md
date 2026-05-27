---
title: ArgoCD & GitOps
module: cicd
duration_min: 25
difficulty: intermediate
tags: [cicd, argocd, gitops, kubernetes, sync, applications, app-of-apps]
exercises: 4
---

## Overview

GitOps is a deployment model where Git is the single source of truth for cluster state. Instead of engineers running `kubectl apply` or triggering imperative scripts, the desired state of every workload lives in a Git repository as declarative YAML. ArgoCD runs as a controller inside Kubernetes, continuously comparing what is in Git against what is running in the cluster. Any divergence — whether from a new commit or from someone manually patching a Deployment — is detected and reconciled. The entire deployment history is the Git log, which means rollback is `git revert`, audit trails are free, and disaster recovery is re-syncing from a known-good branch.

The four principles that define GitOps (declarative, versioned, automatically applied, continuously reconciled) map directly onto ArgoCD's design. Applications are defined as Kubernetes CRDs, not as CLI state. Sync policies control whether reconciliation is automated or requires human approval. RBAC controls who can trigger syncs or override policies. This design keeps the cluster from drifting into an unknown state and makes environment promotion — dev → staging → prod — a Git operation, not a runbook.

In the broader DevOps toolchain, ArgoCD sits at the boundary between CI and the running cluster. CI builds artifacts and updates manifests; ArgoCD deploys them. This separation means your CI system never needs cluster credentials, the cluster's desired state is auditable, and you can reproduce any historical deployment by pointing ArgoCD at a specific commit SHA.

---

## Concepts

### GitOps vs. Traditional Push-Based CD

Understanding the distinction between push-based and pull-based delivery is a common interview topic.

| Dimension | Push-Based (e.g., Jenkins → kubectl) | Pull-Based / GitOps (ArgoCD) |
|---|---|---|
| Who initiates deploy | CI pipeline pushes to cluster | ArgoCD pulls from Git |
| Cluster credentials | Stored in CI system | Never leave the cluster |
| Drift detection | None — state can diverge silently | Continuous, alerts on divergence |
| Rollback | Re-run pipeline with old tag | `argocd app rollback` or `git revert` |
| Audit trail | CI logs (often ephemeral) | Git history (permanent, signed) |
| Multi-cluster | CI needs creds for every cluster | Each cluster runs its own ArgoCD |

**Key security implication:** in a pull model, the cluster initiates outbound connections to Git and the registry. No external system needs inbound access or cluster-admin credentials. This is a meaningful security boundary, especially in regulated environments.

**Why this matters in interviews:** interviewers often ask "what's the problem with storing cluster credentials in Jenkins?" The answer is blast radius — a compromised CI system gives an attacker write access to every cluster it can reach. In the pull model, credentials never leave the cluster, and the worst-case blast radius is limited to what ArgoCD itself can do, which is controlled by its own RBAC.

---

### ArgoCD Application Resource

The `Application` CRD is the core unit of ArgoCD. It binds a Git source to a cluster destination and defines how reconciliation should happen.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp
  namespace: argocd          # Applications always live in the argocd namespace
spec:
  project: default           # ArgoCD Project for RBAC scoping (see Projects section)

  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main     # branch, tag, or immutable commit SHA
    path: apps/myapp/overlays/prod

    # Optional: Helm-specific overrides
    helm:
      valueFiles:
        - values-prod.yaml
      parameters:
        - name: image.tag
          value: "1.4.2"

  destination:
    server: https://kubernetes.default.svc   # in-cluster; use external URL for remote clusters
    namespace: production

  syncPolicy:
    automated:
      prune: true        # delete resources removed from Git — off by default, enable deliberately
      selfHeal: true     # revert manual kubectl changes — the GitOps guarantee
    syncOptions:
      - CreateNamespace=true          # create destination namespace if absent
      - ServerSideApply=true         # use SSA instead of client-side apply (avoids annotation bloat)
      - RespectIgnoreDifferences=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 2m
```

**`prune: false` is the default.** If you remove a Deployment from Git without enabling prune, the old Deployment keeps running silently. Enable prune deliberately and verify your manifests are complete before turning it on in production.

**`targetRevision: main` vs. a commit SHA:** Branches are mutable — a force push changes what ArgoCD deploys without any review process. For production, pin to a tag or commit SHA to make deployments fully reproducible and prevent surprise deploys from branch resets.

**`ServerSideApply: true` is recommended for complex resources.** Client-side apply stores a `last-applied-configuration` annotation that grows unbounded on large objects (e.g., CRDs with large schemas) and can exceed the 256KB etcd annotation limit. SSA avoids this entirely and handles field ownership conflicts more gracefully.

---

### Installing ArgoCD and the CLI

```bash
# 1. Install ArgoCD into the cluster
kubectl create namespace argocd
kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 2. Wait for all pods to be ready
kubectl wait --for=condition=available deployment \
  -l app.kubernetes.io/name=argocd-server \
  -n argocd --timeout=120s

# 3. Expose the API server locally
kubectl port-forward svc/argocd-server -n argocd 8080:443 &

# 4. Retrieve the auto-generated admin password
argocd admin initial-password -n argocd
# → prints a random password; change it immediately in production

# 5. Log in
argocd login localhost:8080 --insecure   # --insecure skips TLS for local dev only

# 6. Change admin password
argocd account update-password

# 7. Register an external cluster (for multi-cluster deployments)
# This creates a ServiceAccount in the target cluster and stores creds in argocd namespace
argocd cluster add my-prod-context --name prod
```

**Common day-2 CLI operations:**

```bash
# List all applications and their sync/health status
argocd app list

# Detailed status, including resource tree
argocd app get myapp

# Show diff between Git and live cluster state
argocd app diff myapp

# Trigger a manual sync (respects sync windows and RBAC)
argocd app sync myapp

# Sync only specific resources — useful for targeted deploys
argocd app sync myapp --resource apps:Deployment:myapp

# View deployment history (revision numbers map to ArgoCD sync operations)
argocd app history myapp

# Roll back to a specific revision
argocd app rollback myapp 5   # revision 5 from `argocd app history`

# Force refresh (re-poll Git without waiting for the 3-minute poll interval)
argocd app get myapp --refresh
```

**Poll interval:** ArgoCD polls Git every 3 minutes by default. For faster response, configure a Git webhook (GitHub → ArgoCD API server) to push change notifications instantly. This is strongly recommended in production — waiting 3 minutes for a hotfix to appear is unacceptable in most teams.

---

### Sync Status and Health Status

ArgoCD tracks two orthogonal states for every Application. They are independent and must both be understood to diagnose a deployment problem correctly.

| Status Type | Values | Meaning |
|---|---|---|
| **Sync Status** | `Synced` | Live cluster matches Git |
| | `OutOfSync` | Divergence detected |
| | `Unknown` | Cannot determine (API error, unreachable cluster) |
| **Health Status** | `Healthy` | All resources pass health checks |
| | `Progressing` | Resources are rolling out |
| | `Degraded` | A resource is failing (e.g., CrashLoopBackOff, failed rollout) |
| | `Missing` | Resource defined in Git but absent from cluster |
| | `Suspended` | Resource is intentionally paused (e.g., suspended CronJob) |

An Application can be `Synced` but `Degraded` — the cluster matches Git exactly, but what Git describes is broken. This means the problem is in the manifests themselves, not a sync issue. Conversely, `OutOfSync` + `Healthy` means someone manually added or modified a resource that works fine but isn't tracked in Git — a classic drift scenario that `selfHeal: true` would revert.

**Health checks are resource-type aware.** ArgoCD ships with built-in health checks for Deployments, StatefulSets, DaemonSets, Jobs, PVCs, and more. A Deployment is `Healthy` only when its desired replica count matches available replicas. You can write custom health checks in Lua for CRDs that ArgoCD doesn't know about natively.

**`argocd app wait` in CI pipelines:**

```bash
argocd app sync myapp
# Block CI until the rollout completes or times out
argocd app wait myapp \
  --health \
  --sync \
  --timeout 300
# Exit code 0 = healthy + synced; non-zero = failure — safe to use as a CI gate
```

This pattern is the correct way to integrate ArgoCD into a CI pipeline. Fire the sync, then block on `argocd app wait` — your pipeline knows the deploy actually succeeded, not just that the API accepted the sync request.

---

### Sync Policies, Sync Windows, and Automated Sync

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true
  syncOptions:
    - CreateNamespace=true
```

For environments where automated sync is too aggressive — production change windows, compliance requirements, or teams that want a human approval gate — use **Sync Windows** to restrict when ArgoCD can sync:

```yaml
# In the AppProject resource
spec:
  syncWindows:
    - kind: allow
      schedule: "0 9 * * 1-5"   # allow syncs Mon-Fri 09:00 UTC
      duration: 8h
      applications:
        - "*"
      namespaces:
        - production
    - kind: deny
      schedule: "0 18 * * 5"    # deny syncs Friday evening (change freeze)
      duration: 16h
      manualSync: true           # even block manual syncs during this window
```

**Sync windows apply to both automated and manual syncs unless `manualSync: true` is explicitly set on the deny window.** Leave `manualSync` unset on deny windows if you want engineers to be able to override the window during incidents. Setting it to `true` means no one can deploy — not even the on-call engineer at 2am — which is appropriate for regulated environments but dangerous for everything else.

**Order of evaluation:** if both an allow and a deny window are active simultaneously, the deny window takes precedence. Design your windows with this in mind.

---

### Sync Waves and Resource Hooks

Sync waves let you control the ordering of resource application within a single Application sync. Resources with lower wave numbers are applied first; ArgoCD waits for them to reach a `Healthy` state before proceeding to the next wave. The default wave is `0`.

```yaml
# ConfigMap applied first — wave -1
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
---
# Deployment applied after ConfigMap is ready — wave 0 (default)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  annotations:
    argocd.argoproj.io/sync-wave: "0"
---
# Smoke-test Job runs last — wave 1
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-test
  annotations:
    argocd.argoproj.io/sync-wave: "1"
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
```

**Resource Hook types:**

| Hook | When it runs | Common use case |
|---|---|---|
| `PreSync` | Before any resources are applied | Database migrations, backup snapshots |
| `Sync` | During the sync, alongside normal resources | Custom ordering logic |
| `PostSync` | After all resources are Healthy | Smoke tests, cache warming, notifications |
| `SyncFail` | If the sync fails | Alert, rollback side-effects, notify on-call |
| `Skip` | Never synced | Exclude a resource from sync without deleting it |

**Hook delete policies:**

| Policy | Behavior |
|---|---|
| `HookSucceeded` | Delete the hook resource after it succeeds — keeps the cluster clean |
| `HookFailed` | Delete after failure — you lose the pod logs; use only if you ship logs externally |
| `BeforeHookCreation` | Delete old hook resource before creating a new one — default for re-runs, prevents name conflicts |

**Gotcha:** if a `PreSync` Job fails, the sync is aborted and the Application enters `Degraded` state. This is the correct behavior for database migrations — you want the sync to stop rather than deploy application code against a broken schema. Always set `backoffLimit: 0` on migration Jobs (fail fast, don't retry), and always set resource limits so a hung migration Job doesn't starve other workloads.

**Waves vs. hooks:** waves control ordering of regular resources; hooks are for ephemeral Jobs that run at specific lifecycle points. You can combine them — a `PreSync` hook runs before wave -1 resources, and a `PostSync` hook runs after the highest wave completes.

---

### Projects

ArgoCD Projects (`AppProject`) are the RBAC and policy boundary. Every Application belongs to a project. The `default` project exists automatically and has no restrictions — it allows any source repo, any destination cluster, and any resource type.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-payments
  namespace: argocd
spec:
  description: "Payments team applications"

  # Only these repos are allowed as sources
  sourceRepos:
    - https://github.com/myorg/k8s-manifests
    - https://github.com/myorg/helm-charts

  # Only these destination clusters/namespaces are allowed
  destinations:
    - server: https://kubernetes.default.svc
      namespace: payments-*     # glob patterns supported

  # Cluster-scoped resources this project may NOT manage
  clusterResourceBlacklist:
    - group: ""
      kind: Namespace           # prevent this team from creating namespaces
    - group: rbac.authorization.k8s.io
      kind: ClusterRole         # prevent privilege escalation via ClusterRole

  # Namespace-scoped resources this project MAY manage (whitelist approach)
  namespaceResourceWhitelist:
    - group: "apps"
      kind: Deployment
    - group: "apps"
      kind: StatefulSet
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
    - group: ""
      kind: ServiceAccount
```

**The default project has no restrictions.** For any real multi-team cluster, always define explicit projects for each team — the default project is a security footgun that lets any authenticated user deploy anything anywhere. Treat it the same way you'd treat a wildcard IAM policy.

**Projects as blast radius control:** even if an attacker gains access to a team's Git repo, the AppProject limits what they can deploy (namespace scope, resource types, destination clusters). It's defense in depth for supply chain attacks.

---

### RBAC in ArgoCD

ArgoCD RBAC is configured in the `argocd-rbac-cm` ConfigMap using a Casbin policy format. Roles are defined with `p` (policy) lines and mapped to users or SSO groups with `g` (group) lines.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly      # default role for authenticated users
  policy.csv: |
    # Syntax: p, <role/user>, <resource>, <action>, <object>, <effect>
    # Resources: applications, clusters, repositories, projects, accounts, certificates
    # Actions: get, create, update, delete, sync, override, action
    # Object format for applications: <project>/<app-name>

    # Dev team: sync and read their own apps in team-payments project
    p, role:dev-team, applications, sync,   team-payments/*, allow
    p, role:dev-team, applications, get,    team-payments/*, allow
    p, role:dev-team, applications, update, team-payments/*, allow

    # Ops team: full access to all apps and cluster visibility
    p, role:ops,      applications, *,      */*, allow
    p, role:ops,      clusters,     get,    *,   allow

    # Map SSO groups (GitHub org teams via OIDC) to roles
    g, myorg:dev-payments, role:dev-team
    g, myorg:platform-ops, role:ops
```

**`policy.default: role:readonly`** means any authenticated user can see all apps and their configuration. This leaks information about your infrastructure. Set it to `role:''` (empty string) to deny all access by default and whitelist explicitly — this is the recommended posture for production clusters.

**The `override` action** allows a user to bypass sync windows and force a sync outside the allowed schedule. Grant it only to on-call roles or admins — it's the emergency break-glass permission.

---

### App of Apps Pattern

The App of Apps pattern solves the bootstrapping problem: how do you manage ArgoCD `Application` resources themselves as code, so the entire cluster state — including which apps exist — is version-controlled and reconciled?

The solution is a single root `Application` that points at a directory of other `Application` YAMLs. ArgoCD deploys those child Applications, and each child Application then deploys its own workloads.

```
k8s-manifests/
  argocd/
    root-app.yaml          # applied once with kubectl to bootstrap
    apps/
      payments-api.yaml
      postgres.yaml
      monitoring.yaml
      ingress-nginx.yaml
```

```yaml
# argocd/root-app.yaml — applied once manually; manages all child Applications
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io   # cascade-delete child apps on deletion
spec:
  project: default
  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main
    path: argocd/apps              # this directory contains child Application YAMLs
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd              # Applications are deployed into the argocd namespace
  syncPolicy:
    automated:
      prune: true     # removes ArgoCD Applications when their YAML is deleted from Git
      selfHeal: true
```

```yaml
# argocd/apps/payments-api.yaml — a child Application managed by root
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-api
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: team-payments
  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main
    path: apps/payments-api/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: payments-prod
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

**The finalizer is critical.** Without `resources-finalizer.argocd.argoproj.io`, deleting a child Application CRD leaves all the Kubernetes resources it deployed still running in the cluster. With the finalizer, ArgoCD garbage-collects all managed resources before the Application object is deleted. This prevents zombie workloads that nobody knows about and that never get cleaned up.

**Bootstrap sequence:** the only manual step is `kubectl apply -f argocd/root-app.yaml`. After that, every subsequent change — adding a new app, removing an app, changing sync policy — is a Git commit. New cluster provisioning becomes: install ArgoCD, apply root-app, wait.

**App of Apps vs. ApplicationSet:** `ApplicationSet` is the more modern approach for generating many similar Applications from a template (e.g., one Application per environment, or one per directory in a repo). App of Apps is simpler and more explicit — each child Application is fully defined. Use App of Apps when each application has meaningfully different configuration; use ApplicationSet when you're templating many near-identical applications.

---

### Handling Secrets in GitOps

Storing secrets in Git is the most common security mistake in GitOps setups. Plain Kubernetes Secrets base64-encode values — they are not encrypted and must never be committed to a repository.

| Approach | How it works | Tradeoffs |
|---|---|---|
| **Sealed Secrets** | Encrypt secrets with a cluster public key; store ciphertext in Git | Simple, no external dependency; re-encryption required on key rotation |
| **External Secrets Operator** | CRD references secrets from AWS Secrets Manager, Vault, GCP SM | Secrets never in Git; requires external secret store |
| **Vault Agent Injector** | Sidecar injects secrets into pod filesystem at runtime | Strong access control; more complex ops |
| **SOPS + age/KMS** | Encrypt secret files before commit; ArgoCD decrypts via plugin | Works with any backend; requires ArgoCD CMP setup |

**External Secrets Operator** is the most common production pattern. You commit an `ExternalSecret` CRD to Git (which contains no sensitive data — only a reference path), and the operator fetches the actual secret value from your secrets manager at sync time.

```yaml
# Safe to commit — contains no secret values
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: payments-prod
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: db-credentials          # creates a standard Kubernetes Secret with this name
    creationPolicy: Owner
  data:
    - secretKey: DB_PASSWORD      # key in the resulting Kubernetes Secret
      remoteRef:
        key: prod/payments/db     # path in AWS Secrets Manager
        property: password
```

**Never use `kubectl create secret` on a GitOps-managed cluster without a plan for how that secret gets into Git-compatible form.** Manually created secrets will either drift (not tracked in Git) or force you to store sensitive data in the repo.

---

## Examples

### Example 1: Deploy a Helm Application from a Private Repo

This scenario covers registering a private Git repo, creating an Application using Helm, and verifying the deployment.

```bash
# Step 1: Register the private repo with SSH credentials
# Generate a deploy key, add the public key to GitHub repo settings (read-only)
argocd repo add git@github.com:myorg/k8s-manifests.git \
  --ssh-private-key-path ~/.ssh/argocd_deploy_key \
  --name k8s-manifests

# Verify the repo is reachable
argocd repo list
# Should show ConnectionStatus: Successful

# Step 2: Create the Application pointing at a Helm chart
argocd app create payments-api \
  --repo git@github.com:myorg/k8s-manifests.git \
  --path charts/payments-api \
  --revision v1.4.2 \                    # pin to a tag, not main
  --dest-server https://kubernetes.default.svc \
  --dest-namespace payments-prod \
  --project team-payments \
  --values values-prod.yaml \
  --helm-set image.tag=1.4.2 \
  --sync-policy automated \
  --auto-prune \
  --self-heal

# Step 3: Watch the sync progress
argocd app get payments-api --watch

# Step 4: Verify health status
argocd app wait payments-api --health --timeout 180
echo "Exit code: $?"   # 0 = healthy, 1 = timeout or degraded

# Step 5: Confirm the pods are running
kubectl get pods -n payments-prod -l app=payments-api
```

After the Application is created via CLI, the equivalent YAML is stored internally as a CRD. Export it to add to your Git repo:

```bash
argocd app get payments-api -o yaml > argocd/apps/payments-api.yaml
# Remove status fields, then commit — now the Application itself is managed by root-app
```

---

### Example 2: Database Migration with PreSync Hook

This pattern ensures a database migration Job completes successfully before the new application version is deployed. A failed migration aborts the sync.

```yaml
# apps/payments-api/overlays/prod/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  namespace: payments-prod
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation  # clean up previous run's Job
spec:
  backoffLimit: 0          # fail immediately — do not retry a broken migration
  ttlSecondsAfterFinished: 600   # clean up after 10 minutes (if hook-delete-policy hasn't)
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: myorg/payments-api:1.4.2   # same image as the app; contains migration scripts
          command: ["python", "manage.py", "migrate", "--noinput"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: DATABASE_URL
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

```bash
# Trigger a sync and observe the hook running first
argocd app sync payments-api

# Watch events to see PreSync hook lifecycle
kubectl get events -n payments-prod --watch --field-selector reason=Created

# Check migration job logs if something goes wrong
kubectl logs -n payments-prod job/db-migrate

# If the sync is stuck due to a failed migration, inspect and then fix in Git
argocd app get payments-api
# Look for: Message: job db-migrate failed
```

If the migration Job exits non-zero, ArgoCD marks the sync as failed and the Application enters `Degraded`. The Deployment is never updated. Fix the migration, push to Git, and re-sync.

---

### Example 3: Multi-Environment Promotion Pipeline

This example shows how to promote a new image tag from staging to production using only Git operations.

```
k8s-manifests/
  apps/
    payments-api/
      overlays/
        staging/
          kustomization.yaml    # image tag pinned to staging value
        prod/
          kustomization.yaml    # image tag pinned to prod value
```

```yaml
# apps/payments-api/overlays/staging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
images:
  - name: myorg/payments-api
    newTag: "1.4.3"            # CI updates this after a successful build
```

```yaml
# apps/payments-api/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
images:
  - name: myorg/payments-api
    newTag: "1.4.2"            # currently running in prod; promoted manually
```

```bash
# CI pipeline step: after staging deploy is healthy, open a PR to promote to prod
# (In a real pipeline this is scripted — shown here as manual steps for clarity)

# 1. Verify staging is healthy before promoting
argocd app wait payments-api-staging --health --timeout 300

# 2. Update the prod overlay image tag (in CI, use yq or kustomize edit)
cd apps/payments-api/overlays/prod
kustomize edit set image myorg/payments-api:1.4.3

# 3. Open a PR — human approval required for prod
git checkout -b promote/payments-api-1.4.3
git add kustomization.yaml
git commit -m "promote payments-api to 1.4.3"
git push origin promote/payments-api-1.4.3
# → Create PR, get approval, merge to main
# → ArgoCD detects the change and syncs payments-api-prod automatically

# 4. Verify prod deployment
argocd app wait payments-api-prod --health --timeout 300
kubectl rollout status deployment/payments-api -n payments-prod
```

The key discipline here: CI writes to `staging`, humans approve writes to `prod`. ArgoCD handles both deployments identically — the only difference is the approval gate in the Git workflow.

---

### Example 4: Diagnosing and Recovering from Drift

This example simulates a common incident: an engineer manually patches a Deployment in production (a hotfix), which causes drift, and shows how to handle it correctly.

```bash
# --- Simulate the incident ---
# Engineer manually bumps the image tag directly on the cluster (bypassing Git)
kubectl set image deployment/payments-api \
  payments-api=myorg/payments-api:1.4.4-hotfix \
  -n payments-prod

# --- ArgoCD detects drift ---
# Within 3 minutes (or immediately if selfHeal is enabled), ArgoCD notices
argocd app get payments-api
# Sync Status: OutOfSync
# Message: Deployment payments-api image differs

# Show exactly what changed
argocd app diff payments-api
# - image: myorg/payments-api:1.4.2
# + image: myorg/payments-api:1.4.4-hotfix

# --- Option A: selfHeal is enabled ---
# ArgoCD automatically reverts the manual change back to 1.4.2 (what Git says)
# This is the GitOps guarantee — manual changes are not allowed to persist

# --- Option B: selfHeal is disabled, hotfix needs to be preserved ---
# Correct procedure: commit the hotfix to Git first, THEN let ArgoCD sync

# 1. Update the image tag in Git
cd apps/payments-api/overlays/prod
kustomize edit set image myorg/payments-api:1.4.4-hotfix
git add kustomization.yaml
git commit -m "hotfix: payments-api 1.4.4-hotfix — fix nil pointer in checkout"
git push origin main

# 2. ArgoCD detects the Git change and syncs — now Git matches cluster
argocd app sync payments-api   # or wait for automated sync
argocd app wait payments-api --health --sync --timeout 180

# 3. Verify reconciliation
argocd app get payments-api
# Sync Status: Synced
# Health Status: Healthy
```

**The lesson here:** `selfHeal: true` enforces the GitOps contract — if someone bypasses Git, ArgoCD will undo it. The correct response to any hotfix is to update Git first, even if you have to do it quickly. This keeps the audit trail intact and prevents the cluster from drifting into an unknown state.

---

## Exercises

### Exercise 1: Bootstrap ArgoCD and Deploy Your First Application

**Goal:** practice the full install-to-deploy workflow and understand what each component does.

1. Install ArgoCD in a local cluster (kind or minikube) using the stable manifest. Retrieve the initial admin password and log in with the CLI.
2. Fork the [ArgoCD example apps repo](https://github.com/argoproj/argocd-example-apps) or create a repository with a simple Nginx Deployment and Service YAML.
3. Create an Application via the CLI (`argocd app create`) pointing at your repo's `guestbook` directory (or your own manifest directory). Set `--sync-policy automated`.
4. Verify the sync status with `argocd app get` and confirm the pods are running with `kubectl get pods`.
5. Manually edit the
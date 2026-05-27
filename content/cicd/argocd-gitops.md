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

**`targetRevision: main` vs. a commit SHA:** Branches are mutable — a force push changes what ArgoCD deploys. For production, pin to a tag or commit SHA to make deployments fully reproducible.

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

**Poll interval:** ArgoCD polls Git every 3 minutes by default. For faster response, configure a Git webhook (GitHub → ArgoCD API server) to push change notifications instantly. This is strongly recommended in production.

---

### Sync Status and Health Status

ArgoCD tracks two orthogonal states for every Application:

| Status Type | Values | Meaning |
|---|---|---|
| **Sync Status** | `Synced` | Live cluster matches Git |
| | `OutOfSync` | Divergence detected |
| | `Unknown` | Cannot determine (API error) |
| **Health Status** | `Healthy` | All resources pass health checks |
| | `Progressing` | Resources are rolling out |
| | `Degraded` | A resource is failing (e.g., CrashLoopBackOff) |
| | `Missing` | Resource defined in Git but absent from cluster |
| | `Suspended` | Resource is intentionally paused |

An Application can be `Synced` but `Degraded` — the cluster matches Git, but what Git describes is broken. Conversely, `OutOfSync` + `Healthy` means someone manually added a resource that works but isn't tracked in Git.

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

For environments where automated sync is too aggressive (production change windows, compliance requirements), use **Sync Windows** to restrict when ArgoCD can sync:

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
      schedule: "0 18 * * 5"    # deny syncs Friday evening
      duration: 16h
      manualSync: true           # even block manual syncs during this window
```

**Sync windows apply to automated and manual syncs unless `manualSync: true` is set.** Leave `manualSync` unset if you want engineers to be able to override the window in emergencies.

---

### Sync Waves and Resource Hooks

Sync waves let you control ordering within a single Application sync. Resources with lower wave numbers are applied first and must be healthy before higher-wave resources are applied.

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
| `SyncFail` | If the sync fails | Alert, rollback side-effects |
| `Skip` | Never synced | Exclude a resource from sync entirely |

**Hook delete policies:**

| Policy | Behavior |
|---|---|
| `HookSucceeded` | Delete the hook resource after it succeeds |
| `HookFailed` | Delete after failure (lose logs — use carefully) |
| `BeforeHookCreation` | Delete old hook resource before creating a new one (default for re-runs) |

**Gotcha:** if a `PreSync` Job fails, the sync is aborted and the Application enters `Degraded` state. This is the correct behavior for migrations — you want the sync to stop rather than deploy against a broken schema. Always set a `backoffLimit` and resource limits on hook Jobs.

---

### Projects

ArgoCD Projects (`AppProject`) are the RBAC and policy boundary. Every Application belongs to a project.

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

  # Cluster-scoped resources this project may not manage
  clusterResourceBlacklist:
    - group: ""
      kind: Namespace           # prevent this team from creating namespaces
    - group: rbac.authorization.k8s.io
      kind: ClusterRole

  # Namespace-scoped resources this project may manage
  namespaceResourceWhitelist:
    - group: "apps"
      kind: Deployment
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
```

**Default project has no restrictions.** For any real multi-team cluster, always define explicit projects — the default project is a security footgun.

---

### RBAC in ArgoCD

ArgoCD RBAC is configured in the `argocd-rbac-cm` ConfigMap using a Casbin policy format.

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

    # Dev team: sync and read their own apps
    p, role:dev-team, applications, sync,   team-payments/*, allow
    p, role:dev-team, applications, get,    team-payments/*, allow
    p, role:dev-team, applications, update, team-payments/*, allow

    # Ops team: full access to all apps
    p, role:ops,      applications, *,      */*, allow
    p, role:ops,      clusters,     get,    *,   allow

    # Map SSO groups to roles (GitHub/OIDC)
    g, myorg:dev-payments, role:dev-team
    g, myorg:platform-ops, role:ops
```

**`policy.default: role:readonly`** means any authenticated user can see all apps. Set it to `role:''` (empty) to deny all access by default and whitelist explicitly.

---

### App of Apps Pattern

The App of Apps pattern solves the bootstrapping problem: how do you manage ArgoCD Applications themselves as code?

```
k8s-manifests/
  argocd/
    root-app.yaml          # applied once with kubectl to bootstrap
    apps/
      myapp.yaml
      postgres.yaml
      monitoring.yaml
      payments-api.yaml
```

```yaml
# argocd/root-app.yaml — applied once; manages everything else
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
    path: argocd/apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
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

**The finalizer is critical.** Without `resources-finalizer.argocd.argoproj.io`, deleting a child Application CRD leaves all the Kubernetes resources it deployed running. With the finalizer, ArgoCD garbage-
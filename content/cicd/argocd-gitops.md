---
title: ArgoCD & GitOps
module: cicd
duration_min: 25
difficulty: intermediate
tags: [cicd, argocd, gitops, kubernetes, sync, applications, app-of-apps]
exercises: 4
---

## Overview
GitOps is a deployment model where Git is the single source of truth for cluster state. ArgoCD runs inside Kubernetes, watches a Git repo, and reconciles the cluster to match whatever is in that repo. If someone applies a change directly to the cluster, ArgoCD detects drift and reverts it. If you push a new image tag to Git, ArgoCD deploys it. The entire deployment history is the Git log.

## Concepts

### Core Principles
1. **Declarative** — desired state is in YAML files in Git
2. **Versioned** — every change is a Git commit with history
3. **Automatically applied** — ArgoCD syncs the cluster to match Git
4. **Continuously reconciled** — drift is detected and corrected

### ArgoCD Application Resource
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp
  namespace: argocd
spec:
  project: default

  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main       # branch, tag, or commit SHA
    path: apps/myapp/overlays/prod   # path within the repo

  destination:
    server: https://kubernetes.default.svc   # in-cluster
    namespace: production

  syncPolicy:
    automated:
      prune: true        # delete resources removed from Git
      selfHeal: true     # revert manual cluster changes
    syncOptions:
      - CreateNamespace=true
```

### argocd CLI
```bash
# Install ArgoCD in cluster
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Access the UI (port-forward or LoadBalancer)
kubectl port-forward svc/argocd-server -n argocd 8080:443

# Get initial admin password
argocd admin initial-password -n argocd

# Login
argocd login localhost:8080

# Create application from CLI
argocd app create myapp \
  --repo https://github.com/myorg/k8s-manifests \
  --path apps/myapp/overlays/prod \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace production \
  --sync-policy automated

# Sync status
argocd app list
argocd app get myapp
argocd app sync myapp          # manual sync
argocd app diff myapp          # show diff vs cluster
argocd app history myapp       # deployment history

# Rollback to previous version
argocd app rollback myapp 3    # roll back to revision 3
```

### Sync Policies
```yaml
syncPolicy:
  automated:
    prune: true       # remove resources deleted from Git
    selfHeal: true    # revert manual changes to cluster

  # Or: manual sync (default when syncPolicy is omitted)
  # → operator must run `argocd app sync myapp` or click Sync in UI
```

**Automated sync + selfHeal** is the GitOps ideal: any drift is automatically corrected. Use manual sync for production environments where you want human approval before deploying.

### Sync Waves and Hooks
Control deploy order within a single application:

```yaml
# Apply this resource first (wave -1 runs before default wave 0)
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-1"   # run first
```

```yaml
# Run a Job before sync begins
metadata:
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
```

Hook types: `PreSync`, `Sync`, `PostSync`, `SyncFail` — use for database migrations, smoke tests, notifications.

### App of Apps Pattern
Instead of creating each Application manually, define a root Application that manages other Applications:

```
k8s-manifests/
  argocd/
    root-app.yaml          # the bootstrap Application
    apps/
      myapp.yaml           # Application for myapp
      postgres.yaml        # Application for postgres
      monitoring.yaml      # Application for monitoring stack
```

```yaml
# argocd/root-app.yaml — the root Application
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main
    path: argocd/apps     # ArgoCD watches this directory
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Apply the root app once with `kubectl apply` or `argocd app create`. From then on, adding a new `apps/newservice.yaml` to Git automatically creates a new ArgoCD Application.

### ApplicationSet
ApplicationSet generates multiple Applications from a template — useful for multi-cluster or multi-environment deployments:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp-environments
  namespace: argocd
spec:
  goTemplate: true                          # modern Go template syntax (recommended)
  goTemplateOptions: ["missingkey=error"]   # fail if a template variable is missing
  generators:
    - list:
        elements:
          - cluster: dev
            namespace: development
          - cluster: staging
            namespace: staging
          - cluster: prod
            namespace: production
  template:
    metadata:
      name: 'myapp-{{.cluster}}'           # dot notation required with goTemplate: true
    spec:
      source:
        repoURL: https://github.com/myorg/k8s-manifests
        path: 'apps/myapp/overlays/{{.cluster}}'
        targetRevision: main
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{.namespace}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### GitOps Deployment Flow
```
Developer pushes code
    ↓
CI pipeline: test → build → push image to registry
CI pipeline: update image tag in k8s-manifests repo (separate repo)
    ↓
ArgoCD detects change in k8s-manifests repo
    ↓
ArgoCD syncs cluster → rolling update to new image
    ↓
ArgoCD reports sync status (Healthy / Degraded / OutOfSync)
```

The CI pipeline never talks to the cluster directly — it only updates Git. ArgoCD handles the actual deployment.

### RBAC in ArgoCD
```yaml
# argocd-rbac-cm ConfigMap
policy.csv: |
  p, role:dev-team, applications, sync, dev/*, allow
  p, role:dev-team, applications, get, dev/*, allow
  g, myorg:dev-team, role:dev-team   # GitHub team -> ArgoCD role
```

## Examples

### Image Updater Integration
ArgoCD Image Updater watches a container registry and automatically updates image tags in Git:

```yaml
metadata:
  annotations:
    argocd-image-updater.argoproj.io/image-list: myapp=myregistry/myapp
    argocd-image-updater.argoproj.io/myapp.update-strategy: newest-build
    argocd-image-updater.argoproj.io/write-back-method: git
```

When a new image is pushed to the registry, Image Updater commits the new tag to Git, and ArgoCD deploys it.

## Exercises

1. Install ArgoCD in a local cluster (kind or minikube). Create an `Application` that deploys nginx from a manifest in a Git repo. Enable auto-sync and selfHeal. Make a manual `kubectl` change and observe ArgoCD revert it.
2. Create an App of Apps: a root Application that watches a directory of Application manifests. Add a new Application YAML to that directory in Git and verify ArgoCD picks it up without any manual `argocd app create`.
3. Add a `PreSync` hook (a Kubernetes Job) to an Application. The Job should echo "running migration". Verify it runs before the main application resources sync.
4. Use `argocd app history` to see deployment history. Roll back to a previous revision with `argocd app rollback`. Verify the cluster state matches the older Git revision.

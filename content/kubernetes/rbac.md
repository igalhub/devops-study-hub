---
title: RBAC
module: kubernetes
duration_min: 20
difficulty: advanced
tags: [kubernetes, rbac, roles, clusterrole, serviceaccount, permissions, security]
exercises: 4
---

## Overview
RBAC (Role-Based Access Control) controls who can do what in a Kubernetes cluster. Without it, every user and every Pod can read and modify any resource. With it, you grant the minimum permissions needed — nothing more. Understanding RBAC is essential for both security hardening and diagnosing "Forbidden" errors.

## Concepts

### RBAC Objects
| Object | Scope | Purpose |
|---|---|---|
| `Role` | Namespace | Permissions within one namespace |
| `ClusterRole` | Cluster-wide | Permissions across all namespaces or cluster-level resources |
| `RoleBinding` | Namespace | Binds a Role (or ClusterRole) to subjects in a namespace |
| `ClusterRoleBinding` | Cluster-wide | Binds a ClusterRole to subjects cluster-wide |

**Subject types:**
- `User` — human user (authenticated via client certs, OIDC, etc.)
- `Group` — group of users
- `ServiceAccount` — identity for Pods and automation

### Role
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: production
rules:
  - apiGroups: [""]          # "" = core API group (pods, services, configmaps, etc.)
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]      # apps group: deployments, statefulsets, daemonsets
    resources: ["deployments"]
    verbs: ["get", "list"]
```

**Common verbs:** `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`

**Common API groups:**
- `""` (core): pods, services, configmaps, secrets, nodes, namespaces, persistentvolumeclaims
- `apps`: deployments, replicasets, statefulsets, daemonsets
- `batch`: jobs, cronjobs
- `networking.k8s.io`: ingresses, networkpolicies
- `rbac.authorization.k8s.io`: roles, rolebindings, clusterroles, clusterrolebindings

### ClusterRole
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: deployment-manager
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services"]
    verbs: ["get", "list", "watch"]
  # Cluster-scoped resources (can only be granted via ClusterRole)
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
```

### RoleBinding
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: production
subjects:
  - kind: User
    name: igal           # must match the authenticated user's name exactly
    apiGroup: rbac.authorization.k8s.io
  - kind: Group
    name: backend-team
    apiGroup: rbac.authorization.k8s.io
  - kind: ServiceAccount
    name: ci-deployer
    namespace: production   # namespace is required for ServiceAccount subjects
roleRef:
  kind: Role               # or ClusterRole
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

A `RoleBinding` can bind a `ClusterRole` — the ClusterRole's rules apply only within the binding's namespace (useful for reusing role definitions).

### ClusterRoleBinding
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cluster-admin-igal
subjects:
  - kind: User
    name: igal
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: cluster-admin    # built-in: full access to everything
  apiGroup: rbac.authorization.k8s.io
```

### Built-in ClusterRoles
| ClusterRole | Access |
|---|---|
| `cluster-admin` | Full access to everything |
| `admin` | Full access within a namespace |
| `edit` | Read/write most resources in a namespace |
| `view` | Read-only most resources in a namespace |

Use these as starting points, restrict further with custom Roles.

### ServiceAccounts
Every Pod runs with a ServiceAccount. By default it's the `default` SA in its namespace — which typically has no permissions. Create specific SAs for workloads that need API access:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: production
```

```yaml
# Use the ServiceAccount in a Pod/Deployment
spec:
  serviceAccountName: ci-deployer
  automountServiceAccountToken: false   # disable if the pod doesn't need API access
  containers:
    - name: app
      image: myapp:v1.0.0
```

The token is mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token`.

### Testing and Debugging RBAC
```bash
# Check what a user/SA can do
kubectl auth can-i get pods --namespace=production
kubectl auth can-i delete deployments --namespace=production --as=igal
kubectl auth can-i create secrets --as=system:serviceaccount:production:ci-deployer

# List all permissions a user has
kubectl auth can-i --list --namespace=production

# Diagnose a Forbidden error
kubectl describe rolebinding -n production    # who has what
kubectl get clusterrolebindings -o wide       # cluster-wide bindings
kubectl get rolebindings -n production -o wide

# Create a quick test role + binding
kubectl create role test-role --verb=get,list --resource=pods -n production
kubectl create rolebinding test-binding --role=test-role --user=testuser -n production
```

## Examples

### CI/CD ServiceAccount
Give a CI pipeline permission to update Deployments and read Secrets in one namespace:

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ci-deployer-role
  namespace: production
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "patch", "update"]
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-deployer-binding
  namespace: production
subjects:
  - kind: ServiceAccount
    name: ci-deployer
    namespace: production
roleRef:
  kind: Role
  name: ci-deployer-role
  apiGroup: rbac.authorization.k8s.io
```

## Exercises

1. Create a Role in the `staging` namespace that allows `get`, `list`, and `watch` on pods and deployments. Bind it to a user named `developer`. Verify with `kubectl auth can-i list pods -n staging --as=developer`.
2. Create a ServiceAccount for a monitoring tool that needs read access to pods, nodes, and services across all namespaces. Use a ClusterRole + ClusterRoleBinding.
3. Intentionally bind a user to the `view` ClusterRole in one namespace. Verify they can list pods there but get "Forbidden" when listing pods in another namespace.
4. Audit your cluster's bindings: list all ClusterRoleBindings that include `cluster-admin`. Explain when `cluster-admin` is appropriate and when it's a security concern.

---
title: RBAC
module: kubernetes
duration_min: 20
difficulty: advanced
tags: [kubernetes, rbac, roles, clusterrole, serviceaccount, permissions, security]
exercises: 4
---

## Overview

Role-Based Access Control (RBAC) is Kubernetes' authorization mechanism for answering the question: "Is this identity allowed to perform this action on this resource?" It sits between authentication (proving who you are) and the API server's actual execution of a request. Without RBAC, a compromised Pod or misconfigured CI pipeline can read every Secret, delete every Deployment, or exfiltrate cluster state. With it, you enforce least-privilege: each identity gets exactly what it needs and nothing more.

RBAC's design is intentionally additive — there are no deny rules. Permissions accumulate across all bindings that apply to a subject. This means you can never use RBAC to explicitly block access to something that would otherwise be allowed; you simply avoid granting it. The model consists of four object types arranged as two independent layers: the *definition layer* (Role, ClusterRole) describes what operations are permitted, and the *binding layer* (RoleBinding, ClusterRoleBinding) attaches those definitions to identities called *subjects*. This separation lets you write a role once and reuse it across teams, namespaces, or automation accounts.

In the broader DevOps toolchain, RBAC sits at the intersection of platform security and developer self-service. Platform teams define roles that describe what CI pipelines, monitoring agents, and application operators need. Developers consume those roles through service accounts without touching raw kubeconfig credentials. Security audits reduce to inspecting bindings, not hunting through application code. Understanding RBAC deeply also makes you effective at diagnosing `Forbidden` errors, the most common Kubernetes access error in production.

---

## Concepts

### The Four RBAC Objects

Every RBAC configuration is built from exactly four object kinds. Understanding their scope is the key to designing a correct permission model.

| Object | Scope | Binds to | Purpose |
|---|---|---|---|
| `Role` | Single namespace | Subjects in that namespace | Namespace-scoped resource permissions |
| `ClusterRole` | Cluster-wide | Any subject | Cluster-scoped resources, or reusable namespace rules |
| `RoleBinding` | Single namespace | Subjects in that namespace | Grants a Role *or* ClusterRole within one namespace |
| `ClusterRoleBinding` | Cluster-wide | Any subject | Grants a ClusterRole across all namespaces |

**Subject types** — the identities that can be bound:

| Kind | Example name | Notes |
|---|---|---|
| `User` | `igal`, `alice@company.com` | Kubernetes has no User object; the name must match the authenticated identity exactly |
| `Group` | `backend-team`, `system:masters` | Also external — e.g., OIDC groups or cert O= fields |
| `ServiceAccount` | `ci-deployer` | Has a real object in the cluster; namespace is required in bindings |

**Critical scoping rule:** A `RoleBinding` can reference a `ClusterRole`, but the effective scope is still limited to the RoleBinding's namespace. This is the correct way to define a role once and reuse it in many namespaces without granting cluster-wide access.

### Roles and the Rules DSL

A `Role` contains one or more rules. Each rule is a combination of API groups, resources, and verbs. All three fields are required.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: production
rules:
  - apiGroups: [""]          # "" = core API group
    resources: ["pods", "pods/log", "pods/exec"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["app-config"]   # restrict to a specific named resource
    verbs: ["get"]
```

**Common verbs and what they map to:**

| Verb | HTTP method | Notes |
|---|---|---|
| `get` | GET (single) | Retrieve one named resource |
| `list` | GET (collection) | List all resources of a type |
| `watch` | GET + `?watch=true` | Stream change events; needed by controllers |
| `create` | POST | Create a new resource |
| `update` | PUT | Replace an entire resource |
| `patch` | PATCH | Partially update a resource |
| `delete` | DELETE (single) | Delete one named resource |
| `deletecollection` | DELETE (collection) | Bulk delete; often forgotten in audits |

**Common API groups:**

| Group | Resources |
|---|---|
| `""` (core) | pods, services, configmaps, secrets, nodes, namespaces, persistentvolumeclaims, serviceaccounts |
| `apps` | deployments, replicasets, statefulsets, daemonsets |
| `batch` | jobs, cronjobs |
| `networking.k8s.io` | ingresses, networkpolicies |
| `rbac.authorization.k8s.io` | roles, rolebindings, clusterroles, clusterrolebindings |
| `autoscaling` | horizontalpodautoscalers |
| `policy` | poddisruptionbudgets |

**`resourceNames` gotcha:** `resourceNames` restricts a rule to specific named instances. However, it cannot be used with `list`, `watch`, `create`, or `deletecollection` — those verbs don't operate on a single named resource. Applying `resourceNames` with those verbs silently produces a rule that will never match.

**Wildcard permissions:** `resources: ["*"]` and `verbs: ["*"]` are valid but should only appear in admin-level roles. They automatically include any new resource types added in the future, which makes them dangerous in production workloads.

### ClusterRole

A `ClusterRole` is identical in syntax to a `Role` but has no `namespace` in its metadata. Use a ClusterRole when you need to:

1. Grant access to cluster-scoped resources (nodes, namespaces, persistentvolumes, storageclasses)
2. Grant access to resources across all namespaces via a `ClusterRoleBinding`
3. Define a reusable role that multiple namespaces reference via `RoleBinding`

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-reader
rules:
  - apiGroups: [""]
    resources: ["nodes", "nodes/metrics", "pods", "services", "endpoints"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["namespaces"]       # cluster-scoped; only grantable via ClusterRole
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/healthz"]   # HTTP paths not backed by K8s objects
    verbs: ["get"]
```

**`nonResourceURLs`** are HTTP paths on the API server that don't correspond to Kubernetes objects — `/metrics`, `/healthz`, `/version`. They can only appear in ClusterRoles and only with the `get` verb.

### RoleBinding and ClusterRoleBinding

Bindings connect roles to subjects. The `roleRef` is **immutable after creation** — to change which role a binding references, you must delete and recreate it.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: dev-pod-reader
  namespace: production
subjects:
  - kind: User
    name: igal
    apiGroup: rbac.authorization.k8s.io
  - kind: Group
    name: backend-team
    apiGroup: rbac.authorization.k8s.io
  - kind: ServiceAccount
    name: ci-deployer
    namespace: production     # required for ServiceAccount; must be explicit
roleRef:
  kind: Role                  # can also be ClusterRole
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: monitoring-global
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: monitoring
roleRef:
  kind: ClusterRole
  name: monitoring-reader
  apiGroup: rbac.authorization.k8s.io
```

**The four combinations and their effective scope:**

| Role type | Binding type | Effective scope |
|---|---|---|
| `Role` | `RoleBinding` | Resources in the binding's namespace only |
| `ClusterRole` | `RoleBinding` | Resources in the binding's namespace only (reuse pattern) |
| `ClusterRole` | `ClusterRoleBinding` | Resources in every namespace + cluster-scoped resources |
| `Role` | `ClusterRoleBinding` | Not valid — `ClusterRoleBinding` can only reference `ClusterRole` |

### Built-in ClusterRoles

Kubernetes ships with several ClusterRoles you should know:

| ClusterRole | Effective access | Typical use |
|---|---|---|
| `cluster-admin` | Full `*` on `*` everywhere | Break-glass only; never for automation |
| `admin` | Full access within a namespace (can manage RBAC within it) | Namespace owner |
| `edit` | Read/write most resources; cannot manage RBAC or access secrets in some configs | Developer access |
| `view` | Read-only on most non-sensitive resources; cannot read secrets | Auditor, dashboard |
| `system:node` | Node-specific access | Kubelets |
| `system:kube-scheduler` | Scheduler-specific access | Scheduler |

**`cluster-admin` warning:** Binding a service account or CI pipeline to `cluster-admin` is a critical security misconfiguration. A single compromised token gives full cluster control — including reading all secrets, modifying RBAC itself, and deleting workloads. Reach for `admin` or a custom ClusterRole instead.

**`edit` vs `admin`:** `admin` allows managing Roles and RoleBindings within the namespace. `edit` does not. Give developers `edit` unless they explicitly need to manage namespace-level RBAC.

### ServiceAccounts

A ServiceAccount (SA) is a namespaced Kubernetes object that provides an identity for processes running in Pods. Every Pod runs as exactly one SA. If you don't specify one, it defaults to the `default` SA in the Pod's namespace — which should have no permissions in a hardened cluster.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: production
  annotations:
    # Optional: link to a cloud IAM role (AWS IRSA, GKE Workload Identity)
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789:role/ci-deployer"
```

```yaml
# Reference the SA in a Deployment
spec:
  serviceAccountName: ci-deployer
  automountServiceAccountToken: false   # disable when the pod doesn't call the K8s API
  containers:
    - name: app
      image: myapp:v1.0.0
```

When `automountServiceAccountToken` is true (the default), Kubernetes mounts a projected token at `/var/run/secrets/kubernetes.io/serviceaccount/token`. Since Kubernetes 1.24, these are time-limited bound tokens (not long-lived JWTs). Applications use this token to authenticate to the API server.

**Automount gotcha:** The `default` service account in most clusters has `automountServiceAccountToken: true` by default. Every Pod that doesn't specify a SA gets a mounted token even if it never uses it. Disable automounting on the `default` SA in each namespace as a hardening baseline:

```bash
kubectl patch serviceaccount default -n production \
  -p '{"automountServiceAccountToken": false}'
```

**ServiceAccount token escalation:** A Pod that can create or modify Pods in a namespace can effectively grant itself any SA in that namespace. This is why `create pods` and `patch deployments` are sensitive verbs — they let a workload escalate to a more privileged SA.

### Testing and Debugging RBAC

The `kubectl auth can-i` command is your primary debugging tool. It calls the SubjectAccessReview API directly — the same mechanism the API server uses to evaluate requests.

```bash
# Check your own permissions
kubectl auth can-i get pods -n production
kubectl auth can-i --list -n production           # dump all permissions for current user

# Impersonate another user or SA
kubectl auth can-i delete deployments -n production --as=igal
kubectl auth can-i create secrets -n production \
  --as=system:serviceaccount:production:ci-deployer

# Impersonate a group
kubectl auth can-i list nodes \
  --as=igal --as-group=backend-team

# Find all bindings in a namespace
kubectl get rolebindings,clusterrolebindings -n production -o wide

# Find every binding that references a specific ClusterRole
kubectl get clusterrolebindings -o json | \
  jq '.items[] | select(.roleRef.name=="cluster-admin") | .metadata.name'

# Describe a binding to see full subject list
kubectl describe rolebinding ci-deployer-binding -n production

# Quick imperative role creation for testing
kubectl create role test-role --verb=get,list --resource=pods -n staging
kubectl create rolebinding test-binding \
  --role=test-role --user=testuser -n staging
```

**`--as` vs actual impersonation:** `kubectl auth can-i --as=X` simulates the check server-side. It does not give you a kubeconfig that acts as X — it asks the API server "would X be allowed?" This is safe to run without having X's credentials.

**Forbidden error anatomy:** When a request is denied, the API server returns HTTP 403 with a message like:
```
User "system:serviceaccount:production:ci-deployer" cannot update resource
"deployments" in API group "apps" in the namespace "production"
```
That message contains all three elements you need to fix it: subject, verb+resource, and namespace.

**Aggregation rules:** ClusterRoles can aggregate permissions from other ClusterRoles using label selectors. Many controllers (like Prometheus Operator) install ClusterRoles with labels like `rbac.example.com/aggregate-to-monitoring: "true"` and define an aggregated ClusterRole that automatically picks them up. Be aware that installing a new operator can silently expand the permissions of existing roles if aggregation labels overlap.

```yaml
# Aggregated ClusterRole picks up any ClusterRole with matching label
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-aggregate
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-monitoring: "true"
rules: []   # rules populated automatically from matching ClusterRoles
```

---

## Examples

### Example 1: CI/CD Pipeline with Scoped Deploy Permissions

A CI pipeline needs to update Deployments and read ConfigMaps and Secrets in the `production` namespace — nothing else, nowhere else.

```yaml
# ci-deployer-rbac.yaml
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
    resources: ["configmaps"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["secrets"]        # read-only; pipeline reads image pull creds
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods"]           # needed to check rollout status
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-deployer-binding
  namespace: production
subjects:
  - kind: ServiceAccount
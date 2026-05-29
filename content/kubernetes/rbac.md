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

In the broader DevOps toolchain, RBAC sits at the intersection of platform security and developer self-service. Platform teams define roles that describe what CI pipelines, monitoring agents, and application operators need. Developers consume those roles through service accounts without touching raw kubeconfig credentials. Security audits reduce to inspecting bindings, not hunting through application code. Understanding RBAC deeply also makes you effective at diagnosing `Forbidden` errors — the most common Kubernetes access error in production — and at designing multi-tenant clusters where teams share infrastructure without interfering with each other.

---

## Concepts

### The Four RBAC Objects

Every RBAC configuration is built from exactly four object kinds. Understanding their scope is the key to designing a correct permission model.

| Object | Scope | Purpose |
|---|---|---|
| `Role` | Single namespace | Namespace-scoped resource permissions |
| `ClusterRole` | Cluster-wide | Cluster-scoped resources, or reusable namespace rules |
| `RoleBinding` | Single namespace | Grants a Role *or* ClusterRole within one namespace |
| `ClusterRoleBinding` | Cluster-wide | Grants a ClusterRole across all namespaces |

**Subject types** — the identities that can be bound:

| Kind | Example name | Notes |
|---|---|---|
| `User` | `alice`, `alice@company.com` | No User object exists in Kubernetes; the name must match the authenticated identity exactly |
| `Group` | `backend-team`, `system:masters` | External — e.g., OIDC groups or certificate `O=` fields |
| `ServiceAccount` | `ci-deployer` | Has a real object in the cluster; namespace is required in bindings |

**Critical scoping rule:** A `RoleBinding` can reference a `ClusterRole`, but the effective scope is still limited to the RoleBinding's namespace. This is the correct pattern for defining a role once and reusing it in many namespaces without granting cluster-wide access.

**The four binding combinations:**

| Role type | Binding type | Effective scope |
|---|---|---|
| `Role` | `RoleBinding` | Resources in the binding's namespace only |
| `ClusterRole` | `RoleBinding` | Resources in the binding's namespace only (reuse pattern) |
| `ClusterRole` | `ClusterRoleBinding` | Resources in every namespace + cluster-scoped resources |
| `Role` | `ClusterRoleBinding` | **Not valid** — ClusterRoleBinding can only reference ClusterRole |

### Roles and the Rules DSL

A `Role` contains one or more rules. Each rule is a combination of API groups, resources, and verbs. All three fields are required.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: production
rules:
  - apiGroups: [""]              # "" = core API group (pods, services, secrets, etc.)
    resources: ["pods", "pods/log", "pods/exec"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["app-config"]  # restrict to one specific named resource
    verbs: ["get"]
```

**Common verbs and their HTTP equivalents:**

| Verb | HTTP method | Notes |
|---|---|---|
| `get` | GET (single) | Retrieve one named resource |
| `list` | GET (collection) | List all resources of a type |
| `watch` | GET + `?watch=true` | Stream change events; required by controllers |
| `create` | POST | Create a new resource |
| `update` | PUT | Replace an entire resource |
| `patch` | PATCH | Partially update a resource |
| `delete` | DELETE (single) | Delete one named resource |
| `deletecollection` | DELETE (collection) | Bulk delete; frequently forgotten in audits |

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

**`resourceNames` gotcha:** `resourceNames` restricts a rule to specific named instances. It **cannot** be used with `list`, `watch`, `create`, or `deletecollection` — those verbs don't operate on a single named resource. Applying `resourceNames` with those verbs silently produces a rule that will never match.

**Subresource access:** `pods/log`, `pods/exec`, `pods/portforward` are subresources — they must be listed explicitly. Granting access to `pods` does not grant access to `pods/exec`. This is a common least-privilege gap: teams grant `get pods` but forget that `exec` is separate and far more sensitive.

**Wildcard permissions:** `resources: ["*"]` and `verbs: ["*"]` are valid YAML but should only appear in admin-level roles. They automatically include any new resource types added by future API versions or installed operators — which makes them silently dangerous as clusters evolve.

### ClusterRole

A `ClusterRole` is syntactically identical to a `Role` but omits the `namespace` field. Use a ClusterRole when you need to:

1. Grant access to cluster-scoped resources (nodes, namespaces, persistentvolumes, storageclasses)
2. Grant access to resources across all namespaces via a `ClusterRoleBinding`
3. Define a reusable template that multiple namespaces consume via individual `RoleBinding`s

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
    resources: ["namespaces"]           # cluster-scoped; only grantable via ClusterRole
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/healthz"]   # HTTP paths not backed by K8s objects
    verbs: ["get"]
```

**`nonResourceURLs`** are HTTP paths on the API server that don't correspond to Kubernetes objects — `/metrics`, `/healthz`, `/version`. They can only appear in ClusterRoles and only with the `get` verb. Prometheus scrapers commonly need `/metrics` on the API server itself.

**ClusterRole aggregation:** ClusterRoles can automatically merge permissions from other ClusterRoles using label selectors. Many operators install ClusterRoles that opt into an aggregation target. Be aware that installing a new operator can silently expand the permissions of an existing aggregated ClusterRole if its labels match.

```yaml
# This ClusterRole's rules are auto-populated from any ClusterRole with the matching label
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-aggregate
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-monitoring: "true"
rules: []   # populated automatically; do not add rules here manually
---
# An operator installs this, and monitoring-aggregate silently gains these rules
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: myoperator-metrics
  labels:
    rbac.example.com/aggregate-to-monitoring: "true"
rules:
  - apiGroups: ["myoperator.io"]
    resources: ["widgetmetrics"]
    verbs: ["get", "list"]
```

### Built-in ClusterRoles

Kubernetes ships with several ClusterRoles that cover common access patterns:

| ClusterRole | Effective access | Typical use |
|---|---|---|
| `cluster-admin` | Full `*` on `*` everywhere | Break-glass only; never for automation |
| `admin` | Full access within a namespace, including managing RBAC within it | Namespace owner |
| `edit` | Read/write most resources; cannot manage RBAC or read Secrets in some configs | Developer access |
| `view` | Read-only on most non-sensitive resources; cannot read Secrets | Auditor, read-only dashboard |
| `system:node` | Node-specific access | Kubelets |
| `system:kube-scheduler` | Scheduler-specific access | Scheduler component |

**`cluster-admin` warning:** Binding a service account or CI pipeline to `cluster-admin` is a critical security misconfiguration. A single compromised token gives full cluster control — including reading all Secrets, modifying RBAC itself, and deleting workloads. Reach for `admin` or a purpose-built ClusterRole instead.

**`edit` vs `admin`:** `admin` allows managing Roles and RoleBindings within the namespace. `edit` does not. Give developers `edit` unless they explicitly need to manage namespace-level RBAC. Never give developers `admin` cluster-wide.

### ServiceAccounts

A ServiceAccount (SA) is a namespaced Kubernetes object that provides an identity for processes running inside Pods. Every Pod runs as exactly one SA. If you don't specify one, it defaults to the `default` SA in the Pod's namespace — which should have no permissions in a hardened cluster.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: production
  annotations:
    # Optional: link to a cloud IAM role for pod-level cloud access
    # AWS IRSA — the pod's K8s token is exchanged for an AWS role credential
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/ci-deployer"
```

```yaml
# Reference the SA in a Deployment's pod spec
spec:
  serviceAccountName: ci-deployer
  automountServiceAccountToken: false   # set false when the pod never calls the K8s API
  containers:
    - name: app
      image: myapp:v1.0.0
```

When `automountServiceAccountToken` is true (the default), Kubernetes mounts a projected token at `/var/run/secrets/kubernetes.io/serviceaccount/token`. Since Kubernetes 1.24, these are time-limited **bound service account tokens** (not permanent JWTs). They expire, are audience-restricted, and are rotated automatically.

**Automount hardening baseline:** The `default` SA in most namespaces has `automountServiceAccountToken: true`. Every Pod that doesn't specify an SA gets a mounted token even if it never uses it. Disable automounting on the `default` SA as a baseline:

```bash
kubectl patch serviceaccount default -n production \
  -p '{"automountServiceAccountToken": false}'
```

**ServiceAccount token escalation:** A Pod that can create or patch Pods in a namespace can effectively grant itself any SA in that namespace. This is why `create pods`, `patch deployments`, and `create cronjobs` are sensitive verbs — they let a workload escalate to a more privileged SA without any explicit RBAC change.

### Testing and Debugging RBAC

The `kubectl auth can-i` command is the primary debugging tool. It calls the SubjectAccessReview API directly — the same mechanism the API server uses internally to evaluate requests.

```bash
# Check your own permissions
kubectl auth can-i get pods -n production
kubectl auth can-i --list -n production          # dump all permissions for current identity

# Impersonate a user or ServiceAccount (server-side simulation — safe, requires no credentials)
kubectl auth can-i delete deployments -n production --as=alice
kubectl auth can-i create secrets -n production \
  --as=system:serviceaccount:production:ci-deployer

# Impersonate a user that belongs to a group
kubectl auth can-i list nodes \
  --as=alice --as-group=backend-team

# Find all RoleBindings and ClusterRoleBindings in a namespace
kubectl get rolebindings,clusterrolebindings -n production -o wide

# Find every ClusterRoleBinding that grants cluster-admin
kubectl get clusterrolebindings -o json | \
  jq '.items[] | select(.roleRef.name=="cluster-admin") | {name: .metadata.name, subjects: .subjects}'

# Find every binding that references a specific ServiceAccount
kubectl get rolebindings,clusterrolebindings -A -o json | \
  jq '.items[] | select(.subjects[]? | .kind=="ServiceAccount" and .name=="ci-deployer")'

# Describe a binding to see its full subject list and role reference
kubectl describe rolebinding ci-deployer-binding -n production

# Quick imperative creation for testing (do not use in production manifests)
kubectl create role test-role --verb=get,list --resource=pods -n staging
kubectl create rolebinding test-binding \
  --role=test-role --user=testuser -n staging
```

**Forbidden error anatomy:** When a request is denied, the API server returns HTTP 403 with a structured message:

```
User "system:serviceaccount:production:ci-deployer" cannot update resource
"deployments" in API group "apps" in the namespace "production"
```

That message contains all three elements you need to fix it: the **subject** (`system:serviceaccount:production:ci-deployer`), the **verb + resource** (`update deployments` in `apps`), and the **namespace** (`production`). Map each field directly to a rule you need to add.

**`roleRef` immutability:** The `roleRef` field on both `RoleBinding` and `ClusterRoleBinding` is immutable after creation. If you need to change which role a binding references, you must delete and recreate the binding. The subjects list is mutable.

**`--as` is not impersonation:** `kubectl auth can-i --as=X` asks the API server "would X be allowed?" It does not give you a kubeconfig that acts as X. To actually impersonate, you need `impersonate` permission on the `users`, `groups`, or `serviceaccounts` resource — a powerful permission that should be restricted to platform admins.

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
    resources: ["secrets"]        # pipeline reads image pull credentials
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods"]           # needed to poll rollout status
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["replicasets"]    # kubectl rollout status reads replicasets
    verbs: ["get", "list", "watch"]
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

**Apply and verify:**

```bash
kubectl apply -f ci-deployer-rbac.yaml

# Confirm the SA can patch deployments
kubectl auth can-i patch deployments -n production \
  --as=system:serviceaccount:production:ci-deployer

# Confirm it cannot delete anything
kubectl auth can-i delete deployments -n production \
  --as=system:serviceaccount:production:ci-deployer
# Expected: no

# Confirm it has no access outside production
kubectl auth can-i get pods -n staging \
  --as=system:serviceaccount:production:ci-deployer
# Expected: no
```

### Example 2: Monitoring Agent with Cluster-Wide Read Access

Prometheus needs read access to pods, services, and endpoints across all namespaces, plus node metrics and non-resource URLs. This is a legitimate ClusterRoleBinding use case because monitoring is inherently cluster-wide.

```yaml
# prometheus-rbac.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-reader
rules:
  - apiGroups: [""]
    resources: ["nodes", "nodes/proxy", "nodes/metrics", "services",
                "endpoints", "pods", "configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor", "/healthz", "/version"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-reader-binding
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: monitoring          # namespace is required even in ClusterRoleBinding
roleRef:
  kind: ClusterRole
  name: prometheus-reader
  apiGroup: rbac.authorization.k8s.io
```

```bash
kubectl apply -f prometheus-rbac.yaml

# Verify cluster-wide pod read access
kubectl auth can-i list pods --all-namespaces \
  --as=system:serviceaccount:monitoring:prometheus
# Expected: yes

# Verify it cannot create or delete anything
kubectl auth can-i create pods -n default \
  --as=system:serviceaccount:monitoring:prometheus
# Expected: no

# Verify non-resource URL access
kubectl auth can-i get /metrics \
  --as=system:serviceaccount:monitoring:prometheus
# Expected: yes
```

### Example 3: Developer Namespace Access Using ClusterRole Reuse

A platform team wants all developers to have `edit` access within their team's namespace, but not outside it. Rather than creating identical Roles in each namespace, they bind the built-in `edit` ClusterRole via a namespace-scoped `RoleBinding`.

```bash
# Create the namespace for the team
kubectl create namespace team-alpha

# Bind the built-in edit ClusterRole — scoped to team-alpha only
# This is the ClusterRole-via-RoleBinding reuse pattern
kubectl create rolebinding team-alpha-edit \
  --clusterrole=edit \
  --group=team-alpha-developers \   # maps to OIDC group or cert O= field
  --namespace=team-alpha

# Verify a developer can create deployments in their namespace
kubectl auth can-i create deployments -n team-alpha \
  --as=alice --as-group=team-alpha-developers
# Expected: yes

# Verify they cannot touch other namespaces
kubectl auth can-i create deployments -n production \
  --as=alice --as-group=team-alpha-developers
# Expected: no

# Verify they cannot manage RBAC (edit role does not include this)
kubectl auth can-i create rolebindings -n team-alpha \
  --as=alice --as-group=team-alpha-developers
# Expected: no
```

### Example 4: Audit Who Has cluster-admin

Before a security review, you need to enumerate every subject that has been granted `cluster-admin`, either directly via ClusterRoleBinding or indirectly via RoleBinding in any namespace.

```bash
# Find all ClusterRoleBindings to cluster-admin
echo "=== ClusterRoleBindings to cluster-admin ==="
kubectl get clusterrolebindings -o json | jq -r '
  .items[]
  | select(.roleRef.name == "cluster-admin")
  | "Binding: \(.metadata.name) | Subjects: \(.subjects // [] | map("\(.kind)/\(.name)") | join(", "))"
'

# Find all RoleBindings to cluster-admin across all namespaces
# (less common, but valid — grants cluster-admin within the binding's namespace)
echo "=== RoleBindings to cluster-admin ==="
kubectl get rolebindings -A -o json | jq -r '
  .items[]
  | select(.roleRef.name == "cluster-admin")
  | "Namespace: \(.metadata.namespace) | Binding: \(.metadata.name) | Subjects: \(.subjects // [] | map("\(.kind)/\(.name)") | join(", "))"
'

# Export all bindings for offline audit
kubectl get clusterrolebindings,rolebindings -A -o yaml > rbac-audit-$(date +%Y%m%d).yaml
```

---

## Exercises

### Exercise 1: Build a Read-Only Namespace Role

**Goal:** Practice translating a permission requirement into a correct Role and RoleBinding.

Create a namespace called `sandbox`. In that namespace, create a ServiceAccount named `auditor`. Write a Role that allows the `auditor` SA to list and get Pods, Deployments, Services, and ConfigMaps — but explicitly does **not** grant access to Secrets or the ability to exec into pods. Bind the role to the SA.

Verify your work:
- `kubectl auth can-i list pods -n sandbox --as=system:serviceaccount:sandbox:auditor` → `yes`
- `kubectl auth can-i get secrets -n sandbox --as=system:serviceaccount:sandbox:auditor` → `no`
- `kubectl auth can-i create pods/exec -n sandbox --as=system:serviceaccount:sandbox:auditor` → `no`

**Hint:** You do not need to explicitly deny Secrets. Think about what "additive only" means for what you omit.

---

### Exercise 2: Diagnose and Fix a Forbidden Error

**Goal:** Practice reading 403 errors and tracing them back to missing rules.

Apply the following ServiceAccount and RoleBinding to a `test` namespace:

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: job-runner
  namespace: test
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: job-runner-role
  namespace: test
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: job-runner-binding
  namespace: test
subjects:
  - kind: ServiceAccount
    name: job-runner
    namespace: test
roleRef:
  kind: Role
  name: job-runner-role
  apiGroup: rbac.authorization.k8s.io
```

Now run this check and observe it fails:

```bash
kubectl auth can-i delete jobs -n test \
  --as=system:serviceaccount:test:job-runner
```

Without re-creating the RoleBinding, modify the Role so the `job-runner` SA can also delete Jobs. Verify the fix works, then check that it still cannot delete Pods — confirming you only added what was needed.

---

### Exercise 3: ClusterRole Reuse vs ClusterRoleBinding

**Goal:** Understand the difference between namespace-scoped and cluster-wide grants by observing both in practice.

1. Create a ClusterRole called `secret-reader` that grants `get` and `list` on Secrets.
2. Create two namespaces: `ns-a` and `ns-b`.
3. Create a ServiceAccount `secret-sa` in `ns-a`.
4. Bind `secret-reader` to `secret-sa` using a **RoleBinding** in `ns-a` only.
5. Verify:
   - The SA can list Secrets in `ns-a` → `yes`
   - The SA cannot list Secrets in `ns-b` → `no`
6. Now create a **ClusterRoleBinding** for the same SA to the same ClusterRole.
7. Re-run the check against `ns-b` — it should now return `yes`.
8. **Cleanup:** Delete the ClusterRoleBinding to restore least-privilege.

Explain in your own words why step 4 does not grant cluster-wide access despite using a ClusterRole.

---

### Exercise 4: Harden the Default ServiceAccount

**Goal:** Apply the automount hardening baseline to a realistic namespace setup.

1. Create a namespace called `hardened`.
2. Deploy a simple Pod that does not need Kubernetes API access:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: no-api-access
  namespace: hardened
spec:
  containers:
    - name: app
      image: busybox
      command: ["sleep", "3600"]
```

3. Exec into the pod and check whether a service account token is mounted:

```bash
kubectl exec -n hardened no-api-access -- \
  ls /var/run/secrets/kubernetes.io/serviceaccount/
```

4. Patch the `default` ServiceAccount in the `hardened` namespace to disable automounting:

```bash
kubectl patch serviceaccount default -n hardened \
  -p '{"automountServiceAccountToken": false}'
```

5. Delete and recreate the Pod. Exec in again and verify the token directory is no longer present.

6. As a follow-up: what happens if you set `automountServiceAccountToken: false` on the ServiceAccount but `automountServiceAccountToken: true` on the Pod spec? Check the Kubernetes documentation to confirm which takes precedence, then verify your answer by testing it.

---

### Quick Checks

7. Count verbs in an RBAC rule. Run: `printf 'verbs: ["get", "list", "watch"]\n' | tr ',' '\n' | grep -c '"'`

```expected_output
3
```

hint: Think about how you can split a comma-separated string into separate lines and then count occurrences of a specific character pattern.
hint: Use `tr ',' '\n'` to split on commas, then pipe to `grep -c` with a quote character as the pattern to count matching lines.

8. Extract the subject kind from a RoleBinding stub. Run: `printf 'subjects:\n- kind: ServiceAccount\n  name: myapp\n' | awk '/kind:/{print $2; exit}'`

```expected_output
ServiceAccount
```

hint: Consider using a stream processing tool that can match lines by pattern and extract specific fields from the matched line.
hint: Use awk with a pattern like /kind:/ to match the relevant line, then print the second field with $2 and use exit to stop after the first match.

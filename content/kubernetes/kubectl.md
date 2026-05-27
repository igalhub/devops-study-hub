---
title: kubectl Mastery
module: kubernetes
duration_min: 25
difficulty: intermediate
tags: [kubernetes, kubectl, commands, debugging, context, jsonpath]
exercises: 4
---

## Overview

`kubectl` is the primary interface between an operator and a Kubernetes cluster's control plane. Every action — deploying an application, inspecting a failing pod, rolling back a release, draining a node — flows through it. For a DevOps engineer, proficiency with kubectl is not optional: it is the lens through which you read the state of the system, and the scalpel with which you intervene. The difference between a senior and junior engineer under incident pressure is often just how fast and confidently they can interrogate a cluster.

kubectl communicates with the Kubernetes API server over HTTPS. Every subcommand maps to a REST operation against the API — `get` is a GET, `apply` is a server-side PATCH or POST, `delete` is a DELETE. Understanding this helps demystify error messages and teaches you that almost anything kubectl can do, you can also do with `curl` against the API server directly. This design also means kubectl is fully stateless: all cluster state lives in etcd, accessed through the API server, never locally.

In the DevOps toolchain, kubectl sits at the intersection of CI/CD pipelines, incident response, and infrastructure-as-code workflows. Pipelines call `kubectl apply` to deploy. On-call engineers call `kubectl describe` and `kubectl logs` to diagnose. Platform teams use JSONPath and custom columns to build health dashboards. Knowing the tool at depth — output formatting, context management, debugging primitives — directly translates into faster deploys and shorter mean-time-to-resolution.

---

## Concepts

### Contexts and Clusters

A kubeconfig file (default: `~/.kube/config`) holds three types of objects: **clusters** (API server endpoints + CA certs), **users** (credentials), and **contexts** (a named tuple of cluster + user + namespace). Switching context switches all three simultaneously.

```bash
# List all configured contexts (cluster + user + namespace combos)
kubectl config get-contexts

# Show current context
kubectl config current-context

# Switch context (switch cluster)
kubectl config use-context prod-cluster

# Set default namespace for current context (avoids -n flag everywhere)
kubectl config set-context --current --namespace=production

# Quick context info — shows API server URL and CoreDNS endpoint
kubectl cluster-info
```

**Multiple kubeconfig files:** Instead of merging everything into one file, you can compose configs using `KUBECONFIG`:

```bash
# Merge two configs temporarily
export KUBECONFIG=~/.kube/staging.yaml:~/.kube/prod.yaml
kubectl config get-contexts   # shows contexts from both files

# Permanently merge into a single file
kubectl config view --flatten > ~/.kube/merged.yaml
```

**kubectx + kubens** reduce context and namespace switching to a single word:

```bash
kubectx prod-cluster     # switch context
kubens production        # switch namespace
kubectx -                # switch back to previous context (like cd -)
```

**Gotcha — namespace persistence:** `kubectl config set-context --current --namespace=production` modifies your kubeconfig on disk. If you forget this is set, every command silently targets the wrong namespace. Always check `kubectl config get-contexts` (the NAMESPACE column) when joining an incident someone else started.

| Field | Where it lives | What it controls |
|-------|----------------|-----------------|
| `cluster` | kubeconfig `clusters:` | API server URL, CA certificate |
| `user` | kubeconfig `users:` | Auth method (token, cert, exec plugin) |
| `context` | kubeconfig `contexts:` | Binds cluster + user + default namespace |
| `current-context` | kubeconfig root | Which context kubectl uses by default |

---

### Getting Resources

`kubectl get` is your primary read path. Learn its flags deeply — the difference between `-o wide`, `-o yaml`, and `-o jsonpath` determines how fast you can extract what you need.

```bash
# Basic listing
kubectl get pods
kubectl get pods -n kube-system
kubectl get pods -A                  # all namespaces; adds NAMESPACE column
kubectl get pods -o wide             # adds NODE, IP, NOMINATED NODE, READINESS GATES

# Multiple resource types in one call (single API round-trip per type)
kubectl get deployments,services,ingress -n production

# Get all "standard" resources: deployments, replicasets, pods, services, etc.
kubectl get all -n production

# Watch mode — live updates without polling manually
kubectl get pods -w

# describe: human-readable deep view including Events section
kubectl describe pod myapp-abc123
kubectl describe node ip-10-0-1-5

# Raw YAML/JSON of the live resource — what the API server actually stores
kubectl get deployment myapp -o yaml
kubectl get pod myapp-abc123 -o json
```

**`describe` vs `get -o yaml`:** `describe` adds computed fields and the Events list that are not in the stored YAML. Always run `describe` first during debugging — the Events section at the bottom is where Kubernetes explains *why* something failed (e.g., `FailedScheduling`, `BackOff`, `Failed to pull image`).

**Gotcha — `kubectl get all` is not truly all:** Despite the name, `kubectl get all` does not return every resource type. It omits CRDs, PersistentVolumes, ServiceAccounts, ConfigMaps, Secrets, and more. To enumerate everything in a namespace, use:

```bash
# List every resource type present in a namespace
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -I{} kubectl get {} -n production --ignore-not-found
```

---

### Filtering and Selecting

Filtering client-side with `grep` works, but server-side filtering with labels and field selectors is faster and scales better in large clusters.

```bash
# Label selectors — match pods by label key=value
kubectl get pods -l app=myapp
kubectl get pods -l app=myapp,env=production      # AND logic
kubectl get pods -l 'env in (staging,production)' # set-based selector
kubectl get pods -l 'app!=myapp'                  # negation

# Field selectors — filter by resource fields (limited set supported server-side)
kubectl get pods --field-selector status.phase=Running
kubectl get pods --field-selector spec.nodeName=ip-10-0-1-5
kubectl get pods --field-selector status.phase!=Running,status.phase!=Succeeded

# Sort output by any JSONPath expression
kubectl get pods --sort-by='.metadata.creationTimestamp'
kubectl get pods --sort-by='.status.startTime'
kubectl get events --sort-by='.lastTimestamp'
```

**Label vs field selectors:** Labels are arbitrary metadata you define; field selectors query actual object fields. Field selectors have limited support — not every field is indexed server-side. If you get `Error: field label not supported`, that field requires client-side filtering instead.

| Selector type | Syntax | Evaluated where | Performance |
|--------------|--------|-----------------|-------------|
| Label selector | `-l app=myapp` | API server (indexed) | Fast, use freely |
| Field selector | `--field-selector status.phase=Running` | API server (limited fields) | Fast for supported fields |
| JSONPath filter | `-o jsonpath='{...}'` | Client-side | Scans full response |
| `grep` on output | `kubectl get pods \| grep name` | Client-side text | Fragile, avoid |

---

### Output Formatting

Raw `kubectl get` output is for humans. Scripts and pipelines need structured data. Master these three formats.

```bash
# Custom columns — define exactly what to show and what to name it
kubectl get pods -o custom-columns=\
NAME:.metadata.name,\
STATUS:.status.phase,\
NODE:.spec.nodeName,\
IP:.status.podIP

# JSONPath — extract a single field from one resource
kubectl get pod myapp-abc123 -o jsonpath='{.status.podIP}'

# JSONPath — extract from all items in a list
kubectl get pods -o jsonpath='{.items[*].metadata.name}'

# JSONPath — multi-field with tab/newline formatting (most useful in scripts)
kubectl get pods -o jsonpath=\
'{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.spec.nodeName}{"\n"}{end}'

# Real-world: get every deployment name and its running image across all namespaces
kubectl get deployments -A -o jsonpath=\
'{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'

# Real-world: find every pod NOT on a specific node
kubectl get pods -A -o jsonpath=\
'{range .items[?(@.spec.nodeName!="ip-10-0-1-5")]}{.metadata.name}{"\n"}{end}'
```

JSONPath quick reference:

| Expression | Meaning |
|-----------|---------|
| `.metadata.name` | Single field access |
| `.items[*]` | All elements of an array |
| `.items[0]` | First element |
| `.items[-1:]` | Last element |
| `.spec.containers[?(@.name=="app")]` | Filter array by field value |
| `{range ...}{end}` | Loop construct for lists |
| `{"\t"}` `{"\n"}` | Literal tab / newline in output |

**Gotcha — JSONPath on lists vs single resources:** When you run `kubectl get pod myapp-abc123 -o jsonpath='{.status.podIP}'`, the root is the Pod object. When you run `kubectl get pods -o jsonpath='{...}'`, the root is a PodList — so you need `.items[*]` to iterate. Forgetting this gives empty output with no error, not an error message.

**`-o json | jq` vs `-o jsonpath`:** For simple extractions, JSONPath is faster — no extra tool required. For complex filtering, conditional logic, or pretty-printing nested structures, pipe to `jq`. Both approaches are valid in production scripts; JSONPath is preferred when minimizing external tool dependencies (e.g., inside a minimal CI container).

---

### Applying and Editing

Kubernetes favors **declarative** management: you describe desired state in YAML, and the control plane reconciles actual state toward it. `kubectl apply` is the primary entry point.

```bash
# Apply a single manifest (create if absent, patch if present)
kubectl apply -f deployment.yaml

# Apply all manifests in a directory (non-recursive by default)
kubectl apply -f ./manifests/

# Apply recursively through subdirectories
kubectl apply -f ./manifests/ -R

# Apply with Kustomize overlays
kubectl apply -k ./overlays/prod/

# Dry run — validate manifest without touching the cluster
kubectl apply -f deployment.yaml --dry-run=client    # parsed locally only
kubectl apply -f deployment.yaml --dry-run=server    # sent to API, validated by admission webhooks

# Edit a live resource in $EDITOR (fetches YAML, opens editor, re-applies on save)
kubectl edit deployment myapp

# Strategic merge patch — merge a partial JSON/YAML document into the resource
kubectl patch deployment myapp -p '{"spec":{"replicas":5}}'

# JSON Patch (RFC 6902) — precise operation-based patching
kubectl patch deployment myapp --type=json \
    -p='[{"op":"replace","path":"/spec/replicas","value":5}]'

# Scale shortcut (equivalent to patching spec.replicas)
kubectl scale deployment myapp --replicas=5

# Delete by manifest (respects resource names in file)
kubectl delete -f deployment.yaml

# Delete by name
kubectl delete deployment myapp
kubectl delete pod myapp-abc123 --grace-period=0   # skip graceful termination
```

**`--dry-run=client` vs `--dry-run=server`:** Client-side dry run only checks YAML syntax and basic structure. Server-side dry run goes through all admission webhooks (OPA Gatekeeper, Kyverno, etc.) and validates against current cluster state — it's the only way to catch policy violations before applying. Use server-side in CI pipelines.

**Gotcha — `kubectl apply` vs `kubectl create`:** `create` fails if the resource already exists. `apply` is idempotent — safe to run repeatedly. Always use `apply` in pipelines. Use `create` only for one-time bootstrapping or when you want an explicit error on collision.

| Command | Idempotent | Creates | Updates | Deletes removed fields |
|---------|-----------|---------|---------|----------------------|
| `kubectl create` | No | Yes | No | N/A |
| `kubectl apply` | Yes | Yes | Yes (merge) | No (use `--prune`) |
| `kubectl replace` | No | No | Yes (full replace) | Yes |
| `kubectl patch` | Yes | No | Yes (partial) | No |

**Rollout management:** After applying a Deployment change, use `kubectl rollout` to track and control the rollout lifecycle:

```bash
# Watch rollout progress (blocks until complete or fails)
kubectl rollout status deployment/myapp

# View rollout history (requires --record on apply, or use annotations)
kubectl rollout history deployment/myapp

# Rollback to the previous revision
kubectl rollout undo deployment/myapp

# Rollback to a specific revision
kubectl rollout undo deployment/myapp --to-revision=3

# Pause a rolling update mid-flight (canary pause)
kubectl rollout pause deployment/myapp

# Resume after inspection
kubectl rollout resume deployment/myapp
```

**Gotcha — `kubectl rollout undo` is not a substitute for GitOps:** Undo writes the previous ReplicaSet template back to the Deployment, but your Git repo still reflects the broken version. Always follow an undo with a corrected `kubectl apply` from a fixed manifest — otherwise the next pipeline run re-deploys the broken version.

---

### Debugging

Debugging in Kubernetes means correlating four sources of information: Events (what the control plane tried to do), logs (what the application output), resource state (what fields say about current condition), and network reachability. kubectl gives you direct access to all four.

```bash
# Logs — basic
kubectl logs myapp-abc123
kubectl logs myapp-abc123 -c sidecar        # specific container in multi-container pod
kubectl logs myapp-abc123 --previous        # logs from the last (crashed) container instance
kubectl logs -f myapp-abc123                # stream / follow
kubectl logs myapp-abc123 --tail=100        # last N lines
kubectl logs myapp-abc123 --since=1h        # logs from the last hour
kubectl logs -l app=myapp --all-containers  # aggregate across all matching pods

# Shell access
kubectl exec -it myapp-abc123 -- /bin/bash
kubectl exec -it myapp-abc123 -c sidecar -- /bin/sh
kubectl exec myapp-abc123 -- cat /etc/resolv.conf   # non-interactive single command

# Ephemeral debug container (K8s 1.23+) — attach a debug image to a running pod
# Useful when the main container has no shell (distroless, scratch images)
kubectl debug -it myapp-abc123 --image=busybox:1.37 --target=app

# Spawn a standalone debug pod on a specific node (bypasses pod scheduling constraints)
kubectl debug node/ip-10-0-1-5 -it --image=ubuntu:22.04

# Port-forward — proxy traffic directly to a pod/service/deployment, no Ingress needed
kubectl port-forward pod/myapp-abc123 8080:8080        # local:remote
kubectl port-forward service/myapp 8080:80
kubectl port-forward deployment/myapp 8080:8080        # forwards to one pod in the deployment

# File transfer
kubectl cp myapp-abc123:/var/log/app.log ./app.log                   # pod → local
kubectl cp ./config.json myapp-abc123:/etc/app/config.json           # local → pod
kubectl cp myapp-abc123:/var/log/app.log ./app.log -c sidecar        # specify container
```

**Gotcha — `kubectl logs --previous`:** This only works while the pod still exists and has had at least one previous container termination. If the pod was deleted and rescheduled (new pod name), the previous logs are gone unless you have a log aggregation system (Loki, Elasticsearch, CloudWatch, etc.). In production, never rely solely on `kubectl logs` — always ship logs to an aggregator.

**Gotcha — `kubectl exec` into distroless containers:** Many production images are built `FROM scratch` or `FROM distroless` and contain no shell. `kubectl debug` with an ephemeral container solves this — it shares the pod's network and PID namespace, so you can inspect `/proc`, run `curl` against `localhost`, and examine the filesystem via `/proc/<pid>/root`.

**Gotcha — `kubectl cp` requires `tar` in the container:** `kubectl cp` works by running `tar` inside the container. If the image has no `tar` binary (distroless, minimal Alpine), the copy will silently fail or error. Use `kubectl debug` to attach a sidecar with tools, then copy from there.

---

### Troubleshooting Patterns

Knowing individual commands is not enough — you need a systematic diagnostic flow for each failure mode.

**Pod stuck in `Pending`:**
```bash
kubectl describe pod myapp-abc123 | grep -A 20 "Events:"
# Common causes in Events:
#   0/3 nodes are available: Insufficient memory
#   0/3 nodes are available: node(s) had untolerated taint
#   persistentvolumeclaim "my-pvc" not found

# Check available node capacity
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
CPU:.status.allocatable.cpu,\
MEM:.status.allocatable.memory,\
STATUS:.status.conditions[-1:].type
```

**Pod in `CrashLoopBackOff`:**
```bash
kubectl logs myapp-abc123 --previous    # application crash output
kubectl describe pod myapp-abc123       # check exit code and reason

# Exit code meanings:
#   exit 0  — process exited cleanly (misconfigured liveness probe likely cause)
#   exit 1  — application error
#   exit 137 — OOMKilled (SIGKILL from kernel OOM, or Docker limit)
#   exit 143 — SIGTERM not handled (graceful shutdown failed)

# If OOMKilled: spec.containers[].resources.limits.memory is too low
# If liveness probe: check probe path, port, and initialDelaySeconds
```

**Pod in `ImagePullBackOff` or `ErrImagePull`:**
```bash
kubectl describe pod myapp-abc123 | grep -A5 "Events:"
# Causes:
#   image tag does not exist → typo or tag was deleted
#   repository is private → missing imagePullSecret
#   registry is unreachable → network policy or DNS issue on node

# Inspect the pull secret content
kubectl get secret regcred -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d
```

**Service not routing traffic:**
```bash
# Step 1: check if endpoints exist — empty = selector matches no pods
kubectl get endpoints myapp-service

# Step 2: compare Service selector to pod labels
kubectl get svc myapp-service -o jsonpath='{.spec.selector}'
kubectl get pods -l app=myapp --show-labels

# Step 3: verify pod is Ready (not just Running)
kubectl get pods -l app=myapp -o custom-columns=\
NAME:.metadata.name,\
READY:.status.containerStatuses[0].ready,\
PHASE:.status.phase

# Step 4: test connectivity from inside the cluster
kubectl run curl-test --image=curlimages/curl:8.5.0 --rm -it --restart=Never \
  -- curl -v http://myapp-service.production.svc.cluster.local:80/healthz
```

**Node NotReady:**
```bash
# Check node conditions
kubectl describe node ip-10-0-1-5 | grep -A5 "Conditions:"

# List pods currently scheduled on the troubled node
kubectl get pods -A --field-selector spec.nodeName=ip-10-0-1-5

# Cordon (prevent new scheduling) before investigating
kubectl cordon ip-10-0-1-5

# Drain (evict existing pods) before maintenance or replacement
kubectl drain ip-10-0-1-5 --ignore-daemonsets --delete-emptydir-data

# Uncordon after node is healthy
kubectl uncordon ip-10-0-1-5
```

**Gotcha — `kubectl drain` and PodDisruptionBudgets:** If a Deployment has a PDB requiring at least 1 pod available and only 1 replica exists, `kubectl drain` will block indefinitely. You'll see `cannot evict pod as it would violate the pod's disruption budget`. Options: scale up the deployment first, or pass `--disable-eviction` (bypasses PDB — use carefully in production).

---

### Resource Management and Efficiency

Several kubectl patterns make day-to-day work substantially faster once internalized.

```bash
# Generate YAML scaffold without applying — great starting point for new manifests
kubectl create deployment myapp --image=nginx:1.25 --dry-run=client -o yaml > deployment.yaml
kubectl create service clusterip myapp --tcp=80:8080 --dry-run=client -o yaml >> deployment.yaml
kubectl create configmap app-config --from-file=./config/ --dry-run=client -o yaml

# Explain any field in any resource — no docs tab needed
kubectl explain pod.spec.containers.resources
kubectl explain deployment.spec.strategy.rollingUpdate
kubectl explain --recursive pod.spec   # full tree of all fields

# API resource discovery — know what CRDs and built-ins are available
kubectl api-resources                          # all resource types
kubectl api-resources --namespaced=false       # cluster-scoped only
kubectl api-resources --api-group=apps         # filter by API group
kubectl api-versions                           # all available API versions

# Check your own RBAC permissions — critical when debugging "Forbidden" errors
kubectl auth can-i create deployments -n production
kubectl auth can-i '*' '*'                     # am I cluster-admin?
kubectl auth can-i list secrets -n kube-system --as=system:serviceaccount:default:myapp

# Top — live resource consumption (requires metrics-server installed)
kubectl top nodes
kubectl top pods -n production
kubectl top pods -n production --sort-by=memory
kubectl top pods -n production --containers     # per-container breakdown
```

**`kubectl explain` in interviews:** Interviewers often ask about specific YAML fields. `kubectl explain` gives you the authoritative answer without memorizing specs. In a live coding screen where you have terminal access, this command is always available — use it.

**Gotcha — `kubectl top` requires metrics-server:** `kubectl top` does not work on a bare cluster. It requires the `metrics-server` aggregated API. If you get `error: Metrics API not available`, either metrics-server isn't installed or it's not healthy. Check with `kubectl get apiservice v1beta1.metrics.k8s.io`.

---

## Examples

### Example 1: Full Deploy, Verify, and Rollback Cycle

This demonstrates the complete deployment lifecycle a CI/CD pipeline performs, ending with a controlled rollback.

```bash
# 1. Write a deployment manifest
cat <<'EOF' > myapp-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
  labels:
    app: myapp
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # allow one extra pod during update
      maxUnavailable: 0  # never reduce below desired count (zero-downtime)
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: app
        image: nginx:1.24   # intentionally older version; we'll upgrade
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 250m
            memory: 256Mi
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5
EOF

# 2. Server-side dry run — validates against admission webhooks
kubectl apply -f myapp-deployment.yaml --dry-run=server

# 3. Apply for real
kubectl apply -f myapp-deployment.yaml

# 4. Watch rollout converge
kubectl rollout status deployment/myapp -n production
# Output: Waiting for deployment "myapp" rollout to finish: 0 of 3 updated replicas are available...
# Output: deployment "myapp" successfully rolled out

# 5. Verify: all pods Running and Ready
kubectl get pods -n production -l app=myapp -o wide

# 6. Simulate an upgrade to a broken image
kubectl set image deployment/myapp app=nginx:broken-tag -n production

# 7. Watch the rollout fail
kubectl rollout status deployment/myapp -n production
# Output: error: deployment "myapp" exceeded its progress deadline

# 8. Confirm: some pods in ImagePullBackOff
kubectl get pods -n production -l app=myapp

# 9. Rollback to the last good revision
kubectl rollout undo deployment/myapp -n production

# 10. Verify recovery
kubectl rollout status deployment/myapp -n production
kubectl get pods -n production -l app=myapp
```

---

### Example 2: Debugging a CrashLoopBackOff from Scratch

Simulates a misconfigured application and walks through the full diagnosis.

```bash
# 1. Deploy a pod that immediately crashes (bad command)
kubectl run crasher \
  --image=busybox:1.37 \
  --restart=Always \
  -n default \
  -- /bin/sh -c "echo 'starting'; exit 1"

# 2. Check pod status after a few seconds
kubectl get pod crasher
# NAME      READY   STATUS             RESTARTS   AGE
# crasher   0/1     CrashLoopBackOff   3          45s

# 3. Read the crash output from the previous container instance
kubectl logs crasher --previous
# Output: starting

# 4. Describe to see exit code and restart count
kubectl describe pod crasher | grep -A 10 "Last State:"
# Last State: Terminated
#   Reason: Error
#   Exit Code: 1
#   ...

# 5. Fix: update the command to not exit with error
kubectl delete pod crasher
kubectl run crasher \
  --image=busybox:1.37 \
  --restart=Always \
  -n default \
  -- /bin/sh -c "echo 'running'; sleep 3600"

# 6. Verify
kubectl get pod crasher
# NAME      READY   STATUS    RESTARTS   AGE
# crasher   1/1     Running   0          10s

# Cleanup
kubectl delete pod crasher
```

---

### Example 3: Service Connectivity Diagnosis

Debugs a Service that appears healthy but receives no traffic.

```bash
# 1. Create a deployment and a deliberately misconfigured Service
kubectl create deployment web --image=nginx:1.25 --replicas=2 -n production

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: production
spec:
  selector:
    app: web-typo   # BUG: should be "app: web"
  ports:
  - port: 80
    targetPort: 80
EOF

# 2. Check endpoints — should be populated if selector matches
kubectl get endpoints web-svc -n production
# NAME      ENDPOINTS   AGE
# web-svc   <none>      5s    ← selector matches nothing

# 3. Compare selector to pod labels
kubectl get svc web-svc -n production -o jsonpath='{.spec.selector}'
# {"app":"web-typo"}

kubectl get pods -n production -l app=web --show-labels
# NAME             READY   STATUS    LABELS
# web-xxx   1/1   Running   app=web,pod-template-hash=...

# 4. Fix the selector
kubectl patch svc web-svc -n production \
  -p '{"spec":{"selector":{"app":"web"}}}'

# 5. Verify endpoints are now populated
kubectl get endpoints web-svc -n production
# NAME      ENDPOINTS                         AGE
# web-svc   10.0.0.5:80,10.0.0.6:80          10s

# 6. Confirm reachability from inside the cluster
kubectl run curl-test --image=curlimages/curl:8.5.0 --rm -it \
  --restart=Never -n production \
  -- curl -s -o /dev/null -w "%{http_code}" http://web-svc.production.svc.cluster.local/
# 200

# Cleanup
kubectl delete deployment web -n production
kubectl delete svc web-svc -n production
```

---

### Example 4: Multi-Cluster JSONPath Report

Generates a cross-namespace image inventory — useful for auditing image versions before a CVE patch.

```bash
# Report: namespace, deployment name, container name, image — across entire cluster
kubectl get deployments -A -o jsonpath=\
'{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{range .spec.template.spec.containers[*]}{.name}{"\t"}{.image}{"\n"}{end}{end}' \
| column -t \
| sort

# Sample output:
# kube-system   coredns          coredns    registry.k8s.io/coredns/coredns:v1.10.1
# production    myapp            app        nginx:1.25
# production    myapp            sidecar    envoyproxy/envoy:v1.28.0
# staging       myapp            app        nginx:1.26-beta   ← spot the drift

# Find all deployments NOT using a pinned tag (using :latest or no tag)
kubectl get deployments -A -o json \
| jq -r '.items[] | 
    .metadata.namespace + "\t" + .metadata.name + "\t" + 
    (.spec.template.spec.containers[].image) 
  | select(test(":latest$|^[^:]+$"))'
# Outputs anything with :latest or missing tag — a security/reproducibility risk
```

---

## Exercises

### Exercise 1: Context and Namespace Safety

**Goal:** Understand how namespace defaults affect every command and practice safe context hygiene.

1. Run `kubectl config get-contexts` and note which context is active and what namespace is set (if any).
2. Set the default namespace for your current context to `kube-system` using `kubectl config set-context`.
3. Run `kubectl get pods` without any `-n` flag. Observe what namespace the results come from.
4. Switch the default namespace back to `default`.
5. Write a one-liner that prints the current context name and its configured namespace using only `kubectl config` subcommands — no `grep`, no `awk`.

**Challenge:** Without switching context, run a single `kubectl get pods` command that targets the `kube-system` namespace of a *different* context than the one currently active. (Hint: `--context` flag.)

---

### Exercise 2: JSONPath Extraction Under Pressure

**Goal:** Build the muscle memory for JSONPath before you need it during an incident.

You have a cluster with several pods running. Answer the following questions using only `kubectl get` with `-o jsonpath` or `-o custom-columns` — no `grep`, no `jq`, no `awk`:

1. Print only the IP addresses of all running pods in the `default` namespace, one per line.
2. Print the name and image of the *first* container in every pod across all namespaces, formatted as `namespace/pod-name: image`.
3. Find any pod whose `status.phase` is not `Running` and print its name and phase. (Hint: JSONPath filter expressions support `!=`.)
4. Print the `nodeName` that each pod in `default` is scheduled on, alongside the pod name.

**Verify:** Each answer should be a single `kubectl` command. If you find yourself reaching for a second command, you're not using JSONPath deeply enough.

---

### Exercise 3: Deployment Rollout and Recovery

**Goal:** Practice the full deploy-break-diagnose-recover cycle without external hints.

1. Create a Deployment named `exercise-app` in a namespace called `exercise` using image `nginx:1.25`, with 3 replicas and a `rollingUpdate` strategy of `maxUnavailable: 0, maxSurge: 1`.
2. Verify all 3 pods are `Running` and `Ready` before proceeding.
3. Update the image to `nginx:does-not-exist` using `kubectl set image`.
4. Without being told what's wrong, use `kubectl describe` and `kubectl get` commands to identify the failure reason and which pods are affected.
5. Roll back to the previous revision and confirm all 3 replicas recover.
6. Print the rollout history showing both revisions.

**Cleanup:** Delete the `exercise` namespace when done.

---

### Exercise 4: Service Debugging Without Hints

**Goal:** Diagnose a broken service from symptoms to root cause using a structured approach.

Apply the following manifests to your cluster:

```yaml
# Save as broken-scenario.yaml and apply with kubectl apply -f broken-scenario.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
      - name: app
        image: hashicorp/http-echo:1.0.0
        args: ["-text=hello"]
        ports:
        - containerPort: 5678
---
apiVersion: v1
kind: Service
metadata:
  name: backend-svc
  namespace: default
spec:
  selector:
    app: backend
    tier: api          # extra label that pods don't have
  ports:
  - port: 80
    targetPort: 5678
```

Without reading the YAML above after applying it:

1. Check whether `backend-svc` has any endpoints. Document the command you used.
2. Identify why the Service has no endpoints by comparing the Service selector against actual pod labels. Document what you found.
3. Fix the Service using `kubectl patch` — do not re-apply the YAML file.
4. Confirm connectivity by running a temporary curl pod inside the cluster targeting `backend-svc`.
5. As a final check, explain in one sentence what would have happened if the Service selector had a label the pods *did* have but with a wrong value (e.g., `tier: frontend` instead of `tier: api`).
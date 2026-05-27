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
|-------|---------------|-----------------|
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
|--------------|--------|----------------|------------|
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

**Gotcha — JSONPath on lists vs single resources:** When you run `kubectl get pod myapp-abc123 -o jsonpath='{.status.podIP}'`, the root is the Pod object. When you run `kubectl get pods -o jsonpath='{...}'`, the root is a PodList — so you need `.items[*]` to iterate. Forgetting this gives empty output with no error.

---

### Applying and Editing

Kubernetes favors **declarative** management: you describe desired state in YAML, and the control plane reconciles actual state toward it. `kubectl apply` is the primary entry point.

```bash
# Apply a single manifest (create if absent, patch if present)
kubectl apply -f deployment.yaml

# Apply all manifests in a directory (non-recursive by default)
kubectl apply -f ./manifests/

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
| `kubectl apply` | Yes | Yes | Yes (merge) | No (use `prune`) |
| `kubectl replace` | No | No | Yes (full replace) | Yes |
| `kubectl patch` | Yes | No | Yes (partial) | No |

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

# Port-forward — proxy traffic directly to a pod/service/deployment, no Service needed
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
kubectl get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory
```

**Pod in `CrashLoopBackOff`:**
```bash
kubectl logs myapp-abc123 --previous    # application crash output
kubectl describe pod myapp-abc123       # check: OOMKilled, liveness probe failures
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
kubectl get secret regcred -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d
```

**Service not routing traffic:**
```bash
kubectl get endpoints myapp-service
# Empty ENDPOINTS column = no pods match the Service selector
kubectl get svc myapp-service -o jsonpath='{.spec
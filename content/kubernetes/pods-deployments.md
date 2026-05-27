---
title: Pods & Deployments
module: kubernetes
duration_min: 25
difficulty: intermediate
tags: [kubernetes, pods, deployments, replicas, rolling-update, kubectl]
exercises: 4
---

## Overview

The Pod is the smallest deployable unit in Kubernetes — one or more containers sharing a network namespace, storage volumes, and an IP address. Containers inside a Pod communicate over `localhost` and see the same filesystem mounts. This co-location model solves a specific problem: tightly coupled processes (an app and a log-shipper sidecar, for example) that must run on the same machine but should remain independently packaged as container images. In practice, most Pods contain exactly one container; the multi-container pattern is reserved for sidecars, init containers, and adapters.

You almost never create a Pod directly in production. A raw Pod has no self-healing: if the node it runs on dies, the Pod disappears and nothing replaces it. The **Deployment** controller exists to solve this. A Deployment declares desired state — "I want three replicas of this image, updated with zero downtime" — and a control loop continuously reconciles the cluster toward that state. Under the hood, a Deployment manages a **ReplicaSet**, which manages the individual Pods. Each time you change the Deployment's pod template (e.g., a new image tag), Kubernetes creates a new ReplicaSet and migrates traffic to it gradually, preserving rollback capability.

In the DevOps toolchain, Deployments are the primary target of your CI/CD pipeline. Your pipeline builds an image, pushes it to a registry, and then either calls `kubectl set image` or applies an updated manifest. Everything downstream — traffic routing via Services, autoscaling via HPA, observability via pod labels — depends on Deployments being correctly configured. Understanding how Pods and Deployments work internally lets you debug failed rollouts, tune update strategies for your traffic patterns, and write manifests that survive production load.

---

## Concepts

### The Object Hierarchy

```
Deployment
  └── ReplicaSet (one per revision — old ones are retained for rollback)
        └── Pod(s)
              └── Container(s)
```

The Deployment owns multiple ReplicaSets but only one is "active" (desired replicas > 0) at any time. During a rolling update, two ReplicaSets are briefly active simultaneously — the old one scales down while the new one scales up. This is why rollback is instant: Kubernetes simply scales the old ReplicaSet back up.

```bash
# See the ReplicaSets owned by a Deployment
kubectl get replicasets -l app=myapp -n production

# Output shows two RS during a rollout:
# NAME               DESIRED   CURRENT   READY   AGE
# myapp-7d9f8b6c4    3         3         3       2d     <- current
# myapp-5c6d7e8f9    0         0         0       5d     <- retained for rollback
```

**The `.spec.revisionHistoryLimit` field** (default: 10) controls how many old ReplicaSets are kept. Set it to 0 and you lose rollback capability entirely. A value of 3–5 is typical for production.

---

### Pod Spec

A Pod spec is embedded inside every Deployment's `.spec.template`. Understanding it deeply means understanding what Kubernetes actually runs.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp-pod
  labels:
    app: myapp
    env: production
    version: v1.2.3        # useful for canary analysis and traffic splitting
spec:
  containers:
    - name: app
      image: myapp:v1.2.3
      ports:
        - containerPort: 8080   # informational only — doesn't actually expose anything
      env:
        - name: DB_HOST
          value: "db.default.svc.cluster.local"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:       # pull sensitive values from a Secret, not plain env
              name: db-secret
              key: password
      resources:
        requests:               # used by scheduler to find a node with enough capacity
          cpu: "100m"           # 100 millicores = 0.1 vCPU
          memory: "128Mi"
        limits:                 # kubelet enforces this ceiling at runtime
          cpu: "500m"
          memory: "512Mi"
      readinessProbe:
        httpGet:
          path: /health
          port: 8080
        initialDelaySeconds: 5
        periodSeconds: 10
      livenessProbe:
        httpGet:
          path: /health
          port: 8080
        initialDelaySeconds: 15
        failureThreshold: 3
```

**Resources — requests vs limits:**

| Field | Who uses it | What happens if exceeded |
|---|---|---|
| `requests.cpu` | Scheduler (placement) | Nothing — it's a soft guarantee |
| `requests.memory` | Scheduler + QoS class | Nothing — it's a soft guarantee |
| `limits.cpu` | kubelet (cgroups) | CPU is **throttled** — container slows down |
| `limits.memory` | kubelet (cgroups) | Container is **OOMKilled** and restarted |

**Memory limit gotcha:** CPU throttling is silent and hard to detect without metrics. A container hitting its CPU limit won't crash — it'll just be mysteriously slow. Always check `container_cpu_throttled_seconds_total` in Prometheus if latency is unexpectedly high.

**QoS classes** are assigned automatically based on resources:

| Class | Condition | Eviction priority |
|---|---|---|
| `Guaranteed` | requests == limits for all containers | Last to be evicted |
| `Burstable` | requests set but not equal to limits | Middle priority |
| `BestEffort` | No requests or limits set | First to be evicted |

---

### Probes

Probes are how Kubernetes decides whether a container is healthy. Getting them right is one of the most impactful things you can do for production reliability.

| Probe | Question it answers | Failure action |
|---|---|---|
| `readinessProbe` | Is this container ready to receive traffic? | Pod removed from Service endpoints — not restarted |
| `livenessProbe` | Is this container still alive and functional? | Container is killed and restarted |
| `startupProbe` | Has the container finished its startup sequence? | Blocks liveness/readiness checks until it passes |

```yaml
# Probe handler types
readinessProbe:
  httpGet:              # HTTP GET — pass if status 200-399
    path: /ready
    port: 8080
  # tcpSocket:          # TCP connect — pass if port accepts connection
  #   port: 5432
  # exec:               # Run a command — pass if exit code 0
  #   command: ["pg_isready", "-U", "postgres"]

  initialDelaySeconds: 5    # wait before first check
  periodSeconds: 10         # how often to check
  timeoutSeconds: 3         # how long to wait for a response
  failureThreshold: 3       # consecutive failures before action
  successThreshold: 1       # consecutive successes to become ready again
```

**Startup probe pattern for slow-starting apps:**
Without a startup probe, a Java app that takes 60 seconds to start will be killed by the liveness probe before it's ready. Use `startupProbe` to give it time:

```yaml
startupProbe:
  httpGet:
    path: /health
    port: 8080
  failureThreshold: 30   # 30 * periodSeconds(10) = 300s max startup time
  periodSeconds: 10

livenessProbe:           # only activates after startupProbe passes
  httpGet:
    path: /health
    port: 8080
  periodSeconds: 15
  failureThreshold: 3
```

**Liveness probe warning:** a liveness probe that hits a slow database query can cause mass restarts under load — every pod restarts, amplifying the load, causing more restarts. Keep liveness probes checking only the process itself (is the event loop alive?), not external dependencies. Use readiness probes to signal dependency unavailability.

---

### Deployment Spec

The Deployment spec wraps a Pod template and adds scheduling policy, replica count, and update strategy.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
  annotations:
    kubernetes.io/change-cause: "Bump to v1.3.0 — fix memory leak"  # shows in rollout history
spec:
  replicas: 3
  revisionHistoryLimit: 5      # keep last 5 ReplicaSets for rollback
  selector:
    matchLabels:
      app: myapp               # immutable after creation — must match template labels
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1              # max pods above desired count during update
      maxUnavailable: 0        # max pods below desired count during update
  template:
    metadata:
      labels:
        app: myapp             # must match selector.matchLabels
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: app
          image: myapp:v1.3.0
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
```

**Selector immutability:** `.spec.selector` cannot be changed after the Deployment is created. If you need to change it, you must delete and recreate the Deployment. This is a common source of confusion when refactoring label schemes.

---

### Update Strategies

```yaml
# RollingUpdate — default, recommended for stateless services
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1          # can be absolute (1) or percentage ("25%")
    maxUnavailable: 0    # zero-downtime: new pod must be Ready before old pod is removed

# Recreate — terminates all old pods before creating new ones
# Use for: stateful apps that cannot run two versions simultaneously,
#          database schema migrations that are not backward-compatible
strategy:
  type: Recreate
```

**maxSurge and maxUnavailable tradeoffs:**

| Setting | Behavior | Best for |
|---|---|---|
| `maxSurge: 1, maxUnavailable: 0` | Always has ≥ desired replicas; slowest update | Production, zero-downtime |
| `maxSurge: 0, maxUnavailable: 1` | Saves resources; capacity drops during update | Dev/staging, resource-constrained clusters |
| `maxSurge: 25%, maxUnavailable: 25%` | Parallel replace; fastest rollout | Large deployments where some drop is acceptable |

**Both cannot be zero.** Setting both to 0 is rejected by the API server — the rollout would be impossible.

---

### Rollouts and Rollbacks

```bash
# Trigger a rollout by updating the image
kubectl set image deployment/myapp app=myapp:v1.3.0 -n production

# Or apply a modified manifest (idempotent — Kubernetes computes the diff)
kubectl apply -f deployment.yaml

# Watch rollout progress in real time — exits 0 on success, non-zero on timeout
kubectl rollout status deployment/myapp -n production

# View rollout history (change-cause comes from the annotation)
kubectl rollout history deployment/myapp -n production
# REVISION  CHANGE-CAUSE
# 1         Initial deployment v1.2.3
# 2         Bump to v1.3.0 — fix memory leak

# Inspect a specific revision
kubectl rollout history deployment/myapp --revision=2 -n production

# Roll back to the previous revision (swaps to the prior ReplicaSet — nearly instant)
kubectl rollout undo deployment/myapp -n production

# Roll back to a specific revision
kubectl rollout undo deployment/myapp --to-revision=1 -n production

# Pause a rollout mid-flight (e.g., to manually verify canary pods)
kubectl rollout pause deployment/myapp -n production

# Resume after inspection
kubectl rollout resume deployment/myapp -n production
```

**Rollout vs apply:** `kubectl rollout undo` restores the previous pod template spec (image, env, resources, probes) but does NOT restore the replica count if you scaled it separately. If you scaled to 10 replicas manually and roll back, you stay at 10 replicas with the old image.

---

### Pod Lifecycle and Restart Policies

| Phase | Meaning | Common cause |
|---|---|---|
| `Pending` | Accepted by cluster, not yet running | Insufficient resources, image pull in progress, PVC binding |
| `Running` | At least one container is running | Normal state |
| `Succeeded` | All containers exited 0 | Completed Jobs, init containers |
| `Failed` | At least one container exited non-zero | Application crash, OOMKill |
| `Unknown` | Node not reporting | Node network partition, node crash |

```yaml
spec:
  restartPolicy: Always      # default — kubelet restarts containers on any exit
  # restartPolicy: OnFailure # restart only on non-zero exit; use in Jobs
  # restartPolicy: Never     # no restart; use for one-shot batch Jobs
```

**CrashLoopBackOff** is not a Pod phase — it's a container state. It means the container keeps crashing and kubelet is applying exponential backoff (10s, 20s, 40s, up to 5min) before restarting it. Diagnose with:

```bash
# Get the last few lines of a crashed container's logs
kubectl logs pod/myapp-abc123 --previous -n production

# Describe the pod for exit codes and last state
kubectl describe pod myapp-abc123 -n production
# Look for: "Last State: Terminated  Reason: OOMKilled" or "Error"
```

**Exit code reference:**

| Exit code | Meaning |
|---|---|
| `0` | Clean exit |
| `1` | Application error |
| `137` | OOMKilled (128 + signal 9) |
| `143` | Graceful termination (128 + signal 15) |

---

### kubectl Essentials for Daily Operations

```bash
# List pods with node assignment and IP
kubectl get pods -o wide -n production

# Watch pods in real time
kubectl get pods -w -n production

# Get pods by label selector
kubectl get pods -l app=myapp,env=production -n production

# Exec into a running container
kubectl exec -it pod/myapp-abc123 -n production -- /bin/sh

# Stream logs
kubectl logs -f deployment/myapp -n production          # follows any pod in the deployment
kubectl logs pod/myapp-abc123 -c app -n production      # specific container

# Copy files to/from a pod (debugging)
kubectl cp myapp-abc123:/tmp/heapdump.hprof ./heapdump.hprof -n production

# Force-delete a stuck terminating pod (last resort)
kubectl delete pod myapp-abc123 --grace-period=0 --force -n production

# Scale replicas imperatively (fine for urgent fixes; commit to git afterward)
kubectl scale deployment/myapp --replicas=5 -n production

# Patch a field without touching the full manifest
kubectl patch deployment myapp -n production \
  -p '{"spec":{"template":{"spec":{"terminationGracePeriodSeconds":60}}}}'
```

**`kubectl apply` vs `kubectl replace`:** `apply` does a server-side merge patch and is idempotent — safe to run from CI/CD. `replace` requires the full manifest and fails if the object doesn't exist. Always use `apply` in pipelines.

---

## Examples

### Example 1: Zero-Downtime Rolling Deployment

This is the standard production pattern: no traffic drop during updates, slow enough to catch bad deploys before they affect all pods.

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: production
  annotations:
    kubernetes.io/change-cause: "v2.0.0 — migrate to new auth service"
spec:
  replicas: 3
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app: api
  strategy:
    type: RollingUpdate
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

The Deployment owns multiple ReplicaSets but only one is "active" (desired replicas > 0) at any time. During a rolling update, two ReplicaSets are briefly active simultaneously — the old one scales down while the new one scales up. This is why rollback is nearly instant: Kubernetes simply scales the old ReplicaSet back up rather than rebuilding anything.

```bash
# See the ReplicaSets owned by a Deployment
kubectl get replicasets -l app=myapp -n production

# Output shows two RS during a rollout:
# NAME               DESIRED   CURRENT   READY   AGE
# myapp-7d9f8b6c4    3         3         3       2d     <- current
# myapp-5c6d7e8f9    0         0         0       5d     <- retained for rollback
```

**The `.spec.revisionHistoryLimit` field** (default: 10) controls how many old ReplicaSets are kept. Set it to 0 and you lose rollback capability entirely. A value of 3–5 is typical for production.

**ReplicaSets are not meant to be managed directly.** If you manually delete a ReplicaSet owned by a Deployment, the Deployment controller will recreate it. Always interact with the Deployment, not its children.

---

### Pod Spec

A Pod spec is embedded inside every Deployment's `.spec.template`. Understanding it deeply means understanding what Kubernetes actually schedules and runs.

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
        - containerPort: 8080   # informational only — does NOT expose or bind anything
      env:
        - name: DB_HOST
          value: "db.default.svc.cluster.local"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:       # pull sensitive values from a Secret, not plaintext env
              name: db-secret
              key: password
      resources:
        requests:               # used by the scheduler to find a node with enough capacity
          cpu: "100m"           # 100 millicores = 0.1 vCPU
          memory: "128Mi"
        limits:                 # kubelet enforces this ceiling at runtime via cgroups
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
| `requests.cpu` | Scheduler (placement decisions) | Nothing at runtime — soft guarantee |
| `requests.memory` | Scheduler + QoS class assignment | Nothing at runtime — soft guarantee |
| `limits.cpu` | kubelet via cgroups | CPU is **throttled** — container slows down silently |
| `limits.memory` | kubelet via cgroups | Container is **OOMKilled** and restarted |

**CPU throttling is invisible without metrics.** A container hitting its CPU limit won't crash — it will just be mysteriously slow. Always instrument `container_cpu_throttled_seconds_total` in Prometheus when debugging unexpected latency increases.

**QoS classes** are assigned automatically based on how resources are configured:

| Class | Condition | Eviction priority |
|---|---|---|
| `Guaranteed` | `requests == limits` for every container | Last to be evicted under node pressure |
| `Burstable` | At least one container has requests set, but not equal to limits | Middle priority |
| `BestEffort` | No requests or limits set on any container | First to be evicted |

For production workloads, aim for `Guaranteed` QoS on critical services by setting `requests == limits`. For batch jobs or non-critical background tasks, `Burstable` is acceptable.

---

### Probes

Probes are how Kubernetes decides whether a container is healthy and whether it should receive traffic. Getting them right is one of the highest-leverage configuration decisions for production reliability.

| Probe | Question it answers | Failure action |
|---|---|---|
| `readinessProbe` | Is this container ready to serve traffic? | Pod is removed from Service endpoints — **not** restarted |
| `livenessProbe` | Is this container still alive and functional? | Container is killed and restarted by kubelet |
| `startupProbe` | Has the container finished its startup sequence? | Blocks liveness and readiness checks until it passes |

```yaml
# Probe handler types — choose one per probe
readinessProbe:
  httpGet:              # HTTP GET to the specified path — passes on HTTP 200-399
    path: /ready
    port: 8080
  # tcpSocket:          # TCP connect — passes if the port accepts a connection
  #   port: 5432
  # exec:               # Runs a shell command — passes if exit code is 0
  #   command: ["pg_isready", "-U", "postgres"]

  initialDelaySeconds: 5    # seconds to wait after container starts before first check
  periodSeconds: 10         # how often to run the check
  timeoutSeconds: 3         # how long to wait for a response before counting as failure
  failureThreshold: 3       # consecutive failures required before taking action
  successThreshold: 1       # consecutive successes required to mark ready again
```

**Startup probe pattern for slow-starting apps:**
Without a startup probe, a JVM app that takes 60 seconds to initialize will be killed by the liveness probe before it finishes starting. The `startupProbe` effectively disables liveness and readiness checks during the startup window.

```yaml
startupProbe:
  httpGet:
    path: /health
    port: 8080
  failureThreshold: 30   # 30 checks × 10s period = 300s max startup window
  periodSeconds: 10

livenessProbe:           # only activates after startupProbe passes
  httpGet:
    path: /health
    port: 8080
  periodSeconds: 15
  failureThreshold: 3
```

**Liveness probe anti-pattern:** a liveness probe that checks an external dependency (database connectivity, upstream API) will cause mass container restarts when that dependency goes down. Every pod restarts simultaneously, amplifying load, causing more failures, causing more restarts. **Liveness probes should check only whether the process itself is alive** (event loop responding, not deadlocked). Use readiness probes to signal that a dependency is temporarily unavailable — this removes the pod from load balancer rotation without restarting it.

---

### Deployment Spec

The Deployment spec wraps a Pod template and adds scheduling policy, replica count, update strategy, and revision tracking.

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
      app: myapp               # immutable after creation — must match pod template labels
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1              # max pods above desired count during update (absolute or %)
      maxUnavailable: 0        # max pods below desired count during update (absolute or %)
  template:
    metadata:
      labels:
        app: myapp             # must match selector.matchLabels exactly
    spec:
      terminationGracePeriodSeconds: 30   # time kubelet waits after SIGTERM before SIGKILL
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

**Selector immutability:** `.spec.selector` cannot be changed after the Deployment is created. If you need to change label selectors (e.g., adding a new required label), you must delete and recreate the Deployment. This is a common source of confusion when teams refactor their label taxonomy.

**`terminationGracePeriodSeconds`** is the window between kubelet sending SIGTERM to a container and force-killing it with SIGKILL. Your application must handle SIGTERM and finish in-flight requests within this window. 30 seconds is the default; HTTP services with long-running requests may need 60–90 seconds. If your app ignores SIGTERM entirely, requests will be dropped.

---

### Update Strategies

```yaml
# RollingUpdate — default; recommended for stateless services
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1          # can be absolute (1) or percentage ("25%")
    maxUnavailable: 0    # zero-downtime: new pod must be Ready before old pod is removed

# Recreate — terminates ALL old pods before creating any new ones
# Causes downtime; use only when two versions cannot coexist:
#   - apps with exclusive file locks
#   - database schema migrations that are not backward-compatible
strategy:
  type: Recreate
```

**maxSurge and maxUnavailable tradeoffs:**

| Setting | Behavior | Best for |
|---|---|---|
| `maxSurge: 1, maxUnavailable: 0` | Always has ≥ desired replicas; one pod added then one removed | Production zero-downtime |
| `maxSurge: 0, maxUnavailable: 1` | Capacity dips during update; no extra nodes needed | Dev/staging, resource-constrained clusters |
| `maxSurge: 25%, maxUnavailable: 25%` | Fast parallel rollout; some capacity drop acceptable | Large deployments where speed matters |
| `maxSurge: 100%, maxUnavailable: 0` | Doubles pods during rollout; effectively blue/green | When you have spare cluster capacity |

**Both cannot be zero simultaneously.** Setting `maxSurge: 0` and `maxUnavailable: 0` is rejected by the API server — there would be no mechanism to make progress on the rollout.

**Percentage rounding:** `maxUnavailable` rounds down, `maxSurge` rounds up. With 3 replicas and `maxUnavailable: 25%`, that rounds down to 0 — effectively zero-downtime behavior even though you specified a percentage.

---

### Rollouts and Rollbacks

```bash
# Trigger a rollout by updating the image
kubectl set image deployment/myapp app=myapp:v1.3.0 -n production

# Or apply a modified manifest — idempotent; Kubernetes computes the diff
kubectl apply -f deployment.yaml

# Watch rollout progress — exits 0 on success, non-zero on timeout
kubectl rollout status deployment/myapp -n production --timeout=5m

# View rollout history (change-cause comes from the annotation)
kubectl rollout history deployment/myapp -n production
# REVISION  CHANGE-CAUSE
# 1         Initial deployment v1.2.3
# 2         Bump to v1.3.0 — fix memory leak

# Inspect the full pod template for a specific revision
kubectl rollout history deployment/myapp --revision=2 -n production

# Roll back to the previous revision — nearly instant (rescales existing ReplicaSet)
kubectl rollout undo deployment/myapp -n production

# Roll back to a specific revision
kubectl rollout undo deployment/myapp --to-revision=1 -n production

# Pause mid-rollout to manually inspect canary pods before continuing
kubectl rollout pause deployment/myapp -n production

# Resume after inspection
kubectl rollout resume deployment/myapp -n production
```

**What rollback does and does not restore:** `kubectl rollout undo` restores the previous pod template spec — image, env vars, resource limits, probe config. It does **not** restore replica count if you scaled the Deployment separately after the original rollout. If you scaled from 3 to 10 replicas manually and then roll back, you stay at 10 replicas running the old image.

**Tracking rollout completion in CI/CD:** `kubectl rollout status` blocks until the rollout completes or times out and returns a non-zero exit code on failure. This makes it suitable as a pipeline gate:

```bash
kubectl apply -f deployment.yaml
kubectl rollout status deployment/myapp -n production --timeout=10m || {
  echo "Rollout failed — rolling back"
  kubectl rollout undo deployment/myapp -n production
  exit 1
}
```

---

### Pod Lifecycle and Restart Policies

| Phase | Meaning | Common causes |
|---|---|---|
| `Pending` | Accepted by cluster, not yet scheduled or running | Insufficient resources, image pull in progress, PVC binding |
| `Running` | At least one container is running | Normal operating state |
| `Succeeded` | All containers exited 0 | Completed Jobs, finished init containers |
| `Failed` | At least one container exited non-zero | Application crash, OOMKill |
| `Unknown` | Node stopped reporting status | Node network partition, node crash |

```yaml
spec:
  restartPolicy: Always      # default — kubelet restarts containers on any exit
  # restartPolicy: OnFailure # restart only on non-zero exit; use in Jobs
  # restartPolicy: Never     # no restart at all; use for one-shot batch tasks
```

**CrashLoopBackOff** is not a Pod phase — it is a container state. It means the container keeps crashing and kubelet is applying exponential backoff (10s → 20s → 40s → up to 5m) before attempting each restart. The backoff resets if the container runs successfully for 10 minutes.

```bash
# Fetch logs from the previous (crashed) container instance
kubectl logs pod/myapp-abc123 --previous -n production

# Describe the pod for exit codes, last state, and event history
kubectl describe pod myapp-abc123 -n production
# Key fields to look at:
#   Last State: Terminated  Reason: OOMKilled  Exit Code: 137
#   Events: section at the bottom shows scheduling and pull events
```

**Exit code reference:**

| Exit code | Meaning |
|---|---|
| `0` | Clean exit — intentional shutdown |
| `1` | Generic application error |
| `2` | Misuse of shell or invalid argument |
| `137` | OOMKilled — 128 + SIGKILL (signal 9) |
| `143` | Graceful termination — 128 + SIGTERM (signal 15) |
| `126` | Permission denied — container couldn't execute the command |
| `127` | Command not found in the container image |

Exit code 137 appearing in `kubectl describe` means the container was killed by the kernel out-of-memory manager — raise `limits.memory` or fix a memory leak.

---

### kubectl Essentials for Daily Operations

```bash
# List pods with node assignment and cluster IP
kubectl get pods -o wide -n production

# Watch pods update in real time (Ctrl+C to exit)
kubectl get pods -w -n production

# Filter pods by label selector
kubectl get pods -l app=myapp,env=production -n production

# Exec into a running container interactively
kubectl exec -it pod/myapp-abc123 -n production -- /bin/sh

# Stream logs from any pod matching the Deployment
kubectl logs -f deployment/myapp -n production

# Stream logs from a specific container in a multi-container pod
kubectl logs pod/myapp-abc123 -c app -n production

# Fetch logs from a crashed container's previous run
kubectl logs pod/myapp-abc123 --previous -n production

# Copy a file out of a pod for offline debugging
kubectl cp myapp-abc123:/tmp/heapdump.hprof ./heapdump.hprof -n production

# Scale replicas imperatively (commit the change to git afterward)
kubectl scale deployment/myapp --replicas=5 -n production

# Patch a single field without modifying the full manifest
kubectl patch deployment myapp -n production \
  -p '{"spec":{"template":{"spec":{"terminationGracePeriodSeconds":60}}}}'

# Force-delete a pod stuck in Terminating state (node is gone or kubelet is unresponsive)
# WARNING: only use this when the node is confirmed dead — skips graceful shutdown
kubectl delete pod myapp-abc123 --grace-period=0 --force -n production
```

**`kubectl apply` vs `kubectl replace`:** `apply` performs a server-side merge patch and is idempotent — safe to run repeatedly from CI/CD even if nothing changed. `replace` requires the complete manifest and fails if the object does not yet exist. Always use `apply` in automated pipelines.

**Namespace flag habit:** always pass `-n <namespace>` explicitly rather than relying on a context default. Omitting it in production environments is a common source of accidental changes to the wrong namespace.

---

## Examples

### Example 1: Zero-Downtime Rolling Deployment

This is the standard production pattern. `maxUnavailable: 0` guarantees the cluster never drops below the desired replica count during an update. The readiness probe acts as the gate — new pods must pass it before old pods are removed.

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
    rollingUpdate:
      maxSurge: 1          # temporarily run 4 pods during update
      maxUnavailable: 0    # never drop below 3 ready pods
  template:
    metadata:
      labels:
        app: api
    spec:
      terminationGracePeriodSeconds: 45  # longer than typical request timeout
      containers:
        - name: api
          image: myregistry.io/api:v2.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1"
              memory: "512Mi"
          startupProbe:
            httpGet:
              path: /healthz
              port: 8080
            failureThreshold: 20   # 20 × 5s = 100s startup window
            periodSeconds: 5
          readinessProbe:
            httpGet:
              path: /ready         # separate endpoint: checks DB conn pool, cache
              port: 8080
            initialDelaySeconds: 0  # startupProbe handles the delay
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz       # lightweight: just confirms event loop is alive
              port: 8080
            periodSeconds: 20
            failureThreshold: 3
```

```bash
# Apply and watch the rollout
kubectl apply -f deployment.yaml
kubectl rollout status deployment/api -n production --timeout=5m

# Verify: 3 pods running the new image
kubectl get pods -l app=api -n production -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'

# Confirm rollout history recorded the annotation
kubectl rollout history deployment/api -n production
```

**What to verify:** all 3 pods show `Running` and `1/1 READY`. The old ReplicaSet shows `DESIRED: 0`. The rollout history shows revision 2 with the change-cause annotation.

---

### Example 2: Simulating and Recovering from a Bad Deployment

Demonstrates how to detect a failed rollout and recover using `rollout undo`.

```bash
# Deploy a known-good version first
kubectl set image deployment/api api=myregistry.io/api:v2.0.0 -n production
kubectl rollout status deployment/api -n production

# Now deploy a bad image (wrong tag — image pull will fail)
kubectl set image deployment/api api=myregistry.io/api:v99.0.0-does-not-exist -n production

# Watch the rollout stall — new pods go to ImagePullBackOff
kubectl get pods -w -n production -l app=api

# rollout status will eventually time out or show stalled
kubectl rollout status deployment/api -n production --timeout=2m
# Expected: error: deployment "api" exceeded its progress deadline

# Inspect the bad pod
kubectl describe pod -l app=api -n production | grep -A5 "Events:"
# You'll see: Failed to pull image "myregistry.io/api:v99.0.0-does-not-exist"

# Roll back — restores previous ReplicaSet instantly
kubectl rollout undo deployment/api -n production

# Confirm recovery
kubectl rollout status deployment/api -n production
kubectl rollout history deployment/api -n production
# Revision 3 will appear — undo creates a new revision, not a true "revert"
```

**Key observation:** because `maxUnavailable: 0`, the bad deployment never removed the old pods. All 3 original pods continued serving traffic throughout. The new broken pod was stuck in `ImagePullBackOff` and never became `Ready`, so it was never added to Service endpoints.

---

### Example 3: Multi-Container Pod with Init Container and Sidecar

Demonstrates a realistic pattern: an init container runs a DB migration before the app starts, and a sidecar ships logs to a central collector.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
    spec:
      # Init containers run sequentially to completion before any app container starts.
      # If an init container fails, the pod restarts — app containers never start.
      initContainers:
        - name: migrate
          image: myregistry.io/worker:v1.5.0
          command: ["python", "manage.py", "migrate", "--run-syncdb"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: url
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"

      containers:
        # Primary application container
        - name: worker
          image: myregistry.io/worker:v1.5.0
          command: ["python", "manage.py", "run_worker"]
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "1Gi"
          livenessProbe:
            exec:
              command: ["python", "-c", "import worker; worker.ping()"]
            periodSeconds: 30
            failureThreshold: 3

        # Sidecar: shares the pod's network — streams logs to Loki
        - name: log-shipper
          image: grafana/promtail:2.9.0
          args:
            - "-config.file=/etc/promtail/config.yaml"
          volumeMounts:
            - name: log-volume
              mountPath: /var/log/worker
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "100m"
              memory: "128Mi"

      volumes:
        - name: log-volume
          emptyDir: {}   # ephemeral volume shared between containers in this pod
```

```bash
# Watch init container complete before app starts
kubectl get pods -w -n production -l app=worker
# STATUS progresses: Init:0/1 → PodInitializing → Running

# Check init container logs (useful when migration fails)
kubectl logs -l app=worker -c migrate -n production

# Check sidecar logs separately
kubectl logs -l app=worker -c log-shipper -n production
```

---

### Example 4: Canary Release Using Pause and Resume

Pause a rollout after the first new pod is healthy to manually validate behavior before completing the rollout.

```bash
# Update to v1.4.0 and immediately pause
kubectl set image deployment/api api=myregistry.io/api:v1.4.0 -n production
kubectl rollout pause deployment/api -n production

# With maxSurge:1, one new pod has been created but the old pods are untouched
kubectl get pods -n production -l app=api
# NAME               READY  STATUS   IMAGE
# api-new-abc        1/1    Running  myregistry.io/api:v1.4.0   <- 1 new pod
# api-old-xyz1       1/1    Running  myregistry.io/api:v1.3.0   <- 3 old pods
# api-old-xyz2       1/1    Running  myregistry.io/api:v1.3.0
# api-old-xyz3       1/1    Running  myregistry.io/api:v1.3.0

# Validate the canary pod: check logs, hit its IP directly, inspect metrics
NEW_POD=$(kubectl get pods -n production -l app=api --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}')
kubectl logs "$NEW_POD" -n production -f &

# Check error rate and latency from your metrics stack here...
# If happy, resume:
kubectl rollout resume deployment/api -n production
kubectl rollout status deployment/api -n production

# If not happy, abort and roll back:
# kubectl rollout undo deployment/api -n production
```

**Why this works:** the Service routes traffic to all Ready pods regardless of which ReplicaSet owns them. During the pause, roughly 25% of traffic (1 of 4 ready pods) hits the new version. You get real production traffic on the canary without additional tooling like Argo Rollouts.

---

## Exercises

### Exercise 1: Diagnose a Broken Deployment

**Goal:** practice reading pod state and container events to identify the root cause of a failed rollout.

1. Create a Deployment with an intentionally misconfigured liveness probe (point it at `/healthz` when your app only exposes `/health`):

```yaml
livenessProbe:
  httpGet:
    path: /healthz-nonexistent
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 2
```

2. Apply the Deployment and wait 60 seconds.
3. Without looking at the manifest, use only `kubectl describe` and `kubectl logs --previous` to determine:
   - What exit code is the container dying with?
   - How many times has it restarted?
   - What is the current backoff delay?
4. Fix the probe path and apply the corrected manifest. Confirm the rollout completes and restart count stops increasing.

**What you're practicing:** reading `kubectl describe pod` output, interpreting `Last State`, and using `--previous` to fetch logs from a crashed instance.

---

### Exercise 2: Tune Resource Requests to Observe QoS Class

**Goal:** understand how resource configuration affects QoS class assignment and scheduling behavior.

1. Create three Deployments, each with one pod and a different resource configuration:
   - `deploy-guaranteed`: `requests.cpu: 200m`, `limits.cpu: 200m`, `requests.memory: 256Mi`, `limits.memory: 256Mi`
   - `deploy-burstable`: `requests.cpu: 100m`, `limits.cpu: 500m`, `requests.memory: 128Mi`, `limits.memory: 512Mi`
   - `deploy-besteffort`: no `resources` block at all

2. For each pod, run:

```bash
kubectl get pod <pod-name> -o jsonpath='{.status.qosClass}'
```

3. Verify each pod has the expected QoS class. Then answer: if the node runs out of memory, in what order will these pods be evicted?

4. **Extension:** set `requests.memory` on `deploy-besteffort` but do not set `limits`. What QoS class does it become? Why?

---

### Exercise 3: Implement a Zero-Downtime Update with Verification

**Goal:** wire together a full update cycle the way a CI/CD pipeline would.

1. Deploy version `v1` of a sample app (use `nginx:1.24` as a stand-in) with 3 replicas, `maxSurge: 1`, `maxUnavailable: 0`, and a readiness probe on port 80.

2. Write a shell script that:
   - Updates the image to `nginx:1.25`
   - Runs `kubectl rollout status` with a 3-minute timeout
   - On failure, automatically runs `kubectl rollout undo` and exits non-zero
   - On success, prints the current rollout history

3. Run the script. Observe the ReplicaSets during the rollout:

```bash
watch kubectl get replicasets -l app=nginx -n default
```

4. Confirm two ReplicaSets exist after the rollout (one at 0 desired replicas) and that `rollout undo` would be available if needed.

---

### Exercise 4: Debug a Pod Stuck in Pending

**Goal:** practice diagnosing scheduling failures — a common real-world issue.

1. Create a Deployment that requests more CPU than any single node in your cluster can provide:

```yaml
resources:
  requests:
    cpu: "9999m"   # almost certainly unschedulable
    memory: "128Mi"
```

2. The pod will be stuck in `Pending`. Use `kubectl describe pod` to find the scheduler event explaining why.

3. Identify the actual allocatable CPU on your nodes:

```bash
kubectl describe nodes | grep -A5 "Allocatable:"
kubectl describe nodes | grep -A10 "Allocated resources:"
```

4. Correct the resource request to a value that fits, apply the fix, and confirm the pod reaches `Running`.

5. **Extension:** deliberately set `requests.memory` to a value that fits on the node but set `limits.memory` to 10Mi. Deploy a pod that allocates 50Mi of memory (use a stress container or a simple Python script). Observe the OOMKill and confirm the exit code is 137.
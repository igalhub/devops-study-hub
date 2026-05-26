---
title: Pods & Deployments
module: kubernetes
duration_min: 25
difficulty: intermediate
tags: [kubernetes, pods, deployments, replicas, rolling-update, kubectl]
exercises: 4
---

## Overview
The Pod is the smallest deployable unit in Kubernetes — one or more containers sharing a network namespace and storage. But you never create Pods directly in production. You create a **Deployment**, which manages a ReplicaSet, which manages Pods. This abstraction gives you rolling updates, rollbacks, and self-healing for free. This lesson covers the objects, their relationships, and the operations you'll perform on them daily.

## Concepts

### The Object Hierarchy
```
Deployment
  └── ReplicaSet (one per revision)
        └── Pod(s)
              └── Container(s)
```

The Deployment defines desired state (image, replicas, update strategy). Kubernetes reconciles actual state toward desired state continuously.

### Pod Spec
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp-pod
  labels:
    app: myapp
    env: production
spec:
  containers:
    - name: app
      image: myapp:v1.2.3
      ports:
        - containerPort: 8080
      env:
        - name: DB_HOST
          value: "db.default.svc.cluster.local"
      resources:
        requests:           # guaranteed allocation
          cpu: "100m"       # 100 millicores = 0.1 CPU
          memory: "128Mi"
        limits:             # hard ceiling
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

**Resources:** always set both `requests` (scheduler uses this to place the Pod) and `limits` (kubelet enforces this). A Pod with no requests gets scheduled anywhere; a Pod with no limits can consume the entire node.

### Probes
| Probe | Purpose | Failure action |
|---|---|---|
| `readinessProbe` | Is the container ready to receive traffic? | Removed from Service endpoints |
| `livenessProbe` | Is the container alive? | Container restarted |
| `startupProbe` | Has the container finished starting? | Delays liveness/readiness checks |

Use readiness probes on every production container. Use liveness probes carefully — aggressive liveness probes can cause cascading restarts under load.

### Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp           # must match template.metadata.labels
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # extra pods during update
      maxUnavailable: 0    # zero-downtime: no pods removed before new ones are ready
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
        - name: app
          image: myapp:v1.2.3
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
```

### Update Strategies
```yaml
# RollingUpdate (default): replaces pods gradually
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1           # up to 1 extra pod
    maxUnavailable: 0     # no unavailability during update

# Recreate: kills all pods, then starts new ones (causes downtime)
strategy:
  type: Recreate
```

### Rollouts and Rollbacks
```bash
# Apply a new image (triggers rolling update)
kubectl set image deployment/myapp app=myapp:v1.3.0 -n production

# Watch rollout progress
kubectl rollout status deployment/myapp -n production

# View rollout history
kubectl rollout history deployment/myapp -n production

# Rollback to previous revision
kubectl rollout undo deployment/myapp -n production

# Rollback to a specific revision
kubectl rollout undo deployment/myapp --to-revision=2 -n production

# Pause/resume a rollout
kubectl rollout pause deployment/myapp
kubectl rollout resume deployment/myapp
```

### Pod Lifecycle and Restart Policies
| Phase | Meaning |
|---|---|
| Pending | Scheduled but not yet started |
| Running | At least one container running |
| Succeeded | All containers exited 0 (one-shots) |
| Failed | At least one container exited non-zero |
| Unknown | Node communication lost |

```yaml
spec:
  restartPolicy: Always    # default — always restart on exit
  # restartPolicy: OnFailure  — restart only on non-zero exit
  # restartPolicy: Never      — no restart (use for Jobs)
```

## Examples

### Zero-Downtime Deployment
```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0     # never take a pod out of service until replacement is ready
  template:
    metadata:
      labels:
        app: api
    spec:
      terminationGracePeriodSeconds: 30   # time for in-flight requests to complete
      containers:
        - name: api
          image: myapi:v2.0.0
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 15
```

```bash
kubectl apply -f deployment.yaml
kubectl rollout status deployment/api   # blocks until complete
```

## Exercises

1. Write a Deployment manifest for an nginx container with 3 replicas, resource requests (100m CPU / 128Mi memory) and limits (500m / 256Mi), and a readiness probe on port 80 path `/`. Apply it and verify all 3 pods are running.
2. Update the image tag in your Deployment and apply it. Watch the rolling update with `kubectl rollout status`. Then roll back with `kubectl rollout undo` and verify the old pods return.
3. Set `maxUnavailable: 0` and `maxSurge: 1` on your Deployment. Apply an update and observe how Kubernetes adds one extra pod before removing any old pods (`kubectl get pods -w`).
4. Add a liveness probe to a Deployment that checks an endpoint that always returns 500. Apply it and watch Kubernetes restart the container in a `CrashLoopBackOff` loop — then fix the probe and reapply.

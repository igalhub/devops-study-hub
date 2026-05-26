---
title: Persistent Volumes
module: kubernetes
duration_min: 20
difficulty: intermediate
tags: [kubernetes, pv, pvc, storageclass, statefulset, storage]
exercises: 4
---

## Overview
Containers are ephemeral — their filesystems disappear when the pod dies. Persistent Volumes (PVs) give pods access to storage that outlives the container lifecycle. Understanding the PV/PVC/StorageClass relationship is essential for running stateful workloads: databases, message queues, caches, and any service that needs durable storage.

## Concepts

### The Storage Abstraction Layers
```
StorageClass     — defines HOW storage is provisioned (provider, type, parameters)
PersistentVolume — a piece of actual storage (provisioned manually or automatically)
PersistentVolumeClaim — a pod's request for storage (size, access mode, class)
```

A pod mounts a PVC. The PVC is bound to a PV. The PV is backed by real storage (EBS, GCS disk, NFS, etc.).

### Access Modes
| Mode | Abbreviation | Meaning |
|---|---|---|
| `ReadWriteOnce` | RWO | Mounted read-write by one node |
| `ReadOnlyMany` | ROX | Mounted read-only by many nodes |
| `ReadWriteMany` | RWX | Mounted read-write by many nodes |
| `ReadWriteOncePod` | RWOP | Mounted read-write by one pod (K8s 1.22+) |

Most cloud block storage (EBS, GCP PD) supports only `ReadWriteOnce`. NFS and distributed filesystems (EFS, Azure Files) support `ReadWriteMany`.

### StorageClass
StorageClass enables dynamic provisioning — PVs are created automatically when a PVC requests them:

```yaml
# Built-in in most cloud clusters; you usually just reference the name
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"   # default for unspecified PVCs
provisioner: ebs.csi.aws.com     # AWS EBS CSI driver
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Delete            # Delete PV when PVC is deleted (Retain keeps it)
volumeBindingMode: WaitForFirstConsumer   # provision only when a pod is scheduled
allowVolumeExpansion: true
```

Common StorageClass names in cloud clusters:
- AWS EKS: `gp2`, `gp3`, `io1`
- GKE: `standard`, `premium-rwo`
- AKS: `default`, `managed-premium`

### PersistentVolumeClaim
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3        # matches a StorageClass name
  resources:
    requests:
      storage: 20Gi
```

```bash
kubectl get pvc -n production
# NAME            STATUS   VOLUME                     CAPACITY   ACCESS MODES
# postgres-data   Bound    pvc-abc123                 20Gi       RWO
```

Status: `Pending` → waiting for a pod (WaitForFirstConsumer) or no matching PV. `Bound` → ready to use.

### Using a PVC in a Pod
```yaml
spec:
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: postgres-data    # reference by name

  containers:
    - name: postgres
      image: postgres:17
      volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
```

### StatefulSets and VolumeClaimTemplates
Deployments share one PVC across all replicas (usually wrong for stateful apps). StatefulSets give each replica its own PVC:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres       # required: headless service for pod DNS
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:17
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3
        resources:
          requests:
            storage: 20Gi
```

Each replica (`postgres-0`, `postgres-1`, `postgres-2`) gets its own PVC (`data-postgres-0`, `data-postgres-1`, `data-postgres-2`). Pods are started in order and have stable network identity: `postgres-0.postgres.production.svc.cluster.local`.

### Reclaim Policies
| Policy | What happens when PVC is deleted |
|---|---|
| `Delete` | PV and underlying storage are deleted (default for dynamic provisioning) |
| `Retain` | PV and storage are kept (must manually clean up) — use for production data |
| `Recycle` | Deprecated — don't use |

For production databases, use `Retain` to prevent accidental data loss when a PVC is deleted:
```bash
kubectl patch storageclass gp3 -p '{"reclaimPolicy":"Retain"}'
```

### Expanding Volumes
With `allowVolumeExpansion: true` on the StorageClass:
```bash
# Edit the PVC to request more storage
kubectl patch pvc postgres-data -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'

# For block storage (EBS, GCP PD), the pod may need to be restarted for the filesystem to resize
```

## Examples

### Postgres StatefulSet
```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: production
spec:
  clusterIP: None          # headless service — each pod gets its own DNS entry
  selector:
    app: postgres
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:17-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1"
              memory: "1Gi"
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3
        resources:
          requests:
            storage: 20Gi
```

## Exercises

1. Create a PVC requesting 5Gi with `ReadWriteOnce` access using your cluster's default StorageClass. Verify it binds with `kubectl get pvc`. Mount it in a pod and write a file to the mounted path — delete the pod and recreate it, verify the file persists.
2. Deploy a single-replica PostgreSQL using a StatefulSet with a `volumeClaimTemplate`. Connect to the pod and create a test database. Delete and recreate the pod — verify the database persists.
3. Inspect the PV that was created for your PVC with `kubectl get pv` and `kubectl describe pv <name>`. Find the reclaim policy and the underlying storage resource ID (e.g. the EBS volume ID).
4. Change the reclaim policy of a PV from `Delete` to `Retain`. Delete the PVC that was bound to it. Show that the PV and the underlying storage still exist. What steps would you take to rebind a new PVC to this retained PV?

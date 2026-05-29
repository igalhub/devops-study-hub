---
title: Persistent Volumes
module: kubernetes
duration_min: 20
difficulty: intermediate
tags: [kubernetes, pv, pvc, storageclass, statefulset, storage]
exercises: 4
---

## Overview

Containers are ephemeral by design — every file written inside a container's filesystem is gone the moment the pod is deleted, rescheduled, or crashes. Persistent Volumes (PVs) are Kubernetes's answer to this: a storage subsystem that decouples durable storage from the pod lifecycle, allowing data to survive container restarts, pod rescheduling, and even cluster upgrades. For DevOps engineers, this is the foundation for running any stateful workload in Kubernetes — PostgreSQL, MySQL, Redis, Kafka, Elasticsearch, and similar services that are now routinely deployed on Kubernetes in production.

The design is deliberately layered. Cluster administrators manage *how* storage is provisioned (StorageClass). Developers request *how much* and *what kind* of storage they need (PersistentVolumeClaim). Kubernetes reconciles those two concerns and binds them to actual storage (PersistentVolume). This separation means a developer writing a PVC YAML doesn't need to know whether the cluster runs on AWS, GCP, or bare metal — the StorageClass abstracts that away. This is the same separation-of-concerns pattern that Services apply to networking.

In the broader DevOps toolchain, PVs sit at the intersection of infrastructure provisioning and application deployment. They integrate with cloud provider APIs (via CSI drivers), affect backup and disaster recovery strategies, influence pod scheduling, and carry cost implications. Misconfiguring reclaim policies has caused production data loss. Understanding the full PV/PVC/StorageClass lifecycle — including edge cases — is one of the clearest signals of Kubernetes operational maturity in a job interview.

---

## Concepts

### The Storage Abstraction Layers

The three-layer model is the most important mental model for this entire topic. Every storage operation in Kubernetes passes through all three layers.

```
StorageClass
  └─ Defines HOW storage is provisioned: which provisioner, what disk type,
     encryption settings, reclaim behavior, binding mode.

PersistentVolume (PV)
  └─ Represents a piece of actual storage. Created automatically by dynamic
     provisioning (via StorageClass) or manually by an admin (static provisioning).
     Lives at cluster scope — not namespaced.

PersistentVolumeClaim (PVC)
  └─ A namespaced request for storage. Specifies size, access mode, and
     optionally a StorageClass. Binds to a matching PV.

Pod
  └─ References a PVC by name. Kubernetes mounts the bound volume into
     the container filesystem at the specified mountPath.
```

**Binding rules:** A PVC binds to a PV when the PV satisfies all of the PVC's requirements: capacity ≥ requested, access modes match, StorageClass matches (or both are empty), and no selector mismatch. Once bound, it's a 1:1 exclusive relationship — that PV cannot be claimed by another PVC.

**Static vs. dynamic provisioning:**

| Approach | Who creates the PV | When to use |
|---|---|---|
| **Dynamic** | Kubernetes (via StorageClass provisioner) | Standard cloud clusters; on-demand |
| **Static** | Cluster admin, manually | Pre-provisioned storage, on-prem, NFS |

In practice, dynamic provisioning covers 90% of use cases on cloud clusters. Static provisioning is common with NFS, Ceph, or when you need to import an existing cloud disk (e.g., restoring from a snapshot).

---

### Access Modes

Access modes define how a volume can be mounted across nodes — not containers. This is a frequent source of confusion.

| Mode | Abbreviation | Meaning |
|---|---|---|
| `ReadWriteOnce` | RWO | Mounted read-write by **one node**. Multiple pods on the same node can all use it. |
| `ReadOnlyMany` | ROX | Mounted read-only by **many nodes simultaneously**. |
| `ReadWriteMany` | RWX | Mounted read-write by **many nodes simultaneously**. |
| `ReadWriteOncePod` | RWOP | Mounted read-write by **exactly one pod**. Enforced at the API level. (K8s 1.22+) |

**Critical distinction — RWO is per-node, not per-pod.** If you have two pods on the same node sharing an RWO volume, Kubernetes won't stop it. Use `ReadWriteOncePod` (RWOP) if you need strict single-pod exclusivity.

**Backend support matrix:**

| Backend | RWO | ROX | RWX | RWOP |
|---|---|---|---|---|
| AWS EBS | ✅ | ❌ | ❌ | ✅ |
| GCP Persistent Disk | ✅ | ✅ | ❌ | ✅ |
| Azure Disk | ✅ | ❌ | ❌ | ✅ |
| AWS EFS (NFS) | ✅ | ✅ | ✅ | ❌ |
| Azure Files | ✅ | ✅ | ✅ | ❌ |
| NFS | ✅ | ✅ | ✅ | ❌ |

**Gotcha:** Requesting `ReadWriteMany` with an EBS-backed StorageClass will leave your PVC stuck in `Pending` forever — EBS physically cannot attach to multiple nodes. Always verify your StorageClass's backend supports the access mode you're requesting.

---

### StorageClass

StorageClass is the provisioner configuration. It tells Kubernetes *which plugin* to call and *with what parameters* when a PVC needs a PV created.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    # Only one StorageClass in a cluster should be default
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com          # CSI driver name — must be installed in cluster
parameters:
  type: gp3                            # EBS volume type
  iops: "3000"                         # gp3 allows explicit IOPS configuration
  throughput: "125"                    # MB/s, gp3-specific
  encrypted: "true"                    # encrypt at rest using default KMS key
  kmsKeyId: "arn:aws:kms:..."          # optional: specify a custom KMS key
reclaimPolicy: Retain                  # Retain = don't delete PV when PVC is deleted
volumeBindingMode: WaitForFirstConsumer  # delay provisioning until pod is scheduled
allowVolumeExpansion: true             # allow PVCs to request more storage later
```

**`volumeBindingMode` matters for multi-AZ clusters.** `Immediate` creates the EBS volume as soon as the PVC is created — but EBS volumes are AZ-specific. If the volume lands in `us-east-1a` and your pod schedules in `us-east-1b`, the pod stays `Pending` forever. `WaitForFirstConsumer` waits until a pod is scheduled, then creates the volume in the same AZ. **Always use `WaitForFirstConsumer` for block storage in multi-AZ clusters.**

**Common StorageClass names by cloud provider:**

| Provider | Class Name | Type |
|---|---|---|
| AWS EKS | `gp2` (legacy default) | General purpose SSD |
| AWS EKS | `gp3` | Improved general purpose SSD |
| GKE | `standard` | Standard HDD |
| GKE | `premium-rwo` | SSD |
| AKS | `default` | Standard HDD |
| AKS | `managed-premium` | SSD |
| Local/minikube | `standard` | hostPath |

```bash
# List all available storage classes in the cluster
kubectl get storageclass

# Identify which one is the default (look for "(default)" in the output)
kubectl get storageclass -o wide
```

---

### PersistentVolumeClaim

A PVC is a namespaced resource. It's what developers write; the PV is usually an implementation detail they never touch directly.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-ssd    # omit to use the cluster default StorageClass
  resources:
    requests:
      storage: 20Gi             # minimum size required; PV may be larger
  # Optional: bind to a specific PV by label (static provisioning)
  selector:
    matchLabels:
      environment: production
```

**PVC status lifecycle:**

| Status | Meaning |
|---|---|
| `Pending` | No matching PV found yet, or waiting for pod (WaitForFirstConsumer) |
| `Bound` | Successfully matched to a PV — ready to mount |
| `Lost` | Was bound, but the PV has been deleted — data may be gone |
| `Terminating` | PVC deletion in progress; blocked if a pod is still mounting it |

```bash
# Check PVC status
kubectl get pvc -n production

# Detailed view: see which PV it's bound to, storage class, events
kubectl describe pvc postgres-data -n production
```

**Gotcha:** A PVC stuck in `Pending` on a cluster with `WaitForFirstConsumer` is normal until a pod that references it is scheduled. But `Pending` on `Immediate` binding means there's no matching PV — check events with `kubectl describe pvc`.

**Gotcha:** You cannot reduce a PVC's storage request. Volume expansion is one-directional. Attempting `storage: 5Gi` on a PVC that already has `20Gi` will be rejected by the API.

---

### Using a PVC in a Pod

The pod spec references a PVC by name. Kubernetes handles mounting the underlying volume.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres
  namespace: production
spec:
  volumes:
    - name: data                          # volume name — internal to this pod spec
      persistentVolumeClaim:
        claimName: postgres-data          # must be in the same namespace as the pod
        readOnly: false

  containers:
    - name: postgres
      image: postgres:17-alpine
      volumeMounts:
        - name: data                      # matches spec.volumes[].name above
          mountPath: /var/lib/postgresql/data
          subPath: pgdata                 # optional: mount a subdirectory of the volume
                                          # useful when one PVC serves multiple containers
      env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
```

**`subPath` use case:** If you mount an EBS volume directly to `/var/lib/postgresql/data`, some images write a `lost+found` directory at the root that breaks PostgreSQL's startup check. Using `subPath: pgdata` mounts only the `pgdata` subdirectory of the volume into the container, avoiding this. It also allows multiple containers in a pod to share one PVC at different paths.

**Gotcha:** A PVC mounted by a running pod **cannot be deleted**. The deletion will be accepted by the API but will stay in `Terminating` state until every pod using it is deleted. This is a finalizer protection mechanism (`kubernetes.io/pvc-protection`). Don't be alarmed — just delete the pod first, then the PVC will complete termination automatically.

---

### StatefulSets and VolumeClaimTemplates

Deployments are designed for stateless workloads. All replicas share the same pod template, and if you attach a PVC to a Deployment, all replicas mount *the same* PVC. This is almost always wrong for databases — you'd need RWX, and you'd have multiple processes writing to one filesystem unsafely.

StatefulSets solve this with `volumeClaimTemplates`: each replica gets its own PVC, auto-generated from the template.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres          # must match a headless Service (clusterIP: None)
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
          image: postgres:17-alpine
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data               # PVC name prefix; full name = data-<pod-name>
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 20Gi
```

**What gets created automatically:**

| Pod | PVC | DNS Name |
|---|---|---|
| `postgres-0` | `data-postgres-0` | `postgres-0.postgres.production.svc.cluster.local` |
| `postgres-1` | `data-postgres-1` | `postgres-1.postgres.production.svc.cluster.local` |
| `postgres-2` | `data-postgres-2` | `postgres-2.postgres.production.svc.cluster.local` |

**StatefulSet pod lifecycle guarantees:**
- Pods are created in order: `0` → `1` → `2`. Each must be `Running` before the next starts.
- Pods are deleted in reverse order: `2` → `1` → `0`.
- Pod identity is stable across restarts: `postgres-0` always comes back as `postgres-0`, and always mounts `data-postgres-0`.

**Critical gotcha:** Deleting a StatefulSet does **not** delete its PVCs. This is intentional data protection. To fully clean up, you must delete the StatefulSet and then manually delete each PVC. Conversely, if you scale down a StatefulSet from 3 to 1 replica, `data-postgres-1` and `data-postgres-2` remain — and if you scale back up to 3, the pods reattach to their existing PVCs with existing data intact.

---

### Reclaim Policies

The reclaim policy on a PV determines what happens to the underlying storage (and the PV object) when the bound PVC is deleted.

| Policy | PV after PVC deletion | Storage after PVC deletion | Use case |
|---|---|---|---|
| `Delete` | Deleted | Deleted | Dev/staging; ephemeral workloads |
| `Retain` | Remains (`Released` status) | Preserved | Production databases; anything you care about |
| `Recycle` | **Deprecated** — don't use | N/A | Removed in modern Kubernetes |

**The `Released` status trap:** When a PVC is deleted with `Retain` policy, the PV enters `Released` status. It is *not* available for new PVCs to bind to automatically — even if the sizes and modes match. The PV still holds a reference to the old PVC in its `spec.claimRef`. You must manually clear that reference to make it available again:

```bash
# Remove the claimRef to make a Released PV available for rebinding
kubectl patch pv <pv-name> -p '{"spec":{"claimRef": null}}'

# The PV will transition from Released → Available
kubectl get pv <pv-name>
```

**Setting reclaim policy:**

The reclaim policy is set on the StorageClass (applies to newly provisioned PVs) or patched directly on an existing PV:

```bash
# Change reclaim policy on a specific PV (does not affect the StorageClass)
kubectl patch pv pvc-abc123 -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

# Change the default for new PVs from a StorageClass
kubectl patch storageclass fast-ssd -p '{"reclaimPolicy":"Retain"}'
```

**Best practice:** In production, set `reclaimPolicy: Retain` on your StorageClass, or patch critical PVs to `Retain` immediately after they're provisioned. A `kubectl delete pvc` by mistake in a `Delete`-policy cluster is unrecoverable.

---

### Expanding Volumes

Volume expansion lets you increase the size of a PVC without deleting and recreating it — critical for databases that grow over time.

**Requirements:**
1. `allowVolumeExpansion: true` on the StorageClass.
2. The CSI driver must support expansion (most modern drivers do).
3. For filesystem resize on a mounted volume: the node must support online expansion (Linux kernel ≥ 4.11 for ext4/xfs; most modern cloud nodes qualify).

**How to expand a PVC:**

```bash
# Edit the PVC's storage request — increase from 20Gi to 50Gi
kubectl patch pvc postgres-data -n production \
  -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'

# Watch the resize complete — look for the FileSystemResizePending condition to clear
kubectl get pvc postgres-data -n production -w
```

**Expansion status conditions:**

| Condition | Meaning |
|---|---|
| `Resizing` | Cloud disk resize in progress |
| `FileSystemResizePending` | Disk expanded, waiting for filesystem resize on next pod mount |
| *(no condition)* | Expansion complete |

**Gotcha:** For offline-only CSI drivers, the filesystem resize happens the next time the pod mounts the volume — not immediately. The PVC capacity shown by `kubectl get pvc` will update to the new size, but the filesystem inside the pod will still reflect the old size until the pod is restarted. Check `df -h` inside the pod after restart to confirm.

**Gotcha:** You cannot shrink a PVC. Kubernetes rejects requests to decrease `spec.resources.requests.storage`. The only path to a smaller volume is backup → delete → recreate → restore.

---

### Static Provisioning

Static provisioning is used when the physical storage already exists and you need to import it — restoring from a snapshot, using an NFS server, or working on bare metal without a dynamic provisioner.

```yaml
# Step 1: Admin creates the PV pointing to existing storage
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nfs-pv-postgres
  labels:
    environment: production       # used by PVC selector for targeted binding
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""            # empty string = no StorageClass; prevents dynamic PV from matching
  nfs:
    server: 10.0.1.50             # NFS server IP
    path: /exports/postgres       # exported path on the NFS server
    readOnly: false
---
# Step 2: Developer creates a PVC that targets this PV by label
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-nfs
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: ""            # must match PV; empty = no dynamic provisioning
  resources:
    requests:
      storage: 100Gi              # must be ≤ PV capacity
  selector:
    matchLabels:
      environment: production     # targets the labeled PV above
```

**Gotcha:** If `storageClassName` is omitted entirely (not set to `""`) on a PVC in a cluster with a default StorageClass, the PVC will attempt dynamic provisioning rather than binding to your static PV. Explicitly set `storageClassName: ""` to opt out of dynamic provisioning.

---

### CSI Drivers

Container Storage Interface (CSI) is the standard plugin architecture replacing the old in-tree volume plugins. CSI drivers are deployed as pods in your cluster and handle the actual interaction with storage backends.

```bash
# List installed CSI drivers in the cluster
kubectl get csidrivers

# Example output:
# NAME                       ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   ...
# ebs.csi.aws.com            true             false            false
# efs.csi.aws.com            false            false            false
# pd.csi.storage.gke.io      true             false            true
```

**Key CSI driver capabilities to check before designing storage:**

| Capability | Why it matters |
|---|---|
| `ATTACH_REQUIRED` | Block devices (EBS, Azure Disk) require attach; NFS-based drivers do not |
| `EXPAND_VOLUME` | Required for online/offline volume expansion |
| `CREATE_DELETE_SNAPSHOT` | Required for VolumeSnapshot support |
| `STORAGE_CAPACITY` | Enables topology-aware scheduling based on available storage |

**Common CSI drivers:**

| Driver | Backend | Notes |
|---|---|---|
| `ebs.csi.aws.com` | AWS EBS | Install via EKS add-on; RWO only |
| `efs.csi.aws.com` | AWS EFS | RWX capable; no per-pod capacity limits |
| `pd.csi.storage.gke.io` | GCP Persistent Disk | Bundled in GKE |
| `disk.csi.azure.com` | Azure Disk | RWO only |
| `file.csi.azure.com` | Azure Files | RWX capable |
| `rbd.csi.ceph.com` | Ceph RBD | On-prem; RWO |
| `cephfs.csi.ceph.com` | CephFS | On-prem; RWX |

---

### VolumeSnapshots

VolumeSnapshots allow point-in-time copies of PVCs — useful for backups, cloning environments, and pre-upgrade snapshots. They require the `snapshot.storage.k8s.io` CRDs and a snapshot controller installed in the cluster.

```yaml
# Step 1: Create a VolumeSnapshotClass (admin task, once per cluster)
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
driver: ebs.csi.aws.com
deletionPolicy: Retain            # Retain = keep underlying snapshot if VolumeSnapshot is deleted
---
# Step 2: Take a snapshot of an existing PVC
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snap-20240115
  namespace: production
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: postgres-data   # PVC to snapshot
---
# Step 3: Restore snapshot into a new PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 20Gi
  dataSource:
    name: postgres-snap-20240115   # VolumeSnapshot to restore from
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

```bash
# Check snapshot readiness
kubectl get volumesnapshot -n production

# Look for READYTOUSE = true
# NAME                        READYTOUSE   SOURCEPVC       ...
# postgres-snap-20240115      true         postgres-data
```

**Gotcha:** Snapshots are crash-consistent, not application-consistent. For a database, this means the snapshot may capture data mid-write. For true application-consistent backups, quiesce the application first (e.g., `CHECKPOINT` in PostgreSQL) or use a backup tool like Velero that coordinates with the application.

---

## Examples

### Example 1: PostgreSQL with Dynamic Provisioning on EKS

A complete setup for a single PostgreSQL instance with a dynamically provisioned EBS gp3 volume.

```yaml
# storage-class.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer   # critical for multi-AZ EKS
allowVolumeExpansion: true
---
# pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ebs-gp3
  resources:
    requests:
      storage: 20Gi
---
# pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres
  namespace: production
spec:
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: postgres-data
  containers:
    - name: postgres
      image: postgres:17-alpine
      env:
        - name: POSTGRES_PASSWORD
          value: "changeme"
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
      volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
          subPath: pgdata               # avoids lost+found issue at volume root
```

```bash
# Apply everything
kubectl apply -f storage-class.yaml
kubectl apply -f pvc.yaml
kubectl apply -f pod.yaml

# PVC stays Pending until the pod is scheduled (WaitForFirstConsumer)
kubectl get pvc -n production
# NAME            STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# postgres-data   Pending                                      ebs-gp3        5s

# Once pod is Running, PVC transitions to Bound
kubectl get pod postgres -n production
kubectl get pvc postgres-data -n production
# NAME            STATUS   VOLUME              CAPACITY   ACCESS MODES
# postgres-data   Bound    pvc-abc123...       20Gi       RWO

# Verify data persists: write a file, delete the pod, recreate it, check the file
kubectl exec -n production postgres -- psql -U postgres -c "CREATE TABLE test (id int);"
kubectl delete pod postgres -n production
kubectl apply -f pod.yaml
kubectl exec -n production postgres -- psql -U postgres -c "\dt"
# Should show the 'test' table — data survived the pod deletion
```

---

### Example 2: Redis StatefulSet with Per-Replica Storage

A Redis cluster where each replica needs its own isolated volume. This pattern applies to any database cluster (Kafka, Cassandra, etcd).

```yaml
# headless-service.yaml — required by StatefulSet for stable DNS
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: cache
spec:
  clusterIP: None                 # headless: no load balancing, direct pod DNS
  selector:
    app: redis
  ports:
    - port: 6379
---
# statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: cache
spec:
  serviceName: redis
  replicas: 3
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          command: ["redis-server", "--appendonly", "yes"]  # AOF persistence
          ports:
            - containerPort: 6379
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: ebs-gp3
        resources:
          requests:
            storage: 10Gi
```

```bash
kubectl apply -f headless-service.yaml
kubectl apply -f statefulset.yaml

# Watch pods come up in order (0, then 1, then 2)
kubectl get pods -n cache -w

# Verify each pod has its own PVC
kubectl get pvc -n cache
# NAME           STATUS   VOLUME          CAPACITY
# data-redis-0   Bound    pvc-111...      10Gi
# data-redis-1   Bound    pvc-222...      10Gi
# data-redis-2   Bound    pvc-333...      10Gi

# Scale down — PVCs are NOT deleted
kubectl scale statefulset redis --replicas=1 -n cache
kubectl get pvc -n cache
# All three PVCs still exist

# Scale back up — redis-1 and redis-2 reattach to their original PVCs
kubectl scale statefulset redis --replicas=3 -n cache

# Address individual pods by DNS
kubectl exec -n cache redis-0 -- redis-cli -h redis-1.redis.cache.svc.cluster.local ping
# PONG
```

---

### Example 3: Recovering a Retained PV After Accidental PVC Deletion

A common production incident: someone deletes a PVC with `Retain` policy. The data is safe on the PV, but you need to reattach it.

```bash
# Scenario: PVC 'postgres-data' was deleted. Find the Released PV.
kubectl get pv
# NAME          CAPACITY  ACCESS MODES  RECLAIM POLICY  STATUS     CLAIM
# pvc-abc123    20Gi      RWO           Retain          Released   production/postgres-data

# The PV has data but won't autobind. Clear the claimRef.
kubectl patch pv pvc-abc123 -p '{"spec":{"claimRef": null}}'

# PV is now Available
kubectl get pv pvc-abc123
# STATUS: Available
```

```yaml
# Recreate the PVC, binding it explicitly to the specific PV by name
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ebs-gp3
  resources:
    requests:
      storage: 20Gi
  volumeName: pvc-abc123          # bind to this specific PV by name
```

```bash
kubectl apply -f pvc-recovered.yaml

# Verify binding
kubectl get pvc postgres-data -n production
# STATUS: Bound   VOLUME: pvc-abc123

# Redeploy the pod — data is intact
kubectl apply -f pod.yaml
kubectl exec -n production postgres -- psql -U postgres -c "\dt"
# test table is still there
```

---

### Example 4: Expanding a PVC Live in Production

Expanding a PostgreSQL volume from 20Gi to 50Gi without downtime, on a StorageClass with `allowVolumeExpansion: true`.

```bash
# Confirm the StorageClass supports expansion
kubectl get storageclass ebs-gp3 -o jsonpath='{.allowVolumeExpansion}'
# true

# Check current size
kubectl get pvc postgres-data -n production
# CAPACITY: 20Gi

# Patch the PVC to request more storage
kubectl patch pvc postgres-data -n production \
  -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'

# Watch the resize — first the disk expands, then the filesystem
kubectl get pvc postgres-data -n production -w
# STATUS transitions through conditions; eventually CAPACITY shows 50Gi

# Check conditions during resize
kubectl describe pvc postgres-data -n production | grep -A5 Conditions
# Type                      Status
# FileSystemResizePending   True    <- disk expanded, filesystem resize pending

# For online resize (pod still running), the filesystem resizes automatically.
# Verify inside the pod:
kubectl exec -n production postgres -- df -h /var/lib/postgresql/data
# Filesystem      Size  Used Avail
# /dev/nvme1n1     50G   18G   32G    <- new size reflected immediately
```

---

## Exercises

### Exercise 1: Diagnose and Fix a Stuck PVC

**Goal:** Practice the PVC debugging workflow.

1. Create a StorageClass with `volumeBindingMode: Immediate` (use `minikube`'s `standard` provisioner or any available provisioner).
2. Create a PVC requesting `ReadWriteMany` access mode against a StorageClass that only supports `ReadWriteOnce` (e.g., minikube's default `standard` class).
3. Observe the PVC stuck in `Pending`. Run `kubectl describe pvc` and identify the specific event message explaining why it's stuck.
4. Fix the PVC by either correcting the access mode or switching to a StorageClass that supports RWX.
5. Verify the PVC reaches `Bound` status and identify which PV it was bound to.

**Verification:** `kubectl get pvc` shows `Bound`. `kubectl get pv` shows the matching PV with status `Bound`.

---

### Exercise 2: StatefulSet Storage Identity

**Goal:** Understand StatefulSet PVC naming and persistence guarantees.

1. Deploy a StatefulSet with 3 replicas using `nginx:alpine` as the image and a `volumeClaimTemplate` requesting `1Gi` RWO storage. Mount the volume at `/usr/share/nginx/html`.
2. Write a unique file to each pod's volume:
   ```bash
   kubectl exec <statefulset-name>-0 -- sh -c "echo 'pod-0' > /usr/share/nginx/html/index.html"
   kubectl exec <statefulset-name>-1 -- sh -c "echo 'pod-1' > /usr/share/nginx/html/index.html"
   kubectl exec <statefulset-name>-2 -- sh -c "echo 'pod-2' > /usr/share/nginx/html/index.html"
   ```
3. Delete all three pods simultaneously (`kubectl delete pod -l app=<label>`). Watch them recreate.
4. After all pods are `Running` again, exec into each and verify that `cat /usr/share/nginx/html/index.html` still returns the correct pod-specific content — proving that each pod reattached to its original PVC.
5. Scale the StatefulSet to 0, then back to 3. Verify data still persists.

**Verification:** Pod-0's file contains `pod-0`, pod-1's contains `pod-1`, pod-2's contains `pod-2` — after both a pod deletion and a scale-to-zero cycle.

---

### Exercise 3: Reclaim Policy Comparison

**Goal:** Directly observe the difference between `Delete` and `Retain` reclaim policies.

1. Create two StorageClasses — one with `reclaimPolicy: Delete` and one with `reclaimPolicy: Retain` (clone your cluster's default and change the name and reclaim policy).
2. Create one PVC against each StorageClass and verify both reach `Bound` status. Record the PV name for each.
3. Delete both PVCs.
4. Run `kubectl get pv` and observe: the PV from the `Delete` policy StorageClass is gone; the PV from the `Retain` policy StorageClass is still present with status `Released`.
5. Patch the `Released` PV to remove its `claimRef` and verify it transitions to `Available`.
6. Create a new PVC that explicitly binds to the recovered PV using `volumeName`. Verify it reaches `Bound`.

**Verification:** After step 4, only one PV remains. After step 6, that PV's status is `Bound` to your new PVC.

---

### Exercise 4: Live Volume Expansion

**Goal:** Expand a PVC on a running pod and verify the filesystem reflects the new size.

1. Ensure your StorageClass has `allowVolumeExpansion: true`. On minikube, patch the `standard` StorageClass: `kubectl patch storageclass standard -p '{"allowVolumeExpansion":true}'`.
2. Create a PVC requesting `1Gi` and a pod that mounts it. Once the pod is `Running`, exec in and run `df -h` to record the filesystem size.
3. Patch the PVC to request `2Gi`:
   ```bash
   kubectl patch pvc <pvc-name> -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}'
   ```
4. Monitor the PVC with `kubectl describe pvc` — look for `FileSystemResizePending` or `Resizing` conditions. On some drivers, you may need to delete and recreate the pod to trigger filesystem resize.
5. After expansion completes, exec into the pod and run `df -h` again. Confirm the mounted filesystem now shows approximately `2Gi`.
6. Attempt to shrink the PVC back to `1Gi`. Document the exact error message returned by the API.

**Verification:** `df -h` shows the expanded size. The shrink attempt is rejected with a validation error mentioning that storage requests cannot be decreased.

---

### Quick Checks

7. Extract the access mode from a PVC spec stub. Run: `printf 'spec:\n  accessModes:\n  - ReadWriteOnce\n' | awk '/- Read/{print $2}'`

```expected_output
ReadWriteOnce
```

hint: Think about how awk can match a specific line pattern and then print a particular field from that line.
hint: Use awk with a pattern like '/- Read/{print $2}' to match lines containing '- Read' and extract the second whitespace-separated field.

8. Parse the storage request size from a PVC. Run: `printf 'resources:\n  requests:\n    storage: 10Gi\n' | awk '/storage:/{print $2}'`

```expected_output
10Gi
```

hint: Think about how you can filter lines in a stream and then extract a specific field from a matching line.
hint: Use awk with a pattern match like /storage:/ to select the relevant line, then print the second field using print $2.

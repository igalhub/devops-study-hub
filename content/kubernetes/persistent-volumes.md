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

**Gotcha:** A PVC mounted by a running pod **cannot be deleted**. The deletion will be accepted by the API but will stay in `Terminating` state until every pod using it is deleted. This is a finalizer protection mechanism. Don't be alarmed — just delete the pod first.

---

### StatefulSets and VolumeClaimTemplates

Deployments are designed for stateless workloads. All replicas share the same pod template, and if you attach a PVC to a Deployment, all replicas mount *the same* PVC. This is almost always wrong for databases (you'd need RWX, and you'd have multiple processes writing to one filesystem unsafely).

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
        name: data               # PVC name prefix
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

**Critical gotcha:** Deleting a StatefulSet does **not** delete its PVCs. This is intentional data protection. To fully clean up, you must delete the StatefulSet and then manually delete each PVC. Conversely, if you scale down a StatefulSet from 3 to 1 replica, `data-postgres-1` and `data-postgres-2` remain — and if you scale back up to 3, the pods reattach to their existing PVCs (with existing data intact).

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
3. For filesystem resize: the
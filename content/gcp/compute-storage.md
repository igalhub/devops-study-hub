---
title: Compute Engine and Cloud Storage
module: gcp
duration_min: 25
difficulty: intermediate
tags: [gcp, compute-engine, cloud-storage, gcs, iam, vpc, gsutil, gcloud]
exercises: 4
---

## Overview

Compute Engine is GCP's Infrastructure-as-a-Service VM offering — the layer where you get raw, configurable Linux or Windows machines running in Google's network. Cloud Storage (GCS) is GCP's globally consistent, strongly durable object store. For a DevOps engineer, these two services are where most foundational work happens: VMs run your workloads, and GCS holds build artifacts, Terraform state, container image layers, backups, and static assets. Understanding both deeply — not just the happy-path commands — is a prerequisite for almost every other GCP service you'll operate.

GCP's design philosophy differs from AWS in one important structural way: the **resource hierarchy**. Every resource belongs to a Project, Projects belong to Folders, and Folders belong to an Organization. IAM policies propagate downward through this tree. This means access control is not purely flat — a permission granted at the Organization level is inherited by every VM and bucket in the entire company. This makes the hierarchy a lever for security at scale, and a footgun if you grant broad permissions carelessly.

In the DevOps toolchain, Compute Engine and GCS sit at the infrastructure layer beneath Kubernetes, CI/CD pipelines, and application code. A CI system pushes build artifacts to GCS; a Managed Instance Group pulls them during VM startup. Terraform state lives in a GCS backend. Log exports land in GCS for long-term archival. Even if your production workloads run on GKE, you are almost certainly interacting with Compute Engine and GCS constantly.

---

## Concepts

### gcloud SDK Setup and Configuration

The `gcloud` CLI is the primary interface for all Compute Engine operations. It manages authentication, project context, and default region/zone so you don't have to specify them on every command.

```bash
# Authenticate your user account (opens browser)
gcloud auth login

# Authenticate for ADC (Application Default Credentials) — used by SDKs and Terraform
gcloud auth application-default login

# Set defaults so you don't repeat them on every command
gcloud config set project my-project-id
gcloud config set compute/region us-central1
gcloud config set compute/zone us-central1-a

# Named configurations are useful when switching between projects/environments
gcloud config configurations create prod
gcloud config set project my-prod-project
gcloud config configurations activate prod

# Inspect current config
gcloud config list
gcloud auth list
```

**`gcloud auth login` vs `gcloud auth application-default login`:** The first sets credentials for the CLI itself. The second sets Application Default Credentials, which is what the Python `google-cloud-*` libraries, Terraform, and other tools use. You often need both. If your Terraform runs fine but your Python script gets a 403, this is usually the cause.

### Compute Engine — Machine Types and Disks

GCP organizes machine types into families with distinct performance/cost tradeoffs:

| Series | Optimization | Typical Use Case |
|--------|-------------|-----------------|
| `e2` | Cost efficiency, shared-core options | Dev/test, low-traffic web servers |
| `n2` / `n2d` | Balanced CPU and memory | General workloads, databases |
| `c2` / `c3` | High-frequency CPU | Compute-intensive, game servers |
| `m2` / `m3` | Memory-to-CPU ratio | In-memory databases, SAP HANA |
| `a2` / `g2` | Attached GPU | ML training, rendering |

```
e2-micro          2 vCPU (shared), 1 GB RAM    — free tier eligible
e2-standard-4     4 vCPU, 16 GB RAM
n2-standard-8     8 vCPU, 32 GB RAM
c2-standard-4     4 vCPU, 16 GB RAM
m2-ultramem-208   208 vCPU, 5888 GB RAM
a2-highgpu-1g     12 vCPU, 85 GB RAM + 1xA100 GPU

# Custom sizing (when predefined ratios don't fit your workload)
n2-custom-6-15360   6 vCPU, 15 GB RAM
```

Disk types are a separate decision from machine type:

| Disk Type | IOPS (per GB) | Use Case |
|-----------|--------------|---------|
| `pd-standard` | ~0.75 read, 1.5 write | Cold storage, sequential reads |
| `pd-balanced` | 6 read/write | General purpose boot disks |
| `pd-ssd` | 30 read/write | Databases, OS disks needing low latency |
| `pd-extreme` | Up to 120,000 provisioned | High-performance databases |
| `hyperdisk-extreme` | Configurable, higher ceiling | I/O-intensive, decoupled from VM |

**Disk gotcha:** IOPS and throughput for `pd-ssd` and `pd-balanced` are capped per disk size AND per VM. A 10 GB `pd-ssd` will not deliver the same IOPS as a 500 GB one. If your database VM has poor disk performance, check both the disk size and the machine type's per-VM I/O cap in the documentation.

### Compute Engine — Creating and Managing Instances

```bash
# Create a production-grade VM
gcloud compute instances create myapp \
  --machine-type e2-standard-2 \
  --image-family debian-12 \
  --image-project debian-cloud \
  --zone us-central1-a \
  --boot-disk-size 50GB \
  --boot-disk-type pd-ssd \
  --service-account myapp-sa@my-project.iam.gserviceaccount.com \
  --scopes cloud-platform \              # Allow the SA to call GCP APIs
  --metadata-from-file startup-script=startup.sh \
  --tags http-server,https-server \      # Used by firewall rules, not DNS
  --no-address                           # No external IP — access via IAP or bastion

# List all instances with their status
gcloud compute instances list

# SSH via IAP tunnel (no external IP needed, no open port 22 to the internet)
gcloud compute ssh myapp \
  --zone us-central1-a \
  --tunnel-through-iap

# Describe instance (get full metadata, network config, disks)
gcloud compute instances describe myapp --zone us-central1-a

# Stop (billing stops for CPU/RAM, disk billing continues)
gcloud compute instances stop myapp --zone us-central1-a

# Delete (also deletes boot disk unless --keep-disks flag is set)
gcloud compute instances delete myapp --zone us-central1-a
```

**`--scopes` vs service account:** The `--scopes` flag is a legacy OAuth2 mechanism. Setting `--scopes cloud-platform` and attaching a properly-permissioned service account is the correct modern pattern. The scope grants the broadest OAuth access; actual permissions are then controlled by IAM on the service account. Never rely on the default compute service account — it has Editor on the project.

#### Startup Scripts

Startup scripts run as root on first boot (and on every restart if you use `shutdown-script` or `startup-script` metadata). They are the primary mechanism for bootstrapping software on VMs.

```bash
#!/bin/bash
# startup.sh — runs on every boot
set -euo pipefail  # fail fast; unset variables are errors

# Update package index
apt-get update -y

# Install dependencies
apt-get install -y docker.io nginx

# Enable and start services
systemctl enable --now docker
systemctl enable --now nginx

# Pull app config from GCS (SA needs roles/storage.objectViewer on the bucket)
gsutil cp gs://my-app-config/nginx.conf /etc/nginx/nginx.conf
systemctl reload nginx

# Signal that startup is complete (useful for health checks)
curl -s -X POST \
  "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/startup/status" \
  -H "Metadata-Flavor: Google" \
  -d "done"
```

Startup script logs go to `/var/log/syslog` (Debian/Ubuntu) and to Cloud Logging under the `GCEMetadataScripts` log name.

```bash
# View startup script output from Cloud Logging
gcloud logging read \
  'resource.type="gce_instance" logName:"GCEMetadataScripts"' \
  --limit 50 \
  --format json
```

### Preemptible and Spot VMs

Spot and Preemptible VMs run on surplus capacity and can be reclaimed by GCP with a 30-second warning. They are 60–91% cheaper than on-demand pricing.

```bash
# Spot VM (current model — no maximum 24h lifetime)
gcloud compute instances create worker-1 \
  --provisioning-model SPOT \
  --instance-termination-action STOP \   # STOP preserves disk; DELETE frees everything
  --machine-type n2-standard-4 \
  --image-family debian-12 \
  --image-project debian-cloud \
  --zone us-central1-a

# Preemptible (legacy model — hard 24h lifetime, always terminated not stopped)
gcloud compute instances create worker-2 \
  --preemptible \
  --machine-type n2-standard-4 \
  --image-family debian-12 \
  --image-project debian-cloud \
  --zone us-central1-a
```

| | Preemptible | Spot |
|-|-------------|------|
| Max lifetime | 24 hours | None |
| Termination behavior | Always deleted | Configurable (STOP or DELETE) |
| Availability | Less predictable | Generally better |
| API flag | `--preemptible` | `--provisioning-model SPOT` |

**Spot VM design pattern:** Use `--instance-termination-action STOP` so the disk and IP survive. Your startup script should be idempotent — assume it can run multiple times. Store all mutable state outside the VM (GCS, Cloud SQL, Redis) so a preemption is just a restart, not a data loss event.

### Instance Templates and Managed Instance Groups (MIGs)

An **Instance Template** is an immutable snapshot of VM configuration. A **Managed Instance Group** uses a template to maintain a fleet of identical, auto-healing, optionally auto-scaling VMs. This is the GCP-native equivalent of an Auto Scaling Group in AWS.

```bash
# Step 1: Create an instance template
gcloud compute instance-templates create myapp-v2-template \
  --machine-type e2-standard-2 \
  --image-family debian-12 \
  --image-project debian-cloud \
  --boot-disk-size 30GB \
  --boot-disk-type pd-balanced \
  --service-account myapp-sa@my-project.iam.gserviceaccount.com \
  --scopes cloud-platform \
  --metadata-from-file startup-script=startup.sh \
  --tags http-server

# Step 2: Create a regional MIG (spans multiple zones — more resilient)
gcloud compute instance-groups managed create myapp-mig \
  --template myapp-v2-template \
  --size 3 \
  --region us-central1 \    # Regional MIG distributes across zones automatically
  --health-checks myapp-health-check \
  --initial-delay 120        # Seconds before health checks start (let startup finish)

# Step 3: Configure autoscaling
gcloud compute instance-groups managed set-autoscaling myapp-mig \
  --region us-central1 \
  --min-num-replicas 2 \
  --max-num-replicas 20 \
  --target-cpu-utilization 0.65 \
  --cool-down-period 90      # Seconds between scaling decisions

# Rolling update to a new template (zero-downtime deploys)
gcloud compute instance-groups managed rolling-action start-update myapp-mig \
  --version template=myapp-v3-template \
  --max-surge 3 \            # Spin up this many extra VMs during update
  --max-unavailable 0 \      # Never take more than 0 existing VMs out of service
  --region us-central1

# Check rollout status
gcloud compute instance-groups managed describe-instance-updates myapp-mig \
  --region us-central1
```

**MIG auto-healing:** When a health check fails on a VM, the MIG automatically deletes and recreates it using the instance template. This is the mechanism that makes stateless fleets self-healing. The health check must be created separately (`gcloud compute health-checks create http`) and attached to the MIG.

### Cloud Storage (GCS) — Core Operations

GCS uses a flat namespace. "Folders" are a console illusion — `gs://bucket/a/b/c.txt` is a single object named `a/b/c.txt`. This matters when you write code that lists or manipulates objects.

```bash
# Create bucket — name must be globally unique across all GCP customers
gsutil mb -l us-central1 -c standard gs://mycompany-artifacts-prod

# Upload single file
gsutil cp ./app-v1.2.tar.gz gs://mycompany-artifacts-prod/releases/

# Upload with explicit storage class override
gsutil -h "x-goog-storage-class:NEARLINE" cp ./archive.tar.gz gs://mycompany-artifacts-prod/archives/

# Parallel upload of a directory (-m = parallel, -r = recursive)
gsutil -m cp -r ./dist gs://mycompany-artifacts-prod/static/

# Sync (only transfers changed files — preferred for CI artifact publishing)
gsutil -m rsync -r ./dist gs://mycompany-artifacts-prod/static/
gsutil -m rsync -r -d ./dist gs://mycompany-artifacts-prod/static/  # -d: delete remote extras

# List with sizes and timestamps
gsutil ls -l -h gs://mycompany-artifacts-prod/releases/

# Enable versioning
gsutil versioning set on gs://mycompany-artifacts-prod

# List all versions of all objects (including non-current)
gsutil ls -a gs://mycompany-artifacts-prod/releases/

# Restore a previous version (copy the non-current version over the live one)
gsutil cp \
  "gs://mycompany-artifacts-prod/releases/app.tar.gz#1698765432000000" \
  gs://mycompany-artifacts-prod/releases/app.tar.gz

# Delete a specific version
gsutil rm "gs://mycompany-artifacts-prod/releases/old.tar.gz#1698000000000000"
```

**Versioning gotcha:** When versioning is enabled, `gsutil rm` on a live object creates a **delete marker** — it doesn't free space. The old versions still exist and accrue storage charges. You need an explicit lifecycle rule (or `gsutil rm -a`) to permanently purge old versions.

### GCS Storage Classes and Lifecycle Policies

Storage classes determine retrieval cost and minimum storage duration:

| Class | Min Storage Duration | Retrieval Fee | Best For |
|-------|---------------------|---------------|---------|
| Standard | None | None | Active data, CI artifacts |
| Nearline | 30 days | $0.01/GB | Monthly backups, logs |
| Coldline | 90 days | $0.02/GB | Quarterly archives |
| Archive | 365 days | $0.05/GB | Compliance, DR cold copies |

**Early deletion fee:** If you store something in Coldline for 45 days then delete it, you are charged for 90 days. Design lifecycle rules to match your actual access patterns before choosing cold storage classes.

```bash
# Lifecycle policy: tiered retention + cleanup
cat > lifecycle.json << 'EOF'
{
  "rule": [
    {
      "action": {"type": "SetStorageClass", "storageClass": "NEARLINE"},
      "condition": {
        "age": 30,
        "matchesStorageClass": ["STANDARD"]
      }
    },
    {
      "action": {"type": "SetStorageClass", "storageClass": "COLDLINE"},
      "condition": {
        "age": 90,
        "matchesStorageClass": ["NEARLINE"]
      }
    },
    {
      "action": {"type
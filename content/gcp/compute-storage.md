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

**Named configurations tip:** Use `gcloud config configurations list` to see all named configs and their active project. In scripts, always pass `--project` explicitly rather than relying on default config — defaults are mutable state and make scripts non-reproducible across engineers.

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

**Persistent disk vs local SSD:** Local SSDs are physically attached NVMe drives with ~10x the IOPS of `pd-ssd`, but they are ephemeral — data is lost when the VM stops or is live-migrated. Never use local SSD as your only storage layer for anything you care about. Use it as a fast scratch/cache tier backed by persistent disk or GCS.

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

**`--scopes` vs service account:** The `--scopes` flag is a legacy OAuth2 mechanism. Setting `--scopes cloud-platform` and attaching a properly-permissioned service account is the correct modern pattern. The scope grants the broadest OAuth access; actual permissions are then controlled by IAM on the service account. Never rely on the default compute service account — it has Editor on the project, which is effectively root access to your entire project.

**Tags vs labels:** `--tags` are network tags used exclusively for firewall rule targeting. `--labels` are arbitrary key-value metadata for billing, resource organization, and filtering. A tag `http-server` does nothing by itself — it only matters if a firewall rule references it. Confusing the two is a common source of broken network policies.

#### Startup Scripts

Startup scripts run as root on first boot (and on every restart). They are the primary mechanism for bootstrapping software on VMs and must be idempotent.

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

# Signal that startup is complete (useful for health checks and MIG initial delay)
curl -s -X PUT \
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

**Startup script failure behavior:** If your startup script exits non-zero, the VM boots anyway — GCP does not halt a VM because its startup script failed. This means silent failures are possible. Always write startup scripts with `set -euo pipefail`, emit structured logs, and use Cloud Monitoring or a health check endpoint to verify successful initialization.

### Preemptible and Spot VMs

Spot and Preemptible VMs run on surplus capacity and can be reclaimed by GCP with a 30-second warning. They are 60–91% cheaper than on-demand pricing and are ideal for batch jobs, CI workers, and stateless compute.

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

**Spot VM design pattern:** Use `--instance-termination-action STOP` so the disk and IP survive reclamation. Your startup script must be idempotent — assume it can run multiple times. Store all mutable state outside the VM (GCS, Cloud SQL, Memorystore) so a preemption is just a restart, not a data loss event. For CI workloads, a 30-second warning is usually enough to checkpoint or gracefully abort a job.

**Handling the preemption signal:** GCP sends an ACPI shutdown event 30 seconds before reclamation. You can poll the metadata server to detect imminent preemption and trigger a graceful shutdown:

```bash
# Poll for preemption notice in a background loop
while true; do
  STATUS=$(curl -s -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/preempted")
  if [ "$STATUS" = "TRUE" ]; then
    echo "Preemption detected — checkpointing and exiting"
    /usr/local/bin/checkpoint-job.sh
    break
  fi
  sleep 5
done &
```

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

# Step 2: Create a regional MIG (spans multiple zones — more resilient than zonal)
gcloud compute instance-groups managed create myapp-mig \
  --template myapp-v2-template \
  --size 3 \
  --region us-central1 \
  --health-checks myapp-health-check \
  --initial-delay 120        # Seconds before health checks begin — let startup finish

# Step 3: Configure autoscaling
gcloud compute instance-groups managed set-autoscaling myapp-mig \
  --region us-central1 \
  --min-num-replicas 2 \
  --max-num-replicas 20 \
  --target-cpu-utilization 0.65 \
  --cool-down-period 90      # Seconds between scaling decisions

# Rolling update to a new template (zero-downtime deploy)
gcloud compute instance-groups managed rolling-action start-update myapp-mig \
  --version template=myapp-v3-template \
  --max-surge 3 \            # Extra VMs created during the update
  --max-unavailable 0 \      # Never reduce capacity below current size
  --region us-central1

# Check rollout status
gcloud compute instance-groups managed describe-instance-updates myapp-mig \
  --region us-central1

# List instances in the MIG with their current template version
gcloud compute instance-groups managed list-instances myapp-mig \
  --region us-central1
```

**MIG auto-healing:** When a health check fails on a VM, the MIG deletes and recreates it using the current instance template. This is the core mechanism that makes stateless fleets self-healing. Without an attached health check, the MIG only replaces VMs that fail at the hypervisor level — it cannot detect application-level failures like a hung process or a crashed web server. Always attach an HTTP health check that exercises your application's actual readiness.

**Instance template immutability:** You cannot edit an instance template after creation. To roll out a change, create a new template (e.g., `myapp-v3-template`) and perform a rolling update. This immutability is intentional — it makes every running VM traceable to a specific, versioned configuration, which is important for debugging and rollback.

| MIG Type | Scope | Use Case |
|----------|-------|---------|
| Zonal | Single zone | Lowest latency within a zone, simpler setup |
| Regional | Spans 3 zones in a region | Production — survives a zone outage |

### Cloud Storage (GCS) — Core Operations

GCS uses a flat namespace. "Folders" are a console illusion — `gs://bucket/a/b/c.txt` is a single object named `a/b/c.txt`. This matters when you write code that lists or manipulates objects — listing with a prefix delimiter is not a real directory traversal.

```bash
# Create bucket — name must be globally unique across all GCP customers
gsutil mb -l us-central1 -c standard gs://mycompany-artifacts-prod

# Upload single file
gsutil cp ./app-v1.2.tar.gz gs://mycompany-artifacts-prod/releases/

# Parallel upload of a directory (-m = multi-threaded, -r = recursive)
gsutil -m cp -r ./dist gs://mycompany-artifacts-prod/static/

# Sync (only transfers changed files — preferred for CI artifact publishing)
gsutil -m rsync -r ./dist gs://mycompany-artifacts-prod/static/
# -d flag: delete remote objects that no longer exist locally — use carefully
gsutil -m rsync -r -d ./dist gs://mycompany-artifacts-prod/static/

# List with human-readable sizes and timestamps
gsutil ls -l -h gs://mycompany-artifacts-prod/releases/

# Enable versioning on a bucket
gsutil versioning set on gs://mycompany-artifacts-prod

# List all versions of all objects (including non-current/deleted)
gsutil ls -a gs://mycompany-artifacts-prod/releases/

# Restore a previous version (copy the non-current version over the live object)
gsutil cp \
  "gs://mycompany-artifacts-prod/releases/app.tar.gz#1698765432000000" \
  gs://mycompany-artifacts-prod/releases/app.tar.gz

# Delete a specific version by generation number
gsutil rm "gs://mycompany-artifacts-prod/releases/old.tar.gz#1698000000000000"
```

**Versioning gotcha:** When versioning is enabled, `gsutil rm` on a live object creates a **delete marker** — it does not free storage. The previous versions still exist and accrue charges. Use `gsutil rm -a` to permanently delete all versions of an object, or configure a lifecycle rule to expire noncurrent versions automatically.

**`gsutil` vs `gcloud storage`:** Google is migrating from `gsutil` to `gcloud storage` (the `gcloud storage` subcommand). The new CLI is faster for large operations and uses the same credential chain as the rest of `gcloud`. For new scripts, prefer `gcloud storage cp`, `gcloud storage ls`, etc. The semantics are nearly identical.

```bash
# gcloud storage equivalents (faster for large transfers)
gcloud storage cp ./app-v1.2.tar.gz gs://mycompany-artifacts-prod/releases/
gcloud storage ls --long gs://mycompany-artifacts-prod/releases/
gcloud storage rsync -r ./dist gs://mycompany-artifacts-prod/static/
```

### GCS Storage Classes and Lifecycle Policies

Storage classes determine per-GB storage price, retrieval cost, and minimum storage duration. Choosing the wrong class for your access pattern wastes money in either direction — overpaying for cold retrieval on active data, or incurring early-deletion fees on data you delete sooner than expected.

| Class | Min Storage Duration | Retrieval Fee | Best For |
|-------|---------------------|---------------|---------|
| Standard | None | None | Active data, CI artifacts, serving |
| Nearline | 30 days | $0.01/GB | Monthly backups, infrequent logs |
| Coldline | 90 days | $0.02/GB | Quarterly archives, DR copies |
| Archive | 365 days | $0.05/GB | Compliance retention, write-once DR |

**Early deletion fee:** If you store an object in Coldline for 45 days then delete it, you are billed for 90 days. Archive has the sharpest penalty — a 30-day-old archive object deleted costs 365 days of storage. Design lifecycle rules around your actual access and deletion patterns before choosing cold classes.

```bash
# Create a lifecycle policy file (tiered retention + old version cleanup)
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
      "action": {"type": "Delete"},
      "condition": {
        "age": 365,
        "matchesStorageClass": ["COLDLINE"]
      }
    },
    {
      "action": {"type": "Delete"},
      "condition": {
        "numNewerVersions": 3,
        "isLive": false
      }
    }
  ]
}
EOF

# Apply the lifecycle policy to the bucket
gsutil lifecycle set lifecycle.json gs://mycompany-artifacts-prod

# Verify it was applied
gsutil lifecycle get gs://mycompany-artifacts-prod
```

The fourth rule above is critical for versioned buckets: it purges noncurrent versions once 3 newer versions exist, which prevents unbounded storage growth from automated CI uploads.

### GCS IAM and Access Control

GCS supports two parallel permission systems that interact in non-obvious ways:

| System | Scope | When to Use |
|--------|-------|------------|
| **Uniform bucket-level IAM** | Entire bucket, managed via IAM roles | Default for new buckets — simpler, auditable |
| **Fine-grained ACLs** | Per-object ACLs + bucket ACLs | Legacy; required only for public websites needing per-object public access |

**Always use uniform bucket-level access** for new buckets. Fine-grained ACLs make it impossible to audit effective permissions using IAM alone — an object can be publicly readable even if the bucket IAM says otherwise.

```bash
# Enable uniform bucket-level access (disables per-object ACLs)
gsutil uniformbucketlevelaccess set on gs://mycompany-artifacts-prod

# Grant a service account read access to the bucket
gsutil iam ch \
  serviceAccount:myapp-sa@my-project.iam.gserviceaccount.com:roles/storage.objectViewer \
  gs://mycompany-artifacts-prod

# Grant a CI service account write access to a specific prefix using IAM conditions
gcloud storage buckets add-iam-policy-binding gs://mycompany-artifacts-prod \
  --member="serviceAccount:ci-sa@my-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectCreator" \
  --condition='expression=resource.name.startsWith("projects/_/buckets/mycompany-artifacts-prod/objects/builds/"),title=ci-builds-only'

# View the current bucket IAM policy
gsutil iam get gs://mycompany-artifacts-prod
```

**Signed URLs:** To grant temporary, unauthenticated access to a private object (e.g., a download link in an email), use signed URLs rather than making the object public:

```bash
# Generate a signed URL valid for 1 hour
gcloud storage sign-url \
  gs://mycompany-artifacts-prod/releases/app-v1.2.tar.gz \
  --duration=1h \
  --private-key-file=sa-key.json
```

### GCS as a Terraform Backend

GCS is the standard remote backend for Terraform state in GCP environments. The bucket must exist before `terraform init`.

```hcl
# backend.tf
terraform {
  backend "gcs" {
    bucket  = "mycompany-tfstate-prod"
    prefix  = "terraform/myapp"   # State stored at gs://bucket/prefix/default.tfstate
  }
}
```

```bash
# Create the state bucket with versioning and uniform access
gsutil mb -l us-central1 gs://mycompany-tfstate-prod
gsutil versioning set on gs://mycompany-tfstate-prod
gsutil uniformbucketlevelaccess set on gs://mycompany-tfstate-prod

# Lock down the bucket — only the CI service account should write state
gsutil iam ch -d allUsers gs://mycompany-tfstate-prod  # Remove any public access
gsutil iam ch \
  serviceAccount:terraform-sa@my-project.iam.gserviceaccount.com:roles/storage.objectAdmin \
  gs://mycompany-tfstate-prod
```

**State locking:** GCS backends use object generation preconditions for state locking — no external lock table needed (unlike S3, which requires a DynamoDB table). This is one reason GCS is simpler to use as a Terraform backend than S3.

---

## Examples

### Example 1: Immutable VM Fleet with Rolling Deploys

This scenario shows the full lifecycle of deploying a stateless web application on a MIG, with a zero-downtime rolling update.

```bash
# 1. Create service account with least-privilege permissions
gcloud iam service-accounts create webserver-sa \
  --display-name "Web Server Service Account"

gcloud projects add-iam-policy-binding my-project-id \
  --member="serviceAccount:webserver-sa@my-project-id.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"   # Only needs to read config from GCS

# 2. Write startup script
cat > startup-v1.sh << 'EOF'
#!/bin/bash
set -euo pipefail
apt-get update -y && apt-get install -y nginx
gsutil cp gs://mycompany-config/nginx-v1.conf /etc/nginx/nginx.conf
systemctl enable --now nginx
EOF

# 3. Upload config to GCS
gsutil cp nginx-v1.conf gs://mycompany-config/nginx-v1.conf

# 4. Create instance template v1
gcloud compute instance-templates create webserver-v1 \
  --machine-type e2-standard-2 \
  --image-family debian-12 \
  --image-project debian-cloud \
  --boot-disk-type pd-balanced \
  --boot-disk-size 20GB \
  --service-account webserver-sa@my-project-id.iam.gserviceaccount.com \
  --scopes cloud-platform \
  --metadata-from-file startup-script=startup-v1.sh \
  --tags http-server

# 5. Create HTTP health check
gcloud compute health-checks create http webserver-hc \
  --port 80 \
  --request-path /healthz \
  --check-interval 10 \
  --unhealthy-threshold 3

# 6. Create regional MIG
gcloud compute instance-groups managed create webserver-mig \
  --template webserver-v1 \
  --size 3 \
  --region us-central1 \
  --health-checks webserver-hc \
  --initial-delay 90

# 7. Verify all instances are healthy
gcloud compute instance-groups managed list-instances webserver-mig \
  --region us-central1
# Expected: all instances show RUNNING with health status HEALTHY

# --- Later: deploy v2 ---

# 8. Create new template
gcloud compute instance-templates create webserver-v2 \
  --machine-type e2-standard-2 \
  --image-family debian-12 \
  --image-project debian-cloud \
  --boot-disk-type pd-balanced \
  --boot-disk-size 20GB \
  --service-account webserver-sa@my-project-id.iam.gserviceaccount.com \
  --scopes cloud-platform \
  --metadata startup-script="$(cat startup-v2.sh)" \
  --tags http-server

# 9. Rolling update — surge by 1, never reduce below 3
gcloud compute instance-groups managed rolling-action start-update webserver-mig \
  --version template=webserver-v2 \
  --max-surge 1 \
  --max-unavailable 0 \
  --region us-central1

# 10. Watch progress
watch -n 5 gcloud compute instance-groups managed list-instances webserver-mig \
  --region us-central1 --format="table(name,status,currentAction,version.name)"
```

### Example 2: CI/CD Artifact Pipeline with GCS

A CI pipeline builds a binary, uploads it to GCS with metadata, and a deployment script pulls the correct version to a VM.

```bash
# --- CI side (runs in GitHub Actions / Cloud Build) ---

VERSION=$(git rev-parse --short HEAD)
ARTIFACT="app-${VERSION}.tar.gz"

# Build and package
make build
tar -czf "${ARTIFACT}" ./bin/

# Upload artifact with version metadata attached to the object
gsutil -h "x-goog-meta-git-sha:${VERSION}" \
       -h "x-goog-meta-build-time:$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  cp "${ARTIFACT}" "gs://mycompany-artifacts-prod/releases/${ARTIFACT}"

# Write a "latest" pointer (small text file with the current version)
echo "${VERSION}" | gsutil cp - gs://mycompany-artifacts-prod/releases/latest.txt

echo "Artifact uploaded: gs://mycompany-artifacts-prod/releases/${ARTIFACT}"

# --- Deployment side (runs in startup script or deploy job) ---

# Read the latest version pointer
LATEST=$(gsutil cat gs://mycompany-artifacts-prod/releases/latest.txt)
echo "Deploying version: ${LATEST}"

# Download artifact to VM
gsutil cp "gs://mycompany-artifacts-prod/releases/app-${LATEST}.tar.gz" /tmp/app.tar.gz

# Verify the object metadata matches expectations
gsutil stat "gs://mycompany-artifacts-prod/releases/app-${LATEST}.tar.gz" | grep "git-sha"

# Extract and install
tar -xzf /tmp/app.tar.gz -C /opt/app/
systemctl restart myapp

# Verify the service came up
sleep 5
systemctl is-active myapp || { journalctl -u myapp --no-pager -n 50; exit 1; }
```

### Example 3: Spot VM Batch Worker Pool

This scenario spins up Spot VM workers to process a queue of jobs, with graceful shutdown on preemption.

```bash
# worker-startup.sh — runs on each Spot VM at boot
cat > worker-startup.sh << 'EOF'
#!/bin/bash
set -euo pipefail

apt-get update -y && apt-get install -y python3-pip
pip3 install google-cloud-pubsub google-cloud-storage

# Download the worker binary from GCS
gsutil cp gs://mycompany-workers/job-processor /usr/local/bin/job-processor
chmod +x /usr/local/bin/job-processor

# Write a systemd service for the worker
cat > /etc/systemd/system/job-worker.service << 'UNIT'
[Unit]
Description=Batch Job Worker
After=network.target

[Service]
ExecStart=/usr/local/bin/job-processor --subscription=projects/my-project/subscriptions/jobs-sub
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl enable --now job-worker

# Poll for preemption and trigger graceful shutdown
(while true; do
  PREEMPTED=$(curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/preempted" || echo "FALSE")
  [ "$PREEMPTED" = "TRUE" ] && { systemctl stop job-worker; break; }
  sleep 5
done) &
EOF

# Create instance template for spot workers
gcloud compute instance-templates create batch-worker-template \
  --machine-type n2-standard-4 \
  --provisioning-model SPOT \
  --instance-termination-action STOP \
  --image-family debian-12 \
  --image-project debian-cloud \
  --boot-disk-type pd-balanced \
  --boot-disk-size 50GB \
  --service-account worker-sa@my-project.iam.gserviceaccount.com \
  --scopes cloud-platform \
  --metadata-from-file startup-script=worker-startup.sh

# Create a MIG for the worker pool — no health check needed for batch
gcloud compute instance-groups managed create batch-worker-mig \
  --template batch-worker-template \
  --size 10 \
  --zone us-central1-a

# Scale to zero when the queue is drained (cost = $0 at idle)
gcloud compute instance-groups managed resize batch-worker-mig \
  --size 0 \
  --zone us-central1-a

# Verify no instances are running
gcloud compute instance-groups managed list-instances batch-worker-mig \
  --zone us-central1-a
```

### Example 4: Secure GCS Bucket for Terraform State

Full setup of a hardened Terraform state bucket with versioning, lifecycle management, and locked-down IAM.

```bash
PROJECT_ID="my-project-id"
BUCKET="mycompany-tfstate-${PROJECT_ID}"
TF_SA="terraform-sa@${PROJECT_ID}.iam.gserviceaccount.com"

# Create bucket in the same region as your primary resources
gsutil mb -l us-central1 -c standard "gs://${BUCKET}"

# Enable versioning — lets you recover from accidental state corruption
gsutil versioning set on "gs://${BUCKET}"

# Enable uniform bucket-level access — disable per-object ACLs
gsutil uniformbucketlevelaccess set on "gs://${BUCKET}"

# Prevent public access at bucket level
gsutil pap set enforced "gs://${BUCKET}"

# Lifecycle: keep 10 noncurrent state versions, delete older ones
cat > tf-state-lifecycle.json << EOF
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {
        "numNewerVersions": 10,
        "isLive": false
      }
    }
  ]
}
EOF
gsutil lifecycle set tf-state-lifecycle.json "gs://${BUCKET}"

# Grant only the Terraform SA write access; give humans read-only for debugging
gsutil iam ch \
  "serviceAccount:${TF_SA}:roles/storage.objectAdmin" \
  "gs://${BUCKET}"

# Allow engineers to read state (e.g., for `terraform state list` debugging)
gsutil iam ch \
  "group:platform-eng@mycompany.com:roles/storage.objectViewer" \
  "gs://${BUCKET}"

# Verify final IAM policy
gsutil iam get "gs://${BUCKET}"

# Confirm versioning and lifecycle are set
gsutil versioning get "gs://${BUCKET}"
gsutil lifecycle get "gs://${BUCKET}"
```

Configure Terraform to use the bucket:

```hcl
# backend.tf
terraform {
  backend "gcs" {
    bucket = "mycompany-tfstate-my-project-id"
    prefix = "terraform/infra"
  }
}
```

```bash
# Initialize — pulls the remote state
terraform init

# State locking test — run two applies simultaneously; the second should fail with lock error
# This is automatic with GCS backends — no DynamoDB table required
terraform apply -auto-approve
```

---

## Exercises

### Exercise 1: Launch a Private VM and Access It via IAP

Create a VM with no external IP address, then SSH into it using Identity-Aware Proxy tunneling. Verify that the VM has no public IP and that SSH still works.

1. Create a VPC firewall rule that allows IAP's IP range (`35.235.240.0/20`) to reach port 22 on instances tagged `iap-ssh`.
2. Create a Debian VM with `--no-address` and the tag `iap-ssh`. Attach the default compute service account — **then find and fix the security problem this creates before proceeding**.
3. SSH into the VM using `gcloud compute ssh --tunnel-through-iap`.
4. From inside the VM, run `curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/name` and explain what you get back and why it works without public internet access.

**Acceptance criteria:** SSH succeeds with no external IP. You can articulate why the default service account is a risk and what you replaced it with.

### Exercise 2: GCS Bucket with Versioning and Lifecycle

Simulate a CI pipeline that publishes multiple builds to GCS, then configure lifecycle management to limit version accumulation.

1. Create a GCS bucket with versioning enabled and uniform bucket-level access enforced.
2. Upload the same file (`build.txt`) five times with different content each time, simulating five CI builds.
3. Use `gsutil ls -a` to confirm all five versions exist. Calculate the total storage being used.
4. Write and apply a lifecycle policy that: (a) deletes noncurrent versions when 2 newer versions exist, and (b) transitions live objects to Nearline after 60 days.
5. Verify the policy was applied. Explain in writing why the noncurrent version rule doesn't immediately delete your 5 existing old versions.

**Acceptance criteria:** Policy is applied correctly. You can explain lifecycle evaluation timing and the difference between deleting a live object vs. a noncurrent version.

### Exercise 3: MIG with Auto-Healing

Deploy a two-VM MIG with an HTTP health check, then manually break one VM and observe auto-healing.

1. Write a startup script that installs nginx and serves a simple `/healthz` endpoint returning `200 OK`.
2. Create an instance template and a zonal MIG with size 2, attached to an HTTP health check on port 80, path `/healthz`.
3. Wait until both VMs are healthy. Use `gcloud compute instance-groups managed list-instances` to confirm.
4. SSH into one VM and run `systemctl stop nginx`. Watch the MIG detect the unhealthy instance and replace it. Time how long it takes from failure to a new healthy VM.
5. Adjust `--initial-delay` on the MIG and `--check-interval` on the health check. Re-run and measure the new recovery time. Explain the tradeoff between fast detection and false positives on startup.

**Acceptance criteria:** You observe a VM being automatically replaced. You can explain the role of `--initial-delay` and why it must exceed your startup script's worst-case runtime.

### Exercise 4: Spot VM with Idempotent Startup

Run a compute job on a Spot VM and demonstrate that preemption and restart produce the same output without data duplication.

1. Write a startup script that: reads a counter value from a GCS object, increments it by 1, writes it back, and appends a log line with the instance name and timestamp to a GCS log file.
2. Create a Spot VM with `--instance-termination-action STOP` that runs this script.
3. After the first run completes, manually stop and start the VM to simulate a preemption. Run the startup script again (or let it run on restart).
4. Verify the counter was incremented exactly once per boot, not duplicated.
5. Now introduce a deliberate race condition: run two VMs simultaneously using the same GCS object. Observe what happens to the counter. Research and implement a fix using GCS object generation preconditions (`x-goog-if-generation-match`).

**Acceptance criteria:** You can demonstrate idempotent state updates to GCS from a VM startup script, and you understand why concurrent writes require generation-based optimistic locking.

---

### Quick Checks

6. Extract the instance zone from a GCP resource path. Run: `echo "projects/my-project/zones/us-central1-a/instances/web-server" | cut -d/ -f4`

```expected_output
us-central1-a
```

7. Convert a GCS URI to its bucket name. Run: `echo "gs://my-data-bucket/path/to/object.csv" | cut -d/ -f3`

```expected_output
my-data-bucket
```

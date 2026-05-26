---
title: Compute Engine and Cloud Storage
module: gcp
duration_min: 25
difficulty: intermediate
tags: [gcp, compute-engine, cloud-storage, gcs, iam, vpc, gsutil, gcloud]
exercises: 4
---

## Overview
Compute Engine is GCP's IaaS VM service, equivalent to AWS EC2. Cloud Storage (GCS) is GCP's object storage, equivalent to S3. Together with GCP's IAM and VPC, these three are the foundation for any GCP infrastructure. The GCP IAM model differs meaningfully from AWS — everything has a resource hierarchy (Organization → Folder → Project → Resource), and permissions are inherited down the tree.

## Concepts

### gcloud Setup
```bash
# Install Google Cloud SDK
# https://cloud.google.com/sdk/docs/install

# Authenticate
gcloud auth login
gcloud config set project my-project-id
gcloud config set compute/region us-central1
gcloud config set compute/zone us-central1-a

# Check current config
gcloud config list
gcloud auth list
```

### Compute Engine — VM Instances

#### Machine Types
```
e2-micro          — 2 vCPU (shared), 1 GB RAM   (free tier eligible)
e2-standard-4     — 4 vCPU, 16 GB RAM            (general purpose, cost-efficient)
n2-standard-8     — 8 vCPU, 32 GB RAM            (balanced performance)
c2-standard-4     — 4 vCPU, 16 GB RAM            (compute-optimized)
m2-ultramem-208   — 208 vCPU, 5888 GB RAM        (memory-optimized)
a2-highgpu-1g     — 12 vCPU, 85 GB RAM + 1xA100 (GPU)

Custom: n1-custom-6-15360  — 6 vCPU, 15 GB RAM (exact sizing)
```

#### Creating Instances
```bash
# Create a VM
gcloud compute instances create myapp \
  --machine-type e2-standard-2 \
  --image-family debian-12 \
  --image-project debian-cloud \
  --zone us-central1-a \
  --boot-disk-size 20GB \
  --boot-disk-type pd-ssd \
  --service-account myapp-sa@my-project.iam.gserviceaccount.com \
  --scopes cloud-platform \
  --metadata-from-file startup-script=startup.sh \
  --tags http-server,https-server

# List instances
gcloud compute instances list

# SSH in (gcloud handles key management)
gcloud compute ssh myapp --zone us-central1-a

# Stop / delete
gcloud compute instances stop myapp
gcloud compute instances delete myapp
```

#### Startup Scripts
```bash
#!/bin/bash
apt-get update -y
apt-get install -y docker.io
systemctl enable --now docker
```

Pass via `--metadata-from-file startup-script=startup.sh` or inline with `--metadata startup-script='#!/bin/bash ...'`.

#### Preemptible / Spot VMs
```bash
# Preemptible (classic) — up to 24h max lifetime, ~80% cheaper
gcloud compute instances create myapp \
  --preemptible \
  --machine-type n2-standard-4 ...

# Spot VMs (replacement for preemptible, no 24h limit)
gcloud compute instances create myapp \
  --provisioning-model SPOT \
  --instance-termination-action STOP \
  --machine-type n2-standard-4 ...
```

#### Instance Templates and Managed Instance Groups
```bash
# Create an instance template
gcloud compute instance-templates create myapp-template \
  --machine-type e2-standard-2 \
  --image-family debian-12 --image-project debian-cloud \
  --metadata-from-file startup-script=startup.sh

# Create a managed instance group (auto-scaling, auto-healing)
gcloud compute instance-groups managed create myapp-mig \
  --template myapp-template \
  --size 3 \
  --zone us-central1-a

# Enable autoscaling
gcloud compute instance-groups managed set-autoscaling myapp-mig \
  --min-num-replicas 2 \
  --max-num-replicas 10 \
  --target-cpu-utilization 0.6 \
  --zone us-central1-a
```

### Cloud Storage (GCS)

#### Core Operations
```bash
# Create bucket
gsutil mb -l US-CENTRAL1 gs://my-unique-bucket-name

# Upload / download
gsutil cp ./file.txt gs://my-bucket/folder/file.txt
gsutil cp gs://my-bucket/folder/file.txt ./file.txt

# Sync directory
gsutil -m rsync -r ./dist gs://my-bucket/dist
gsutil -m rsync -r -d ./dist gs://my-bucket/dist   # -d deletes remote files not in source

# List
gsutil ls gs://my-bucket/
gsutil ls -l -h gs://my-bucket/   # human-readable sizes

# Delete
gsutil rm gs://my-bucket/file.txt
gsutil -m rm -r gs://my-bucket/folder/

# Set public access
gsutil iam ch allUsers:objectViewer gs://my-bucket
```

#### Storage Classes
```
Standard          — frequently accessed (~$0.020/GB/month)
Nearline          — accessed < once/month (~$0.010/GB)
Coldline          — accessed < once/quarter (~$0.004/GB)
Archive           — accessed < once/year (~$0.0012/GB)
```

```bash
# Create bucket with specific storage class
gsutil mb -c nearline -l us-central1 gs://my-archive-bucket

# Change object storage class
gsutil rewrite -s coldline gs://my-bucket/old-data/**
```

#### Lifecycle Policies
```bash
# Create lifecycle rule (transition to Nearline after 30 days, delete after 365)
cat > lifecycle.json <<'EOF'
{
  "rule": [
    {
      "action": {"type": "SetStorageClass", "storageClass": "NEARLINE"},
      "condition": {"age": 30}
    },
    {
      "action": {"type": "Delete"},
      "condition": {"age": 365}
    }
  ]
}
EOF

gsutil lifecycle set lifecycle.json gs://my-bucket
gsutil lifecycle get gs://my-bucket
```

#### Signed URLs (time-limited access)
```python
from google.cloud import storage
from datetime import timedelta

client = storage.Client()
bucket = client.bucket('my-bucket')
blob = bucket.blob('reports/q4.pdf')

url = blob.generate_signed_url(
    expiration=timedelta(hours=1),
    method='GET'
)
```

### GCP IAM

#### Resource Hierarchy
```
Organization (my-company.com)
└── Folder (production)
    └── Project (my-app-prod)
        └── Resources (GCE, GCS, GKE, etc.)
```

Permissions granted at a higher level are inherited by all resources below. Grant at the most specific level needed.

#### Roles
```
Primitive roles (legacy, avoid)  — Owner, Editor, Viewer (too broad)
Predefined roles                 — roles/storage.objectAdmin, roles/compute.instanceAdmin
Custom roles                     — fine-grained permissions you define
```

```bash
# Grant a role to a service account on a specific resource
gsutil iam ch serviceAccount:myapp-sa@my-project.iam.gserviceaccount.com:objectAdmin \
  gs://my-bucket

# Grant project-level role
gcloud projects add-iam-policy-binding my-project \
  --member serviceAccount:myapp-sa@my-project.iam.gserviceaccount.com \
  --role roles/logging.logWriter

# View IAM policy on a bucket
gsutil iam get gs://my-bucket

# View project IAM policy
gcloud projects get-iam-policy my-project
```

#### Service Accounts
```bash
# Create service account
gcloud iam service-accounts create myapp-sa \
  --display-name "MyApp Service Account"

# Create key (prefer Workload Identity where possible — no key file needed)
gcloud iam service-accounts keys create sa-key.json \
  --iam-account myapp-sa@my-project.iam.gserviceaccount.com

# Use the key
export GOOGLE_APPLICATION_CREDENTIALS=./sa-key.json
```

## Exercises

1. Create a Compute Engine VM with a startup script that installs nginx. Allow HTTP traffic by adding the `http-server` tag and a firewall rule. SSH in via `gcloud compute ssh` and verify nginx is serving on port 80.
2. Create a GCS bucket and upload a directory of files using `gsutil -m rsync`. Enable versioning. Upload a new version of one file, then list all versions with `gsutil ls -a`. Restore the previous version.
3. Apply a lifecycle policy to a GCS bucket that transitions objects to Nearline after 30 days. Set up logging for the bucket to track access. Verify the lifecycle policy with `gsutil lifecycle get`.
4. Create a service account with only `roles/storage.objectViewer` on a specific bucket. Generate a key, set `GOOGLE_APPLICATION_CREDENTIALS`, and verify it can read but not write to the bucket using the Python GCS client.

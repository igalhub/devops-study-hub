---
title: Google Kubernetes Engine (GKE)
module: gcp
duration_min: 25
difficulty: intermediate
tags: [gcp, gke, kubernetes, autopilot, workload-identity, ingress, node-pools]
exercises: 4
---

## Overview
GKE is GCP's managed Kubernetes service. It comes in two modes: Standard (you manage nodes) and Autopilot (GCP manages everything — you pay per pod, not per node). Autopilot is the better default for new clusters: it handles node provisioning, auto-scaling, OS patching, and security hardening automatically. The GKE-specific integrations to know are Workload Identity (IAM for pods), GKE Ingress (Google Cloud Load Balancer), and Artifact Registry.

## Concepts

### Cluster Modes

**Autopilot** (recommended for new clusters)
```bash
gcloud container clusters create-auto prod-cluster \
  --region us-central1 \
  --project my-project

# Autopilot: no node management, pay per pod resource request
# - Nodes provisioned automatically
# - Optimized for security (no SSH, no privileged containers)
# - Scales to zero (cost-efficient for dev environments)
```

**Standard** (when you need control over nodes)
```bash
gcloud container clusters create prod-cluster \
  --zone us-central1-a \
  --num-nodes 3 \
  --machine-type n2-standard-4 \
  --disk-size 100 \
  --enable-autoscaling \
  --min-nodes 2 \
  --max-nodes 10 \
  --enable-ip-alias \
  --workload-pool my-project.svc.id.goog \
  --release-channel regular
```

### Connecting kubectl
```bash
# Get credentials for a cluster
gcloud container clusters get-credentials prod-cluster \
  --region us-central1 \
  --project my-project

# Verify
kubectl get nodes
kubectl cluster-info
```

### Node Pools (Standard mode)
```bash
# Add a node pool (e.g. GPU pool)
gcloud container node-pools create gpu-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --machine-type n1-standard-4 \
  --accelerator type=nvidia-tesla-t4,count=1 \
  --num-nodes 2 \
  --enable-autoscaling \
  --min-nodes 0 \
  --max-nodes 5

# Spot node pool (cost-efficient for fault-tolerant workloads)
gcloud container node-pools create spot-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --machine-type e2-standard-4 \
  --spot \
  --enable-autoscaling \
  --min-nodes 0 \
  --max-nodes 20

# Cordon and drain a node pool before deleting
kubectl drain --ignore-daemonsets --delete-emptydir-data \
  $(kubectl get nodes -l cloud.google.com/gke-nodepool=old-pool -o name)
gcloud container node-pools delete old-pool --cluster prod-cluster --zone us-central1-a
```

### Workload Identity
Workload Identity lets pods assume GCP IAM service accounts without storing key files. This is the correct way to give Kubernetes workloads GCP permissions.

```bash
# 1. Enable Workload Identity on the cluster (or use --workload-pool at creation)
gcloud container clusters update prod-cluster \
  --workload-pool my-project.svc.id.goog \
  --zone us-central1-a

# 2. Create a GCP service account
gcloud iam service-accounts create myapp-sa \
  --project my-project

# 3. Grant the GCP SA the permissions it needs
gcloud projects add-iam-policy-binding my-project \
  --member serviceAccount:myapp-sa@my-project.iam.gserviceaccount.com \
  --role roles/storage.objectAdmin

# 4. Create a Kubernetes service account
kubectl create serviceaccount myapp-ksa -n production

# 5. Bind the KSA to the GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  myapp-sa@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[production/myapp-ksa]"

# 6. Annotate the KSA
kubectl annotate serviceaccount myapp-ksa -n production \
  iam.gke.io/gcp-service-account=myapp-sa@my-project.iam.gserviceaccount.com
```

```yaml
# Use the annotated KSA in your Deployment
spec:
  serviceAccountName: myapp-ksa
  containers:
    - name: app
      # Pod gets GCP credentials via projected token — no key file
```

### GKE Ingress
GKE Ingress creates a Google Cloud Load Balancer (L7):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
  annotations:
    kubernetes.io/ingress.class: "gce"              # external GCLB
    kubernetes.io/ingress.allow-http: "false"       # HTTPS only
    networking.gke.io/managed-certificates: myapp-cert
    networking.gke.io/v1beta1.FrontendConfig: myapp-frontend
spec:
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /*
            pathType: ImplementationSpecific
            backend:
              service:
                name: myapp
                port:
                  number: 80
```

```yaml
# Google-managed SSL certificate (auto-provisioned, auto-renewed)
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: myapp-cert
spec:
  domains:
    - api.myapp.com
```

### Artifact Registry Integration
```bash
# Configure Docker to authenticate with Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev

# Create a repository
gcloud artifacts repositories create myapp \
  --repository-format docker \
  --location us-central1

# Build and push
docker build -t us-central1-docker.pkg.dev/my-project/myapp/api:latest .
docker push us-central1-docker.pkg.dev/my-project/myapp/api:latest
```

```yaml
# Reference in Kubernetes Deployment
image: us-central1-docker.pkg.dev/my-project/myapp/api:v1.2.3
```

GKE nodes have access to Artifact Registry in the same project via Workload Identity — no `imagePullSecrets` needed if the node SA has `roles/artifactregistry.reader`.

### Horizontal Pod Autoscaling with Custom Metrics
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    - type: Resource
      resource:
        name: memory
        target:
          type: AverageValue
          averageValue: 512Mi
```

### Cluster Upgrades
```bash
# Check available versions
gcloud container get-server-config --region us-central1

# Upgrade control plane
gcloud container clusters upgrade prod-cluster \
  --master \
  --cluster-version 1.31 \
  --region us-central1

# Upgrade node pool (surge upgrade — upgrades nodes one at a time)
gcloud container clusters upgrade prod-cluster \
  --node-pool default-pool \
  --cluster-version 1.31 \
  --zone us-central1-a
```

Use **release channels** (rapid, regular, stable) to get automatic upgrades within a channel — recommended for most clusters.

## Exercises

1. Create an Autopilot GKE cluster. Deploy a stateless application (nginx with a custom index page via ConfigMap). Expose it with a LoadBalancer service. Access it via the external IP.
2. Set up Workload Identity for a deployment that needs to read from a GCS bucket. Create the GCP SA, Kubernetes SA, bind them, and annotate the KSA. Verify the pod can access GCS without key files by running `gsutil ls gs://your-bucket` from inside the pod.
3. Deploy a GKE Ingress with a Google-managed SSL certificate for a test domain. Verify the certificate reaches `ACTIVE` status (may take ~15 minutes). Confirm HTTPS traffic routes to your backend service.
4. Create a spot node pool and taint it. Deploy a batch job with the corresponding toleration so it runs only on spot nodes. Verify pod placement with `kubectl get pod -o wide`.

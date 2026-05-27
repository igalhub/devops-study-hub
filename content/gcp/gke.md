---
title: Google Kubernetes Engine (GKE)
module: gcp
duration_min: 25
difficulty: intermediate
tags: [gcp, gke, kubernetes, autopilot, workload-identity, ingress, node-pools]
exercises: 4
---

## Overview

Google Kubernetes Engine (GKE) is GCP's fully managed Kubernetes service and one of the most mature managed Kubernetes offerings in the industry. For DevOps engineers, GKE removes the hardest operational work — etcd management, control plane upgrades, certificate rotation — while preserving the full Kubernetes API. This means you can focus on deploying workloads rather than babysitting the cluster infrastructure. GKE is the default choice for running containerized workloads on GCP, from microservices to ML training jobs to internal tooling.

GKE is built around two guiding principles: deep integration with GCP primitives and progressive operational responsibility. On the integration side, GKE hooks directly into Cloud IAM (Workload Identity), Cloud Load Balancing (GKE Ingress), Artifact Registry, Cloud Monitoring, and Cloud Logging — these aren't bolt-ons, they're first-class. On the responsibility side, GKE offers a spectrum from Autopilot (GCP owns nodes, scaling, security hardening) to Standard (you control node configuration, pool topology, and OS choices). Neither mode requires you to manage the control plane.

In the DevOps toolchain, GKE sits at the runtime layer: CI pipelines build images and push to Artifact Registry, GKE pulls and runs them, Cloud Monitoring/Logging provides observability, and tools like Helm or Config Connector manage configuration. Understanding GKE means understanding not just kubectl commands but also how Kubernetes abstractions map to GCP infrastructure — how an Ingress becomes a load balancer, how a ServiceAccount becomes an IAM principal, and how a node pool maps to a Managed Instance Group.

## Concepts

### Cluster Modes: Autopilot vs Standard

The choice between Autopilot and Standard is architectural, not cosmetic. It determines who manages nodes, what workloads you can run, and how you're billed.

| Dimension | Autopilot | Standard |
|---|---|---|
| Node management | GCP provisions, patches, scales | You manage node pools |
| Billing unit | Per pod resource request | Per node (running or idle) |
| Privileged containers | Not allowed | Allowed |
| SSH to nodes | Not supported | Supported |
| Custom OS / image | Not supported | Supported |
| Scale to zero | Supported | Requires min-nodes 0 per pool |
| GPUs | Supported (auto-provisioning) | Supported (explicit pool config) |
| Best for | Stateless apps, new projects | ML workloads, privileged daemonsets, cost optimization at scale |

**Autopilot** (recommended for new clusters):
```bash
gcloud container clusters create-auto prod-cluster \
  --region us-central1 \
  --project my-project

# Autopilot clusters are always regional (multi-zone by default)
# No --num-nodes flag — GCP determines nodes from pod requests
# Networking: VPC-native (alias IPs) is mandatory
```

**Standard** (when you need node-level control):
```bash
gcloud container clusters create prod-cluster \
  --zone us-central1-a \
  --num-nodes 3 \
  --machine-type n2-standard-4 \
  --disk-size 100 \
  --enable-autoscaling \
  --min-nodes 2 \
  --max-nodes 10 \
  --enable-ip-alias \           # VPC-native networking (required for many GKE features)
  --workload-pool my-project.svc.id.goog \
  --release-channel regular     # automatic minor version upgrades
```

**Autopilot gotcha:** Autopilot enforces resource requests on every container. If you omit `requests`, GKE injects defaults. Pods without requests may be scheduled with more resources than you expect — and billed for them. Always set explicit `requests` and `limits` in Autopilot clusters.

**Standard gotcha:** Creating a cluster without `--enable-ip-alias` (routes-based networking) disables Workload Identity, Private Google Access for pods, and several other features. Always use VPC-native (`--enable-ip-alias`) for new Standard clusters.

### Connecting kubectl

After cluster creation, `kubectl` needs credentials. GKE uses the `gke-gcloud-auth-plugin` to handle token refresh — this replaced the old embedded credential approach.

```bash
# Install the auth plugin (required since kubectl 1.26+)
gcloud components install gke-gcloud-auth-plugin

# Write cluster credentials into ~/.kube/config
gcloud container clusters get-credentials prod-cluster \
  --region us-central1 \
  --project my-project

# Verify connectivity
kubectl get nodes
kubectl cluster-info

# Working with multiple clusters — check current context
kubectl config get-contexts
kubectl config use-context gke_my-project_us-central1_prod-cluster
```

The kubeconfig entry created by `get-credentials` uses the `gke-gcloud-auth-plugin` as an exec credential provider. It fetches short-lived tokens using your active `gcloud` identity. This means your GCP IAM identity determines what Kubernetes RBAC can grant you — they're linked through GKE's IAM integration.

**RBAC note:** GKE maps GCP IAM roles to Kubernetes RBAC. `roles/container.clusterAdmin` grants full cluster access. `roles/container.developer` grants namespace-scoped access. You still need explicit Kubernetes `RoleBinding` or `ClusterRoleBinding` for fine-grained control inside the cluster.

### Node Pools (Standard Mode)

Node pools are groups of nodes with identical configuration within a cluster. A cluster can have multiple pools with different machine types, accelerators, or OS images. This is how you handle heterogeneous workload requirements: one pool for general-purpose services, another for GPU-intensive jobs, another of spot instances for batch work.

```bash
# GPU node pool for ML inference
gcloud container node-pools create gpu-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --machine-type n1-standard-4 \
  --accelerator type=nvidia-tesla-t4,count=1 \
  --num-nodes 2 \
  --enable-autoscaling \
  --min-nodes 0 \           # scale to zero when idle
  --max-nodes 5 \
  --node-taints nvidia.com/gpu=present:NoSchedule  # only GPU workloads land here

# Spot node pool for cost-efficient batch jobs
# Spot nodes can be preempted with 30s notice — use for fault-tolerant work only
gcloud container node-pools create spot-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --machine-type e2-standard-4 \
  --spot \
  --enable-autoscaling \
  --min-nodes 0 \
  --max-nodes 20

# Migrate off an old pool safely
# Step 1: Cordon all nodes in the old pool (no new pods scheduled)
kubectl cordon $(kubectl get nodes -l cloud.google.com/gke-nodepool=old-pool -o name)

# Step 2: Drain (evict existing pods gracefully)
kubectl drain --ignore-daemonsets --delete-emptydir-data \
  $(kubectl get nodes -l cloud.google.com/gke-nodepool=old-pool -o name)

# Step 3: Delete the pool
gcloud container node-pools delete old-pool \
  --cluster prod-cluster \
  --zone us-central1-a
```

**Spot node gotcha:** Spot nodes carry an automatic taint `cloud.google.com/gke-spot=true:NoSchedule`. Your workloads must have a matching toleration or they will never schedule on spot nodes — GKE doesn't do this automatically.

```yaml
# Required toleration for spot node pools
tolerations:
  - key: "cloud.google.com/gke-spot"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"
```

| Pool type | Cost | Eviction risk | Best for |
|---|---|---|---|
| On-demand | Baseline | None | Production stateful workloads |
| Spot | ~60-90% cheaper | Up to 30s notice | Batch jobs, CI runners, dev environments |
| Standard with committed use | ~30-55% cheaper | None | Predictable baseline load |

### Workload Identity

Workload Identity is the secure, keyfile-free way to give Kubernetes pods access to GCP APIs. Without it, you'd need to create a service account JSON key, store it as a Kubernetes Secret, and mount it into pods — a significant secret management burden and a credential leak risk.

With Workload Identity, a Kubernetes ServiceAccount (KSA) is linked to a GCP IAM ServiceAccount (GSA). When a pod runs with the KSA, GKE automatically injects a short-lived token that impersonates the GSA. No JSON key ever exists.

```bash
# 1. Workload Identity must be enabled on the cluster
gcloud container clusters update prod-cluster \
  --workload-pool my-project.svc.id.goog \
  --zone us-central1-a
# (Or pass --workload-pool at cluster creation — preferred)

# 2. Create the GCP service account
gcloud iam service-accounts create myapp-sa \
  --display-name "MyApp Service Account" \
  --project my-project

# 3. Grant the GSA the GCP permissions the app needs
gcloud projects add-iam-policy-binding my-project \
  --member serviceAccount:myapp-sa@my-project.iam.gserviceaccount.com \
  --role roles/storage.objectViewer

# 4. Create the Kubernetes service account
kubectl create serviceaccount myapp-ksa \
  --namespace production

# 5. Allow the KSA to impersonate the GSA
#    The member format encodes: project, namespace, and KSA name
gcloud iam service-accounts add-iam-policy-binding \
  myapp-sa@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[production/myapp-ksa]"

# 6. Annotate the KSA to point at the GSA
kubectl annotate serviceaccount myapp-ksa \
  --namespace production \
  iam.gke.io/gcp-service-account=myapp-sa@my-project.iam.gserviceaccount.com
```

```yaml
# Pod/Deployment spec — reference the annotated KSA
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: myapp-ksa   # this triggers Workload Identity token injection
      containers:
        - name: app
          image: us-central1-docker.pkg.dev/my-project/myapp/api:v1.2.3
          # No volume mounts for credentials needed
          # GCP client libraries auto-detect the projected token via GOOGLE_APPLICATION_CREDENTIALS
```

**Workload Identity gotcha:** The binding in step 5 is namespace-scoped. A KSA named `myapp-ksa` in `production` and a KSA named `myapp-ksa` in `staging` are different principals. If you want the same GSA to be used by both, you need two `add-iam-policy-binding` calls — one per namespace/KSA pair.

**Verification:**
```bash
# Exec into the pod and test GCP access
kubectl exec -it deploy/myapp -n production -- \
  gcloud storage ls gs://my-bucket --project my-project

# Check which identity the pod is using
kubectl exec -it deploy/myapp -n production -- \
  gcloud auth list
# Should show: myapp-sa@my-project.iam.gserviceaccount.com as ACTIVE
```

### GKE Ingress and Managed Certificates

GKE Ingress provisions a Google Cloud HTTP(S) Load Balancer when you create an `Ingress` object. This is a Layer 7 load balancer with global anycast IPs, Google-managed SSL, and built-in DDoS protection — substantially more capable than a basic `LoadBalancer` Service (which creates a regional TCP/UDP load balancer).

```yaml
# FrontendConfig: configure HTTPS redirect at the load balancer level
apiVersion: networking.gke.io/v1beta1
kind: FrontendConfig
metadata:
  name: myapp-frontend
spec:
  redirectToHttps:
    enabled: true
    responseCodeName: MOVED_PERMANENTLY_DEFAULT  # 301
---
# Google-managed SSL certificate — GCP provisions and renews automatically
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: myapp-cert
spec:
  domains:
    - api.myapp.com
---
# The Ingress itself — ties everything together
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
  annotations:
    kubernetes.io/ingress.class: "gce"                          # external GCLB (use "gce-internal" for internal LB)
    kubernetes.io/ingress.allow-http: "false"                   # block plain HTTP at LB
    networking.gke.io/managed-certificates: myapp-cert          # attach the managed cert
    networking.gke.io/v1beta1.FrontendConfig: myapp-frontend    # attach the redirect config
spec:
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /*
            pathType: ImplementationSpecific   # required for GCE ingress — use /* not /
            backend:
              service:
                name: myapp-service
                port:
                  number: 80
```

```bash
# Check ingress status — ADDRESS field shows the load balancer IP
kubectl get ingress myapp-ingress -w

# Check managed certificate status — takes 10-20 minutes to go ACTIVE
kubectl describe managedcertificate myapp-cert
# Provisioning status: Provisioning -> Active
# Certificate status must be Active before HTTPS works

# The backend service must use NodePort or ClusterIP (not headless)
# GKE Ingress requires a named port on the Service
kubectl get service myapp-service
```

**Ingress gotcha:** GKE Ingress requires backend Services to have a health check that passes. By default, GKE creates a health check that hits `/` on the container port. If your app returns non-200 on `/`, the backend will be marked unhealthy and traffic won't route. Use a `BackendConfig` to specify a custom health check path:

```yaml
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: myapp-backendconfig
spec:
  healthCheck:
    requestPath: /healthz
    port: 8080
---
# Reference BackendConfig from the Service
apiVersion: v1
kind: Service
metadata:
  name: myapp-service
  annotations:
    cloud.google.com/backend-config: '{"default": "myapp-backendconfig"}'
spec:
  type: NodePort   # GKE Ingress requires NodePort or ClusterIP (not LoadBalancer)
  selector:
    app: myapp
  ports:
    - port: 80
      targetPort: 8080
```

### Artifact Registry Integration

Artifact Registry is GCP's container registry and the successor to Container Registry (`gcr.io`). GKE integrates with it through node service accounts — by default, GKE nodes have the `roles/artifactregistry.reader` role for repositories in the same project, so `imagePullSecrets` are not required for same-project images.

```bash
# One-time: configure local Docker to authenticate with Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev

# Create a Docker repository
gcloud artifacts repositories create myapp \
  --repository-format docker \
  --location us-central1 \
  --description "Application container images"

# Build, tag, and push
docker build -t us-central1-docker.pkg.dev/my-project/myapp/api:v1.2.3 .
docker push us-central1-docker.pkg.dev/my-project
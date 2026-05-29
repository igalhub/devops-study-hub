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

In the DevOps toolchain, GKE sits at the runtime layer: CI pipelines build images and push to Artifact Registry, GKE pulls and runs them, Cloud Monitoring/Logging provides observability, and tools like Helm or Config Connector manage configuration. Understanding GKE means understanding not just `kubectl` commands but also how Kubernetes abstractions map to GCP infrastructure — how an Ingress becomes a load balancer, how a ServiceAccount becomes an IAM principal, and how a node pool maps to a Managed Instance Group.

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

**Autopilot gotcha:** Autopilot enforces resource requests on every container. If you omit `requests`, GKE injects defaults. Pods without explicit requests may be billed at higher injected values than you intended. Always set explicit `requests` and `limits` in Autopilot clusters.

**Standard gotcha:** Creating a cluster without `--enable-ip-alias` (routes-based networking) disables Workload Identity, Private Google Access for pods, and several other features. Always use VPC-native (`--enable-ip-alias`) for new Standard clusters.

**Release channel reference:**

| Channel | Kubernetes version lag | Auto-upgrade cadence | Best for |
|---|---|---|---|
| Rapid | Earliest access | Immediate on release | Testing new features |
| Regular | ~2-3 months behind rapid | Monthly | Most production workloads |
| Stable | ~5-6 months behind rapid | Quarterly | Conservative production |
| None | Pinned | Manual only | Compliance, strict change control |

### Connecting kubectl

After cluster creation, `kubectl` needs credentials. GKE uses the `gke-gcloud-auth-plugin` to handle token refresh — this replaced the old embedded credential approach in kubectl 1.26+.

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

# Working with multiple clusters — check and switch contexts
kubectl config get-contexts
kubectl config use-context gke_my-project_us-central1_prod-cluster

# Rename a context to something human-readable
kubectl config rename-context \
  gke_my-project_us-central1_prod-cluster \
  prod
```

The kubeconfig entry created by `get-credentials` uses the `gke-gcloud-auth-plugin` as an exec credential provider. It fetches short-lived tokens using your active `gcloud` identity. This means your GCP IAM identity determines what Kubernetes RBAC can grant you — they're linked through GKE's IAM integration.

**RBAC note:** GKE maps GCP IAM roles to Kubernetes RBAC permissions at the cluster API level. However, namespace-level access still requires explicit Kubernetes `RoleBinding` or `ClusterRoleBinding` inside the cluster.

| GCP IAM Role | Kubernetes access level |
|---|---|
| `roles/container.clusterAdmin` | Full cluster admin (`cluster-admin` ClusterRole) |
| `roles/container.developer` | Read/write to workloads, not cluster config |
| `roles/container.viewer` | Read-only across the cluster |
| `roles/container.clusterViewer` | Can view cluster metadata (nodes, pools), not workloads |

**Private cluster gotcha:** If your cluster has a private endpoint (no public API server), `get-credentials` succeeds but `kubectl` commands will fail unless you're on an authorized network or using Cloud Shell/IAP tunnel. Use `--enable-master-authorized-networks` with your CIDR to avoid lockouts.

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

# Step 2: Drain (evict existing pods gracefully, respecting PodDisruptionBudgets)
kubectl drain --ignore-daemonsets --delete-emptydir-data \
  $(kubectl get nodes -l cloud.google.com/gke-nodepool=old-pool -o name)

# Step 3: Delete the pool
gcloud container node-pools delete old-pool \
  --cluster prod-cluster \
  --zone us-central1-a
```

**Spot node gotcha:** Spot nodes carry an automatic taint `cloud.google.com/gke-spot=true:NoSchedule`. Your workloads must have a matching toleration or they will never schedule on spot nodes — GKE does not add this toleration automatically.

```yaml
# Required toleration for spot node pools
tolerations:
  - key: "cloud.google.com/gke-spot"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"
```

Use `nodeAffinity` alongside the toleration to prefer spot nodes without exclusively requiring them — useful when you want spot but need on-demand as a fallback:

```yaml
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
            - key: cloud.google.com/gke-spot
              operator: In
              values: ["true"]
```

| Pool type | Cost | Eviction risk | Best for |
|---|---|---|---|
| On-demand | Baseline | None | Production stateful workloads |
| Spot | ~60-90% cheaper | Up to 30s notice | Batch jobs, CI runners, dev environments |
| Committed use discount | ~30-55% cheaper | None | Predictable baseline load |

**Node auto-upgrade gotcha:** By default, GKE automatically upgrades node pools when the control plane upgrades. If you have stateful workloads that don't tolerate disruption during upgrades, configure maintenance windows and surge upgrade settings:

```bash
gcloud container node-pools update gpu-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --max-surge-upgrade 1 \       # one extra node during upgrade
  --max-unavailable-upgrade 0   # never take a node down without a replacement ready
```

### Workload Identity

Workload Identity is the secure, keyfile-free way to give Kubernetes pods access to GCP APIs. Without it, you'd need to create a service account JSON key, store it as a Kubernetes Secret, and mount it into pods — a significant secret management burden and a credential leak risk.

With Workload Identity, a Kubernetes ServiceAccount (KSA) is linked to a GCP IAM ServiceAccount (GSA). When a pod runs with that KSA, GKE automatically injects a short-lived OIDC token that impersonates the GSA. No JSON key ever exists.

```bash
# 1. Workload Identity must be enabled on the cluster
#    Pass --workload-pool at cluster creation (preferred), or update an existing cluster:
gcloud container clusters update prod-cluster \
  --workload-pool my-project.svc.id.goog \
  --zone us-central1-a

# 2. Create the GCP service account (GSA)
gcloud iam service-accounts create myapp-sa \
  --display-name "MyApp Service Account" \
  --project my-project

# 3. Grant the GSA the GCP permissions the app needs
gcloud projects add-iam-policy-binding my-project \
  --member serviceAccount:myapp-sa@my-project.iam.gserviceaccount.com \
  --role roles/storage.objectViewer

# 4. Create the Kubernetes service account (KSA)
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
# Deployment spec — reference the annotated KSA
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: myapp-ksa   # triggers Workload Identity token injection
      containers:
        - name: app
          image: us-central1-docker.pkg.dev/my-project/myapp/api:v1.2.3
          # No volume mounts for credentials needed
          # GCP client libraries auto-detect the projected token via the metadata server
```

**Workload Identity gotcha:** The binding in step 5 is namespace-scoped. A KSA named `myapp-ksa` in `production` and a KSA named `myapp-ksa` in `staging` are different principals. If you want both namespaces to use the same GSA, you need two separate `add-iam-policy-binding` calls — one per namespace/KSA pair.

**Workload Identity gotcha:** Workload Identity works by routing metadata server requests (`169.254.169.254`) through a node-local proxy. If your pod has `hostNetwork: true`, it bypasses this proxy and falls back to the node's service account identity — which is rarely what you want. Avoid `hostNetwork` with Workload Identity.

**Verification:**
```bash
# Exec into the pod and confirm GCP identity
kubectl exec -it deploy/myapp -n production -- \
  gcloud auth list
# Expected output:
# ACTIVE  ACCOUNT
# *       myapp-sa@my-project.iam.gserviceaccount.com

# Test actual GCP API access
kubectl exec -it deploy/myapp -n production -- \
  gcloud storage ls gs://my-bucket --project my-project
```

### GKE Ingress and Managed Certificates

GKE Ingress provisions a Google Cloud HTTP(S) Load Balancer when you create an `Ingress` object. This is a Layer 7 load balancer with global anycast IPs, Google-managed SSL, and built-in DDoS protection — substantially more capable than a basic `LoadBalancer` Service, which creates a regional Layer 4 load balancer.

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
# The Ingress — ties FrontendConfig, ManagedCertificate, and Services together
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
  annotations:
    kubernetes.io/ingress.class: "gce"                          # external GCLB
    kubernetes.io/ingress.allow-http: "false"                   # block plain HTTP at LB level
    networking.gke.io/managed-certificates: myapp-cert
    networking.gke.io/v1beta1.FrontendConfig: myapp-frontend
spec:
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /*
            pathType: ImplementationSpecific   # GCE ingress requires /* not /
            backend:
              service:
                name: myapp-service
                port:
                  number: 80
```

```bash
# Check ingress provisioning — ADDRESS appears once the LB is ready (can take 2-5 min)
kubectl get ingress myapp-ingress -w

# Managed cert provisioning takes 10-20 minutes after DNS propagates
kubectl describe managedcertificate myapp-cert
# Look for: Status: Active
# If stuck at Provisioning, verify DNS A record points to the ingress ADDRESS

# Point your domain at the ingress IP
# (example using Cloud DNS)
gcloud dns record-sets transaction start --zone my-zone
gcloud dns record-sets transaction add \
  $(kubectl get ingress myapp-ingress -o jsonpath='{.status.loadBalancer.ingress[0].ip}') \
  --name api.myapp.com. \
  --ttl 300 \
  --type A \
  --zone my-zone
gcloud dns record-sets transaction execute --zone my-zone
```

**Ingress gotcha:** GKE creates a health check that hits `/` on the container port. If your app returns non-2xx on `/`, the backend is marked unhealthy and traffic stops routing — even though pods are running and passing Kubernetes liveness probes. Use a `BackendConfig` to specify the correct health check path:

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
apiVersion: v1
kind: Service
metadata:
  name: myapp-service
  annotations:
    cloud.google.com/backend-config: '{"default": "myapp-backendconfig"}'
spec:
  type: NodePort   # GKE Ingress requires NodePort (not LoadBalancer, not headless)
  selector:
    app: myapp
  ports:
    - port: 80
      targetPort: 8080
```

| Ingress class | Load balancer type | Use case |
|---|---|---|
| `gce` | External global HTTP(S) LB | Public internet traffic |
| `gce-internal` | Internal regional HTTP(S) LB | Private microservices, internal tools |
| `gce-l7-global-external-managed` | Next-gen external LB | Advanced traffic management |

### Artifact Registry Integration

Artifact Registry is GCP's container registry and the successor to Container Registry (`gcr.io`). GKE integrates with it through node service accounts — by default, GKE nodes can pull images from repositories in the same project without `imagePullSecrets`. For cross-project pulls, you must explicitly grant `roles/artifactregistry.reader` to the node service account.

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
docker push us-central1-docker.pkg.dev/my-project/myapp/api:v1.2.3

# Grant cross-project pull access to a GKE node service account
# First, find the node service account
gcloud container clusters describe prod-cluster \
  --zone us-central1-a \
  --format="value(nodeConfig.serviceAccount)"
# Default: PROJECT_NUMBER-compute@developer.gserviceaccount.com

# Grant read access from another project's registry
gcloud artifacts repositories add-iam-policy-binding myapp \
  --location us-central1 \
  --project images-project \
  --member serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role roles/artifactregistry.reader
```

**Artifact Registry gotcha:** The image URL format changed from `gcr.io` to `REGION-docker.pkg.dev`. They are separate registries — pushing to `gcr.io/my-project/myapp` does not make the image available at `us-central1-docker.pkg.dev/my-project/myapp/myapp`. Migrate workloads to Artifact Registry URLs explicitly.

**Vulnerability scanning:** Artifact Registry can automatically scan images on push. Enable it and gate deployments on scan results:

```bash
# Enable scanning on the repository
gcloud artifacts repositories update myapp \
  --location us-central1 \
  --project my-project \
  --enable-vulnerability-scanning

# List vulnerabilities for a specific image
gcloud artifacts docker images scan \
  us-central1-docker.pkg.dev/my-project/myapp/api:v1.2.3 \
  --format="table(vulnerability.effectiveSeverity, vulnerability.shortDescription)"
```

### Cluster Autoscaler and Vertical Pod Autoscaler

GKE provides three autoscaling mechanisms that operate at different layers. Understanding which layer each operates at is critical for sizing workloads correctly.

| Autoscaler | What it scales | Trigger | Latency |
|---|---|---|---|
| Cluster Autoscaler (CA) | Nodes in a pool | Unschedulable pods / underutilized nodes | 1-3 minutes |
| Horizontal Pod Autoscaler (HPA) | Pod replica count | CPU/memory/custom metrics | 15-30 seconds |
| Vertical Pod Autoscaler (VPA) | CPU/memory requests per pod | Historical usage | Requires pod restart |

```bash
# Cluster Autoscaler is enabled per node pool (shown in node pool creation above)
# View CA activity — useful for debugging why pods are Pending
kubectl describe configmap cluster-autoscaler-status -n kube-system

# HPA — scale on CPU
kubectl autoscale deployment myapp \
  --cpu-percent=60 \
  --min=2 \
  --max=20

# Check HPA status
kubectl get hpa myapp
# TARGETS column shows current/target (e.g., 45%/60%)
```

```yaml
# VPA — let GKE recommend or auto-set resource requests
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Off"   # "Off" = recommendations only, no restarts
                        # "Auto" = applies recommendations, restarts pods
  resourcePolicy:
    containerPolicies:
      - containerName: app
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 2
          memory: 2Gi
```

**HPA + VPA gotcha:** Do not run HPA (CPU-based) and VPA (Auto mode) on the same deployment simultaneously. VPA changes `requests`, which changes the CPU utilization percentage HPA reads, causing them to fight each other. Use VPA in `Off` mode to gather recommendations, then bake those values into your deployment spec, then enable HPA.

**Cluster Autoscaler gotcha:** CA will not scale down a node if any pod on it lacks a controller (bare pods), has a restrictive PodDisruptionBudget, or uses `local-storage`. Long-running Jobs and DaemonSet pods are also never evicted during scale-down. Check the CA status ConfigMap for the exact reason a node isn't being removed.

## Examples

### Example 1: Deploy a Web Application with Workload Identity and Ingress

This scenario deploys a web API that reads from Cloud Storage, exposes it publicly via HTTPS, and authenticates to GCP without any service account keys.

```bash
# 1. Create an Autopilot cluster
gcloud container clusters create-auto prod-cluster \
  --region us-central1 \
  --project my-project

gcloud container clusters get-credentials prod-cluster \
  --region us-central1 \
  --project my-project

# 2. Set up Workload Identity
gcloud iam service-accounts create api-sa --project my-project

gcloud projects add-iam-policy-binding my-project \
  --member serviceAccount:api-sa@my-project.iam.gserviceaccount.com \
  --role roles/storage.objectViewer

kubectl create namespace api

kubectl create serviceaccount api-ksa --namespace api

gcloud iam service-accounts add-iam-policy-binding \
  api-sa@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[api/api-ksa]"

kubectl annotate serviceaccount api-ksa \
  --namespace api \
  iam.gke.io/gcp-service-account=api-sa@my-project.iam.gserviceaccount.com

# 3. Deploy application
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      serviceAccountName: api-ksa
      containers:
        - name: api
          image: us-central1-docker.pkg.dev/my-project/myapp/api:v1.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 250m        # explicit requests required in Autopilot
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
EOF

# 4. Create Service, BackendConfig, ManagedCertificate, and Ingress
cat <<EOF | kubectl apply -f -
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: api-backendconfig
  namespace: api
spec:
  healthCheck:
    requestPath: /healthz
    port: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: api
  annotations:
    cloud.google.com/backend-config: '{"default": "api-backendconfig"}'
spec:
  type: NodePort
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: api-cert
  namespace: api
spec:
  domains:
    - api.myapp.com
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: api
  annotations:
    kubernetes.io/ingress.class: "gce"
    networking.gke.io/managed-certificates: api-cert
    kubernetes.io/ingress.allow-http: "false"
spec:
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /*
            pathType: ImplementationSpecific
            backend:
              service:
                name: api-service
                port:
                  number: 80
EOF

# 5. Verify
kubectl get ingress api-ingress -n api -w        # wait for ADDRESS
kubectl describe managedcertificate api-cert -n api  # wait for Active
kubectl get pods -n api                          # all Running
```

### Example 2: Spot Node Pool for CI Runners

This scenario creates a spot node pool and deploys ephemeral CI runners that tolerate preemption.

```bash
# 1. Add spot pool to existing Standard cluster
gcloud container node-pools create ci-spot-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --machine-type e2-standard-8 \
  --spot \
  --enable-autoscaling \
  --min-nodes 0 \
  --max-nodes 30 \
  --disk-size 100 \
  --node-labels workload-type=ci

# 2. Deploy a CI runner (example: GitLab runner) with spot tolerations
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gitlab-runner
  namespace: ci
spec:
  replicas: 3
  selector:
    matchLabels:
      app: gitlab-runner
  template:
    metadata:
      labels:
        app: gitlab-runner
    spec:
      # Tolerate spot node taint — required or pods won't schedule on the pool
      tolerations:
        - key: "cloud.google.com/gke-spot"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
      # Prefer spot, but don't require it — on-demand fallback if spot unavailable
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: cloud.google.com/gke-spot
                    operator: In
                    values: ["true"]
      terminationGracePeriodSeconds: 30   # matches spot preemption window
      containers:
        - name: runner
          image: gitlab/gitlab-runner:latest
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
EOF

# 3. Verify pods land on spot nodes
kubectl get pods -n ci -o wide   # check NODE column
kubectl get nodes -l cloud.google.com/gke-spot=true
```

### Example 3: Migrating a Node Pool with Zero Downtime

This scenario replaces an old `n1-standard-4` pool with a new `n2-standard-4` pool without service disruption.

```bash
# 1. Create new pool with upgraded machine type
gcloud container node-pools create new-general-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --machine-type n2-standard-4 \
  --num-nodes 3 \
  --enable-autoscaling \
  --min-nodes 2 \
  --max-nodes 10 \
  --disk-size 100

# Wait for nodes to be Ready
kubectl wait --for=condition=Ready nodes \
  -l cloud.google.com/gke-nodepool=new-general-pool \
  --timeout=300s

# 2. Cordon all nodes in the old pool — new pods won't schedule here
for node in $(kubectl get nodes \
    -l cloud.google.com/gke-nodepool=old-general-pool \
    -o jsonpath='{.items[*].metadata.name}'); do
  kubectl cordon $node
done

# 3. Drain one node at a time to respect PodDisruptionBudgets
for node in $(kubectl get nodes \
    -l cloud.google.com/gke-nodepool=old-general-pool \
    -o jsonpath='{.items[*].metadata.name}'); do
  kubectl drain $node \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=60 \
    --timeout=300s
  echo "Drained $node, sleeping 10s before next..."
  sleep 10
done

# 4. Verify all workloads rescheduled on new pool
kubectl get pods -A -o wide | grep new-general-pool

# 5. Delete old pool
gcloud container node-pools delete old-general-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --quiet
```

### Example 4: Debugging a Pending Pod

This is one of the most common real-world GKE tasks. A pod stuck in `Pending` can mean several different things.

```bash
# Start by describing the pod — the Events section is the most useful part
kubectl describe pod myapp-7d6f9b-xkz2p -n production
# Look for Events at the bottom:
# "0/3 nodes are available: 3 Insufficient memory" -> need larger nodes or more replicas
# "0/3 nodes are available: 3 node(s) had taint..." -> pod missing toleration
# "0/3 nodes are available: 3 node(s) didn't match node affinity" -> affinity too strict

# If the issue is node capacity, check cluster autoscaler status
kubectl describe configmap cluster-autoscaler-status -n kube-system | grep -A 5 "ScaleUp"
# "NotNeeded" -> CA doesn't think scale-up is required
# "InProgress" -> CA is provisioning nodes, wait 1-3 minutes
# "NoActivity" -> check if min/max bounds are hit

# Check if node pool is at max-nodes
gcloud container node-pools describe general-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --format="value(autoscaling.maxNodeCount, autoscaling.minNodeCount)"

# Check actual node count vs max
kubectl get nodes -l cloud.google.com/gke-nodepool=general-pool --no-headers | wc -l

# If at max, either increase max-nodes or reduce pod resource requests
gcloud container node-pools update general-pool \
  --cluster prod-cluster \
  --zone us-central1-a \
  --max-nodes 15

# Check resource requests vs node capacity
kubectl describe nodes | grep -A 5 "Allocated resources"
# Look for "cpu" and "memory" — high % means little room for new pods

# For Autopilot clusters, Pending is usually a resource request issue
kubectl get events -n production --sort-by='.lastTimestamp' | tail -20
```

## Exercises

### Exercise 1: Workload Identity End-to-End

Set up a pod that reads from a Cloud Storage bucket using Workload Identity — no service account keys allowed.

1. Create a Standard GKE cluster with Workload Identity enabled (`--workload-pool`).
2. Create a GCS bucket and upload a test file to it.
3. Create a GSA with `roles/storage.objectViewer`, a KSA in a `test` namespace, and wire them together with the correct IAM binding and annotation.
4. Deploy a pod that runs `gsutil ls gs://your-bucket` as its command using the KSA.
5. Verify the pod completes successfully (`kubectl logs`). Then remove the IAM binding and redeploy — confirm the pod now fails with a permission error.

**What to think about:** What happens if you forget the annotation on the KSA? What happens if you forget the `add-iam-policy-binding` step? These are the two most common mistakes.

### Exercise 2: Spot Pool Scheduling

Create a spot node pool and confirm workloads can be scheduled to it and tolerate the expected taint.

1. Add a spot node pool (`--spot`) to an existing cluster with `--min-nodes 1 --max-nodes 5`.
2. Deploy a Deployment without any tolerations. Confirm pods schedule only on on-demand nodes.
3. Add the spot toleration and `nodeAffinity` preference to the Deployment. Confirm pods now schedule on spot nodes.
4. Use `kubectl cordon` on all spot nodes and verify that pods with the `preferredDuringScheduling` affinity (not `required`) fall back gracefully to on-demand nodes.

**What to think about:** Why would using `requiredDuringSchedulingIgnoredDuringExecution` for spot affinity be dangerous in production?

### Exercise 3: Ingress Health Check Debugging

Intentionally create a broken Ingress backend and practice diagnosing it.

1. Deploy a simple app that serves HTTP on port 8080 with a `/healthz` endpoint returning 200, but returns 404 on `/`.
2. Create an Ingress backed by this Service using the default GKE health check (no `BackendConfig`). Observe that the backend becomes unhealthy — verify using `kubectl describe ingress` and the GCP Console Load Balancing page.
3. Create a `BackendConfig` that points the health check to `/healthz` and attach it to the Service. Verify the backend becomes healthy and traffic routes correctly.
4. Use `curl -v` against the Ingress IP to confirm HTTP → HTTPS redirect is working once you add a `FrontendConfig`.

**What to think about:** The GCP Load Balancer health check is separate from Kubernetes liveness/readiness probes. A pod can be `Running` and passing readiness checks while the LB backend is unhealthy. What does this imply about your monitoring strategy?

### Exercise 4: Autoscaler Behavior

Observe the Cluster Autoscaler scaling up and down in response to load.

1. Create a Standard cluster with a node pool of `--min-nodes 1 --max-nodes 5 --enable-autoscaling`.
2. Deploy a Deployment with `replicas: 1` and resource requests large enough that only one pod fits per node (e.g., `requests.cpu: 1500m` on `e2-standard-2` nodes with 2 vCPU).
3. Scale the Deployment to `replicas: 5`. Watch `kubectl get nodes -w` and observe CA provisioning new nodes within 1-3 minutes.
4. Scale back down to `replicas: 1`. Observe CA scale-down (takes ~10 minutes by default due to the scale-down delay). Check the CA status ConfigMap to see why nodes are or aren't being removed.
5. Set a `PodDisruptionBudget` with `minAvailable: 1` and attempt to trigger scale-down again. Confirm CA respects the PDB.

**What to think about:** Why does scale-down take so much longer than scale-up? What is the `--scale-down-unneeded-time` flag for, and what problem does it prevent?

---

### Quick Checks

6. Extract the cluster name from a GKE kubectl context string. Run: `echo "gke_my-project_us-central1_my-cluster" | cut -d_ -f4`

```expected_output
my-cluster
```

hint: Think about how you can split a string by a specific delimiter and select a particular segment from the result.
hint: Use the cut command with the -d flag to set underscore as the delimiter and the -f flag to specify which field number you want to extract.

7. Count node pools in a GKE config stub. Run: `printf 'nodePools:\n- name: default-pool\n- name: gpu-pool\n- name: spot-pool\n' | grep -c '^- name:'`

```expected_output
3
```

hint: Think about how you can filter lines matching a specific pattern and have the tool count them directly.
hint: Use grep with the -c flag to count lines matching the pattern '^- name:' from the piped input.

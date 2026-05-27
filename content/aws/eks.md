---
title: Amazon EKS
module: aws
duration_min: 30
difficulty: intermediate
tags: [aws, eks, kubernetes, eksctl, node-groups, irsa, alb, fargate]
exercises: 4
---

## Overview

Amazon EKS (Elastic Kubernetes Service) is AWS's managed Kubernetes offering. AWS owns and operates the control plane — the API server, etcd, scheduler, and controller manager run in AWS-managed infrastructure across multiple availability zones, with automatic backups and a 99.95% SLA. You never SSH into a control plane node, pay per-instance for it, or worry about etcd compaction. Your responsibility begins at the worker nodes: EC2 instances (or Fargate) that run your pods, joined to the cluster via the AWS VPC CNI plugin.

The two dominant reasons teams choose EKS over self-managed Kubernetes are: automatic control plane upgrades (a historically painful operation) and native integration with the AWS service ecosystem — IAM for pod-level credentials, ALB for ingress, EBS/EFS for persistent storage, and CloudWatch for observability. These integrations are not cosmetic; IAM Roles for Service Accounts (IRSA) in particular solves a fundamental security problem in cloud-native workloads: how do pods get AWS credentials without hardcoding secrets or inheriting overly broad node-level permissions.

In the DevOps toolchain, EKS sits at the intersection of infrastructure provisioning (Terraform or eksctl to create the cluster), CI/CD (GitHub Actions or CodePipeline pushing images and applying manifests), and platform engineering (managing addons, autoscaling, and upgrade cadence). Understanding EKS means understanding Kubernetes itself *plus* the AWS-specific surface area: IAM trust policies, VPC networking, and the addon lifecycle. Both halves matter for production operations.

---

## Concepts

### Control Plane vs. Data Plane

Understanding what AWS manages versus what you manage prevents a whole class of operational mistakes.

| Layer | Who manages it | What it includes |
|---|---|---|
| **Control plane** | AWS | kube-apiserver, etcd, scheduler, controller-manager, cloud-controller-manager |
| **Data plane (EC2)** | You | EC2 worker nodes, kubelet, kube-proxy, container runtime, VPC CNI |
| **Data plane (Fargate)** | AWS (mostly) | Underlying EC2, kubelet — you manage pod spec only |
| **Addons** | Shared | CoreDNS, kube-proxy, VPC CNI, EBS CSI — AWS provides versions, you install/upgrade |

**You cannot access the control plane nodes.** There are no SSH keys, no EC2 instances visible in your account. All interaction is through `kubectl` (which talks to the managed API server endpoint) and the EKS API (for cluster-level operations like upgrades).

**The control plane and data plane versions can drift by up to two minor versions**, but this is a support boundary, not a hard limit. Always upgrade the control plane first, then node groups, then addons — in that order. Reversing that sequence can cause addon incompatibilities that are difficult to recover from without downtime.

**Control plane logging is opt-in.** By default, none of the API server, audit, authenticator, controller manager, or scheduler logs are sent to CloudWatch. Enable them explicitly — especially `audit` logs — before anything goes wrong, not after.

```bash
# Enable all control plane log types for a cluster
aws eks update-cluster-config \
  --name prod-cluster \
  --region us-east-1 \
  --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'
```

### Cluster Creation with eksctl

`eksctl` is the official CLI for EKS cluster management. It wraps CloudFormation under the hood, so every `eksctl` operation creates or modifies a CloudFormation stack. This matters: if you manually modify resources that `eksctl` created, drift can cause future `eksctl` operations to fail.

**Install eksctl:**
```bash
curl -sLO "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_amd64.tar.gz"
tar -xzf eksctl_Linux_amd64.tar.gz && sudo mv eksctl /usr/local/bin
eksctl version
```

**Cluster config file (preferred over CLI flags for reproducibility):**
```yaml
# cluster.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: prod-cluster
  region: us-east-1
  version: "1.31"
  tags:
    environment: production
    team: platform

# Required for IRSA — provisions an OIDC identity provider
iam:
  withOIDC: true

managedNodeGroups:
  - name: standard
    instanceType: m6i.large
    minSize: 2
    maxSize: 5
    desiredCapacity: 3
    # Spread across all AZs in the region for HA
    availabilityZones: ["us-east-1a", "us-east-1b", "us-east-1c"]
    labels:
      role: worker
    tags:
      k8s.io/cluster-autoscaler/enabled: "true"
      k8s.io/cluster-autoscaler/prod-cluster: "owned"

  - name: spot
    # Multiple instance families increases spot availability and reduces interruption rate
    instanceTypes: [m6i.large, m5.large, m5a.large, m5n.large]
    spot: true
    minSize: 0
    maxSize: 20
    labels:
      role: spot-worker
      lifecycle: spot
    # Taint spot nodes so only tolerating pods land here
    taints:
      - key: spot
        value: "true"
        effect: NoSchedule
```

```bash
eksctl create cluster -f cluster.yaml
# eksctl writes kubeconfig automatically
kubectl get nodes -o wide
```

**`withOIDC: true` is not optional in practice.** Without an OIDC provider, IRSA does not work, and IRSA is the correct mechanism for giving pods AWS permissions. Enable it at cluster creation time — adding it later requires updating the cluster and re-creating service accounts.

**eksctl vs Terraform for EKS:** eksctl is purpose-built for EKS and faster for getting a cluster running. Terraform (via the `aws_eks_cluster` resource or the community EKS module) is preferred when the cluster is part of a larger IaC codebase that also manages VPCs, RDS, and other resources. Don't mix both tools to manage the same cluster — pick one and stick with it.

### Managed Node Groups vs. Self-Managed vs. Fargate

| Feature | Managed Node Group | Self-Managed | Fargate |
|---|---|---|---|
| AMI updates | AWS provides, you apply | You build/manage | AWS managed |
| Node cordoning on update | Automatic (respects PDBs) | Manual | N/A |
| SSH / node access | Optional (EC2 keypair) | Yes | No |
| DaemonSets | Yes | Yes | **No** |
| Privileged containers | Yes | Yes | **No** |
| GPU instances | Yes | Yes | No |
| EBS volumes | Yes | Yes | **No** |
| Pricing model | On-demand or Spot | On-demand or Spot | Per vCPU/memory/second |
| Best for | General workloads | Custom AMIs, bootstrapping | Batch, serverless-style |

**Managed node groups respect Pod Disruption Budgets (PDBs) during updates.** If a node drain would violate a PDB, the upgrade pauses and waits. Self-managed node groups have no such safety net — you drain manually and must write your own eviction logic.

**Fargate gotcha:** Each Fargate pod runs on its own dedicated micro-VM. Pods that share an EC2 node can benefit from CPU/memory bursting headroom on the node; Fargate pods cannot. Fargate also does not support the EBS CSI driver — use EFS instead if you need persistent storage on Fargate. DaemonSets are silently ignored on Fargate profiles, which means tools like Fluentd, Datadog agents, or node exporters deployed as DaemonSets will not run on Fargate pods — you must use sidecar containers instead.

```bash
# Common node group operations
eksctl get nodegroup --cluster prod-cluster

eksctl scale nodegroup \
  --cluster prod-cluster \
  --name standard \
  --nodes 5 \
  --nodes-min 3 \
  --nodes-max 10

# Rolling AMI update — drains and replaces nodes one at a time
eksctl upgrade nodegroup \
  --cluster prod-cluster \
  --name standard \
  --kubernetes-version 1.31

# Gracefully drain and delete an old node group
eksctl delete nodegroup \
  --cluster prod-cluster \
  --name old-workers \
  --drain
```

### IRSA — IAM Roles for Service Accounts

IRSA is the mechanism for giving pods fine-grained AWS IAM permissions without using static credentials or node-level roles. Without IRSA, the only alternative is node-level IAM roles — meaning every pod on that node gets the same permissions. IRSA solves this by binding an IAM role to a Kubernetes service account via OIDC federation.

**How it works:**
1. EKS exposes an OIDC endpoint for the cluster.
2. You create an IAM role with a trust policy that permits tokens from that OIDC endpoint, scoped to a specific namespace and service account name.
3. EKS injects a projected service account token into the pod (via a volume mount at `/var/run/secrets/eks.amazonaws.com/serviceaccount/token`).
4. The AWS SDK in the pod exchanges that token for temporary STS credentials using `AssumeRoleWithWebIdentity`.

The pod never touches instance metadata credentials. If the pod is compromised, the blast radius is limited to the permissions of that single IAM role.

```bash
# Step 1: Associate OIDC provider (if not done at cluster creation)
eksctl utils associate-iam-oidc-provider \
  --cluster prod-cluster \
  --region us-east-1 \
  --approve

# Step 2: Create the IAM service account
# eksctl creates the IAM role, attaches the policy, and creates the K8s ServiceAccount
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace production \
  --name s3-reader-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
  --approve \
  --override-existing-serviceaccounts
```

The generated trust policy (inspecting the IAM role confirms IRSA is wired correctly):
```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E:sub": "system:serviceaccount:production:s3-reader-sa",
      "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E:aud": "sts.amazonaws.com"
    }
  }
}
```

```yaml
# Deployment using the IRSA service account
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      # This is the only required change — the SDK picks up credentials automatically
      serviceAccountName: s3-reader-sa
      containers:
        - name: app
          image: amazon/aws-cli:latest
          command: ["aws", "s3", "ls", "s3://my-bucket"]
          # AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE are injected automatically
          # by the EKS mutating webhook when the SA has the eks.amazonaws.com/role-arn annotation
```

**Verify IRSA is working:**
```bash
# Check the annotation on the service account
kubectl get sa s3-reader-sa -n production -o yaml | grep role-arn

# Exec into pod and confirm assumed identity
kubectl exec -it <pod-name> -n production -- aws sts get-caller-identity
# Should return the IRSA role ARN, NOT the node's instance profile ARN
```

**IRSA gotcha:** The trust policy `Condition` block uses `StringEquals` on the fully qualified service account name (`system:serviceaccount:<namespace>:<name>`). If you rename the service account or move it to a different namespace, the trust relationship breaks and all AWS SDK calls return `AccessDenied` — with no error message that points to the namespace mismatch. Treat the namespace + service account name as immutable parts of your IAM configuration.

**Pod Identity vs. IRSA:** AWS introduced EKS Pod Identity in 2023 as a simpler alternative to IRSA. Pod Identity does not require an OIDC provider and uses an agent DaemonSet instead. IRSA remains the more widely supported option and works across all Kubernetes distributions. Pod Identity is worth evaluating for new clusters but is not yet universally supported by all addons.

### AWS Load Balancer Controller

The AWS Load Balancer Controller (formerly ALB Ingress Controller) provisions Application Load Balancers for `Ingress` resources and Network Load Balancers for `Service` resources of type `LoadBalancer`. It is **not** installed by default — it is a separate controller that must be deployed and requires its own IRSA service account.

```bash
# 1. Create the IAM policy from the official document
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.1/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

# 2. Create the IRSA service account
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace kube-system \
  --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::123456789012:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve

# 3. Install the controller via Helm
helm repo add eks https://aws.github.io/eks-charts && helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=prod-cluster \
  --set serviceAccount.create=false \       # reuse the IRSA SA already created
  --set serviceAccount.name=aws-load-balancer-controller \
  --set replicaCount=2                      # HA: two controller replicas

# Verify the controller is running
kubectl get deployment -n kube-system aws-load-balancer-controller
kubectl logs -n kube-system deploy/aws-load-balancer-controller | tail -20
```

```yaml
# Ingress with ALB annotations
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing         # or internal for VPC-only
    alb.ingress.kubernetes.io/target-type: ip                 # route to pod IPs directly
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789012:certificate/abc-123
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    # Group multiple Ingress resources onto one ALB to reduce cost
    alb.ingress.kubernetes.io/group.name: prod-shared-alb
spec:
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: myapp-svc
                port:
                  number: 80
```

**`target-type: ip` vs `target-type: instance`:**

| | `ip` | `instance` |
|---|---|---|
| Routes to | Pod IP directly | NodePort on EC2 |
| Requires | VPC CNI (standard on EKS) | Any CNI |
| Fargate support | Yes | No |
| Latency | Lower (one fewer hop) | Higher |
| Security groups | Pod-level SGs supported | Node-level only |

Use `ip` mode unless you have a specific reason not to. It is lower latency, supports Fargate, and integrates with pod-level security groups.

**The ALB DNS name is the externally reachable address.** It takes 1–3 minutes to provision after the Ingress is created:
```bash
kubectl get ingress myapp-ingress -n production
# ADDRESS column will be empty, then populate with the ALB DNS name
```

### EBS CSI Driver

Since Kubernetes 1.23, the in-tree EBS volume plugin is deprecated. You must use the EBS CSI driver addon for PersistentVolumes backed by EBS. Without it, `kubectl describe pvc` will show pods stuck in `Pending` with a "no volume plugin" error.

```bash
# Create the IRSA role for the EBS CSI controller
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace kube-system \
  --name ebs-csi-controller-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve

# Install as an EKS managed addon — AWS handles version compatibility with the cluster
eksctl create addon \
  --name aws-ebs-csi-driver \
  --cluster prod-cluster \
  --service-account-role-arn arn:aws:iam::123456789012:role/eksctl-prod-cluster-addon-iamserviceaccount-kube-system-ebs-csi-controller-sa \
  --force

# Verify
eksctl get addon --cluster prod-cluster
kubectl get pods -n kube-system -l app=ebs-csi-controller
```

```yaml
# gp3 StorageClass — set as cluster default for cost and performance
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer  # don't provision until pod is scheduled; respects AZ
reclaimPolicy: Retain                    # don't delete EBS volume when PVC is deleted
parameters:
  type: gp3
  encrypted: "true"
  # Optionally specify throughput and IOPS (gp3 allows independent tuning)
  throughput: "250"
  iops: "4000"
---
# Example StatefulSet PVC using this StorageClass
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
  namespace: production
spec:
  accessModes: [ReadWriteOnce]   # EBS is block storage — single node only
  storageClassName: gp3
  resources:
    requests:
      storage: 20Gi
```

**`WaitForFirstConsumer` is critical for multi-AZ clusters.** Without it, the PVC is provisioned in a random AZ, and if the pod is scheduled in a different AZ, it will fail to mount with a `VolumeNotAttached` error. `WaitForFirstConsumer` delays provisioning until the scheduler picks a node, so the EBS volume is created in the correct AZ.

**EBS vs EFS on EKS:**

| | EBS | EFS |
|---|---|---|
| Access mode | ReadWriteOnce (single node) | ReadWriteMany (multi-node) |
| Fargate support | No | Yes |
| Performance | Higher IOPS, lower latency | Network filesystem overhead |
| Cost | Lower for block workloads | Higher, scales with usage |
| Use case | Databases, single-replica apps | Shared config, ML datasets, Fargate |

### Cluster Autoscaler

The Cluster Autoscaler (CA) adds or removes EC2 nodes in response to unschedulable pods and underutilized nodes. It reads the node group min/max boundaries set in the Auto Scaling Group and respects them.

```bash
# Deploy CA via Helm
helm repo add autoscaler https://kubernetes.github.io/autoscaler

helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  -n kube-system \
  --set autoDiscovery.clusterName=prod-cluster \
  --set awsRegion=us-east-1 \
  --set rbac.serviceAccount.name=cluster-autoscaler \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/ClusterAutoscalerRole \
  --set extraArgs.balance-similar-node-groups=true \  # spread pods evenly across AZs
  --set extraArgs.skip-nodes-with-system-pods=false
```

**CA requires node group tags.** The tags `k8s.io/cluster-autoscaler/enabled: "true"` and `k8s.io/cluster-autoscaler/<cluster-name>: "owned"` must be present on the Auto Scaling Group — which is why the cluster.yaml in the eksctl section includes them.

**Karpenter vs. Cluster Autoscaler:** Karpenter is AWS's newer autoscaler that provisions nodes directly (bypassing ASGs) and can select instance types dynamically. It is faster to scale (seconds vs. minutes) and more cost-efficient. CA is more mature and widely understood. Both are valid; Karpenter is the direction AWS is investing in for new clusters.

### Access Management and aws-auth

EKS uses a ConfigMap called `aws-auth` in the `kube-system` namespace to map IAM identities (users and roles) to Kubernetes RBAC subjects. This is the mechanism that grants humans and CI/CD systems access to the cluster.

```bash
# View current aws-auth mappings
kubectl get configmap aws-auth -n kube-system -o yaml
```

```yaml
# aws-auth ConfigMap structure
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-auth
  namespace: kube-system
data:
  mapRoles: |
    # Node groups must be mapped — eksctl does this automatically
    - rolearn: arn:aws:iam::123456789012:role/eksctl-prod-cluster-nodegroup-NodeInstanceRole
      username: system:node:{{EC2PrivateDNSName}}
      groups:
        - system:bootstrappers
        - system:nodes
    # CI/CD role — cluster-admin for deployment pipelines
    - rolearn: arn:aws:iam::123456789012:role/GitHubActionsDeployRole
      username: github-actions
      groups:
        - system:masters
  mapUsers: |
    # Individual IAM user — read-only access
    - userarn: arn:aws:iam::123456789012:user/alice
      username: alice
      groups:
        - viewers
```

**`aws-auth` is a single point of failure for cluster access.** If you corrupt it (malformed YAML is common), you can lose all access to the cluster. Only the cluster creator's IAM identity retains access via the EKS API. Always edit it with `kubectl edit` (which validates before writing) rather than piping raw YAML with `kubectl apply`. **Better yet, manage it with eksctl or a tool like `eksctl create iamidentitymapping`.**

```bash
# Safer: use eksctl to manage mappings
eksctl create iamidentitymapping \
  --cluster prod-cluster \
  --arn arn:aws:iam::123456789012:role/GitHubActionsDeployRole \
  --group system:masters \
  --username github-actions
```

**EKS Access Entries (2024):** AWS introduced a new access management system that replaces `aws-auth` with a first-class EKS API. New clusters should prefer Access Entries over `aws-auth` — they are managed via the EKS API and are not a Kubernetes resource that can be accidentally broken.

```bash
# Create an access entry using the new EKS Access Entries API
aws eks create-access-entry \
  --cluster-name prod-cluster \
  --principal-arn arn:aws:iam::123456789012:role/GitHubActionsDeployRole \
  --type STANDARD

aws eks associate-access-policy \
  --cluster-name prod-cluster \
  --principal-arn arn:aws:iam::123456789012:role/GitHubActionsDeployRole \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

---

## Examples

### Example 1: Deploy a Web Application with ALB Ingress and IRSA

This example creates a namespace, deploys an app with an IRSA service account for S3 access, and exposes it via ALB.

```bash
# 1. Create the namespace
kubectl create namespace production

# 2. Create IRSA service account bound to an S3 read policy
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace production \
  --name webapp-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
  --approve

# 3. Verify the annotation was set
kubectl get sa webapp-sa -n production -o jsonpath='{.metadata.annotations}'
```

```yaml
# webapp.yaml — Deployment + Service + Ingress
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: webapp
  template:
    metadata:
      labels:
        app: webapp
    spec:
      serviceAccountName: webapp-sa   # grants S3 read via IRSA
      containers:
        - name: webapp
          image: nginx:1.25
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: webapp-svc
  namespace: production
spec:
  selector:
    app: webapp
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webapp-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80}]'
    alb.ingress.kubernetes.io/healthcheck-path: /
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: webapp-svc
                port:
                  number: 80
```

```bash
# 4. Apply everything
kubectl apply -f webapp.yaml

# 5. Wait for the ALB to provision (1-3 minutes)
kubectl get ingress webapp-ingress -n production --watch

# 6. Verify the app is reachable
ALB_DNS=$(kubectl get ingress webapp-ingress -n production -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl -s http://$ALB_DNS | head -5

# 7. Verify IRSA is working from inside the pod
POD=$(kubectl get pod -n production -l app=webapp -o jsonpath='{.items[0].metadata.name}')
kubectl exec -it $POD -n production -- aws sts get-caller-identity
# Output should show the IRSA role ARN, not the node role
```

### Example 2: StatefulSet with EBS Persistent Storage

Demonstrates a database workload using EBS-backed PersistentVolumes, with a PodDisruptionBudget to prevent data loss during node upgrades.

```yaml
# postgres-statefulset.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: production
spec:
  minAvailable: 1          # never evict the last running pod
  selector:
    matchLabels:
      app: postgres
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
      # Spread across nodes to avoid co-location with other DB pods
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: postgres
      containers:
        - name: postgres
          image: postgres:16
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata  # subdirectory avoids mount lost+found issue
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3           # must match the StorageClass created earlier
        resources:
          requests:
            storage: 50Gi
```

```bash
kubectl apply -f postgres-statefulset.yaml

# Verify PVC is bound (may take 30-60s for EBS to provision)
kubectl get pvc -n production
# Expected: STATUS=Bound, VOLUME=pvc-<uuid>

# Verify the pod is running and the volume is mounted
kubectl describe pod postgres-0 -n production | grep -A5 Volumes

# Write data and verify persistence across pod restarts
kubectl exec -it postgres-0 -n production -- psql -U postgres -c "CREATE TABLE test (id serial);"
kubectl delete pod postgres-0 -n production   # StatefulSet will recreate it
# After pod restarts:
kubectl exec -it postgres-0 -n production -- psql -U postgres -c "SELECT * FROM test;"
# Table should still exist — confirming EBS persistence
```

### Example 3: Cluster Upgrade (Control Plane → Node Groups → Addons)

The correct upgrade sequence matters. Upgrading node groups before the control plane is unsupported and can break your cluster.

```bash
# --- Step 1: Check current versions ---
eksctl get cluster prod-cluster
eksctl get nodegroup --cluster prod-cluster
eksctl get addon --cluster prod-cluster

# --- Step 2: Upgrade the control plane ---
# This is non-disruptive — the API server has a brief interruption (~30s) during rollover
eksctl upgrade cluster \
  --name prod-cluster \
  --version 1.31 \
  --approve

# Wait for the control plane to finish upgrading
aws eks describe-cluster --name prod-cluster \
  --query 'cluster.status' --output text
# Wait until output is ACTIVE

# --- Step 3: Upgrade managed node groups (rolling) ---
# This drains, terminates, and replaces nodes one at a time, respecting PDBs
eksctl upgrade nodegroup \
  --cluster prod-cluster \
  --name standard \
  --kubernetes-version 1.31

# Monitor the rollout
kubectl get nodes --watch
# Nodes will cycle through SchedulingDisabled → NotReady → Ready

# --- Step 4: Upgrade addons ---
# Check what version each addon supports for k8s 1.31
aws eks describe-addon-versions \
  --kubernetes-version 1.31 \
  --query 'addons[].{Name:addonName,Versions:addonVersions[0].addonVersion}'

# Upgrade each addon
for ADDON in coredns kube-proxy vpc-cni aws-ebs-csi-driver; do
  eksctl update addon \
    --name $ADDON \
    --cluster prod-cluster \
    --force
done

# --- Step 5: Verify ---
kubectl get nodes
kubectl get pods -A | grep -v Running   # look for any non-Running pods after upgrade
```

**Upgrade gotcha:** Addon upgrades with `--force` will overwrite any manual changes you made to addon configuration. If you've customized CoreDNS's `Corefile` or VPC CNI's environment variables, record those changes before upgrading and re-apply them afterward.

### Example 4: Spot Instance Node Group with Graceful Interruption Handling

Spot instances can be reclaimed with a 2-minute warning. The AWS Node Termination Handler (NTH) listens for these events and gracefully drains the node before the instance disappears.

```bash
# Install Node Termination Handler via Helm
helm repo add eks https://aws.github.io/eks-charts && helm repo update

helm install aws-node-termination-handler eks/aws-node-termination-handler \
  -n kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true \
  --set nodeSelector."lifecycle"=spot     # only run on spot nodes
```

```yaml
# Example workload tolerating the spot taint
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-worker
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: batch-worker
  template:
    metadata:
      labels:
        app: batch-worker
    spec:
      tolerations:
        - key: spot
          value: "true"
          effect: NoSchedule
      nodeSelector:
        lifecycle: spot               # only schedule on spot nodes
      # Give the pod time to finish in-flight work before termination
      terminationGracePeriodSeconds: 90
      containers:
        - name: worker
          image: myapp/batch:latest
          lifecycle:
            preStop:
              exec:
                # Signal the app to finish current task and stop accepting new work
                command: ["/bin/sh", "-c", "kill -SIGTERM 1 && sleep 80"]
```

```bash
# Verify NTH is running on spot nodes only
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-node-termination-handler -o wide

# Simulate what happens during a spot interruption
# (NTH will cordon + drain the node, pods reschedule to on-demand nodes)
NODE=$(kubectl get nodes -l lifecycle=spot -o jsonpath='{.items[0].metadata.name}')
kubectl cordon $NODE
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --grace-period=90
```

---

## Exercises

### Exercise 1: Create a Cluster and Validate IRSA End-to-End

Create an EKS cluster with OIDC enabled, create an IRSA service account bound to `AmazonS3ReadOnlyAccess`, deploy a pod using that service account, and confirm the pod assumes the correct IAM role (not the node role).

**Requirements:**
- The pod must succeed at `aws sts get-caller-identity` and the returned ARN must contain the IRSA role name, not `NodeInstanceRole`.
- Inspect the projected volume mount inside the pod at `/var/run/secrets/eks.amazonaws.com/serviceaccount/token` and explain what it contains and why it exists.
- Deliberately deploy a second pod *without* the service account annotation and show that it falls back to the node role — then explain the security implication.

### Exercise 2: Trigger and Observe Cluster Autoscaler

Deploy a Cluster Autoscaler to your cluster. Then create a Deployment that requests more CPU than a single node can provide, forcing the autoscaler to add nodes. Observe the full scale-up sequence.

**Requirements:**
- Set resource requests high enough (e.g., `cpu: "3.5"` on an `m6i.large` which has 2 vCPUs) so pods cannot be scheduled on existing nodes.
- Watch `kubectl get nodes --watch` and `kubectl get events --sort-by=.metadata.creationTimestamp` simultaneously to see the autoscaler's decisions in real time.
- After verifying scale-up, scale the Deployment to 0 replicas and observe scale-down. Note: scale-down has a default 10-minute cooldown — explain why this cooldown exists and what the `--scale-down-delay-after-add` flag controls.

### Exercise 3: Perform a Safe Node Group Upgrade

Given a running cluster with a managed node group that has at least 2 running pods covered by a PodDisruptionBudget (`minAvailable: 1`), perform a node group AMI upgrade and verify that the PDB was respected.

**Requirements:**
- Before upgrading, apply a PDB and confirm `kubectl get pdb` shows `ALLOWED DISRUPTIONS: 1`.
- Run `kubectl get events -n <namespace> --watch` in a separate terminal during the upgrade and capture the `Evicting pod` and `SuccessfulCreate` events.
- After the upgrade completes, confirm all nodes show the new AMI ID via `kubectl get nodes -o custom-columns='NAME:.metadata.name,AMI:.metadata.labels.alpha\.eksctl\.io/nodegroup-name'` and by describing a node to find the AMI annotation.
- Explain what would happen if the PDB had `minAvailable: 2` with 2 replicas — and how the node group upgrade would behave differently.

### Exercise 4: Expose a Service with ALB and Debug a Failing Ingress

Deploy the AWS Load Balancer Controller to your cluster, create an Ingress resource, and intentionally introduce two separate misconfigurations — then diagnose and fix each one using controller logs and AWS console.

**Requirements:**
- Misconfiguration 1: Set `alb.ingress.kubernetes.io/scheme` to an invalid value and observe what error the controller logs in `kubectl logs -n kube-system deploy/aws-load-balancer-controller`.
- Misconfiguration 2: Delete the IRSA service account annotation from the controller's service account and observe the resulting AWS API error (`AccessDenied`). Restore the annotation and confirm the controller recovers without restart.
- Final verification: Use `curl -v` against the ALB DNS name and confirm a 200 response. Then use the AWS Console to inspect the ALB target group and verify targets are in `healthy` state with `target-type: ip`, showing pod IPs rather than node IPs.
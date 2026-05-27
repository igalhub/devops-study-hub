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

**The control plane and data plane versions can drift by up to two minor versions**, but this is a support boundary, not a hard limit. Always upgrade control plane first, then node groups, then addons — in that order.

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
    # Multiple instance families increases spot availability
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

**`--with-oidc` / `withOIDC: true` is not optional in practice.** Without an OIDC provider, IRSA does not work, and IRSA is the correct mechanism for giving pods AWS permissions. Enable it at cluster creation time — adding it later requires updating the cluster and re-creating service accounts.

### Managed Node Groups vs. Self-Managed vs. Fargate

| Feature | Managed Node Group | Self-Managed | Fargate |
|---|---|---|---|
| AMI updates | AWS provides, you apply | You build/manage | AWS managed |
| Node cordoning on update | Automatic (respects PDBs) | Manual | N/A |
| SSH / node access | Optional (EC2 keypair) | Yes | No |
| DaemonSets | Yes | Yes | **No** |
| Privileged containers | Yes | Yes | **No** |
| GPU instances | Yes | Yes | No |
| Pricing model | On-demand or Spot | On-demand or Spot | Per vCPU/memory/second |
| Best for | General workloads | Custom AMIs, bootstrapping | Batch, serverless-style |

**Managed node groups respect Pod Disruption Budgets (PDBs) during updates.** If a node drain would violate a PDB, the upgrade pauses. Self-managed node groups have no such safety net — you drain manually.

**Fargate gotcha:** Each Fargate pod runs on its own dedicated micro-VM. Pods that share a node (EC2) can share CPU/memory bursts; Fargate pods cannot. Fargate also does not support the EBS CSI driver (EBS volumes cannot be mounted to Fargate pods) — use EFS instead if you need persistent storage on Fargate.

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

IRSA is the mechanism for giving pods fine-grained AWS IAM permissions. Without IRSA, the only alternative is node-level IAM roles — meaning every pod on that node gets the same permissions. IRSA solves this by binding an IAM role to a Kubernetes service account via OIDC federation.

**How it works:**
1. EKS exposes an OIDC endpoint for the cluster.
2. You create an IAM role with a trust policy that permits tokens from that OIDC endpoint, scoped to a specific namespace and service account name.
3. EKS injects a projected service account token into the pod (via a volume mount).
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

The generated trust policy looks like this (inspecting the IAM role confirms IRSA is wired correctly):
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
      # This is the only change needed — the SDK picks up credentials automatically
      serviceAccountName: s3-reader-sa
      containers:
        - name: app
          image: amazon/aws-cli:latest
          command: ["aws", "s3", "ls", "s3://my-bucket"]
          # AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE are injected automatically
          # by EKS when the service account has the eks.amazonaws.com/role-arn annotation
```

**Verify IRSA is working:**
```bash
# Check the annotation on the service account
kubectl get sa s3-reader-sa -n production -o yaml | grep role-arn

# Exec into pod and confirm identity
kubectl exec -it <pod-name> -n production -- aws sts get-caller-identity
# Should return the IRSA role ARN, not the node's instance profile ARN
```

**IRSA gotcha:** The trust policy `Condition` block uses `StringEquals` on the service account name. If you rename the service account or move it to a different namespace, the trust relationship breaks and AWS calls return `AccessDenied`. Treat the namespace + service account name as part of the IAM configuration, not just a Kubernetes detail.

### AWS Load Balancer Controller

The AWS Load Balancer Controller (formerly ALB Ingress Controller) provisions Application Load Balancers for `Ingress` resources and Network Load Balancers for `Service` resources of type `LoadBalancer`. It is **not** installed by default — it is a separate controller that must be deployed.

**Prerequisites:** The controller needs an IRSA service account with permissions to manage ALB/NLB resources.

```bash
# 1. Create the IAM policy (download the official policy document)
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
  --set serviceAccount.create=false \           # use the IRSA SA we already created
  --set serviceAccount.name=aws-load-balancer-controller \
  --set replicaCount=2                           # HA: two controller replicas

# Verify
kubectl get deployment -n kube-system aws-load-balancer-controller
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
    alb.ingress.kubernetes.io/scheme: internet-facing         # or internal
    alb.ingress.kubernetes.io/target-type: ip                 # route to pod IPs (not node ports)
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789012:certificate/abc-123
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
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

**`target-type: ip` vs `target-type: instance`:** With `ip`, the ALB routes directly to pod IPs — requires VPC CNI (standard on EKS). With `instance`, traffic goes to a NodePort on each EC2 instance first. Use `ip` for lower latency and to support pods on Fargate (which have no node-level NodePort).

**The ALB DNS name is the externally reachable address.** Check it with:
```bash
kubectl get ingress myapp-ingress -n production
# Look at ADDRESS column — takes 1-3 minutes to provision
```

### EBS CSI Driver

Since Kubernetes 1.23, the in-tree EBS volume plugin is deprecated. You must use the EBS CSI driver addon for PersistentVolumes backed by EBS.

```bash
# Create the IRSA role for the EBS CSI driver
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace kube-system \
  --name ebs-csi-controller-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve

# Install as an EKS managed addon
eksctl create addon \
  --name aws-ebs-csi-driver \
  --cluster prod-cluster \
  --service-account-role-arn arn:aws:iam::123456789012:role/eksctl-prod-cluster-addon-iamserviceaccount \
  --force
```

```yaml
# gp3 StorageClass — set as default
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
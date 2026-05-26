---
title: Amazon EKS
module: aws
duration_min: 30
difficulty: intermediate
tags: [aws, eks, kubernetes, eksctl, node-groups, irsa, alb, fargate]
exercises: 4
---

## Overview
EKS (Elastic Kubernetes Service) is AWS's managed Kubernetes offering. AWS manages the control plane (API server, etcd, scheduler); you manage the worker nodes. The two main value-adds over self-managed K8s are: automatic control plane upgrades and deep integration with AWS services (IAM, ALB, EBS, EFS). The hard parts of EKS are IAM — specifically how pods get AWS permissions via IRSA — and networking via the AWS VPC CNI.

## Concepts

### Cluster Creation

#### eksctl (simplest path)
```bash
# Install eksctl
curl -sLO "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_amd64.tar.gz"
tar -xzf eksctl_Linux_amd64.tar.gz && sudo mv eksctl /usr/local/bin

# Create cluster with managed node group
eksctl create cluster \
  --name prod-cluster \
  --region us-east-1 \
  --version 1.31 \
  --nodegroup-name standard-workers \
  --node-type m6i.large \
  --nodes 3 \
  --nodes-min 2 \
  --nodes-max 5 \
  --managed \
  --with-oidc    # enable OIDC provider (required for IRSA)

# Cluster creates a kubeconfig entry automatically
kubectl get nodes
```

#### eksctl config file
```yaml
# cluster.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: prod-cluster
  region: us-east-1
  version: "1.31"

iam:
  withOIDC: true    # enable IRSA

managedNodeGroups:
  - name: standard
    instanceType: m6i.large
    minSize: 2
    maxSize: 5
    desiredCapacity: 3
    labels:
      role: worker
    tags:
      environment: production

  - name: spot
    instanceTypes: [m6i.large, m5.large, m5a.large]
    spot: true
    minSize: 0
    maxSize: 10
    labels:
      role: spot-worker
```

```bash
eksctl create cluster -f cluster.yaml
```

### Node Groups
```bash
# List node groups
eksctl get nodegroup --cluster prod-cluster

# Scale a node group
eksctl scale nodegroup \
  --cluster prod-cluster \
  --name standard \
  --nodes 5

# Upgrade node group to new Kubernetes version
eksctl upgrade nodegroup \
  --cluster prod-cluster \
  --name standard \
  --kubernetes-version 1.31

# Delete a node group (drain first)
eksctl delete nodegroup \
  --cluster prod-cluster \
  --name old-workers \
  --drain
```

### Fargate Profiles
Fargate runs pods without managing EC2 nodes:
```bash
eksctl create fargateprofile \
  --cluster prod-cluster \
  --name batch-jobs \
  --namespace batch \
  --labels type=fargate-job
```

Pods in the `batch` namespace with label `type: fargate-job` run on Fargate. No node groups to manage, but Fargate doesn't support DaemonSets or privileged containers.

### IRSA — IAM Roles for Service Accounts
IRSA lets pods assume IAM roles without node-level credentials. This is the correct way to give pods AWS permissions.

```bash
# 1. Ensure OIDC provider is enabled (--with-oidc in eksctl, or:)
eksctl utils associate-iam-oidc-provider --cluster prod-cluster --approve

# 2. Create an IAM service account with a managed policy
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace production \
  --name myapp-service-account \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
  --approve

# Or with an inline policy:
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace production \
  --name myapp-sa \
  --attach-policy-arn arn:aws:iam::123456789:policy/MyAppPolicy \
  --approve
```

```yaml
# Use the service account in a Deployment
spec:
  serviceAccountName: myapp-service-account
  containers:
    - name: app
      # This pod will automatically get AWS credentials for the attached IAM role
      # via a projected token at /var/run/secrets/eks.amazonaws.com/serviceaccount/token
```

### AWS Load Balancer Controller
The AWS Load Balancer Controller provisions ALBs for Kubernetes Ingress resources:

```bash
# Install via Helm
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=prod-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

```yaml
# Ingress using ALB
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789:certificate/abc-123
spec:
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: myapp
                port:
                  number: 80
```

### EBS CSI Driver
Mount EBS volumes as PersistentVolumes:

```bash
# Install EBS CSI driver (required for PVC support on EKS 1.23+)
eksctl create addon \
  --name aws-ebs-csi-driver \
  --cluster prod-cluster \
  --service-account-role-arn arn:aws:iam::123456789:role/ebs-csi-role
```

```yaml
# StorageClass backed by gp3 EBS
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### Cluster Autoscaler
```bash
helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  -n kube-system \
  --set autoDiscovery.clusterName=prod-cluster \
  --set awsRegion=us-east-1 \
  --set rbac.serviceAccount.name=cluster-autoscaler
```

The Cluster Autoscaler adds nodes when pods are unschedulable and removes them when underutilized.

### Cluster Upgrades
```bash
# Upgrade control plane first
eksctl upgrade cluster --name prod-cluster --version 1.31 --approve

# Then upgrade node groups (one at a time)
eksctl upgrade nodegroup \
  --cluster prod-cluster \
  --name standard \
  --kubernetes-version 1.31

# Upgrade EKS addons
eksctl update addon --name coredns --cluster prod-cluster
eksctl update addon --name kube-proxy --cluster prod-cluster
eksctl update addon --name vpc-cni --cluster prod-cluster
```

## Exercises

1. Create an EKS cluster with `eksctl` using a config file. Include a managed node group (3 nodes, m6i.large) with `--with-oidc`. Verify `kubectl get nodes` shows all nodes `Ready`.
2. Create an IRSA service account that allows a pod to read from a specific S3 bucket. Deploy a pod using that service account and verify it can run `aws s3 ls s3://your-bucket` without hardcoded credentials.
3. Install the AWS Load Balancer Controller. Deploy a service and an Ingress with ALB annotations. Verify the ALB is created in the AWS console and the app is reachable via the ALB DNS name.
4. Create a PVC using the `gp3` StorageClass (backed by the EBS CSI driver). Mount it in a pod, write a file, delete the pod, recreate it, and verify the file persists.

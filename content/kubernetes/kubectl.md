---
title: kubectl Mastery
module: kubernetes
duration_min: 25
difficulty: intermediate
tags: [kubernetes, kubectl, commands, debugging, context, jsonpath]
exercises: 4
---

## Overview
kubectl is the control plane CLI for every Kubernetes cluster. Mastering it means faster debugging, less time digging through YAML, and the ability to diagnose cluster issues in seconds rather than minutes. This lesson covers the commands you'll use daily — inspection, debugging, context switching, and output formatting — not just the basics.

## Concepts

### Contexts and Clusters
```bash
# List all configured contexts (cluster + user + namespace combos)
kubectl config get-contexts

# Show current context
kubectl config current-context

# Switch context (switch cluster)
kubectl config use-context prod-cluster

# Set default namespace for current context (avoids -n flag everywhere)
kubectl config set-context --current --namespace=production

# Quick context info
kubectl cluster-info
```

**kubectx + kubens** (popular third-party tools) make context and namespace switching faster:
```bash
kubectx prod-cluster     # switch context
kubens production        # switch namespace
```

### Getting Resources
```bash
# List resources
kubectl get pods
kubectl get pods -n kube-system
kubectl get pods -A               # all namespaces
kubectl get pods -o wide          # extra columns: node, IP

kubectl get deployments
kubectl get services
kubectl get ingress
kubectl get nodes

# Get all common resources at once
kubectl get all -n production

# Watch (live updates)
kubectl get pods -w

# Describe (detailed info, events)
kubectl describe pod myapp-abc123
kubectl describe node ip-10-0-1-5

# Get YAML of live resource
kubectl get deployment myapp -o yaml
kubectl get pod myapp-abc123 -o json
```

### Filtering and Selecting
```bash
# By label
kubectl get pods -l app=myapp
kubectl get pods -l app=myapp,env=production

# By field
kubectl get pods --field-selector status.phase=Running
kubectl get pods --field-selector spec.nodeName=ip-10-0-1-5

# Sort output
kubectl get pods --sort-by='.metadata.creationTimestamp'
kubectl get pods --sort-by='.status.startTime'
```

### Output Formatting
```bash
# Custom columns
kubectl get pods -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,NODE:.spec.nodeName

# JSONPath — extract specific fields
kubectl get pod myapp-abc123 -o jsonpath='{.status.podIP}'
kubectl get pods -o jsonpath='{.items[*].metadata.name}'
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'

# Get all container images across all deployments
kubectl get deployments -A -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
```

### Applying and Editing
```bash
# Apply manifest (create or update)
kubectl apply -f deployment.yaml
kubectl apply -f ./manifests/      # apply all files in a directory
kubectl apply -k ./overlays/prod/  # kustomize

# Dry run (validate without applying)
kubectl apply -f deployment.yaml --dry-run=client
kubectl apply -f deployment.yaml --dry-run=server   # server-side validation

# Edit live resource in your editor
kubectl edit deployment myapp

# Patch without editing the full resource
kubectl patch deployment myapp -p '{"spec":{"replicas":5}}'
kubectl patch deployment myapp --type=json \
    -p='[{"op":"replace","path":"/spec/replicas","value":5}]'

# Scale
kubectl scale deployment myapp --replicas=5

# Delete
kubectl delete -f deployment.yaml
kubectl delete deployment myapp
kubectl delete pod myapp-abc123 --grace-period=0   # force delete
```

### Debugging
```bash
# View logs
kubectl logs myapp-abc123
kubectl logs myapp-abc123 -c sidecar   # specific container in multi-container pod
kubectl logs myapp-abc123 --previous   # logs from the previous (crashed) container
kubectl logs -f myapp-abc123           # follow
kubectl logs -l app=myapp --all-containers   # all pods with label

# Shell into a running pod
kubectl exec -it myapp-abc123 -- /bin/bash
kubectl exec -it myapp-abc123 -c sidecar -- /bin/sh

# Run an ephemeral debug container (K8s 1.23+)
kubectl debug -it myapp-abc123 --image=busybox --target=app

# Port-forward (access a pod directly without a Service)
kubectl port-forward pod/myapp-abc123 8080:8080
kubectl port-forward service/myapp 8080:80
kubectl port-forward deployment/myapp 8080:8080

# Copy files to/from a pod
kubectl cp myapp-abc123:/var/log/app.log ./app.log
kubectl cp ./config.json myapp-abc123:/etc/app/config.json
```

### Troubleshooting Patterns
```bash
# Pod stuck in Pending?
kubectl describe pod myapp-abc123 | grep -A10 Events
# Look for: Insufficient memory, No nodes available, volume errors

# Pod in CrashLoopBackOff?
kubectl logs myapp-abc123 --previous   # see crash output
kubectl describe pod myapp-abc123      # check Events section

# Pod in ImagePullBackOff?
# → image name wrong, tag doesn't exist, or registry auth missing

# Service not routing traffic?
kubectl get endpoints myapp-service   # empty = no pods matching selector
kubectl get pods -l app=myapp         # check labels match

# Node issues?
kubectl get nodes                     # check Ready status
kubectl describe node ip-10-0-1-5    # check allocatable resources, conditions
kubectl top nodes                     # CPU/memory usage (requires metrics-server)
kubectl top pods -n production
```

### Imperative Commands (Quick Tasks)
```bash
# Generate YAML without applying (useful starting point)
kubectl create deployment myapp --image=nginx:1.25 --dry-run=client -o yaml

# Create resources directly
kubectl create namespace staging
kubectl create configmap myconfig --from-literal=KEY=value
kubectl create secret generic mysecret --from-literal=PASSWORD=secret

# Expose a deployment as a service
kubectl expose deployment myapp --port=80 --target-port=8080 --type=ClusterIP
```

## Examples

### Cluster Health Check Script
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Node Status ==="
kubectl get nodes -o custom-columns=NAME:.metadata.name,STATUS:.status.conditions[-1].type,VERSION:.status.nodeInfo.kubeletVersion

echo ""
echo "=== Unhealthy Pods (all namespaces) ==="
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded \
    -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase

echo ""
echo "=== Recent Events (Warnings) ==="
kubectl get events -A --field-selector type=Warning \
    --sort-by='.lastTimestamp' | tail -20
```

## Exercises

1. Configure kubectl to use two different kubeconfig files (staging and prod). Switch between them with `kubectl config use-context`. Set a default namespace on each context.
2. Write a one-liner using JSONPath that prints each pod's name, its node, and its IP address across all namespaces.
3. A pod is in `CrashLoopBackOff`. Walk through the full diagnosis: check events, logs from previous container, describe the pod. Write out the commands you'd run and what you'd look for at each step.
4. Use `kubectl port-forward` to access a pod running a web server without creating a Service. Then use `kubectl cp` to copy a file into the running pod and verify it's there.

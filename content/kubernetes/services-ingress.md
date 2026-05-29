---
title: Services & Ingress
module: kubernetes
duration_min: 20
difficulty: intermediate
tags: [kubernetes, services, ingress, clusterip, nodeport, loadbalancer, networking]
exercises: 4
---

## Overview
Pods are ephemeral and get new IPs every restart. Services give you a stable endpoint that automatically routes to healthy Pods — regardless of which specific Pod IPs are active. Ingress routes external HTTP/HTTPS traffic to the right Service based on hostname or path. Together they form the networking layer every Kubernetes app depends on.

## Concepts

### Service Types
| Type | Accessible from | Use case |
|---|---|---|
| `ClusterIP` | Inside cluster only | Internal service-to-service |
| `NodePort` | Any node's IP + port | Simple external access, dev/testing |
| `LoadBalancer` | Public IP (cloud LB) | Production external access |
| `ExternalName` | Inside cluster | DNS alias to an external hostname |

### ClusterIP (Default)
```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
spec:
  type: ClusterIP      # default — omit or explicit
  selector:
    app: api           # routes to Pods with this label
  ports:
    - port: 80         # port the Service listens on
      targetPort: 8080 # port the Pod container listens on
      protocol: TCP
```

Other pods in the cluster reach this service at:
- `api-service` (same namespace)
- `api-service.production` (cross-namespace shorthand)
- `api-service.production.svc.cluster.local` (full DNS name)

Kubernetes DNS handles resolution automatically — no IPs needed.

### NodePort
```yaml
spec:
  type: NodePort
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8080
      nodePort: 30080   # optional — auto-assigned in 30000-32767 range if omitted
```

Accessible at `<any-node-ip>:30080`. Rarely used in production — use LoadBalancer or Ingress instead.

### LoadBalancer
```yaml
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8080
```

In cloud environments (EKS, GKE, AKS), this provisions an actual cloud load balancer and assigns a public IP. Each LoadBalancer Service costs money (one cloud LB per Service). Ingress is more cost-efficient for HTTP/HTTPS.

### Endpoints and Pod Selection
Services route to Pods via label selectors. The Service controller maintains an `Endpoints` object (list of ready Pod IPs):

```bash
kubectl get endpoints api-service
# NAME          ENDPOINTS                         AGE
# api-service   10.0.1.5:8080,10.0.1.6:8080      5m
```

Only Pods with matching labels AND passing their readiness probe appear in Endpoints. Unhealthy Pods are automatically removed.

### Ingress
Ingress routes external HTTP/HTTPS traffic based on host or path. Requires an **Ingress Controller** (nginx-ingress, AWS ALB Controller, Traefik, etc.) to be installed in the cluster.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    cert-manager.io/cluster-issuer: letsencrypt-prod   # auto TLS
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret   # cert-manager populates this
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
    - host: app.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 80
```

### Path Types
| Type | Behavior |
|---|---|
| `Exact` | Exactly matches the path |
| `Prefix` | Matches path prefix (most common) |
| `ImplementationSpecific` | Controller-defined behavior |

### DNS Resolution Inside the Cluster
Every Service gets a DNS entry managed by CoreDNS:
```
<service>.<namespace>.svc.cluster.local
```

```bash
# Test DNS from inside a pod
kubectl run -it --rm debug --image=alpine -- /bin/sh
# Inside pod:
nslookup api-service.production.svc.cluster.local
wget -qO- http://api-service.production/health
```

### Network Policies
Control traffic between pods (requires a CNI plugin that supports NetworkPolicy, e.g., Calico, Cilium):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-netpol
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend   # only frontend pods can reach api pods
      ports:
        - port: 8080
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: db
      ports:
        - port: 5432
```

## Examples

### Full Stack: Deployment + Service + Ingress
```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
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
      containers:
        - name: api
          image: myapi:v1.0.0
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 80
```

## Exercises

1. Create a Deployment and a ClusterIP Service for an nginx Pod. Verify the Service resolves correctly by running `kubectl run -it --rm debug --image=busybox -- wget -qO- http://<service-name>` from within the cluster.
2. Change the Service type to `NodePort`. Find the assigned node port with `kubectl get svc`. Access the service from outside the cluster at `<node-ip>:<node-port>`.
3. Write an Ingress resource that routes `api.local/v1` to one Service and `api.local/v2` to another Service. Apply it and test with `curl -H "Host: api.local" http://<ingress-ip>/v1`.
4. Write a NetworkPolicy that allows only pods with label `app: frontend` to talk to pods with label `app: api` on port 8080. Deny all other ingress. Test it by creating both pod types and verifying connectivity.


---

### Quick Checks

5. Extract the `targetPort` from a Service spec stub. Run: `printf 'ports:\n- port: 80\n  targetPort: 8080\n' | awk '/targetPort:/{print $2}'`

```expected_output
8080
```

6. Count host rules in an Ingress spec stub. Run: `printf 'rules:\n- host: app.example.com\n- host: api.example.com\n- host: admin.example.com\n' | grep -c 'host:'`

```expected_output
3
```

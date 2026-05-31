# Kubernetes — Quick Reference

## kubectl Basics

| Command | Description |
|---------|-------------|
| `kubectl get pods` | List pods in current namespace |
| `kubectl get pods -A` | List pods in all namespaces |
| `kubectl get all` | List all resources |
| `kubectl get pods -o wide` | Include node and IP |
| `kubectl get pod NAME -o yaml` | Output full YAML spec |
| `kubectl describe pod NAME` | Detailed pod info + events |
| `kubectl apply -f file.yaml` | Apply manifest |
| `kubectl delete -f file.yaml` | Delete from manifest |
| `kubectl delete pod NAME` | Delete specific pod |

## Namespaces & Context

| Command | Description |
|---------|-------------|
| `kubectl config get-contexts` | List contexts |
| `kubectl config use-context ctx` | Switch context |
| `kubectl config current-context` | Show active context |
| `kubectl get ns` | List namespaces |
| `kubectl create ns name` | Create namespace |
| `kubectl -n ns get pods` | Pods in specific namespace |
| `kubectl config set-context --current --namespace=ns` | Set default namespace |

## Workloads

| Command | Description |
|---------|-------------|
| `kubectl create deployment name --image=img` | Create deployment |
| `kubectl scale deploy name --replicas=3` | Scale deployment |
| `kubectl rollout status deploy name` | Watch rollout |
| `kubectl rollout undo deploy name` | Rollback deployment |
| `kubectl rollout history deploy name` | Rollout history |
| `kubectl set image deploy name app=img:tag` | Update image |
| `kubectl get deploy` | List deployments |
| `kubectl get rs` | List ReplicaSets |

## Services & Networking

| Command | Description |
|---------|-------------|
| `kubectl get svc` | List services |
| `kubectl expose deploy name --port=80 --type=ClusterIP` | Expose deployment |
| `kubectl port-forward pod NAME 8080:80` | Forward local port to pod |
| `kubectl port-forward svc NAME 8080:80` | Forward to service |
| `kubectl get ingress` | List ingresses |
| `kubectl get endpoints` | Show service endpoints |

## Debugging

| Command | Description |
|---------|-------------|
| `kubectl logs pod NAME` | Pod logs |
| `kubectl logs -f pod NAME` | Follow logs |
| `kubectl logs pod NAME -c container` | Specific container |
| `kubectl logs pod NAME --previous` | Previous (crashed) container |
| `kubectl exec -it pod NAME -- bash` | Shell into pod |
| `kubectl exec -it pod NAME -c ctr -- sh` | Specific container |
| `kubectl top pods` | CPU/memory usage |
| `kubectl top nodes` | Node resource usage |
| `kubectl events --sort-by=.lastTimestamp` | Sorted events |

## Config & Secrets

| Command | Description |
|---------|-------------|
| `kubectl get configmap` | List ConfigMaps |
| `kubectl describe configmap NAME` | Show ConfigMap data |
| `kubectl create configmap NAME --from-file=file` | Create from file |
| `kubectl get secret` | List secrets |
| `kubectl get secret NAME -o jsonpath='{.data.key}' \| base64 -d` | Decode secret |
| `kubectl create secret generic NAME --from-literal=k=v` | Create secret |

## Resource Management

| Command | Description |
|---------|-------------|
| `kubectl get nodes` | List cluster nodes |
| `kubectl describe node NAME` | Node details + capacity |
| `kubectl cordon node NAME` | Mark node unschedulable |
| `kubectl drain node NAME` | Evict pods from node |
| `kubectl uncordon node NAME` | Re-enable scheduling |
| `kubectl label pod NAME key=val` | Add label |
| `kubectl annotate pod NAME key=val` | Add annotation |
| `kubectl taint node NAME key=val:NoSchedule` | Add taint |

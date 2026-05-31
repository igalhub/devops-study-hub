# Helm — Quick Reference

## Core Commands

| Command | Description |
|---------|-------------|
| `helm install name chart` | Install a release |
| `helm install name chart -f values.yaml` | Install with custom values |
| `helm install name chart --set key=val` | Install with inline value |
| `helm upgrade name chart` | Upgrade a release |
| `helm upgrade --install name chart` | Install or upgrade |
| `helm uninstall name` | Uninstall a release |
| `helm list` | List releases in current namespace |
| `helm list -A` | List all releases |
| `helm status name` | Show release status |
| `helm history name` | Show release history |

## Values & Templates

| Command | Description |
|---------|-------------|
| `helm show values chart` | Show default values |
| `helm show chart chart` | Show chart metadata |
| `helm get values name` | Show applied values |
| `helm get manifest name` | Show rendered manifests |
| `helm template name chart` | Render templates locally |
| `helm template name chart -f values.yaml` | Render with custom values |
| `helm lint chart/` | Validate chart syntax |
| `helm diff upgrade name chart` | Preview changes (requires plugin) |

## Rollback & Debugging

| Command | Description |
|---------|-------------|
| `helm rollback name 1` | Roll back to revision 1 |
| `helm rollback name 0` | Roll back to previous revision |
| `helm test name` | Run chart tests |
| `helm get notes name` | Show post-install notes |
| `helm upgrade name chart --debug --dry-run` | Dry run with debug output |
| `helm upgrade name chart --atomic` | Roll back automatically on failure |
| `helm upgrade name chart --timeout 5m0s` | Set timeout |

## Repositories

| Command | Description |
|---------|-------------|
| `helm repo add name url` | Add repository |
| `helm repo list` | List repos |
| `helm repo update` | Fetch latest charts |
| `helm repo remove name` | Remove repo |
| `helm search repo term` | Search in repos |
| `helm search hub term` | Search Artifact Hub |
| `helm pull repo/chart` | Download chart tarball |
| `helm pull repo/chart --untar` | Download and extract |

## Chart Development

| Command | Description |
|---------|-------------|
| `helm create name` | Scaffold new chart |
| `helm package chart/` | Package chart to tarball |
| `helm dependency update chart/` | Download chart dependencies |
| `helm dependency list chart/` | List dependencies |

## Common Flags

| Flag | Description |
|------|-------------|
| `-n namespace` | Target namespace |
| `--create-namespace` | Create namespace if missing |
| `--wait` | Wait until all resources are ready |
| `--timeout 5m0s` | Override default timeout |
| `--dry-run` | Simulate without applying |
| `--debug` | Enable verbose output |
| `--set key=val` | Override single value |
| `-f values.yaml` | Override values file |

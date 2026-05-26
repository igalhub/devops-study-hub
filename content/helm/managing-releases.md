---
title: Managing Releases
module: helm
duration_min: 15
difficulty: intermediate
tags: [helm, releases, upgrade, rollback, repositories, install]
exercises: 4
---

## Overview
A Helm **release** is a deployed instance of a chart in a cluster. You can install the same chart multiple times with different release names and values — one release per environment, for example. Helm tracks the history of each release, which enables atomic upgrades and one-command rollbacks. This lesson covers the full release lifecycle and working with the Helm ecosystem of public charts.

## Concepts

### Release Lifecycle Commands
```bash
# Install a chart as a new release
helm install <release-name> <chart> [flags]

# Upgrade an existing release
helm upgrade <release-name> <chart> [flags]

# Install or upgrade (idempotent — the standard in CI/CD)
helm upgrade --install <release-name> <chart> [flags]

# Uninstall a release (removes all K8s objects)
helm uninstall <release-name>

# Uninstall but keep history
helm uninstall <release-name> --keep-history
```

### install / upgrade Flags
```bash
# Values
--values prod.yaml             # load values from file
--values base.yaml --values prod.yaml   # merge multiple files (later overrides earlier)
--set image.tag=v1.3.0         # override a single value
--set-string version="1.0.0"   # force string (avoids type coercion)

# Namespace
--namespace production
--create-namespace             # create the namespace if it doesn't exist

# Wait for rollout to complete
--wait                         # wait for pods to be ready
--timeout 5m                   # override default 5m wait timeout
--atomic                       # roll back automatically if install/upgrade fails

# Debug
--dry-run                      # render + send to server but don't apply
--debug                        # verbose output including rendered manifests
```

### Values Precedence (low → high)
1. Chart's `values.yaml` (defaults)
2. Parent chart's `values.yaml` (for subcharts)
3. `--values file.yaml` (left to right: later files override earlier)
4. `--set` flags (highest priority)

### Viewing Releases
```bash
# List releases in current namespace
helm list
helm list -n production
helm list -A   # all namespaces

# Release details
helm status myapp -n production
helm get values myapp -n production            # values used in current release
helm get values myapp -n production --all      # all values (including defaults)
helm get manifest myapp -n production          # rendered Kubernetes manifests
helm get notes myapp -n production             # NOTES.txt output

# Release history
helm history myapp -n production
# REVISION  UPDATED               STATUS     CHART         DESCRIPTION
# 1         2024-01-10 09:00:00   superseded myapp-0.1.0   Install complete
# 2         2024-01-15 14:00:00   deployed   myapp-0.2.0   Upgrade complete
```

### Rollback
```bash
# Roll back to previous release
helm rollback myapp -n production

# Roll back to a specific revision
helm rollback myapp 1 -n production

# Rollback with wait
helm rollback myapp --wait --timeout 3m -n production
```

### Working with Repositories
Helm repositories are HTTP servers hosting packaged charts (`.tgz` files) and an `index.yaml`.

```bash
# Add a repository
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add cert-manager https://charts.jetstack.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts

# Update repo indexes
helm repo update

# List configured repos
helm repo list

# Search for a chart
helm search repo postgres
helm search repo bitnami/postgresql
helm search repo bitnami/postgresql --versions   # all available versions

# Inspect a chart before installing
helm show chart bitnami/postgresql
helm show values bitnami/postgresql             # default values
helm show values bitnami/postgresql > pg-defaults.yaml   # save to file, customize
```

### Installing from a Repository
```bash
# Install latest
helm install pg bitnami/postgresql -n databases --create-namespace

# Install specific version
helm install pg bitnami/postgresql --version 14.2.3 -n databases

# With custom values
helm install pg bitnami/postgresql \
    --version 14.2.3 \
    --namespace databases \
    --create-namespace \
    --values postgres-values.yaml \
    --set auth.postgresPassword=secret \
    --atomic \
    --wait
```

### OCI Registries (Helm 3.8+)
Charts can be stored in OCI container registries alongside images:
```bash
# Push a chart to ECR (OCI registry)
helm package ./mychart
helm push mychart-0.1.0.tgz oci://123456789.dkr.ecr.us-east-1.amazonaws.com/charts

# Install from OCI
helm install myapp oci://123456789.dkr.ecr.us-east-1.amazonaws.com/charts/mychart --version 0.1.0
```

### CI/CD Pattern
```bash
#!/usr/bin/env bash
set -euo pipefail

RELEASE="myapp"
NAMESPACE="production"
CHART="./charts/myapp"
VERSION=$(git rev-parse --short HEAD)

helm upgrade --install "$RELEASE" "$CHART" \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --values "values/base.yaml" \
    --values "values/production.yaml" \
    --set image.tag="$VERSION" \
    --atomic \
    --wait \
    --timeout 5m
```

`--atomic` is key for CI: if the upgrade fails (pods don't become ready), Helm automatically rolls back to the previous revision.

## Examples

### Multi-Environment Pattern
```bash
# Directory structure
values/
  base.yaml       # shared defaults
  dev.yaml        # dev overrides
  prod.yaml       # prod overrides

# Install per environment
helm upgrade --install myapp ./charts/myapp \
    -f values/base.yaml \
    -f values/prod.yaml \
    --set image.tag="${GIT_SHA}" \
    -n production --create-namespace --atomic
```

## Exercises

1. Add the `bitnami` Helm repo. Search for the `nginx` chart, inspect its default values, create a custom `values.yaml` overriding the replica count and service type. Install it and verify with `kubectl get pods`.
2. Upgrade an installed release by changing a value (e.g. `replicaCount`). View the release history with `helm history`. Then roll back to revision 1 and verify the replica count reverted.
3. Use `helm upgrade --install` to make a deployment script idempotent. Run it twice — verify the first run installs, the second upgrades (check `helm history` for revision 2).
4. Install the `ingress-nginx` chart from the official Helm repo in a local cluster. Use `helm get manifest ingress-nginx` to see what Kubernetes resources were created. Then uninstall it and verify they're all gone.

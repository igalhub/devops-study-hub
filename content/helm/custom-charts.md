---
title: Writing Custom Charts
module: helm
duration_min: 25
difficulty: advanced
tags: [helm, custom-charts, subcharts, hooks, tests, library-charts]
exercises: 4
---

## Overview
Writing your own Helm charts means controlling exactly how your application is deployed, tested, and upgraded across environments. This lesson covers production-grade chart patterns: hooks for database migrations, chart tests, library charts for shared templates, and dependency management with subcharts.

## Concepts

### Hooks
Hooks run Jobs at specific points in the release lifecycle:

| Hook | When it runs |
|---|---|
| `pre-install` | Before any resources are created |
| `post-install` | After all resources are created |
| `pre-upgrade` | Before upgrading resources |
| `post-upgrade` | After upgrading resources |
| `pre-delete` | Before deleting resources |
| `post-delete` | After deleting resources |
| `pre-rollback` | Before rolling back |
| `test` | Only when `helm test` is run |

```yaml
# templates/hooks/db-migrate.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Release.Name }}-db-migrate
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install
    "helm.sh/hook-weight": "-5"           # lower = runs first (can be negative)
    "helm.sh/hook-delete-policy": hook-succeeded   # delete job after success
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["python", "manage.py", "migrate"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Release.Name }}-secrets
                  key: DATABASE_URL
```

Hook delete policies:
- `hook-succeeded` — delete after hook Job completes successfully
- `hook-failed` — delete if hook fails (keeps on success for inspection)
- `before-hook-creation` — delete old hook before running new one (default if not specified)

### Chart Tests
Tests are Pods with the `helm.sh/hook: test` annotation. They run when you call `helm test`:

```yaml
# templates/tests/test-connection.yaml
apiVersion: v1
kind: Pod
metadata:
  name: {{ .Release.Name }}-test-connection
  annotations:
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  restartPolicy: Never
  containers:
    - name: wget
      image: busybox:1.36
      command: ["wget", "--spider", "--timeout=5",
                "http://{{ .Release.Name }}-{{ .Chart.Name }}/health"]
```

```bash
helm test myapp -n production
# Running hook: myapp/templates/tests/test-connection.yaml
# Pod myapp-test-connection: Succeeded
# TEST SUITE: myapp
# Status: SUCCESS
```

### Library Charts
A library chart contains only `_helpers.tpl` templates — reusable snippets with no renderable manifests. Other charts declare it as a dependency:

```yaml
# library-chart/Chart.yaml
apiVersion: v2
name: common
type: library         # library type — cannot be installed directly
version: 1.0.0
```

```yaml
# library-chart/templates/_labels.tpl
{{- define "common.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
{{- end -}}
```

```yaml
# mychart/Chart.yaml
dependencies:
  - name: common
    version: "1.0.0"
    repository: "file://../common"   # local path or repo URL
```

```yaml
# mychart/templates/deployment.yaml
metadata:
  labels:
    {{- include "common.labels" . | nindent 4 }}
```

### Chart Dependencies (Subcharts)
```yaml
# Chart.yaml
dependencies:
  - name: postgresql
    version: "14.2.3"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled   # only deploy if this value is true
    tags:
      - database
  - name: redis
    version: "18.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled
```

```bash
# Download dependencies into charts/
helm dependency update ./mychart
# Creates charts/postgresql-14.2.3.tgz, charts/redis-18.x.x.tgz, and Chart.lock

# Build dependencies (use Chart.lock versions)
helm dependency build ./mychart
```

In `values.yaml`, subchart values are nested under the subchart name:
```yaml
postgresql:
  enabled: true
  auth:
    postgresPassword: secret
    database: myapp
  primary:
    persistence:
      size: 20Gi

redis:
  enabled: false
```

### Advanced Template Patterns

#### Named Templates with Arguments
```yaml
# _helpers.tpl
{{- define "myapp.env" -}}
{{- range $key, $val := . }}
- name: {{ $key }}
  value: {{ $val | quote }}
{{- end }}
{{- end }}
```

```yaml
# deployment.yaml
env:
  {{- include "myapp.env" .Values.env | nindent 12 }}
```

#### Required and Validation
```yaml
# Fail fast if required values are missing
image: {{ required "image.repository is required" .Values.image.repository }}

# Custom validation
{{- if and .Values.ingress.enabled (not .Values.ingress.host) }}
{{- fail "ingress.host must be set when ingress.enabled=true" }}
{{- end }}
```

#### Computed Values
```yaml
# Combine values into a connection string
env:
  - name: DATABASE_URL
    value: {{ printf "postgresql://%s:%s@%s:%d/%s"
      .Values.db.user
      .Values.db.password
      .Values.db.host
      (.Values.db.port | int)
      .Values.db.name | quote }}
```

### Packaging and Publishing
```bash
# Package chart into a .tgz
helm package ./mychart

# Package with specific output directory
helm package ./mychart --destination ./dist

# Update repo index (for self-hosted chart repo)
helm repo index ./dist --url https://charts.example.com

# Push to OCI registry
helm push mychart-0.1.0.tgz oci://registry.example.com/charts
```

## Examples

### Production Chart with Migration Hook
```yaml
# templates/hooks/migrate.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "myapp.fullname" . }}-migrate-{{ .Release.Revision }}
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: {{ .Release.Name }}-migrator
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: {{ .Values.migration.command | toJson }}
          envFrom:
            - secretRef:
                name: {{ .Release.Name }}-secrets
```

## Exercises

1. Add a `pre-upgrade` hook to an existing chart that runs a database migration Job. Use `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded`. Test it by running `helm upgrade` and verifying the Job ran.
2. Write a chart test that verifies the application's `/health` endpoint returns HTTP 200. Run it with `helm test` and verify it passes and cleans up the test pod.
3. Create a library chart with a `common.labels` template. Create a dependent application chart that uses it. Verify `helm template` produces the shared labels on all resources.
4. Add `postgresql` from Bitnami as a chart dependency with `condition: postgresql.enabled`. Show that `helm install --set postgresql.enabled=false` deploys your app without a PostgreSQL instance.

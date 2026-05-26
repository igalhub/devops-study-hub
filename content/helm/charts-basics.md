---
title: Charts, Templates & Values
module: helm
duration_min: 20
difficulty: intermediate
tags: [helm, charts, templates, values, go-templates, kubernetes]
exercises: 4
---

## Overview
Helm is the package manager for Kubernetes. A **chart** is a collection of YAML templates and default values that renders into valid Kubernetes manifests. Instead of maintaining 10 nearly-identical YAML files for dev/staging/prod, you maintain one chart and override values per environment. This lesson covers chart structure, Go template syntax, and the values system.

## Concepts

### Chart Structure
```
mychart/
├── Chart.yaml          # chart metadata (name, version, description)
├── values.yaml         # default values
├── templates/          # YAML templates (rendered with values)
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── _helpers.tpl    # reusable template snippets (not rendered directly)
│   └── NOTES.txt       # printed after install (usage instructions)
└── charts/             # chart dependencies (subcharts)
```

### Chart.yaml
```yaml
apiVersion: v2          # always v2 for Helm 3
name: myapp
description: My application Helm chart
type: application       # application or library
version: 0.1.0          # chart version (semver)
appVersion: "1.2.3"     # application version (informational)
```

### values.yaml
```yaml
replicaCount: 2

image:
  repository: myapp
  tag: "v1.2.3"
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 80

ingress:
  enabled: false
  host: ""

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

env:
  APP_ENV: production
  LOG_LEVEL: info
```

### Go Template Syntax
Helm templates use Go's `text/template` package with Helm-specific functions:

```yaml
# {{ .Values.path.to.value }} — reference a value
# {{ .Release.Name }} — release name
# {{ .Release.Namespace }} — namespace
# {{ .Chart.Name }} — chart name
# {{ .Chart.Version }} — chart version
```

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  namespace: {{ .Release.Namespace }}
  labels:
    app: {{ .Chart.Name }}
    release: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Chart.Name }}
      release: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Chart.Name }}
        release: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - containerPort: 8080
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          env:
            {{- range $key, $val := .Values.env }}
            - name: {{ $key }}
              value: {{ $val | quote }}
            {{- end }}
```

**Key template functions:**
- `toYaml` — converts a value to YAML string
- `nindent N` — indent by N spaces (with leading newline)
- `indent N` — indent by N spaces (no leading newline)
- `quote` — wrap in double quotes
- `default "fallback"` — use fallback if value is empty
- `required "error msg"` — fail if value is not set
- `tpl` — render a string as a template

### Conditionals
```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}-ingress
spec:
  rules:
    - host: {{ .Values.ingress.host | required "ingress.host is required when ingress.enabled=true" }}
      ...
{{- end }}
```

### _helpers.tpl — Reusable Snippets
```yaml
# templates/_helpers.tpl
{{/*
Common labels applied to all resources.
*/}}
{{- define "myapp.labels" -}}
app: {{ .Chart.Name }}
release: {{ .Release.Name }}
chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}
```

Use in templates:
```yaml
metadata:
  labels:
    {{- include "myapp.labels" . | nindent 4 }}
```

### Rendering Without Installing
```bash
# Render templates to stdout (debug)
helm template myrelease ./mychart
helm template myrelease ./mychart --values prod-values.yaml

# Render a specific template file
helm template myrelease ./mychart -s templates/deployment.yaml

# Validate rendered output against the cluster API
helm template myrelease ./mychart | kubectl apply --dry-run=server -f -
```

### Linting
```bash
helm lint ./mychart
helm lint ./mychart --values prod-values.yaml
```

## Examples

### Minimal Working Chart
```yaml
# Chart.yaml
apiVersion: v2
name: webapp
version: 0.1.0
appVersion: "1.0.0"
```

```yaml
# values.yaml
image:
  repository: nginx
  tag: "1.25"
replicaCount: 2
service:
  port: 80
```

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-webapp
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}-webapp
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-webapp
    spec:
      containers:
        - name: webapp
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - containerPort: 80
```

```bash
helm template myapp ./webapp                     # preview
helm install myapp ./webapp                      # install
helm install myapp ./webapp --values prod.yaml   # with overrides
```

## Exercises

1. Create a Helm chart from scratch with `helm create myapp`. Inspect the generated structure. Render it with `helm template test ./myapp` and identify the Go template directives in the output.
2. Modify the chart's `values.yaml` to add an `ingress.enabled` flag. Add a conditional `{{- if .Values.ingress.enabled }}` block in `templates/ingress.yaml`. Test both `helm template ... --set ingress.enabled=true` and `false`.
3. Add a `_helpers.tpl` snippet that defines a template `myapp.fullname` returning `{{ .Release.Name }}-{{ .Chart.Name }}`. Use it with `include` in the Deployment and Service templates.
4. Add an `env` map to `values.yaml` and iterate over it with `{{- range $key, $val := .Values.env }}` to render environment variables in the Deployment template. Test with `--set env.APP_ENV=staging`.

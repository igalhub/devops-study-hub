---
title: Charts, Templates & Values
module: helm
duration_min: 20
difficulty: intermediate
tags: [helm, charts, templates, values, go-templates, kubernetes]
exercises: 4
---

## Overview

Helm is the de facto package manager for Kubernetes. Rather than maintaining separate, nearly-identical YAML manifests for each environment, Helm lets you define a single parameterized chart and override values at install time. This single source of truth dramatically reduces configuration drift between dev, staging, and production — a core DevOps objective. Under the hood, Helm renders Go templates against a merged values tree to produce plain Kubernetes manifests, then manages those manifests as a named release with full lifecycle support (install, upgrade, rollback, uninstall).

The design philosophy is explicit separation of concerns: structure lives in `templates/`, defaults live in `values.yaml`, and environment-specific overrides live in external values files or `--set` flags. The chart itself is versioned independently from the application it deploys, which means you can patch your deployment strategy without shipping new application code. Helm 3 dropped the server-side Tiller component entirely; the Helm binary now communicates directly with the Kubernetes API server, which simplifies RBAC and removes a security surface.

In the broader DevOps toolchain, Helm slots between your CI system and your cluster. A pipeline builds an image, pushes it to a registry, then calls `helm upgrade --install` with the new image tag. Tools like ArgoCD and Flux can watch a Helm chart repository and apply changes declaratively. Understanding chart internals — how values merge, how templates render, when to use helpers — is essential for writing maintainable charts and debugging broken deployments.

---

## Concepts

### Chart Structure

Every Helm chart is a directory with a predictable layout. Knowing what each file does is the foundation for reading and writing any chart.

```
mychart/
├── Chart.yaml          # required: chart metadata (name, version, type)
├── values.yaml         # default values — always present, may be empty
├── templates/          # Go templates rendered into Kubernetes manifests
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── _helpers.tpl    # named templates — NOT rendered directly (underscore prefix)
│   └── NOTES.txt       # printed to stdout after install; also a template
└── charts/             # unpacked chart dependencies (subcharts)
```

| File/Dir | Rendered? | Purpose |
|---|---|---|
| `Chart.yaml` | No | Chart identity and version metadata |
| `values.yaml` | No | Default value tree |
| `templates/*.yaml` | Yes | Kubernetes manifests |
| `templates/_*.tpl` | No (defines named templates) | Reusable snippet library |
| `templates/NOTES.txt` | Yes (to stdout only) | Post-install usage instructions |
| `charts/` | Transitively | Subchart sources |

**`helm create mychart`** scaffolds this entire structure with a working nginx example. Always start here rather than from scratch.

---

### Chart.yaml

`Chart.yaml` is required and must be valid on every chart operation.

```yaml
apiVersion: v2          # must be v2 for Helm 3; v1 is Helm 2 legacy
name: myapp             # must match the directory name when packaging
description: Production-grade web application chart
type: application       # "application" installs resources; "library" provides only named templates
version: 0.2.1          # chart version — increment this with every chart change (semver)
appVersion: "2.4.0"     # informational: the version of the app being packaged
dependencies:           # optional — lock file is charts/Chart.lock
  - name: postgresql
    version: "12.x.x"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.enabled   # only pull in if this value is true
```

| Field | Required | Notes |
|---|---|---|
| `apiVersion` | Yes | Always `v2` for Helm 3 |
| `name` | Yes | Lowercase, no spaces |
| `version` | Yes | Semver; used to tag chart releases |
| `appVersion` | No | Shown in `helm list`; no semantic meaning to Helm |
| `type` | No | Defaults to `application` |

**`version` vs `appVersion`:** bump `version` every time the chart changes (template logic, new fields), regardless of whether the app version changed. They evolve independently.

---

### values.yaml and the Values Hierarchy

`values.yaml` defines the default values tree. Every key here is reachable inside templates as `.Values.<key>`.

```yaml
# values.yaml
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
  annotations: {}

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

postgresql:
  enabled: false
```

Values are merged in order from lowest to highest priority:

| Priority | Source | How supplied |
|---|---|---|
| 1 (lowest) | `values.yaml` in chart | Committed to chart |
| 2 | `values.yaml` in parent chart | When used as a subchart |
| 3 | User-supplied values files | `-f overrides.yaml` (left to right) |
| 4 (highest) | `--set` flags | `--set image.tag=v2.0.0` |

**Merge behavior:** Helm does a deep merge for maps. If your override file sets `image.tag`, the `image.repository` from `values.yaml` is preserved. However, if you `--set` a list, it replaces the entire list — it does not append.

**`--set` syntax cheat sheet:**

```bash
--set key=value
--set a.b.c=value          # nested: a.b.c
--set list={a,b,c}         # list literal
--set map.key=val          # map entry
--set "annotations.kubernetes\.io/ingress=nginx"   # escape dots in keys
```

---

### Go Template Syntax

Helm templates use Go's `text/template` package augmented with Sprig functions and Helm-specific additions. Template directives are wrapped in `{{ }}`.

```yaml
# Built-in objects available in every template:
# .Values       — merged values tree
# .Release.Name — name given at helm install
# .Release.Namespace
# .Release.IsInstall / .Release.IsUpgrade
# .Chart.Name
# .Chart.Version
# .Chart.AppVersion
# .Files        — access non-template files in the chart
# .Capabilities — cluster version, API groups
```

A realistic deployment template:

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "myapp.fullname" . }}   # use helper, not inline concat
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "myapp.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "myapp.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "myapp.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          env:
            {{- range $key, $val := .Values.env }}
            - name: {{ $key }}
              value: {{ $val | quote }}
            {{- end }}
```

**Essential template functions:**

| Function | What it does | Example |
|---|---|---|
| `toYaml` | Serialize a value to YAML string | `toYaml .Values.resources` |
| `nindent N` | Indent every line N spaces + add leading newline | `toYaml .Values.x \| nindent 12` |
| `indent N` | Indent N spaces, no leading newline | `indent 4` |
| `quote` | Wrap in double quotes | `$val \| quote` |
| `default "x"` | Use fallback if empty/nil/zero | `\| default "latest"` |
| `required "msg"` | Hard-fail render if value unset | `\| required "must set host"` |
| `tpl` | Render a string as a template (enables dynamic templates in values) | `tpl .Values.config .` |
| `include` | Render a named template as a string (pipeable) | `include "myapp.labels" .` |
| `trim` / `trimAll` | Strip whitespace | `\| trim` |
| `b64enc` | Base64 encode | used in Secret templates |

**`{{-` vs `{{`:** The dash strips the whitespace (including newlines) before the action. `{{-` strips leading whitespace; `-}}` strips trailing. Incorrect dash placement is the most common cause of unexpected blank lines in rendered YAML, which can break strict parsers.

```yaml
# Without dash: blank line appears before the if block
{{ if .Values.ingress.enabled }}

# With dash: no blank line
{{- if .Values.ingress.enabled }}
```

---

### Conditionals and Loops

**Conditionals** gate entire resource blocks or individual fields:

```yaml
# Entire resource is conditional
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "myapp.fullname" . }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}   # "." here is .Values.ingress.annotations
  {{- end }}
spec:
  rules:
    - host: {{ .Values.ingress.host | required "ingress.host must be set when ingress.enabled=true" }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "myapp.fullname" . }}
                port:
                  number: {{ .Values.service.port }}
{{- end }}
```

**`with`** changes the scope of `.` to the given value and only executes the block if the value is non-empty:

```yaml
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 8 }}
{{- end }}
```

**Loops** iterate over lists and maps:

```yaml
# Iterating a list (tolerations)
{{- if .Values.tolerations }}
tolerations:
  {{- toYaml .Values.tolerations | nindent 8 }}
{{- end }}

# Iterating a map (environment variables)
env:
  {{- range $key, $val := .Values.env }}
  - name: {{ $key }}
    value: {{ $val | quote }}
  {{- end }}

# Iterating a list of objects
{{- range .Values.extraPorts }}
- name: {{ .name }}
  containerPort: {{ .port }}
{{- end }}
```

**`range` gotcha:** inside a `range` block, `.` is rebound to the current item. To access the top-level context (e.g., `.Release.Name`), save it before the loop: `{{- $root := . }}` then use `$root.Release.Name` inside.

---

### _helpers.tpl — Named Templates

Files prefixed with `_` are not rendered as manifests. They exist purely to define reusable named templates using `define`. Every production chart extracts common label sets and naming logic here.

```yaml
# templates/_helpers.tpl

{{/*
Expand the full name. Truncated to 63 chars (DNS label limit).
*/}}
{{- define "myapp.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels — applied to every resource.
*/}}
{{- define "myapp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — used in matchLabels (must be stable across upgrades).
*/}}
{{- define "myapp.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

Call named templates with `include` (preferred over `template` because the result is a string you can pipe):

```yaml
metadata:
  labels:
    {{- include "myapp.labels" . | nindent 4 }}
```

**`include` vs `template`:** `template` outputs directly and cannot be piped; `include` captures the output as a string so you can pipe it to `nindent`, `trim`, etc. Always use `include`.

**The `trunc 63` pattern:** Kubernetes DNS labels have a 63-character maximum. If `Release.Name` and `Chart.Name` together exceed this, the resource name becomes invalid. Truncating defensively in `fullname` prevents hard-to-debug install failures on long release names.

---

### Secrets in Templates

Secrets require base64 encoding. Never hardcode secret values in `values.yaml` committed to version control. Instead, pass them via `--set` at deploy time or via an external secrets operator.

```yaml
# templates/secret.yaml
{{- if .Values.secret.create }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "myapp.fullname" . }}-secret
  labels:
    {{- include "myapp.labels" . | nindent 4 }}
type: Opaque
data:
  db-password: {{ .Values.secret.dbPassword | b64enc | quote }}
  api-key: {{ .Values.secret.apiKey | required "secret.apiKey must be set" | b64enc | quote }}
{{- end }}
```

**Do not store base64-encoded secrets in `values.yaml`.** Base64 is encoding, not encryption. Anyone with access to the values file has the secret in plaintext. Use Helm Secrets (sops-based), Vault Agent, or External Secrets Operator in real environments.

---

### Rendering, Linting, and Dry-Run

These three commands are your development loop before touching a real cluster.

```bash
# Render templates to stdout — inspect the final YAML
helm template myrelease ./mychart

# Render with environment-specific overrides
helm template myrelease ./mychart \
  --values prod-values.yaml \
  --set image.tag=v2.1.0

# Render only one template file (useful for targeting a single resource)
helm template myrelease ./mychart -s templates/deployment.yaml

# Lint: check for syntax errors and chart conventions
helm lint ./mychart
helm lint ./mychart --values prod-values.yaml   # lint with real values

# Server-side dry-run: validate against the live cluster API
# (catches API version mismatches, schema errors, RBAC issues)
helm template myrelease ./mychart | kubectl apply --dry-run=server -f -

# Helm's own dry-run (client-side, less thorough)
helm install myrelease ./mychart --dry-run
```

| Command | Cluster required? | What it catches |
|---|---|---|
| `helm lint` | No | YAML syntax, missing required fields, chart conventions |
| `helm template` | No | Template rendering errors, wrong value types |
| `helm template \| kubectl apply --dry-run=server
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

**`helm create mychart`** scaffolds this entire structure with a working nginx example. Always start here rather than from scratch — the generated `_helpers.tpl` includes battle-tested naming and labeling patterns you should not skip.

**Hidden file behavior:** Helm ignores files beginning with `.` inside `templates/`. This is occasionally useful for keeping scratch files in the directory without accidentally rendering them.

---

### Chart.yaml

`Chart.yaml` is required and must be valid on every chart operation. Missing or malformed fields cause `helm lint` to fail immediately.

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
| `dependencies` | No | Requires `helm dependency update` before install |

**`version` vs `appVersion`:** bump `version` every time the chart changes (template logic, new fields, dependency updates), regardless of whether the app version changed. They evolve independently. Many teams automate `version` bumps in CI using `helm-docs` or a simple `sed` replacement.

**Library charts** (`type: library`) are a pattern for sharing named templates across multiple application charts without deploying any resources directly. They are included as a dependency and provide only `define` blocks.

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

**Merge behavior:** Helm performs a deep merge for maps. If your override file sets `image.tag`, the `image.repository` from `values.yaml` is preserved. However, if you `--set` a list, it **replaces the entire list** — it does not append. This is a frequent source of confusion when overriding `tolerations` or `imagePullSecrets`.

**`--set` syntax cheat sheet:**

```bash
--set key=value
--set a.b.c=value                               # nested keys
--set list={a,b,c}                              # list literal (replaces, not appends)
--set map.key=val                               # single map entry
--set "annotations.kubernetes\.io/ingress=nginx"  # escape dots in key names
--set-string image.tag=1.0                      # force string type (prevents 1.0 → 1)
--set-file config.data=./config.json            # read value from a file
```

**`--set-string` is often necessary** for values that look like numbers or booleans. `--set image.tag=1.0` will render as the float `1` in the template. `--set-string image.tag=1.0` preserves the string `"1.0"`. Always use `--set-string` for image tags that are version numbers.

**Documenting values:** production charts include a `values.schema.json` file alongside `values.yaml`. Helm validates user-supplied values against the schema before rendering, catching type mismatches and missing required fields at `helm install` time rather than at runtime.

---

### Go Template Syntax

Helm templates use Go's `text/template` package augmented with Sprig functions and Helm-specific additions. Template directives are wrapped in `{{ }}`.

```yaml
# Built-in objects available in every template:
# .Values            — merged values tree
# .Release.Name      — name given at helm install
# .Release.Namespace
# .Release.IsInstall / .Release.IsUpgrade
# .Chart.Name
# .Chart.Version
# .Chart.AppVersion
# .Files             — access non-template files in the chart
# .Capabilities      — cluster API versions and Kubernetes version
```

A realistic deployment template:

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "myapp.fullname" . }}        # use helper, not inline concat
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
| `toYaml` | Serialize a value to a YAML string | `toYaml .Values.resources` |
| `nindent N` | Indent every line N spaces + add leading newline | `toYaml .Values.x \| nindent 12` |
| `indent N` | Indent N spaces, no leading newline | `indent 4` |
| `quote` | Wrap in double quotes | `$val \| quote` |
| `default "x"` | Use fallback if empty/nil/zero | `\| default "latest"` |
| `required "msg"` | Hard-fail render if value unset | `\| required "must set host"` |
| `tpl` | Render a string as a template | `tpl .Values.config .` |
| `include` | Render a named template as a pipeable string | `include "myapp.labels" .` |
| `b64enc` | Base64 encode | Used in Secret templates |
| `trimSuffix "-"` | Remove trailing hyphen after truncation | `trunc 63 \| trimSuffix "-"` |
| `replace "+" "_"` | String replacement | Used in chart version labels |
| `upper` / `lower` | Case conversion | `\| lower` |
| `int` / `toString` | Type conversion | `\| int` |

**`{{-` vs `{{`:** The dash strips whitespace (including newlines) adjacent to the action. `{{-` strips leading whitespace; `-}}` strips trailing. Incorrect dash placement is the most common cause of unexpected blank lines in rendered YAML, which can break strict parsers and produce confusing `helm template` output.

```yaml
# Without dash: blank line appears above the label block
{{ include "myapp.labels" . | nindent 4 }}

# With dash: no blank line — the newline before {{ is consumed
{{- include "myapp.labels" . | nindent 4 }}
```

**`tpl` enables dynamic rendering** of strings stored in values — useful when you want a values file to contain template expressions. Be aware it increases rendering complexity and can hide errors; use it sparingly.

---

### Conditionals and Loops

**Conditionals** gate entire resource blocks or individual fields:

```yaml
# Entire resource is conditional — file renders to empty string when disabled
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

**`with`** changes the scope of `.` to the given value and only executes the block if the value is non-empty (non-nil, non-zero, non-empty string, non-empty map/list):

```yaml
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 8 }}
{{- end }}
```

**`if` vs `with`:** use `with` when you both need to test for existence and use the value. Use `if` when you need to test a boolean flag or a complex condition without rebinding `.`.

**Loops** iterate over lists and maps:

```yaml
# Iterating a map to produce env vars
env:
  {{- range $key, $val := .Values.env }}
  - name: {{ $key }}
    value: {{ $val | quote }}
  {{- end }}

# Iterating a list of objects defined in values
# values.yaml: extraPorts: [{name: metrics, port: 9090}]
{{- range .Values.extraPorts }}
- name: {{ .name }}
  containerPort: {{ .port }}
{{- end }}

# Safe pattern for a list that may be absent
{{- if .Values.tolerations }}
tolerations:
  {{- toYaml .Values.tolerations | nindent 8 }}
{{- end }}
```

**`range` gotcha:** inside a `range` block, `.` is rebound to the current item. To access the top-level context (e.g., `.Release.Name`), capture it before the loop:

```yaml
{{- $root := . }}
{{- range .Values.extraPorts }}
- name: {{ $root.Release.Name }}-{{ .name }}
  containerPort: {{ .port }}
{{- end }}
```

**`else` and `else if`** work as expected and are valuable for multi-environment branching:

```yaml
{{- if eq .Values.service.type "LoadBalancer" }}
# LoadBalancer-specific annotations
{{- else if eq .Values.service.type "NodePort" }}
# NodePort-specific config
{{- else }}
# Default ClusterIP config
{{- end }}
```

---

### _helpers.tpl — Named Templates

Files prefixed with `_` are not rendered as manifests. They exist purely to define reusable named templates using `define`. Every production chart extracts common label sets and naming logic here to avoid repetition and ensure consistency across all resources.

```yaml
# templates/_helpers.tpl

{{/*
Expand the full name. Truncated to 63 chars (DNS label limit).
*/}}
{{- define "myapp.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels — applied to every resource for observability and selection.
*/}}
{{- define "myapp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — used in matchLabels and must be STABLE across upgrades.
Never add mutable fields like chart version here; changing them breaks upgrades.
*/}}
{{- define "myapp.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Image string helper — centralizes the image reference so it is never duplicated.
*/}}
{{- define "myapp.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end }}
```

Call named templates with `include` (preferred over `template` because the result is a string you can pipe):

```yaml
metadata:
  labels:
    {{- include "myapp.labels" . | nindent 4 }}
```

**`include` vs `template`:** `template` outputs directly to the rendered stream and cannot be piped to functions like `nindent`. `include` captures the output as a string, enabling pipeline composition. **Always use `include`.**

**The `trunc 63` pattern:** Kubernetes DNS labels have a 63-character maximum. If `.Release.Name` and `.Chart.Name` together exceed this, the resource name becomes invalid. Truncating defensively in the `fullname` helper prevents hard-to-debug install failures on long release names in CI environments where release names are auto-generated.

**Selector labels must not change after initial install.** Kubernetes rejects upgrades where `matchLabels` changes on a Deployment. Never include `helm.sh/chart` (which contains the version) in `selectorLabels`. This is a common mistake in hand-rolled charts that causes upgrade failures in production.

---

### Secrets in Templates

Secrets require base64 encoding. Never hardcode secret values in `values.yaml` that is committed to version control.

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
  # b64enc encodes the plaintext value; quote prevents YAML parsing issues
  db-password: {{ .Values.secret.dbPassword | b64enc | quote }}
  api-key: {{ .Values.secret.apiKey | required "secret.apiKey must be set" | b64enc | quote }}
{{- end }}
```

**Do not store base64-encoded secrets in `values.yaml`.** Base64 is encoding, not encryption. Anyone with read access to the values file has the secret in plaintext. The correct production patterns are:

| Approach | Tool | How it works |
|---|---|---|
| Encrypted values files | Helm Secrets + SOPS | Encrypts values.yaml at rest; decrypts at deploy time |
| Injected at deploy time | `--set` in CI pipeline | Secret injected from CI secret store (Vault, GitHub Secrets) |
| External operator | External Secrets Operator | ESO syncs secrets from Vault/AWS SM into Kubernetes Secrets |
| Sidecar injection | Vault Agent Injector | Vault agent writes secrets to a shared volume at pod start |

**`lookup` function:** Helm 3 provides a `lookup` function that queries the live cluster during rendering. This enables patterns like "only create the secret if it doesn't already exist," which prevents wiping secrets on upgrade:

```yaml
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "myapp.fullname" .) }}
{{- if not $existing }}
# create secret only on first install
{{- end }}
```

---

### Rendering, Linting, and Dry-Run

These commands form your development loop before touching a real cluster. Run them in order: lint first, then render, then server-side dry-run.

```bash
# Render templates to stdout — inspect the final YAML Helm would apply
helm template myrelease ./mychart

# Render with environment-specific overrides
helm template myrelease ./mychart \
  --values prod-values.yaml \
  --set image.tag=v2.1.0

# Render only one template file (useful for debugging a single resource)
helm template myrelease ./mychart -s templates/deployment.yaml

# Lint: check for syntax errors and chart conventions
helm lint ./mychart
helm lint ./mychart --values prod-values.yaml   # lint with realistic values to catch required fields

# Server-side dry-run: validate against the live cluster API
# This catches API version mismatches, schema validation errors, and RBAC issues
helm template myrelease ./mychart | kubectl apply --dry-run=server -f -

# Helm's own --dry-run flag (client-side; weaker than server-side but no cluster needed)
helm install myrelease ./mychart --dry-run --debug
```

| Command | Cluster required? | What it catches |
|---|---|---|
| `helm lint` | No | YAML syntax, missing required chart fields, convention violations |
| `helm template` | No | Template rendering errors, wrong value types, missing values |
| `helm install --dry-run` | Yes (API call) | Basic API validation, does not fully validate resource schemas |
| `helm template \| kubectl apply --dry-run=server` | Yes | Full API server schema validation, deprecated API versions, RBAC |

**`--debug` with `helm template`** prints additional context including computed values and the order in which templates are rendered — essential when you cannot figure out why a value is resolving incorrectly.

**`helm get manifest <release>`** retrieves the last-applied manifests for a live release, letting you diff what is in the cluster against what a new chart version would produce.

---

### Dependencies (Subcharts)

Charts can declare dependencies on other charts, which are downloaded into `charts/` and rendered as part of the same release.

```bash
# After editing Chart.yaml dependencies section:
helm dependency update ./mychart   # downloads deps into charts/, writes Chart.lock
helm dependency build ./mychart    # uses Chart.lock (reproducible; for CI)
```

Values for a subchart are namespaced under the dependency name in `values.yaml`:

```yaml
# values.yaml — configuring the postgresql subchart
postgresql:
  enabled: true
  auth:
    postgresPassword: ""      # injected at deploy time via --set
    database: myapp
  primary:
    persistence:
      size: 10Gi
```

**`condition` and `tags`** in `Chart.yaml` control whether a dependency is loaded at all. The `condition` field (e.g., `postgresql.enabled`) maps to a value path — if that value is `false`, the entire subchart is skipped. This is the standard pattern for optional infrastructure dependencies.

**Global values** are a special top-level key `global` in `values.yaml` that is passed down into every subchart without namespacing — useful for shared settings like image registry, environment name, or pull secrets:

```yaml
global:
  imageRegistry: registry.example.com
  imagePullSecrets:
    - name: regcred
```

---

## Examples

### Example 1: Multi-Environment Deployment with Per-Environment Values Files

**Setup:** A web application chart deployed to three environments using separate values files and a single `helm upgrade --install` command pattern suitable for a CI pipeline.

```bash
# Directory layout
myapp-chart/
├── Chart.yaml
├── values.yaml          # shared defaults
├── values-dev.yaml      # dev overrides
├── values-staging.yaml  # staging overrides
└── values-prod.yaml     # prod overrides
```

```yaml
# values.yaml (defaults)
replicaCount: 1
image:
  repository: registry.example.com/myapp
  tag: "latest"
  pullPolicy: Always
resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 256Mi
ingress:
  enabled: false
  host: ""
autoscaling:
  enabled: false
```

```yaml
# values-prod.yaml (prod overrides — layered on top of values.yaml)
replicaCount: 3
image:
  pullPolicy: IfNotPresent       # only pull on digest change in prod
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 2Gi
ingress:
  enabled: true
  host: myapp.example.com
  annotations:
    kubernetes.io/ingress-class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
```

```bash
# CI pipeline deploy command — idempotent; installs on first run, upgrades on subsequent runs
helm upgrade --install myapp ./myapp-chart \
  --namespace production \
  --create-namespace \
  --values values-prod.yaml \
  --set image.tag=${CI_COMMIT_SHA} \   # inject the exact image digest from CI
  --atomic \                            # roll back automatically if upgrade fails
  --timeout 5m \
  --wait                                # block until all pods are ready

# Verify the deployed release
helm list -n production
helm get values myapp -n production     # confirm effective values
kubectl rollout status deployment/myapp -n production
```

---

### Example 2: Chart with a Conditional Subchart and Secret Injection

**Setup:** A Django application chart with an optional PostgreSQL subchart, where the database password is injected from a CI secret store.

```yaml
# Chart.yaml
apiVersion: v2
name: django-app
version: 1.3.0
appVersion: "3.2.0"
dependencies:
  - name: postgresql
    version: "12.x.x"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.enabled    # skipped entirely when false (external DB case)
```

```yaml
# values.yaml
django:
  secretKey: ""          # injected via --set at deploy time — never committed
  dbHost: ""             # used when postgresql.enabled=false (external DB)
  dbName: myapp

postgresql:
  enabled: true           # set to false when pointing at an external RDS instance
  auth:
    database: myapp
    postgresPassword: ""  # injected via --set
```

```yaml
# templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "django-app.fullname" . }}-django
  labels:
    {{- include "django-app.labels" . | nindent 4 }}
type: Opaque
data:
  secret-key: {{ .Values.django.secretKey | required "django.secretKey must be set" | b64enc | quote }}
  # Compute the DB host: use the subchart service name if postgresql is enabled,
  # otherwise use the externally supplied host value.
  {{- if .Values.postgresql.enabled }}
  db-host: {{ printf "%s-postgresql" (include "django-app.fullname" .) | b64enc | quote }}
  {{- else }}
  db-host: {{ .Values.django.dbHost | required "django.dbHost required when postgresql.enabled=false" | b64enc | quote }}
  {{- end }}
  db-name: {{ .Values.django.dbName | b64enc | quote }}
```

```bash
# Install with subchart enabled, secrets injected from environment variables
helm dependency update ./django-app

helm upgrade --install django-prod ./django-app \
  --namespace production \
  --set django.secretKey="${DJANGO_SECRET_KEY}" \
  --set postgresql.auth.postgresPassword="${DB_PASSWORD}" \
  --atomic --wait

# Verify secret was created with correct keys (values will be base64 encoded)
kubectl get secret django-prod-django-django -n production -o jsonpath='{.data}' | python3 -m json.tool
```

---

### Example 3: Debugging a Broken Template with helm template and --debug

**Scenario:** A chart is failing with a cryptic error during `helm install`. This walkthrough shows the systematic debugging process.

```bash
# Step 1: Attempt install — observe the error
helm install myapp ./mychart --values prod-values.yaml
# Error: template: mychart/templates/ingress.yaml:14:22:
#   executing "mychart/templates/ingress.yaml" at <.Values.ingress.host>:
#   error calling required: ingress.host must be set when ingress.enabled=true

# Step 2: Render to stdout to see exactly what Helm is computing
helm template myapp ./mychart --values prod-values.yaml --debug 2>&1 | head -60
# The --debug flag prints the computed values at the top — inspect them first

# Step 3: Render a single template to isolate the problem
helm template myapp ./mychart \
  --values prod-values.yaml \
  -s templates/ingress.yaml
# This renders only the ingress template — output shows exactly where rendering fails

# Step 4: Add the missing value and re-render to confirm fix
helm template myapp ./mychart \
  --values prod-values.yaml \
  --set ingress.host=myapp.example.com \
  -s templates/ingress.yaml
# Confirm the rendered Ingress YAML looks correct

# Step 5: Server-side dry-run to validate against cluster APIs
helm template myapp ./mychart \
  --values prod-values.yaml \
  --set ingress.host=myapp.example.com \
  | kubectl apply --dry-run=server -f -
# Catches: deprecated networking.k8s.io/v1beta1, schema errors, missing CRDs

# Step 6: Actual install now succeeds
helm upgrade --install myapp ./mychart \
  --values prod-values.yaml \
  --set ingress.host=myapp.example.com \
  --wait
```

---

### Example 4: Writing a Reusable Named Template for ConfigMap Data

**Setup:** Multiple ConfigMaps across the chart share the same base configuration. Extract the data-generation logic into `_helpers.tpl` to avoid duplication.

```yaml
# templates/_helpers.tpl (additions)

{{/*
Generate standard application config data.
Takes a dict with keys: env, dbName, logLevel.
Usage: include "myapp.appConfig" (dict "Values" .Values "Release" .Release)
*/}}
{{- define "myapp.appConfigData" -}}
APP_ENV: {{ .Values.env.APP_ENV | quote }}
DB_NAME: {{ .Values.django.dbName | quote }}
LOG_LEVEL: {{ .Values.env.LOG_LEVEL | default "info" | quote }}
RELEASE_NAME: {{ .Release.Name | quote }}
{{- end }}
```

```yaml
# templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "myapp.fullname" . }}-config
  labels:
    {{- include "myapp.labels" . | nindent 4 }}
data:
  {{- include "myapp.appConfigData" . | nindent 2 }}
  # Additional map-level entries from values — merged in alongside the helper output
  {{- with .Values.extraConfig }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
```

```bash
# Render to verify the ConfigMap data is correct before applying
helm template myapp ./mychart -s templates/configmap.yaml

# Expected output:
# apiVersion: v1
# kind: ConfigMap
# metadata:
#   name: myapp-myapp-config
# data:
#   APP_ENV: "production"
#   DB_NAME: "myapp"
#   LOG_LEVEL: "info"
#   RELEASE_NAME: "myapp"
```

---

## Exercises

### Exercise 1: Add a Horizontal Pod Autoscaler with Conditional Rendering

Create a new template file `templates/hpa.yaml` in an existing chart (use `helm create myapp` to scaffold one). The HPA should:

- Only render when `.Values.autoscaling.enabled` is `true`
- Reference the Deployment created by the chart using the `fullname` helper
- Read `minReplicas`, `maxReplicas`, and `targetCPUUtilizationPercentage` from `.Values.autoscaling`
- Add a `required` guard on `targetCPUUtilizationPercentage` with a meaningful error message
- When `autoscaling.enabled` is `true`, set `replicaCount` on the Deployment to `null` (hint: use `{{- if not .Values.autoscaling.enabled }}` around the `replicas` field — a Deployment managed by an HPA should not have `replicas` set statically)

Verify with `helm template myapp ./myapp --set autoscaling.enabled=true --set autoscaling.minReplicas=2 --set autoscaling.maxReplicas=5 --set autoscaling.targetCPUUtilizationPercentage=60` and confirm the rendered HPA is present and the Deployment has no `replicas` field.

---

### Exercise 2: Implement a Multi-Source Environment Variable Template

Your chart currently supports only a flat `env` map for environment variables. Extend it to support three sources simultaneously, all rendering into the same `env:` list in the Deployment:

1. **Static values** from `.Values.env` (existing map, key: value)
2. **ConfigMap references** from `.Values.envFromConfigMap` (list of `{name, key, configMapName}`)
3. **Secret references** from `.Values.envFromSecret` (list of `{name, key, secretName}`)

Write the template logic using `range` and conditionals. Add sample values for all three sources to `values.yaml`. Render the Deployment template and verify all three `env` entry types appear correctly: plain `value:`, `valueFrom.configMapKeyRef:`, and `valueFrom.secretKeyRef:`.

---

### Exercise 3: Trace a Values Merge Conflict

Given this base `values.yaml`:

```yaml
tolerations:
  - key: dedicated
    operator: Equal
    value: backend
    effect: NoSchedule
resources:
  requests:
    cpu: 100m
    memory: 128Mi
```

And this override file `override.yaml`:

```yaml
resources:
  limits:
    cpu: 500m
    memory: 512Mi
```

Without running any commands, predict the effective `tolerations` and `resources` values after `helm template myapp ./mychart -f override.yaml`. Then run `helm template myapp ./mychart -f override.yaml --debug 2>&1 | grep -A 30 "^USER-SUPPLIED VALUES"` to see the computed values and verify your prediction.

Next, deliberately use `--set` to wipe the tolerations list: `--set tolerations=[]`. Confirm that toleration is gone in the rendered Deployment. Explain why `--set tolerations=[]` removes all tolerations while `-f override.yaml` (which does not mention `tolerations`) preserves them.

---

### Exercise 4: Extract and Consume a Library Chart Named Template

This exercise simulates the real-world pattern of sharing templates across multiple application charts.

1. Create a library chart: `helm create common-lib` and change `type` to `library` in `Chart.yaml`. Delete all files in `templates/` except `_helpers.tpl`.
2. In `common-lib/templates/_helpers.tpl`, define a named template `common-lib.serviceAccountName` that renders either a custom service account name from `.Values.serviceAccount.name` or the string `"default"` if no name is supplied.
3. Create a second chart `helm create consumer-app`. Add `common-lib` as a local file dependency in `consumer-app/Chart.yaml` using `repository: file://../common-lib`.
4. Run `helm dependency update ./consumer-app` to link the library chart.
5. In `consumer-app/templates/deployment.yaml`, replace any inline service account name logic with `{{ include "common-lib.serviceAccountName" . }}`.
6. Render the consumer chart with and without `--set serviceAccount.name=mysa` and verify the correct name appears in the rendered Deployment's `spec.serviceAccountName` field.

---

### Quick Checks

7. Extract the chart name from a Chart.yaml stub. Run: `printf 'apiVersion: v2\nname: mywebapp\nversion: 1.0.0\n' | awk '/^name:/{print $2}'`

```expected_output
mywebapp
```

8. Extract the chart API version. Run: `printf 'apiVersion: v2\nname: mywebapp\nversion: 1.0.0\n' | awk '/^apiVersion:/{print $2}'`

```expected_output
v2
```

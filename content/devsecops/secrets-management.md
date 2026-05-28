---
title: Secrets Management
module: devsecops
duration_min: 25
difficulty: intermediate
tags: [devsecops, secrets, vault, aws-secrets-manager, kubernetes, external-secrets]
exercises: 4
---

## Overview

A secret hardcoded in a Dockerfile, `.env` file, or CI pipeline YAML is a breach waiting to happen — and "private" repositories are not a mitigation. Secrets management is the practice of ensuring secrets are stored encrypted at rest, transmitted securely, access is audited, and secrets can be rotated without redeploying code. The goal is to make it impossible for a developer to accidentally commit a credential, and impossible for an attacker who gains filesystem access to harvest usable long-lived credentials.

The guiding principles are: **least privilege** (each service reads only its own secrets), **short lifetimes** (dynamic credentials expire automatically), **auditability** (every read is logged with an identity), and **separation of concerns** (the application never owns the secret store). These principles push you away from static passwords shared across services and toward just-in-time credential issuance tied to verified workload identity.

Secrets management sits at the intersection of security and platform engineering in the DevOps toolchain. It integrates with your CI/CD system (injecting secrets into pipelines), your orchestration layer (Kubernetes mounting secrets into pods), your cloud IAM (IRSA, Workload Identity, IAM roles), and your application code (SDKs for reading secrets at startup or on demand). This lesson covers the two most common backends — HashiCorp Vault and AWS Secrets Manager — and the External Secrets Operator for bridging them into Kubernetes clusters.

---

## Concepts

### What Counts as a Secret

Not everything sensitive is a secret in the technical sense. Distinguishing the categories helps you apply the right controls.

| Category | Examples | Typical Backend |
|---|---|---|
| **Static credentials** | DB passwords, API keys, webhook tokens | Vault KV, Secrets Manager |
| **Dynamic credentials** | Short-lived DB users, temporary AWS creds | Vault database/AWS engine |
| **PKI / TLS material** | Private keys, CA certificates | Vault PKI engine, ACM |
| **Encryption keys** | AES keys, HMAC secrets | AWS KMS, Vault Transit |
| **Service tokens** | GitHub App tokens, Slack bot tokens | Vault KV, Secrets Manager |

**Hard rules — never store secrets in:**
- Source code or git history (even in "private" repos — assume history is permanent)
- Docker image layers (secrets baked into `RUN` commands survive even `docker history --no-trunc`)
- `ENV` instructions in Dockerfiles
- CI/CD pipeline YAML in plaintext (use the platform's native secret store)
- Kubernetes `ConfigMap` objects (use `Secret` objects, and enable envelope encryption at rest)
- Log output — even partial values enable brute-force attacks

**The git history problem:** Running `git filter-repo` or BFG Cleaner to remove a secret from history does not protect you if the repo was ever cloned or if GitHub/GitLab cached the commit. Treat any leaked credential as compromised and rotate it immediately, regardless of whether you cleaned the history.

---

### HashiCorp Vault Architecture

Understanding Vault's internals prevents misconfiguration surprises in production.

#### Core Building Blocks

| Concept | Description |
|---|---|
| **Secrets Engine** | Plugin that stores or generates secrets. Each is mounted at a path (`secret/`, `database/`, `pki/`). |
| **Auth Method** | How a client proves identity to get a token. Options: `token`, `AppRole`, `kubernetes`, `aws`, `oidc`, `ldap`. |
| **Policy** | HCL document defining path-based capabilities (`read`, `create`, `update`, `delete`, `list`). Tokens carry policies. |
| **Lease** | TTL attached to dynamic secrets. Client must renew before expiry or Vault revokes the credential automatically. |
| **Token** | The result of authentication. Every Vault operation uses a token. Tokens are themselves leased (or root, in dev mode). |

The trust chain for a Kubernetes workload is: **pod service account JWT → Vault Kubernetes auth → Vault token with policies → read secret path**. No human credential is involved at runtime.

#### KV Secrets Engine (Static Secrets)

KV v2 is the workhorse for static secrets. It adds versioning, soft-delete, and metadata over v1.

```bash
# Start Vault in dev mode — in-memory, auto-unsealed, root token = "root"
# Never use dev mode in production
vault server -dev &

export VAULT_ADDR='http://127.0.0.1:8200'
export VAULT_TOKEN='root'

# Enable KV v2 at the path "secret/"
vault secrets enable -path=secret kv-v2

# Write a secret (all fields in one operation)
vault kv put secret/myapp/database \
  host=db.internal \
  port=5432 \
  username=myapp \
  password=supersecret

# Read the whole secret
vault kv get secret/myapp/database

# Read a single field — useful in shell scripts
vault kv get -field=password secret/myapp/database

# Read as JSON and extract with jq
vault kv get -format=json secret/myapp/database | jq '.data.data'

# Update — this creates version 2, does NOT delete version 1
vault kv put secret/myapp/database password=rotated-password

# Roll back to version 1 (useful for rotation testing)
vault kv get -version=1 secret/myapp/database

# See full version history and metadata
vault kv metadata get secret/myapp/database

# Soft-delete version 2 (recoverable)
vault kv delete secret/myapp/database

# Hard-destroy version 2 (irrecoverable)
vault kv destroy -versions=2 secret/myapp/database
```

**KV v1 vs v2:** KV v2 has versioning and a separate metadata API. The path structure changes: reads go to `secret/data/<path>` internally, which matters when writing policies. A policy for v2 must include `secret/data/myapp/*`, not just `secret/myapp/*`. This is the most common Vault KV policy mistake.

#### Dynamic Database Credentials

Dynamic credentials are the killer feature that separates Vault from a simple encrypted store. Each application request gets a unique, short-lived database user. When the lease expires, Vault executes a `DROP ROLE` statement automatically.

```bash
# Enable the database secrets engine
vault secrets enable database

# Register a PostgreSQL connection — Vault uses a privileged account
# to create/revoke short-lived roles
vault write database/config/myapp-db \
  plugin_name=postgresql-database-plugin \
  connection_url="postgresql://{{username}}:{{password}}@db.internal:5432/myapp?sslmode=require" \
  allowed_roles="myapp-readonly,myapp-readwrite" \
  username="vault-superuser" \
  password="vault-superuser-password"

# Rotate the root credentials immediately after setup
# Vault takes ownership — you can no longer log in with vault-superuser directly
vault write -force database/config/myapp-db/rotate-root

# Define a role — the SQL template runs at credential creation time
vault write database/roles/myapp-readonly \
  db_name=myapp-db \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
    GRANT CONNECT ON DATABASE myapp TO \"{{name}}\";
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";
  " \
  revocation_statements="DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# Request credentials — each call returns a unique username/password
vault read database/creds/myapp-readonly
# Key                Value
# lease_id           database/creds/myapp-readonly/abc123xyz
# lease_duration     1h
# username           v-token-myapp-readonly-abc123
# password           A1b2-C3d4-E5f6...

# Renew a lease before expiry
vault lease renew database/creds/myapp-readonly/abc123xyz

# Revoke a specific lease immediately (e.g., after a suspected breach)
vault lease revoke database/creds/myapp-readonly/abc123xyz

# Revoke ALL credentials for a role at once — incident response
vault lease revoke -prefix database/creds/myapp-readonly/
```

**Rotate-root warning:** After `rotate-root`, Vault is the only entity that knows the privileged account password. If you lose Vault's storage backend (and your snapshot), you will need manual database recovery. Always back up Vault storage before rotating root credentials on critical databases.

#### Vault Policies

Policies are Vault's authorization layer. Every token has one or more policies attached; if no policy grants access to a path, the request is denied.

```hcl
# myapp-policy.hcl
# Allow reading any secret under myapp/ in KV v2
# Note: KV v2 requires "secret/data/" prefix for read operations
path "secret/data/myapp/*" {
  capabilities = ["read", "list"]
}

# Allow reading metadata (for version history)
path "secret/metadata/myapp/*" {
  capabilities = ["read", "list"]
}

# Allow requesting dynamic DB credentials
path "database/creds/myapp-readonly" {
  capabilities = ["read"]
}

# Allow renewing its own leases
path "sys/leases/renew" {
  capabilities = ["update"]
}

# Explicitly deny access to other apps' secrets
path "secret/data/otherapp/*" {
  capabilities = ["deny"]
}
```

```bash
# Apply the policy
vault policy write myapp-policy myapp-policy.hcl

# Inspect the policy
vault policy read myapp-policy
```

#### Kubernetes Auth Method

AppRole works for VMs; for Kubernetes, the Kubernetes auth method is the correct choice. It validates the pod's service account JWT against the cluster's API server.

```bash
# Enable Kubernetes auth
vault auth enable kubernetes

# Configure Vault to validate JWTs against your cluster
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc.cluster.local:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Bind a Kubernetes service account to a Vault policy
vault write auth/kubernetes/role/myapp \
  bound_service_account_names=myapp-sa \
  bound_service_account_namespaces=production \
  policies=myapp-policy \
  ttl=1h
```

```python
# Application code: authenticate using the pod's projected service account token
import hvac
import os

def build_vault_client() -> hvac.Client:
    client = hvac.Client(url=os.environ['VAULT_ADDR'])

    # Kubernetes injects this token — it's rotated automatically by the kubelet
    with open('/var/run/secrets/kubernetes.io/serviceaccount/token') as f:
        jwt = f.read()

    client.auth.kubernetes.login(role='myapp', jwt=jwt)
    # client is now authenticated; client.token holds the Vault token
    return client

def get_db_password(client: hvac.Client) -> str:
    response = client.secrets.kv.v2.read_secret_version(
        path='myapp/database',   # relative to mount point
        mount_point='secret',
    )
    return response['data']['data']['password']
```

---

### AWS Secrets Manager

AWS Secrets Manager is the managed alternative when you're running in AWS and don't want to operate Vault. It integrates natively with RDS (automatic rotation), IAM (resource policies), CloudTrail (audit), and Lambda (rotation functions).

#### Core Operations

```bash
# Create a secret with a JSON value (recommended — parse fields independently)
aws secretsmanager create-secret \
  --name prod/myapp/database \
  --description "Production RDS credentials for myapp" \
  --kms-key-id alias/myapp-secrets \
  --secret-string '{"host":"db.internal","port":5432,"username":"myapp","password":"supersecret"}'

# Read the secret value
aws secretsmanager get-secret-value \
  --secret-id prod/myapp/database

# Extract only the secret string and parse a single field
aws secretsmanager get-secret-value \
  --secret-id prod/myapp/database \
  --query 'SecretString' \
  --output text | jq '.password'

# Update the secret value (creates a new version, keeps AWSPREVIOUS label)
aws secretsmanager put-secret-value \
  --secret-id prod/myapp/database \
  --secret-string '{"host":"db.internal","port":5432,"username":"myapp","password":"newpassword"}'

# List version IDs and their staging labels
aws secretsmanager list-secret-version-ids \
  --secret-id prod/myapp/database

# Enable automatic 30-day rotation using an AWS-managed Lambda for RDS PostgreSQL
aws secretsmanager rotate-secret \
  --secret-id prod/myapp/database \
  --rotation-lambda-arn arn:aws:lambda:us-east-1:123456789012:function:SecretsManagerRDSPostgreSQLRotationSingleUser \
  --rotation-rules AutomaticallyAfterDays=30

# Immediately trigger a rotation (useful for testing or after a suspected breach)
aws secretsmanager rotate-secret \
  --secret-id prod/myapp/database

# Tag a secret (enables attribute-based access control via IAM conditions)
aws secretsmanager tag-resource \
  --secret-id prod/myapp/database \
  --tags Key=Environment,Value=production Key=Team,Value=platform
```

**Version labels:** Secrets Manager maintains `AWSCURRENT` (the live version) and `AWSPREVIOUS` (the prior version) labels automatically. During rotation, a new version is staged as `AWSPENDING`, then promoted to `AWSCURRENT` after the rotation Lambda verifies the new credential works. Applications reading `AWSCURRENT` see the new credential seamlessly — no redeployment required.

#### IAM Access Control

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowMyappRoleToReadDbSecret",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/myapp-ecs-task-role"
      },
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/myapp/database-*"
    },
    {
      "Sid": "DenyAllOtherPrincipals",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "secretsmanager:*",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalArn": [
            "arn:aws:iam::123456789012:role/myapp-ecs-task-role",
            "arn:aws:iam::123456789012:role/platform-admin-role"
          ]
        }
      }
    }
  ]
}
```

**Resource policy vs identity policy:** You can grant access via an IAM identity policy on the role (common) or a resource policy on the secret (useful for cross-account access). For same-account access, identity policies are simpler. For cross-account access, you need both: a resource policy on the secret granting the foreign account, and an identity policy in the foreign account allowing the call.

#### Application Access Pattern

```python
import boto3
import json
import os
import logging
from functools import lru_cache

logger = logging.getLogger(__name__)

@lru_cache(maxsize=None)
def _get_secrets_client():
    # boto3 reuses the underlying HTTP connection — don't recreate the client per call
    return boto3.client('secretsmanager', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

def get_secret(secret_id: str) -> dict:
    """Fetch and parse a JSON secret from Secrets Manager.

    Raises on any API error — callers should handle exceptions at startup
    and fail fast rather than running with missing credentials.
    """
    client = _get_secrets_client()
    try:
        response = client.get_secret_value(SecretId=secret_id)
    except client.exceptions.ResourceNotFoundException:
        logger.error("Secret %s not found", secret_id)
        raise
    except client.exceptions.AccessDeniedException:
        logger.error("IAM role lacks permission to read %s", secret_id)
        raise

    # SecretString is present for text secrets; SecretBinary for binary
    raw = response.get('SecretString') or response.get('SecretBinary').decode('utf-8')
    return json.loads(raw)

# At application startup — fail fast if secrets are unavailable
db_creds = get_secret('prod/myapp/database')
DB_HOST     = db_creds['host']
DB_PASSWORD = db_creds['password']
```

**Caching caveat:** The `lru_cache` on the client is safe, but do not cache the secret value itself for longer than your rotation period. Applications that cache secrets in memory for the lifetime of the process will use stale credentials after rotation. Either re-fetch on connection errors, or use a TTL-based cache shorter than the rotation interval.

---

### External Secrets Operator (Kubernetes Bridge)

External Secrets Operator (ESO) runs as a controller in your Kubernetes cluster. It reads from an external backend (Vault, Secrets Manager, GCP Secret Manager, etc.) and writes native Kubernetes `Secret` objects that pods can consume normally. This decouples the secrets backend from the application — pods don't need Vault SDKs or AWS credentials; they just read a mounted `Secret`.

#### Architecture

```
External Backend          Cluster
─────────────────         ──────────────────────────────
Vault / Secrets Manager ← SecretStore (credentials + endpoint)
                          ExternalSecret (what to sync, how often)
                               ↓ (ESO controller reconciles)
                          Kubernetes Secret (native object)
                               ↓
                          Pod (mounts secret as env var or file)
```

#### SecretStore Configuration

A `SecretStore` is namespaced; a `ClusterSecretStore` applies cluster-wide. Always prefer `ClusterSecretStore` for platform-managed backends to avoid duplicating credentials across every namespace.

```yaml
# cluster-secret-store-aws.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        # Use IRSA — the ESO pod's service account carries an IAM role annotation
        # No static credentials stored in the cluster
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
```

```yaml
# cluster-secret-store-vault.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.internal:8200"
      path: "secret"          # KV mount path
      version: "v2"
      caBundle: "LS0tLS1CRUdJTi..."   # base64-encoded CA cert
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets-role"
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
```

#### ExternalSecret Resource

```yaml
# myapp-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-db-credentials
  namespace: production
spec:
  # How often ESO re-syncs the secret from the backend
  refreshInterval: 5m

  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore

  # The Kubernetes Secret that ESO will create or update
  target:
    name: myapp-db-credentials      # name of the resulting K8s Secret
    creationPolicy: Owner           # ESO owns the Secret; deletes it if ExternalSecret is deleted
    template:
      type: Opaque
      # Optionally transform the data before writing to the K8s Secret
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/myapp"

  # Extract specific keys from the remote secret
  data:
    - secretKey: username           # key in the resulting K8s Secret
      remoteRef:
        key: prod/myapp/database    # path in Secrets Manager
        property: username          # JSON field within the secret value

    - secretKey: password
      remoteRef:
        key: prod/myapp/database
        property: password

    - secretKey: host
      remoteRef:
        key: prod/myapp/database
        property: host

    - secretKey: port
      remoteRef:
        key: prod/myapp/database
        property: port
```

```bash
# Apply the ExternalSecret and verify sync status
kubectl apply -f myapp-external-secret.yaml

# Check sync status — Ready condition means the K8s Secret was written
kubectl get externalsecret myapp-db-credentials -n production

# NAME                    STORE                  REFRESH INTERVAL   STATUS
# myapp-db-credentials    aws-secrets-manager    5m                 SecretSynced

# Verify the resulting Kubernetes Secret was created
kubectl get secret myapp-db-credentials -n production -o jsonpath='{.data.password}' | base64 -d
```

**Refresh interval gotcha:** ESO will overwrite the Kubernetes `Secret` on every refresh cycle. If anything manually edits the `Secret` object in the cluster, those changes will be silently lost on the next sync. Treat ESO-managed secrets as read-only in the cluster.

#### Consuming the Secret in a Pod

```yaml
# myapp-deployment.yaml (excerpt)
spec:
  serviceAccountName: myapp-sa
  containers:
    - name: myapp
      image: myapp:latest
      env:
        # Inject individual fields as environment variables
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: myapp-db-credentials   # the K8s Secret ESO created
              key: password
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: myapp-db-credentials
              key: DATABASE_URL
      # Alternatively, mount the whole secret as a directory of files
      volumeMounts:
        - name: db-credentials
          mountPath: /run/secrets/db
          readOnly: true
  volumes:
    - name: db-credentials
      secret:
        secretName: myapp-db-credentials
```

**Environment variables vs file mounts:** Environment variables are convenient but appear in `/proc/<pid>/environ`, crash dumps, and are inherited by child processes. For highly sensitive values (private keys, tokens), prefer file mounts under `/run/secrets/` — they're readable only by the process that opens them.

---

### Secret Rotation Patterns

Rotation is where many teams cut corners and later pay the price. There are three distinct patterns:

| Pattern | How It Works | Best For |
|---|---|---|
| **Break-glass rotation** | Manual rotation triggered by an incident | One-off breach response |
| **Scheduled static rotation** | Cron job or Secrets Manager schedule updates the value | API keys, service tokens |
| **Dynamic / just-in-time** | Each client request generates a new short-lived credential | Database passwords, cloud creds |

**Zero-downtime rotation requirement:** For static secrets, the rotation process must support a transition window where both old and new credentials are valid. The standard pattern is:
1. Write new credential to the store (old remains active)
2. Deploy application version that reads the new credential
3. Verify new credential works in production
4. Revoke old credential

Skipping step 1 (writing new → deploy → revoke old in sequence) is safe. Revoking old before deploying new causes an outage.

**Dynamic credentials solve this entirely** — there is no "old credential" because each application instance holds its own short-lived lease. When you rotate a Vault database role's configuration, only new credential requests are affected; existing leases remain valid until they expire naturally.

---

### Secrets in CI/CD Pipelines

CI/CD systems need secrets to deploy — but the pipeline itself is a high-risk environment. Every job that runs untrusted code (e.g., a PR from a fork) is a potential exfiltration path.

#### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    # Use OIDC to get short-lived AWS credentials — no static AWS keys stored in GitHub
    permissions:
      id-token: write     # required for OIDC token issuance
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy-role
          aws-region: us-east-1
          # No AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY — credentials are ephemeral

      - name: Read deploy-time secret from Secrets Manager
        id: secrets
        run: |
          # Fetch only what this job needs; do not print the value
          DB_PASSWORD=$(aws secretsmanager get-secret-value \
            --secret-id prod/myapp/database \
            --query 'SecretString' \
            --output text | jq -r '.password')

          # Mask the value in all subsequent log output
          echo "::add-mask::$DB_PASSWORD"

          # Pass to next step via environment file — not as a step output
          echo "DB_PASSWORD=$DB_PASSWORD" >> "$GITHUB_ENV"

      - name: Deploy
        run: ./scripts/deploy.sh
        env:
          DEPLOY_ENV: production
```

**Fork PR warning:** Secrets stored in GitHub Actions repository secrets are **not** passed to workflows triggered by pull requests from forks. This is intentional. If you need secrets in PR checks (e.g., integration tests), use environment-scoped secrets with required reviewers on the environment, not repository-level secrets.

**`::add-mask::` limitation:** The mask only applies to that workflow run's log output. It does not prevent the value from appearing in a core dump, being exfiltrated by malicious code in a dependency, or being written to a file that's uploaded as an artifact. Defense in depth still applies.

---

## Examples

### Example 1: Vault Dev Mode — End-to-End Static Secret Workflow

This example sets up a local Vault, writes a secret, creates a scoped policy, and reads the secret using a token bound to that policy.

```bash
# 1. Start Vault in dev mode (terminal 1)
vault server -dev -dev-root-token-id=devroot 2>&1 | grep -E "Unseal Key|Root Token|VAULT_ADDR"

# 2. Configure the client (terminal 2)
export VAULT_ADDR='http://127.0.0.1:8200'
export VAULT_TOKEN='devroot'

# 3. Enable KV v2 and write a secret
vault secrets enable -path=secret kv-v2

vault kv put secret/webapp/config \
  db_password="s3cr3tpassword" \
  api_key="ak-abc123xyz789" \
  feature_flag_endpoint="https://flags.internal/v1"

# 4. Write a least-privilege policy for the webapp
cat << 'EOF' > webapp-policy.hcl
path "secret/data/webapp/config" {
  capabilities = ["read"]
}
path "secret/metadata/webapp/config" {
  capabilities = ["read"]
}
EOF

vault policy write webapp webapp-policy.hcl

# 5. Create a token with only the webapp policy (simulates app identity)
WEBAPP_TOKEN=$(vault token create \
  -policy=webapp \
  -ttl=1h \
  -format=json | jq -r '.auth.client_token')

# 6. Verify the token can only read its own secret
VAULT_TOKEN=$WEBAPP_TOKEN vault kv get secret/webapp/config
# ✓ returns the secret

# 7. Verify the token cannot read other paths
VAULT_TOKEN=$WEBAPP_TOKEN vault kv get secret/otherapp/config
# ✗ Error: permission denied

# 8. Extract a single value for use in a script
DB_PASS=$(VAULT_TOKEN=$WEBAPP_TOKEN vault kv get -field=db_password secret/webapp/config)
echo "DB_PASS is set: $([ -n "$DB_PASS" ] && echo yes || echo no)"
```

---

### Example 2: AWS Secrets Manager with Automatic RDS Rotation

This example creates a secret, assigns it to an RDS PostgreSQL instance, and enables automatic rotation.

```bash
# 1. Create a KMS key for secret encryption (recommended over default AWS key)
KEY_ARN=$(aws kms create-key \
  --description "Secrets Manager encryption key for myapp" \
  --query 'KeyMetadata.Arn' \
  --output text)

aws kms create-alias \
  --alias-name alias/myapp-secrets \
  --target-key-id "$KEY_ARN"

# 2. Create the secret with the initial RDS credentials
aws secretsmanager create-secret \
  --name prod/myapp/rds \
  --kms-key-id alias/myapp-secrets \
  --secret-string '{
    "engine": "postgres",
    "host": "myapp-db.cluster-abc123.us-east-1.rds.amazonaws.com",
    "username": "myapp_user",
    "password": "InitialPassword123!",
    "dbname": "myapp",
    "port": 5432
  }'

# 3. Grant the ECS task role permission to read the secret
aws secretsmanager put-resource-policy \
  --secret-id prod/myapp/rds \
  --resource-policy '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"AWS": "arn:aws:iam::123456789012:role/myapp-ecs-task-role"},
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "*"
    }]
  }'

# 4. Enable automatic rotation every 7 days
# The Lambda ARN format is standardized by AWS region
aws secretsmanager rotate-secret \
  --secret-id prod/myapp/rds \
  --rotation-lambda-arn \
    arn:aws:lambda:us-east-1:123456789012:function:SecretsManagerRDSPostgreSQLRotationSingleUser \
  --rotation-rules AutomaticallyAfterDays=7

# 5. Verify rotation status
aws secretsmanager describe-secret \
  --secret-id prod/myapp/rds \
  --query '{RotationEnabled: RotationEnabled, LastRotatedDate: LastRotatedDate, NextRotationDate: NextRotationDate}'

# 6. Test immediate rotation (confirm it completes successfully)
aws secretsmanager rotate-secret --secret-id prod/myapp/rds
# Wait ~10 seconds, then verify the new password works
aws secretsmanager get-secret-value \
  --secret-id prod/myapp/rds \
  --query 'SecretString' \
  --output text | jq '.password'
```

---

### Example 3: External Secrets Operator Syncing Vault into Kubernetes

Full setup: install ESO, configure Vault auth, create ExternalSecret, verify the Kubernetes Secret.

```bash
# 1. Install ESO via Helm
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true

# 2. Create a Kubernetes service account for ESO to use with Vault
kubectl create serviceaccount external-secrets-sa -n external-secrets

# 3. On the Vault side: allow ESO's service account to authenticate
vault write auth/kubernetes/role/external-secrets \
  bound_service_account_names=external-secrets-sa \
  bound_service_account_namespaces=external-secrets \
  policies=external-secrets-policy \
  ttl=1h

# Policy granting ESO read access to the paths it needs to sync
cat << 'EOF' | vault policy write external-secrets-policy -
path "secret/data/production/*" {
  capabilities = ["read"]
}
path "secret/metadata/production/*" {
  capabilities = ["read", "list"]
}
EOF

# 4. Deploy the ClusterSecretStore
kubectl apply -f - <<'EOF'
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.internal:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
EOF

# 5. Create an ExternalSecret in the production namespace
kubectl apply -f - <<'EOF'
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: webapp-secrets
  namespace: production
spec:
  refreshInterval: 5m
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: webapp-secrets
    creationPolicy: Owner
  dataFrom:
    # Pull all key-value pairs from the Vault path into the K8s Secret
    - extract:
        key: production/webapp/config
EOF

# 6. Verify sync
kubectl get externalsecret webapp-secrets -n production
# STATUS should show "SecretSynced"

kubectl get secret webapp-secrets -n production
# Should appear with type Opaque and populated data keys

# Decode a value to confirm
kubectl get secret webapp-secrets -n production \
  -o jsonpath='{.data.db_password}' | base64 -d
```

---

### Example 4: Preventing Secret Leakage in a CI Pipeline with pre-commit

This example adds a pre-commit hook that blocks secret commits before they reach the remote.

```bash
# 1. Install detect-secrets (Yelp's tool)
pip install detect-secrets pre-commit

# 2. Scan the repo and generate a baseline (known false positives are recorded here)
detect-secrets scan --baseline .secrets.baseline .

# Review the baseline and mark any false positives as such
# The baseline file should be committed to the repo
git add .secrets.baseline

# 3. Configure pre-commit to run detect-secrets on every commit
cat << 'EOF' > .pre-commit-config.yaml
repos:
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.4.0
    hooks:
      - id: detect-secrets
        args: ['--baseline', '.secrets.baseline']
        # Exclude test fixtures and auto-generated files
        exclude: >
          (?x)^(
            tests/fixtures/.*|
            .*\.lock$
          )$

  # Also block commits that accidentally stage .env files
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: detect-private-key
      - id: check-added-large-files
EOF

# 4. Install the hooks into the local git repo
pre-commit install

# 5. Test: attempt to commit a file containing a fake AWS key
echo 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' > test-leak.txt
git add test-leak.txt
git commit -m "test"
# ✗ detect-secrets will block this commit and print the offending line

# Clean up
rm test-leak.txt
git reset HEAD test-leak.txt 2>/dev/null || true

# 6. For CI enforcement (catch secrets that bypass local hooks)
# Add to .github/workflows/security.yml:
cat << 'EOF'
      - name: Scan for secrets
        run: |
          pip install detect-secrets
          git diff --name-only HEAD~1 HEAD | xargs detect-secrets-hook --baseline .secrets.baseline
EOF
```

---

## Exercises

### Exercise 1: Vault Policy Least-Privilege Audit

**Goal:** Practice writing and verifying Vault policies by auditing an overly permissive existing policy.

You are given the following policy that a developer wrote in a hurry:

```hcl
path "secret/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
```

1. Start Vault in dev mode and enable KV v2 at `secret/`.
2. Write secrets at two paths: `secret/app-a/config` and `secret/app-b/config` with different passwords.
3. Write a corrected policy for `app-a` that grants **only** read access to `secret/data/app-a/config` and `secret/metadata/app-a/config`, with an explicit deny on `secret/data/app-b/*`.
4. Create a token with the new policy. Verify it can read `app-a/config` but receives a permission denied error on `app-b/config`.
5. Try to use the token to `kv put` a new version of `app-a/config`. Confirm it is also denied. Explain in a comment why read-only prevents this and why this is the correct behavior for an application token.

---

### Exercise 2: AWS Secrets Manager Rotation Simulation

**Goal:** Understand the version label lifecycle by manually walking through a rotation.

Using the AWS CLI (LocalStack is acceptable if you don't have an AWS account):

1. Create a secret `dev/exercise/apikey` with value `{"key": "v1-aaabbbccc"}`.
2. Verify `AWSCURRENT` points to the v1 version using `list-secret-version-ids`.
3. Put a new secret value `{"key": "v2-dddeeefff"}`. Observe that `AWSPREVIOUS` now points to v1 and `AWSCURRENT` to v2.
4. Write a shell script that reads `AWSCURRENT` and prints only the `key` field. Run it and confirm it returns the v2 value.
5. Simulate a rollback: use `update-secret-version-stage` to move the `AWSCURRENT` label back to v1. Read the secret again and confirm the v1 value is returned.
6. **Explain** in a short comment block: why does Secrets Manager keep the previous version around, and what could go wrong if you deleted it immediately after rotation?

---

### Exercise 3: External Secrets Operator — Multi-Namespace Isolation

**Goal:** Verify that ESO enforces namespace isolation correctly when using a namespaced `SecretStore` vs a `ClusterSecretStore`.

Set up a local Kubernetes cluster (kind or minikube) with ESO installed. You'll need a Vault dev instance accessible from the cluster.

1. Write a secret at `secret/data/team-a/config` and `secret/data/team-b/config` in Vault.
2. Create a **namespaced** `SecretStore` in the `team-a` namespace that authenticates to Vault using a service account bound to a policy that only allows reading `secret/data/team-a/*`.
3. Create an `ExternalSecret` in `team-a` that syncs `team-a/config`. Verify it creates the Kubernetes `Secret` successfully.
4. Create a second `ExternalSecret` in `team-a` that attempts to sync `team-b/config` using the same `SecretStore`. Observe the error in `kubectl get externalsecret` — capture the exact status message.
5. Explain the trust boundary that makes this work: what prevents a developer with only `team-a` namespace access from creating a `SecretStore` pointing to a different Vault role and reading `team-b` secrets?

---

### Exercise 4: Detect and Remediate a Leaked Secret

**Goal:** Practice the full incident response workflow for a credential exposed in git history.

1. Create a new git repository locally. Add a Python file containing a fake (non-functional) AWS access key and secret:
   ```
   AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
   AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
   ```
   Commit it. Then "discover" the leak: delete the keys from the file and commit again.

2. Run `git log -p` and confirm the secret is still visible in the first commit's diff. This is the core problem.

3. Use `git filter-repo --path <file> --invert-paths` or BFG (`java -jar bfg.jar --delete-files <file>`) to purge the commit from history. Confirm with `git log -p` that the secret no longer appears.

4. Install `detect-secrets` and configure a pre-commit hook (as shown in Example 4). Attempt to commit the fake keys again. Confirm the hook blocks the commit.

5. **Write a one-paragraph incident response runbook** covering: (a) how you would verify whether the leaked credential was used (hint: AWS CloudTrail), (b) the rotation steps, (c) why cleaning git history alone is insufficient, and (d) how you would prevent recurrence at the team level.

---

### Quick Checks

6. Detect an AWS access key ID in this environment variable line. Print only the matched key.

```bash
echo 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' | grep -oE 'AKIA[0-9A-Z]{16}'
```

```expected_output
AKIAIOSFODNN7EXAMPLE
```

7. Compute the SHA-256 hash of the string `vault-token` (no trailing newline). Print only the hex digest.

```bash
echo -n "vault-token" | sha256sum | awk '{print $1}'
```

```expected_output
1be23b07ef444b13455e71fc8de580aef6cb309128f9e9a91e3cb7ab08d27cfb
```
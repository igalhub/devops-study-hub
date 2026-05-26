---
title: Security & Access Control
module: elasticsearch
duration_min: 20
difficulty: intermediate
tags: [elasticsearch, security, tls, rbac, api-keys, audit-logging]
exercises: 3
---

## Overview
Elasticsearch ships with all security features disabled by default in older versions (pre-8.0). From 8.0 onward, security is on by default — but understanding how to configure it correctly is non-negotiable in any production deployment. Exposed Elasticsearch clusters have repeatedly appeared in breach reports because default installs listen on 0.0.0.0 with no authentication. This lesson covers TLS, authentication, role-based access control, API keys, and fine-grained document- and field-level security — the full security stack used in enterprise environments.

## Concepts

### X-Pack Security

X-Pack is the security (and features) plugin bundled with Elasticsearch since version 6.8. In Elasticsearch 8.x it is enabled by default and cannot be disabled in production mode. In 7.x clusters you must enable it:

```yaml
# elasticsearch.yml
xpack.security.enabled: true
xpack.security.transport.ssl.enabled: true
xpack.security.http.ssl.enabled: true
```

After enabling, run the setup utility to generate certificates and built-in user passwords:

```bash
# Generate CA and node certificates
./bin/elasticsearch-certutil ca
./bin/elasticsearch-certutil cert --ca elastic-stack-ca.p12

# Auto-configure security (8.x only — outputs passwords)
./bin/elasticsearch-setup-passwords auto
```

### TLS Setup

Two distinct TLS channels must be secured independently:

| Channel | Setting prefix | Purpose |
|---------|---------------|---------|
| Transport (inter-node) | `xpack.security.transport.ssl` | Node-to-node cluster communication |
| HTTP (client-facing) | `xpack.security.http.ssl` | REST API, Kibana, Logstash, Beats |

```yaml
# elasticsearch.yml — full TLS configuration
xpack.security.transport.ssl.enabled: true
xpack.security.transport.ssl.verification_mode: certificate
xpack.security.transport.ssl.keystore.path: elastic-certificates.p12
xpack.security.transport.ssl.truststore.path: elastic-certificates.p12

xpack.security.http.ssl.enabled: true
xpack.security.http.ssl.keystore.path: elastic-http.p12
```

For PEM format (common when certs are managed by Vault or cert-manager):
```yaml
xpack.security.http.ssl.certificate: /etc/elasticsearch/certs/node.crt
xpack.security.http.ssl.key: /etc/elasticsearch/certs/node.key
xpack.security.http.ssl.certificate_authorities: /etc/elasticsearch/certs/ca.crt
```

`verification_mode` options:
- `certificate` — verify the certificate is signed by the trusted CA (recommended for inter-node)
- `full` — also verify the hostname matches the cert SAN (required for HTTP client-facing)
- `none` — no verification (development only, never production)

### Built-in Users

Elasticsearch ships with several built-in users:

| Username | Purpose |
|----------|---------|
| `elastic` | Superuser — full cluster access |
| `kibana_system` | Kibana backend service account |
| `logstash_system` | Logstash monitoring |
| `beats_system` | Beats monitoring |
| `apm_system` | APM server |
| `remote_monitoring_user` | Cross-cluster monitoring |

Set or reset passwords:
```bash
# From the command line
./bin/elasticsearch-reset-password -u elastic

# Via REST API (requires current credentials)
POST /_security/user/elastic/_password
{
  "password": "new-password-here"
}
```

Never use `elastic` as a service account. Create dedicated users with minimal permissions.

### Roles and Privileges

A **role** is a named set of cluster privileges, index privileges, and application privileges.

**Cluster privileges** (examples): `monitor`, `manage`, `manage_index_templates`, `create_snapshot`, `all`.

**Index privileges** (examples): `read`, `write`, `index`, `delete`, `create_index`, `manage`, `all`.

```bash
# Create a role that can read and write a specific index pattern
POST /_security/role/logs-writer
{
  "cluster": ["monitor"],
  "indices": [
    {
      "names": ["logs-*"],
      "privileges": ["index", "create_index", "read"]
    }
  ]
}

# Read-only role for analysts
POST /_security/role/logs-reader
{
  "cluster": ["monitor"],
  "indices": [
    {
      "names": ["logs-*"],
      "privileges": ["read"]
    }
  ]
}
```

### Users and Role Assignment

```bash
# Create a user and assign roles
POST /_security/user/logstash-ingest
{
  "password": "secure-password-123",
  "roles": ["logs-writer"],
  "full_name": "Logstash Ingest Service",
  "email": "ops@example.com"
}

# Assign an additional role to an existing user
POST /_security/user/logstash-ingest
{
  "roles": ["logs-writer", "monitoring-user"]
}

# View a user
GET /_security/user/logstash-ingest

# Delete a user
DELETE /_security/user/logstash-ingest
```

### Role Mappings (External Identity Providers)

Role mappings connect external identities (LDAP groups, SAML attributes, PKI certificates) to Elasticsearch roles — without creating local users:

```bash
POST /_security/role_mapping/ops-team-mapping
{
  "roles": ["logs-writer", "cluster-monitor"],
  "rules": {
    "all": [
      { "field": { "realm.name": "ldap1" } },
      { "field": { "groups": "cn=ops-team,ou=groups,dc=example,dc=com" } }
    ]
  },
  "enabled": true
}
```

This is the standard enterprise pattern — you manage group membership in Active Directory/LDAP and Elasticsearch roles are assigned automatically.

### API Keys

API keys are the preferred authentication method for programmatic access (CI pipelines, application code, Beats, custom scripts). They do not expire by default but can have an explicit expiry. They are scoped — they can only grant a subset of the creating user's permissions.

```bash
# Create an API key (inherits the permissions of the authenticated user)
POST /_security/api_key
{
  "name": "logstash-prod-key",
  "expiration": "30d",
  "role_descriptors": {
    "logs-ingest": {
      "cluster": ["monitor"],
      "indices": [
        {
          "names": ["logs-*"],
          "privileges": ["index", "create_index"]
        }
      ]
    }
  }
}
```

Response includes `id` and `api_key`. The credential used in HTTP headers is `base64(id:api_key)`:

```bash
curl -H "Authorization: ApiKey $(echo -n 'id:api_key' | base64)" \
     https://localhost:9200/_cluster/health
```

Invalidate a key:
```bash
DELETE /_security/api_key
{
  "ids": ["VuaCfGcBCdbkIjia..."]
}
```

List API keys for the current user:
```bash
GET /_security/api_key?mine=true
```

### Field-Level Security (FLS)

FLS restricts which **fields** a role can see in documents. Useful when a single index contains a mix of sensitive and non-sensitive data:

```bash
POST /_security/role/pii-restricted
{
  "indices": [
    {
      "names": ["users-*"],
      "privileges": ["read"],
      "field_security": {
        "grant": ["@timestamp", "service_name", "level", "message"],
        "except": ["user.email", "user.ssn", "payment.*"]
      }
    }
  ]
}
```

`grant: ["*"]` plus `except: [...]` is cleaner than enumerating every allowed field when the set is large.

### Document-Level Security (DLS)

DLS restricts which **documents** a role can see using a Query DSL filter applied transparently at query time:

```bash
POST /_security/role/prod-namespace-only
{
  "indices": [
    {
      "names": ["k8s-events-*"],
      "privileges": ["read"],
      "query": {
        "term": { "namespace": "production" }
      }
    }
  ]
}
```

Any search against `k8s-events-*` by a user with this role automatically gets this filter injected — they cannot see events from other namespaces, and they cannot tell the other documents exist.

DLS and FLS are evaluated at query time, not at ingest time, so document content can change after indexing and access will reflect current document values.

### Audit Logging

Audit logging records security events — authentication successes/failures, access denials, index operations — for compliance and incident response.

```yaml
# elasticsearch.yml
xpack.security.audit.enabled: true
xpack.security.audit.logfile.events.include:
  - authentication_success
  - authentication_failed
  - access_denied
  - connection_denied
  - run_as_denied
xpack.security.audit.logfile.events.exclude:
  - system_access_granted
```

Audit logs are written to `logs/audit.json` by default. In production, ship them to a separate Elasticsearch cluster (not the one being audited) or a SIEM so they cannot be tampered with.

Key audit event fields: `event.action`, `user.name`, `user.roles`, `request.id`, `url.path`, `network.client.ip`.

## Examples

### Least-Privilege Service Account Setup for Logstash

Requirements: Logstash reads from Kafka and writes to `logs-{service}-{env}` indices. It should not be able to delete indices, modify mappings, or read existing data.

```bash
# 1. Create the role
POST /_security/role/logstash-ingest-role
{
  "cluster": ["monitor", "manage_index_templates", "manage_ilm"],
  "indices": [
    {
      "names": ["logs-*", ".monitoring-*"],
      "privileges": ["index", "create_index", "auto_configure"]
    }
  ]
}

# 2. Create an API key — not a user — for Logstash
POST /_security/api_key
{
  "name": "logstash-prod",
  "expiration": "90d",
  "role_descriptors": {
    "logstash-writer": {
      "cluster": ["monitor", "manage_index_templates", "manage_ilm"],
      "indices": [
        { "names": ["logs-*"], "privileges": ["index", "create_index", "auto_configure"] }
      ]
    }
  }
}

# 3. Store the base64 credential in Logstash keystore — never in plaintext config
```

If the API key is rotated or the Logstash instance is compromised, you invalidate the key without touching user passwords.

## Exercises

1. On a local Elasticsearch 8.x instance (Docker), create a role `app-readonly` with read-only access to `app-*` indices and `monitor` cluster privilege. Create a user `app-monitor` with this role. Authenticate as `app-monitor` and confirm you can run `GET /app-*/_search` but receive a 403 when attempting `DELETE /app-test`.

2. Create a role `tenant-a-role` that applies document-level security filtering documents where `tenant: "tenant-a"`, and field-level security that grants all fields except `internal_cost` and `vendor_margin`. Index 5 documents mixing two tenants and one document with sensitive fields. Authenticate as a user with `tenant-a-role` and verify: (a) only tenant-a documents are returned, (b) the excluded fields are absent from responses.

3. Generate an API key scoped to write access on `metrics-*` with a 7-day expiration. Use `curl` with the base64 `Authorization: ApiKey` header to index a test document. Then invalidate the key using `DELETE /_security/api_key` and confirm subsequent requests return 401. List the audit log entries for the invalidation event.

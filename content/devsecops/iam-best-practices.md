---
title: IAM Best Practices
module: devsecops
duration_min: 20
difficulty: intermediate
tags: [devsecops, iam, aws, gcp, least-privilege, oidc, mfa, audit, access-control]
exercises: 4
---

## Overview

IAM (Identity and Access Management) is the authorization layer that controls who can do what to which cloud resources. In practice, IAM misconfiguration is the leading cause of cloud breaches — overly permissive roles, leaked access keys, and unused permissions all create pivot points for attackers. Unlike a network firewall that a single team configures once, IAM permissions sprawl across every team, every CI/CD pipeline, and every service account in your organization. The blast radius of a single misconfigured role can be the entire cloud account.

IAM best practices are not a one-time checklist. They are operational habits built into your deployment process: permissions reviewed on every merge, credential rotation enforced by policy, and access patterns monitored continuously. The mental model to internalize is that access is debt — every permission you grant is a liability that must be justified, reviewed, and revoked when no longer needed.

In the DevOps toolchain, IAM sits at the intersection of infrastructure-as-code (where roles are defined), CI/CD pipelines (where they are assumed), and observability (where their usage is audited). Getting IAM right means treating it the same way you treat code: version-controlled, peer-reviewed, and automatically tested.

---

## Concepts

### Principle of Least Privilege

Grant only the permissions needed to perform a specific task — no more. The correct direction is additive: start with zero and add permissions until the job works, not the reverse. Wildcards in actions or resources are a code smell that should require explicit justification in code review.

**Why it's hard in practice:** developers tend to request broad permissions to unblock themselves, and those permissions never get trimmed. The result is role sprawl where production roles carry permissions that haven't been exercised in months.

**The operational pattern:** use IAM Access Advisor to see last-used dates per service, then remove what hasn't been touched in 90 days.

```bash
# Step 1 — generate a report of services accessed by a role
JOB_ID=$(aws iam generate-service-last-accessed-details \
  --arn arn:aws:iam::123456789012:role/MyAppRole \
  --query 'JobId' --output text)

# Step 2 — wait briefly, then fetch results
aws iam get-service-last-accessed-details \
  --job-id "$JOB_ID" \
  --query 'ServicesLastAccessed[?TotalAuthenticatedEntities==`0`].ServiceName' \
  --output table
# Any service listed has NEVER been used — safe candidate for removal

# Find roles not assumed in the last 90 days
aws iam list-roles --output json | jq -r '
  .Roles[] |
  select(
    .RoleLastUsed.LastUsedDate == null or
    (.RoleLastUsed.LastUsedDate | fromdateiso8601) < (now - 7776000)
  ) | .RoleName'
```

**Policy scoping — the most common mistake:**

```json
// ❌ Bad — wildcard action, wildcard resource
{
  "Effect": "Allow",
  "Action": "s3:*",
  "Resource": "*"
}

// ✅ Good — specific actions, specific resource path
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::my-app-bucket/uploads/*"
}
```

**Gotcha:** `s3:ListBucket` operates on the bucket ARN (`arn:aws:s3:::bucket-name`), not the object ARN. If you grant only `s3:GetObject` on `arn:aws:s3:::bucket/*`, the SDK will throw `AccessDenied` on list operations even if the user only needs to list — you must add the bucket ARN separately.

```json
// Correct pattern for an app that needs to list and read objects
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-app-bucket"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::my-app-bucket/uploads/*"
    }
  ]
}
```

---

### Eliminate Long-Lived Credentials

Static access keys (`AKIA...`) are the highest-risk IAM artifact. They don't expire, they travel in environment variables and config files, and they appear in git history. Every AWS workload that runs in a managed compute environment — EC2, ECS, EKS, Lambda — can use short-lived, automatically rotated credentials via the instance metadata service instead.

| Credential Type | Rotation | Revocation | Recommended Context |
|---|---|---|---|
| Root account keys | Never auto-rotates | Delete account | Never use |
| IAM user access keys | Manual | Immediate on delete | Local dev only, with rotation policy |
| EC2 instance profile | Every hour (automatic) | Role detach | All EC2 workloads |
| EKS IRSA token | ~24h (projected) | Role unbinding | Kubernetes workloads |
| OIDC federated token | ~15 min–1h | Role trust policy | CI/CD pipelines |
| `aws sts assume-role` | 15 min–12h | Policy revocation | Cross-account, human access |

**Boto3 credential chain — know the order:**

```python
# ❌ Never do this — key is plaintext in source code
import boto3
s3 = boto3.client('s3',
    aws_access_key_id='AKIAIOSFODNN7EXAMPLE',
    aws_secret_access_key='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
)

# ✅ Let boto3 resolve credentials automatically
# Resolution order (first match wins):
# 1. Explicit params (avoid)
# 2. ENV: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# 3. ~/.aws/credentials (local dev)
# 4. ~/.aws/config (profile-based)
# 5. ECS task role (via container metadata endpoint)
# 6. EC2 instance profile (via IMDSv2)
s3 = boto3.client('s3')  # works on EC2, Lambda, ECS, EKS with IRSA
```

**Gotcha:** on EC2, enforce IMDSv2 (token-required mode) to prevent SSRF attacks from reading instance credentials via the metadata endpoint. IMDSv1 allows a simple `curl http://169.254.169.254/latest/meta-data/iam/security-credentials/` — no auth required.

```bash
# Enforce IMDSv2 at launch time
aws ec2 run-instances \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  ...

# Or modify an existing instance
aws ec2 modify-instance-metadata-options \
  --instance-id i-0abc123 \
  --http-tokens required \
  --http-endpoint enabled
```

---

### OIDC for CI/CD — No Stored Secrets

The modern standard for CI/CD pipelines is OIDC federation: the pipeline exchanges a short-lived OIDC JWT (issued by GitHub, GitLab, etc.) for temporary AWS credentials via `sts:AssumeRoleWithWebIdentity`. No secrets are stored anywhere.

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write   # required — lets the runner request an OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy
          aws-region: us-east-1
          # No access key or secret — role assumed via JWT exchange

      - name: Verify identity
        run: aws sts get-caller-identity
```

```json
// IAM role trust policy — locks the role to one repo AND one branch
// Without the sub condition, any repo in the org could assume this role
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:myorg/myrepo:ref:refs/heads/main"
      }
    }
  }]
}
```

**Gotcha:** using `StringLike` with a wildcard (`repo:myorg/*`) instead of `StringEquals` for the `sub` condition allows any repo in your org to assume the role. Scope it to the exact repo and branch unless you deliberately want org-wide access.

For GCP, the equivalent is Workload Identity Federation:

```bash
# Create a Workload Identity Pool for GitHub Actions
gcloud iam workload-identity-pools create "github-pool" \
  --project="my-project" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Create an OIDC provider within the pool
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="my-project" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub OIDC Provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='myorg/myrepo'"
```

---

### MFA and Root Account Hardening

The AWS root account has unconditional access to everything including canceling the account, changing billing, and bypassing SCPs. It must be treated as a break-glass credential: strong hardware MFA, no access keys, and rarely used.

| Control | Root Account | IAM Users | IAM Roles |
|---|---|---|---|
| MFA enforcement | Hardware MFA always | SCP or IAM Condition | N/A (assume-role is short-lived) |
| Access keys | Delete all | Rotate every 90 days | Not applicable |
| Usage frequency | Break-glass only | Prefer roles | Normal operation |
| Audit | CloudTrail | CloudTrail | CloudTrail |

```bash
# Check root MFA status — 0 means critical finding
aws iam get-account-summary \
  --query 'SummaryMap.AccountMFAEnabled' \
  --output text

# Check root access key existence — should always be 0
aws iam get-account-summary \
  --query 'SummaryMap.AccountAccessKeysPresent' \
  --output text

# Audit all IAM users for missing MFA
aws iam list-users --query 'Users[*].UserName' --output text | tr '\t' '\n' | \
  while read user; do
    count=$(aws iam list-mfa-devices \
      --user-name "$user" \
      --query 'length(MFADevices)' \
      --output text)
    [ "$count" = "0" ] && echo "NO MFA: $user"
  done

# Audit access keys older than 90 days
aws iam generate-credential-report && sleep 5
aws iam get-credential-report --query 'Content' --output text | \
  base64 -d | \
  awk -F',' 'NR>1 && $9!="N/A" {
    cmd = "date -d " $9 " +%s"
    cmd | getline key_date; close(cmd)
    age = (systime() - key_date) / 86400
    if (age > 90) printf "OLD KEY (%.0f days): user=%s\n", age, $1
  }'
```

**SCP to require MFA across an AWS Organization** — this denies all API actions for users who haven't authenticated with MFA, while still allowing them to set up MFA:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyWithoutMFA",
    "Effect": "Deny",
    "NotAction": [
      "iam:CreateVirtualMFADevice",
      "iam:EnableMFADevice",
      "iam:GetUser",
      "iam:ListMFADevices",
      "iam:ListVirtualMFADevices",
      "iam:ResyncMFADevice",
      "sts:GetSessionToken"
    ],
    "Resource": "*",
    "Condition": {
      "BoolIfExists": {
        "aws:MultiFactorAuthPresent": "false"
      }
    }
  }]
}
```

**Gotcha:** `BoolIfExists` is intentional — `Bool` would not match IAM role sessions (which don't carry the `aws:MultiFactorAuthPresent` key at all), potentially denying all role-based operations. `BoolIfExists` only applies the condition when the key is present.

---

### Permission Boundaries

A permission boundary is an IAM managed policy attached to a role (or user) that sets the maximum permissions that entity can ever have — regardless of what identity-based policies are attached. It's the ceiling, not the floor.

This is critical in environments where teams can create their own roles (e.g., a developer CI role that can run `iam:CreateRole`). Without a boundary, that role could create a new role with admin access and use it to escalate privileges.

```
Effective permissions = Identity Policy ∩ Permission Boundary
```

```json
// Permission boundary — caps a developer role to only S3, CloudWatch, and logs
// Even if someone attaches AdministratorAccess, they can't exceed this
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:*",
        "cloudwatch:*",
        "logs:*",
        "lambda:*"
      ],
      "Resource": "*"
    }
  ]
}
```

```bash
# Create a role with a permission boundary applied at creation time
aws iam create-role \
  --role-name developer-sandbox-role \
  --assume-role-policy-document file://trust.json \
  --permissions-boundary arn:aws:iam::123456789012:policy/DeveloperBoundary

# Attach the boundary to an existing role
aws iam put-role-permissions-boundary \
  --role-name existing-role \
  --permissions-boundary arn:aws:iam::123456789012:policy/DeveloperBoundary

# Verify the boundary is attached
aws iam get-role \
  --role-name developer-sandbox-role \
  --query 'Role.PermissionsBoundary'
```

**Gotcha:** permission boundaries do not grant permissions by themselves. A role with only a boundary attached has zero effective permissions — the identity policy must also explicitly allow the action, and then the boundary must also allow it. Both must say yes.

---

### IAM Access Analyzer

Access Analyzer continuously evaluates resource policies (S3 buckets, IAM roles, KMS keys, Lambda functions, SQS queues, Secrets Manager secrets) and flags any that grant access to principals outside your account or organization. It answers the question: "what can the outside world reach?"

```bash
# Create an account-level analyzer (free tier, covers one account)
aws accessanalyzer create-analyzer \
  --analyzer-name account-analyzer \
  --
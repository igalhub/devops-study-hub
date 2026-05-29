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
  --image-id ami-0abcdef1234567890 \
  --instance-type t3.micro \
  --iam-instance-profile Name=MyAppInstanceProfile

# Or harden an existing running instance
aws ec2 modify-instance-metadata-options \
  --instance-id i-0abc123 \
  --http-tokens required \
  --http-endpoint enabled

# Verify the setting took effect
aws ec2 describe-instances \
  --instance-ids i-0abc123 \
  --query 'Reservations[0].Instances[0].MetadataOptions'
```

**Detecting leaked keys in git history** — run this before any repo goes public:

```bash
# Install trufflehog and scan a repo for high-entropy strings and known key patterns
pip install trufflehog
trufflehog git file://. --only-verified

# For GitHub repos (scans all branches and commits)
trufflehog github --repo https://github.com/myorg/myrepo --only-verified
```

**Rotating an existing IAM user key without downtime:**

```bash
# Step 1 — create a second key (max 2 per user)
NEW_KEY=$(aws iam create-access-key --user-name ci-deployer \
  --query 'AccessKey.{ID:AccessKeyId,Secret:SecretAccessKey}' \
  --output json)

# Step 2 — update your secret store (GitHub, Vault, SSM) with the new key
# Step 3 — verify the new key works in your pipeline
# Step 4 — deactivate (not delete yet) the old key
aws iam update-access-key \
  --user-name ci-deployer \
  --access-key-id AKIAOLDKEYEXAMPLE \
  --status Inactive

# Step 5 — after confirming nothing broke, delete the old key
aws iam delete-access-key \
  --user-name ci-deployer \
  --access-key-id AKIAOLDKEYEXAMPLE
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

**Registering the GitHub OIDC provider in AWS** — this is a one-time setup per account:

```bash
# Get the thumbprint of the GitHub OIDC endpoint (required by AWS)
THUMBPRINT=$(openssl s_client -connect token.actions.githubusercontent.com:443 \
  -showcerts </dev/null 2>/dev/null \
  | openssl x509 -fingerprint -noout \
  | sed 's/://g' | awk -F= '{print tolower($2)}')

# Register the provider
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list "$THUMBPRINT"
```

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

# Bind the provider to a GCP service account
gcloud iam service-accounts add-iam-policy-binding \
  deploy-sa@my-project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/myorg/myrepo"
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

# Audit access keys older than 90 days using the credential report
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

**Gotcha:** `BoolIfExists` is intentional — `Bool` would not match IAM role sessions (which don't carry the `aws:MultiFactorAuthPresent` key at all), potentially denying all role-based operations. `BoolIfExists` only applies the condition when the key is present, leaving role-based sessions unaffected.

---

### Permission Boundaries

A permission boundary is an IAM managed policy attached to a role (or user) that sets the maximum permissions that entity can ever have — regardless of what identity-based policies are attached. It's the ceiling, not the floor.

This is critical in environments where teams can create their own roles (e.g., a developer CI role that can run `iam:CreateRole`). Without a boundary, that role could create a new role with admin access and use it to escalate privileges.

```
Effective permissions = Identity Policy ∩ Permission Boundary
```

| Scenario | Identity Policy | Permission Boundary | Effective Result |
|---|---|---|---|
| S3 read, boundary allows S3 | `s3:GetObject` | `s3:*` | `s3:GetObject` ✅ |
| S3 read, boundary blocks S3 | `s3:GetObject` | `ec2:*` only | Denied ❌ |
| Admin access, boundary limits | `AdministratorAccess` | `s3:*, logs:*` | Only S3 + logs ✅ |
| No identity policy, boundary set | None | `s3:*` | Denied — boundary alone grants nothing ❌ |

```json
// Permission boundary — caps a developer role to only S3, CloudWatch, Lambda, and logs
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

# Remove a boundary (use with caution — immediately expands effective permissions)
aws iam delete-role-permissions-boundary \
  --role-name developer-sandbox-role
```

**Gotcha:** permission boundaries do not grant permissions by themselves. A role with only a boundary attached has zero effective permissions — the identity policy must also explicitly allow the action, and then the boundary must also allow it. Both must say yes.

**Preventing privilege escalation via boundary enforcement:** if your platform team allows developers to self-service roles, require that every `iam:CreateRole` or `iam:PutRolePolicy` call is conditioned on the boundary being present:

```json
{
  "Effect": "Allow",
  "Action": ["iam:CreateRole", "iam:PutRolePolicy"],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/DeveloperBoundary"
    }
  }
}
```

Without this condition, a developer with `iam:CreateRole` can create a role without a boundary and attach `AdministratorAccess` to it.

---

### IAM Access Analyzer

Access Analyzer continuously evaluates resource policies (S3 buckets, IAM roles, KMS keys, Lambda functions, SQS queues, Secrets Manager secrets) and flags any that grant access to principals outside your account or organization. It answers the question: "what can the outside world reach?"

```bash
# Create an account-level analyzer (free, covers one account)
aws accessanalyzer create-analyzer \
  --analyzer-name account-analyzer \
  --type ACCOUNT

# Create an organization-level analyzer (covers all accounts in the org)
# Must be run from the Organizations management account or a delegated admin
aws accessanalyzer create-analyzer \
  --analyzer-name org-analyzer \
  --type ORGANIZATION

# List all active findings (externally accessible resources)
aws accessanalyzer list-findings \
  --analyzer-arn arn:aws:access-analyzer:us-east-1:123456789012:analyzer/account-analyzer \
  --filter '{"status": {"eq": ["ACTIVE"]}}' \
  --query 'findings[*].{Resource:resource,Type:resourceType,Principal:principal}' \
  --output table

# Archive a finding after reviewing and accepting it (e.g., intentional public bucket)
aws accessanalyzer update-findings \
  --analyzer-arn arn:aws:access-analyzer:us-east-1:123456789012:analyzer/account-analyzer \
  --status ARCHIVED \
  --ids '["finding-id-here"]'
```

Access Analyzer also includes **policy validation** — it checks policies for syntax errors, overly permissive statements, and known security warnings before you deploy them:

```bash
# Validate a policy document before attaching it to any resource
aws accessanalyzer validate-policy \
  --policy-document file://my-policy.json \
  --policy-type IDENTITY_POLICY

# Example output for a policy with a wildcard resource
# {
#   "findings": [{
#     "findingType": "SECURITY_WARNING",
#     "issueCode": "PASS_ROLE_WITH_STAR_IN_RESOURCE",
#     "learnMoreLink": "...",
#     "locations": [...]
#   }]
# }
```

**Access Analyzer for unused access (IAM Access Analyzer external + unused access findings):**

```bash
# Unused access analyzer identifies over-permissioned roles and users
# This requires an analyzer with the ACCOUNT_UNUSED_ACCESS type (paid feature)
aws accessanalyzer create-analyzer \
  --analyzer-name unused-access-analyzer \
  --type ACCOUNT_UNUSED_ACCESS \
  --configuration '{"unusedAccessAge": 90}'

# Fetch findings for roles with unused permissions
aws accessanalyzer list-findings-v2 \
  --analyzer-arn arn:aws:access-analyzer:us-east-1:123456789012:analyzer/unused-access-analyzer \
  --filter '{"findingType": {"eq": ["UnusedPermission"]}}' \
  --query 'findings[*].{Resource:resource,FindingType:findingType}' \
  --output table
```

**Gotcha:** Access Analyzer only analyzes policies at the moment a resource policy changes or on a periodic refresh. It does not provide real-time alerting on every API call — that's CloudTrail's job. Use both together: Access Analyzer for static policy analysis and CloudTrail for runtime behavior.

---

### CloudTrail Auditing for IAM Events

Every IAM and STS API call is recorded in CloudTrail. This is your audit log: who assumed which role, when, from where, and what they did with it. Without CloudTrail enabled and queried, you cannot answer incident investigation questions.

```bash
# Look up all IAM events in the last 24 hours
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=iam.amazonaws.com \
  --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --query 'Events[*].{Time:EventTime,User:Username,Event:EventName}' \
  --output table

# Find all AssumeRole events for a specific role
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=MyAppRole \
  --query 'Events[?EventName==`AssumeRole`].{Time:EventTime,Who:Username,Source:CloudTrailEvent}' \
  --output table

# Detect use of the root account (should return zero results in a healthy account)
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=Username,AttributeValue=root \
  --start-time "$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --query 'Events[*].{Time:EventTime,Event:EventName,Source:EventSource}' \
  --output table
```

**CloudWatch alarm for root account usage** — set this up once per account:

```bash
# Create a metric filter that fires on any root account API call
aws logs put-metric-filter \
  --log-group-name "CloudTrail/DefaultLogGroup" \
  --filter-name "RootAccountUsage" \
  --filter-pattern '{ $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }' \
  --metric-transformations \
    metricName=RootAccountUsageCount,metricNamespace=CISBenchmark,metricValue=1

# Create an alarm on that metric
aws cloudwatch put-metric-alarm \
  --alarm-name "RootAccountUsage" \
  --metric-name RootAccountUsageCount \
  --namespace CISBenchmark \
  --statistic Sum \
  --period 300 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 1 \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:security-alerts
```

**Gotcha:** CloudTrail `lookup-events` only covers the last 90 days and is limited to management events. For longer retention, security investigations, and data events (S3 object access, Lambda invocations), you must configure a trail that ships logs to S3 and optionally to CloudWatch Logs or an Athena-queryable data lake.

---

## Examples

### Example 1: Provision a Scoped CI/CD Role with OIDC (GitHub → AWS)

**Goal:** give a GitHub Actions workflow permission to push Docker images to ECR and update an ECS service — nothing else.

**Step 1 — create the permission policy:**

```bash
cat > ecr-ecs-deploy-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "ECRPush",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      ],
      "Resource": "arn:aws:ecr:us-east-1:123456789012:repository/my-app"
    },
    {
      "Sid": "ECSUpdate",
      "Effect": "Allow",
      "Action": [
        "ecs:UpdateService",
        "ecs:DescribeServices"
      ],
      "Resource": "arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service"
    },
    {
      "Sid": "PassRoleToECS",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/ecs-task-execution-role"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name ECRAndECSDeploy \
  --policy-document file://ecr-ecs-deploy-policy.json
```

**Step 2 — create the role with OIDC trust:**

```bash
cat > github-trust.json <<'EOF'
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
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:myorg/myrepo:ref:refs/heads/main"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name github-actions-ecr-ecs-deploy \
  --assume-role-policy-document file://github-trust.json

aws iam attach-role-policy \
  --role-name github-actions-ecr-ecs-deploy \
  --policy-arn arn:aws:iam::123456789012:policy/ECRAndECSDeploy
```

**Step 3 — use the role in the workflow:**

```yaml
# .github/workflows/deploy.yml
name: Build and Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Assume deploy role via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-ecr-ecs-deploy
          aws-region: us-east-1

      - name: Log in to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        env:
          REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $REGISTRY/my-app:$IMAGE_TAG .
          docker push $REGISTRY/my-app:$IMAGE_TAG

      - name: Update ECS service
        env:
          IMAGE_TAG: ${{ github.sha }}
        run: |
          aws ecs update-service \
            --cluster my-cluster \
            --service my-service \
            --force-new-deployment
```

**Step 4 — verify:**

```bash
# After workflow runs, confirm the assumed role identity in the logs
# The "Verify identity" step should show:
# {
#   "UserId": "AROAEXAMPLE:GitHubActions",
#   "Account": "123456789012",
#   "Arn": "arn:aws:sts::123456789012:assumed-role/github-actions-ecr-ecs-deploy/GitHubActions"
# }

# Check the role was assumed in CloudTrail
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=github-actions-ecr-ecs-deploy \
  --query 'Events[?EventName==`AssumeRoleWithWebIdentity`].{Time:EventTime,Event:EventName}' \
  --output table
```

---

### Example 2: Detect and Remediate Overly Permissive Roles

**Goal:** find all roles in an account that have `*` in their action or resource fields, report them, and demonstrate scoping a wildcard policy down.

```bash
#!/bin/bash
# scan-wildcard-policies.sh — identifies policies with Action:* or Resource:*

echo "=== Scanning inline role policies for wildcards ==="

aws iam list-roles --query 'Roles[*].RoleName' --output text | tr '\t' '\n' | \
while read role; do
  # Get all inline policy names for this role
  policies=$(aws iam list-role-policies --role-name "$role" \
    --query 'PolicyNames' --output text)

  for policy in $policies; do
    doc=$(aws iam get-role-policy \
      --role-name "$role" \
      --policy-name "$policy" \
      --query 'PolicyDocument' \
      --output json)

    # Check for wildcard actions or resources
    if echo "$doc" | jq -e '.Statement[] | select(.Action == "*" or .Resource == "*")' > /dev/null 2>&1; then
      echo "⚠️  WILDCARD FOUND: role=$role policy=$policy"
    fi
  done
done

echo ""
echo "=== Scanning customer managed policies ==="

aws iam list-policies --scope Local --query 'Policies[*].Arn' --output text | tr '\t' '\n' | \
while read policy_arn; do
  version=$(aws iam get-policy \
    --policy-arn "$policy_arn" \
    --query 'Policy.DefaultVersionId' --output text)

  doc=$(aws iam get-policy-version \
    --policy-arn "$policy_arn" \
    --version-id "$version" \
    --query 'PolicyVersion.Document' \
    --output json)

  if echo "$doc" | jq -e '.Statement[] | select(.Action == "*" or .Resource == "*")' > /dev/null 2>&1; then
    echo "⚠️  WILDCARD FOUND: policy=$policy_arn"
  fi
done
```

**Remediation — replace a wildcard S3 policy with a scoped one:**

```bash
# Before: the role had this inline policy (overly permissive)
cat > scoped-s3-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-app-data"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::my-app-data/app-prefix/*"
    }
  ]
}
EOF

# Replace the inline policy with the scoped version
aws iam put-role-policy \
  --role-name MyAppRole \
  --policy-name S3Access \
  --policy-document file://scoped-s3-policy.json

# Validate the replacement with Access Analyzer
aws accessanalyzer validate-policy \
  --policy-document file://scoped-s3-policy.json \
  --policy-type IDENTITY_POLICY \
  --query 'findings[*].{Type:findingType,Issue:issueCode}' \
  --output table
# Should return an empty findings list if the policy is clean
```

---

### Example 3: Enforce Permission Boundaries Across a Developer Platform

**Goal:** platform team allows developers to create their own Lambda execution roles, but prevents any role from exceeding a defined boundary.

```bash
# Step 1 — create the boundary policy (platform team manages this)
cat > developer-boundary.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject", "s3:PutObject",
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query",
        "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
        "xray:PutTraceSegments", "xray:PutTelemetryRecords"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name DeveloperLambdaBoundary \
  --policy-document file://developer-boundary.json

# Step 2 — grant developers permission to create roles,
# but ONLY if they attach the boundary at creation time
cat > developer-iam-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowRoleCreationWithBoundary",
      "Effect": "Allow",
      "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
      "Resource": "arn:aws:iam::123456789012:role/dev-*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/DeveloperLambdaBoundary"
        }
      }
    },
    {
      "Sid": "DenyBoundaryRemoval",
      "Effect": "Deny",
      "Action": [
        "iam:DeleteRolePermissionsBoundary",
        "iam:PutRolePermissionsBoundary"
      ],
      "Resource": "arn:aws:iam::123456789012:role/dev-*",
      "Condition": {
        "StringNotEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/DeveloperLambdaBoundary"
        }
      }
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name DeveloperRole \
  --policy-name IAMSelfService \
  --policy-document file://developer-iam-policy.json

# Step 3 — developer creates a Lambda role with the boundary (this succeeds)
aws iam create-role \
  --role-name dev-my-lambda-role \
  --assume-role-policy-document file://lambda-trust.json \
  --permissions-boundary arn:aws:iam::123456789012:policy/DeveloperLambdaBoundary

# Step 4 — verify the boundary is present
aws iam get-role \
  --role-name dev-my-lambda-role \
  --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' \
  --output text
# Expected: arn:aws:iam::123456789012:policy/DeveloperLambdaBoundary
```

---

## Exercises

### Exercise 1: Audit and Trim an Overpermissioned Role

**Context:** you have a role called `LegacyAppRole` that was created with broad permissions two years ago.

1. Use `generate-service-last-accessed-details` to identify which AWS services this role has never called. Write the commands to retrieve the job result and filter for services with zero authenticated entities.
2. Examine the role's attached policies and identify any wildcard actions or resources.
3. Write a replacement policy JSON that grants only the services that *have* been used in the last 90 days, scoped to specific resource ARNs for at least two of those services.
4. Validate the new policy with `aws accessanalyzer validate-policy` before applying it.

**Expected outcome:** you can explain why each permission in the new policy is there and which line in the Access Advisor output justifies it.

---

### Exercise 2: Set Up OIDC Federation for a GitLab Pipeline

**Context:** your company uses GitLab CI, not GitHub Actions. GitLab also supports OIDC — its token issuer is `https://gitlab.com`.

1. Register the GitLab OIDC provider in your AWS account. The thumbprint must be fetched from the live endpoint. Write the `aws iam create-open-id-connect-provider` command with the correct `--client-id-list` (`https://gitlab.com` is the audience for GitLab OIDC).
2. Write a trust policy for a role that restricts assumption to a specific GitLab project. GitLab's `sub` claim format is `project_path:mygroup/myproject:ref_type:branch:ref:main`. Use `StringEquals` (not `StringLike`) for the sub condition.
3. Write the `.gitlab-ci.yml` job that uses `id_tokens` to exchange a JWT for AWS credentials and runs `aws sts get-caller-identity` to verify.
4. Explain what would happen if you used `StringLike` with `project_path:mygroup/*` — what attack scenario does that enable?

---

### Exercise 3: Build a Permission Boundary for a Self-Service Platform

**Context:** your platform team runs a shared AWS account where product teams deploy Lambda functions. Product teams need to be able to create Lambda execution roles themselves, but must not be able to escalate beyond S3, DynamoDB, and CloudWatch Logs access.

1. Write a permission boundary policy named `ProductTeamBoundary` that caps access to S3 (read/write on a prefix of your choice), DynamoDB (GetItem, PutItem, Query on a specific table ARN), and the CloudWatch Logs actions needed for Lambda logging.
2. Write an IAM policy for the `ProductTeamDeveloper` role that allows `iam:CreateRole` and `iam:AttachRolePolicy` — but only if the boundary is present. Include a statement that prevents developers from removing or replacing the boundary on any role they create.
3. Apply the boundary to a test role and then attempt to attach `AdministratorAccess` to that role. Verify that the effective permissions are still capped to what the boundary allows by calling an action outside the boundary (e.g., `ec2:DescribeInstances`) and confirming it is denied.

---

### Exercise 4: Build a Continuous IAM Audit Report

**Context:** your security team wants a weekly report of IAM hygiene issues delivered to a Slack channel.

Write a bash script `iam-audit.sh` that checks all of the following and prints a structured report:

1. **Root MFA** — is root MFA enabled? (use `get-account-summary`)
2. **Root access keys** — are any root access keys present? (use `get-account-summary`)
3. **Users without MFA** — list all IAM users who have no MFA device configured.
4. **Stale access keys** — list all access keys older than 90 days using the credential report. Parse the CSV output correctly (the `access_key_1_last_rotated` field is column 9, zero-indexed from the header).
5. **Roles unused for 90 days** — use `list-roles` and filter on `RoleLastUsed.LastUsedDate`.

The script should output each finding prefixed with `[PASS]` or `[FAIL]` so it can be parsed downstream. Run it against a real or sandbox AWS account and verify every `[FAIL]` item corresponds to an actual misconfiguration you can manually confirm in the console.

---

### Quick Checks

6. Parse this minimal IAM policy and print `overprivileged` if any statement grants `Action: '*'`, otherwise print `ok`.

```python
import json; p = json.loads('{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}'); print("overprivileged" if any(s["Action"] == "*" for s in p["Statement"]) else "ok")
```

```expected_output
overprivileged
```

hint: Think about how to parse JSON in a shell or scripting language and navigate nested structures to inspect each statement's Action field.
hint: Use `jq` with a query like `.Statement[].Action` to iterate over statements, then pipe through `grep` or add a conditional `if` in jq to check whether any value equals `"*"`.

7. Extract the AWS account ID (the 12-digit field) from this ARN: `arn:aws:iam::123456789012:user/alice`.

```python
arn = "arn:aws:iam::123456789012:user/alice"; print(arn.split(":")[4])
```

```expected_output
123456789012
```
hint: Think about how to split a string by a delimiter to isolate specific fields.
hint: Use the cut command with -d':' to set the colon as the delimiter, then select the appropriate field number with -f to target the account ID position.

---
title: IAM Best Practices
module: devsecops
duration_min: 20
difficulty: intermediate
tags: [devsecops, iam, aws, gcp, least-privilege, oidc, mfa, audit, access-control]
exercises: 4
---

## Overview
IAM misconfiguration is the leading cause of cloud breaches — overly permissive roles, leaked access keys, unused permissions that an attacker can pivot through. IAM best practices aren't a checklist you do once; they're operational habits: review permissions regularly, never use long-lived keys where temporary credentials work, and treat the root account as a break-glass emergency tool. This lesson covers the core patterns across AWS and GCP with specific, actionable guidance.

## Concepts

### Principle of Least Privilege
Grant only the permissions needed to do the job — no more. Start with nothing and add; don't start with everything and remove.

```bash
# AWS: check what permissions are actually used (IAM Access Analyzer)
aws accessanalyzer list-access-previews --analyzer-arn arn:aws:access-analyzer:...

# AWS IAM Access Advisor — see last used date for each permission
aws iam get-service-last-accessed-details \
  --job-id $(aws iam generate-service-last-accessed-details \
    --arn arn:aws:iam::123456789:role/MyRole \
    --query 'JobId' --output text)

# Find unused IAM roles (not assumed in last 90 days)
aws iam list-roles --query 'Roles[?CreateDate!=`null`]' --output json \
  | jq '.[] | select(.RoleLastUsed.LastUsedDate == null or (.RoleLastUsed.LastUsedDate | fromdateiso8601) < (now - 7776000)) | .RoleName'
```

**Scoping resources in policies:**
```json
// Bad — wildcard resource
{
  "Effect": "Allow",
  "Action": "s3:*",
  "Resource": "*"
}

// Good — specific resource and limited actions
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::my-app-bucket/uploads/*"
}
```

### Eliminate Long-Lived Credentials

#### Use Instance Roles / Workload Identity Instead
```python
# Bad — hardcoded credentials
import boto3
s3 = boto3.client('s3',
    aws_access_key_id='AKIAIOSFODNN7EXAMPLE',
    aws_secret_access_key='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
)

# Good — boto3 uses the credential chain automatically:
# 1. Instance profile (EC2/ECS/Lambda)
# 2. EKS IRSA (via projected token)
# 3. ~/.aws/credentials (local dev only)
s3 = boto3.client('s3')   # no credentials in code
```

#### OIDC for CI/CD (No Stored Credentials)
```yaml
# GitHub Actions — assume an AWS role via OIDC (no ACCESS_KEY stored)
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789:role/github-actions-deploy
      aws-region: us-east-1
```

```json
// IAM role trust policy — only allow specific repo/branch
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789:oidc-provider/token.actions.githubusercontent.com"
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

### MFA and Root Account Hardening
```bash
# Check if root account has MFA enabled
aws iam get-account-summary \
  --query 'SummaryMap.AccountMFAEnabled'
# 1 = enabled, 0 = not enabled (critical finding)

# List IAM users without MFA
aws iam list-users --query 'Users[*].UserName' --output text | \
  while read user; do
    mfa=$(aws iam list-mfa-devices --user-name "$user" --query 'MFADevices | length(@)' --output text)
    [ "$mfa" = "0" ] && echo "NO MFA: $user"
  done

# Create an SCP (Service Control Policy) to deny actions without MFA
# (requires AWS Organizations)
```

```json
// SCP: deny all actions except MFA-enabling actions if MFA not present
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Deny",
    "NotAction": [
      "iam:CreateVirtualMFADevice",
      "iam:EnableMFADevice",
      "iam:GetUser",
      "iam:ListMFADevices",
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

### IAM Access Analyzer
```bash
# Create an analyzer for the current account
aws accessanalyzer create-analyzer \
  --analyzer-name account-analyzer \
  --type ACCOUNT

# List findings (externally accessible resources)
aws accessanalyzer list-findings \
  --analyzer-arn arn:aws:access-analyzer:us-east-1:123456789:analyzer/account-analyzer \
  --query 'findings[*].[resource, condition, status]' \
  --output table

# Archive a finding (mark as intentional)
aws accessanalyzer update-findings \
  --analyzer-arn arn:... \
  --ids finding-id-here \
  --status ARCHIVED
```

Access Analyzer flags resources (S3 buckets, IAM roles, KMS keys, Lambda functions) that grant access to external principals — useful for finding accidental public exposures.

### CloudTrail — Audit All API Calls
```bash
# Create a trail logging all regions
aws cloudtrail create-trail \
  --name org-audit-trail \
  --s3-bucket-name my-cloudtrail-logs \
  --is-multi-region-trail \
  --enable-log-file-validation

aws cloudtrail start-logging --name org-audit-trail

# Search for specific API calls
aws logs filter-log-events \
  --log-group-name CloudTrail/DefaultLogGroup \
  --filter-pattern '{ $.eventName = "DeleteBucket" }' \
  --start-time $(date -d '7 days ago' +%s000)

# Who made the most API calls in the last hour?
aws cloudtrail lookup-events \
  --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%SZ) \
  --query 'Events[*].Username' --output text | \
  sort | uniq -c | sort -rn | head -10
```

### GCP IAM Best Practices
```bash
# Use service accounts for workloads, not user accounts
# Never create service account keys when Workload Identity is available

# Check for service account keys (should be minimal)
gcloud iam service-accounts list --format json | \
  jq -r '.[].email' | \
  while read sa; do
    keys=$(gcloud iam service-accounts keys list --iam-account "$sa" \
      --managed-by user --format json | jq length)
    [ "$keys" -gt 0 ] && echo "$keys keys: $sa"
  done

# Enable audit logging for all services
gcloud projects get-iam-policy my-project | grep auditLogConfigs

# Use Org Policy to enforce security constraints
gcloud resource-manager org-policies set-policy \
  --project my-project \
  --policy @deny-public-buckets.json
```

### Permission Boundary (AWS)
Permission boundaries cap the maximum permissions a role can have — even if the attached policy grants more:

```json
// Permission boundary: caps at S3 and CloudWatch only
// An admin could attach AdministratorAccess, but the boundary overrides it
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:*",
      "cloudwatch:*",
      "logs:*"
    ],
    "Resource": "*"
  }]
}
```

```bash
aws iam create-role \
  --role-name limited-developer-role \
  --permissions-boundary arn:aws:iam::123456789:policy/DeveloperBoundary \
  --assume-role-policy-document file://trust.json
```

## Exercises

1. Audit an AWS account for IAM hygiene: find roles not used in 90 days, IAM users without MFA, and any access keys older than 90 days. Write a bash script using the AWS CLI that outputs a report for each.
2. Replace a hardcoded `AWS_ACCESS_KEY_ID`/`SECRET` in a GitHub Actions workflow with OIDC. Create the IAM role with a trust policy scoped to the specific repo. Verify the workflow works and that no credentials are stored in GitHub secrets.
3. Enable CloudTrail in a test AWS account. Use `aws cloudtrail lookup-events` to find: (a) who created or deleted an S3 bucket in the last 24 hours, (b) all IAM role changes in the last week.
4. Enable IAM Access Analyzer and review its findings. For each finding, determine whether it's intentional (archive it) or unintentional (fix the resource policy). Document your reasoning for each decision.

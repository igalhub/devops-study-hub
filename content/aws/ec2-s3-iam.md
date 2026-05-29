---
title: EC2, S3, and IAM
module: aws
duration_min: 35
difficulty: intermediate
tags: [aws, ec2, s3, iam, instances, buckets, policies, roles, permissions]
exercises: 4
---

## Overview
EC2, S3, and IAM are the foundation of almost every AWS deployment. EC2 provides virtual machines; S3 provides object storage; IAM controls who and what can access everything. Understanding how these three interact — especially the IAM model of users, roles, and policies — is prerequisite knowledge for every other AWS service.

## Concepts

### EC2 — Elastic Compute Cloud

#### Instance Types
```
t3.micro      — burstable, 2 vCPU, 1 GB RAM     (dev/test, free tier)
t3.medium     — burstable, 2 vCPU, 4 GB RAM
m6i.large     — general purpose, 2 vCPU, 8 GB RAM
c6i.xlarge    — compute optimized, 4 vCPU, 8 GB RAM
r6i.large     — memory optimized, 2 vCPU, 16 GB RAM
g4dn.xlarge   — GPU instance (ML inference, graphics)
```

Naming pattern: `<family><generation><attributes>.<size>` — `m6i.xlarge` = M family, gen 6, Intel, extra large.

#### Launching an Instance
```bash
# Launch via CLI
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type t3.micro \
  --key-name my-keypair \
  --security-group-ids sg-12345678 \
  --subnet-id subnet-12345678 \
  --iam-instance-profile Name=MyEC2Role \
  --user-data file://startup.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=myapp}]'

# List running instances
aws ec2 describe-instances \
  --filters Name=instance-state-name,Values=running \
  --query 'Reservations[*].Instances[*].[InstanceId,PublicIpAddress,Tags[?Key==`Name`].Value|[0]]' \
  --output table

# SSH in
ssh -i ~/.ssh/my-keypair.pem ec2-user@<public-ip>

# Stop / terminate
aws ec2 stop-instances --instance-ids i-1234567890abcdef0
aws ec2 terminate-instances --instance-ids i-1234567890abcdef0
```

#### User Data (startup script)
```bash
#!/bin/bash
set -euo pipefail
yum update -y
yum install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user
```

Runs once at first boot as root. Use it to install packages, pull configs, start services.

#### Instance Profiles
An instance profile is the mechanism that gives EC2 instances an IAM role. When your code running on EC2 calls `boto3.client('s3')`, it automatically gets temporary credentials from the instance metadata service at `169.254.169.254`.

```bash
# Check what role the instance is using
curl http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

---

### S3 — Simple Storage Service

#### Core Operations
```bash
# Create bucket
aws s3 mb s3://my-unique-bucket-name --region us-east-1

# Upload/download
aws s3 cp ./file.txt s3://my-bucket/folder/file.txt
aws s3 cp s3://my-bucket/folder/file.txt ./file.txt

# Sync directory
aws s3 sync ./dist s3://my-bucket/dist --delete

# List
aws s3 ls s3://my-bucket/
aws s3 ls s3://my-bucket/ --recursive --human-readable

# Delete
aws s3 rm s3://my-bucket/file.txt
aws s3 rm s3://my-bucket/folder/ --recursive
```

#### Bucket Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCIAccess",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789:role/github-actions-role"
      },
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::my-bucket/*"
    }
  ]
}
```

#### Versioning and Lifecycle
```bash
# Enable versioning
aws s3api put-bucket-versioning \
  --bucket my-bucket \
  --versioning-configuration Status=Enabled

# Lifecycle rule (transition to Glacier after 90 days, delete after 365)
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket \
  --lifecycle-configuration file://lifecycle.json
```

#### Presigned URLs (time-limited access)
```python
import boto3

s3 = boto3.client('s3')
url = s3.generate_presigned_url(
    'get_object',
    Params={'Bucket': 'my-bucket', 'Key': 'reports/q4.pdf'},
    ExpiresIn=3600   # 1 hour
)
# Anyone with this URL can download the file for 1 hour — no auth needed
```

---

### IAM — Identity and Access Management

#### Core Concepts
```
Users       — human identities (use roles instead wherever possible)
Groups      — collections of users sharing the same policies
Roles       — assumed by services, EC2 instances, Lambda, CI pipelines
Policies    — JSON documents that define permissions
```

**The golden rule: grant least privilege.** Start with no permissions and add only what's needed.

#### Policy Types
```
Identity-based policies  — attached to IAM users, groups, or roles
Resource-based policies  — attached to the resource itself (S3 bucket policy, SQS queue policy)
Service control policies — applied at AWS Organizations level (affect entire accounts)
```

#### Writing a Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::my-app-bucket/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-app-bucket"
    }
  ]
}
```

#### IAM Role (for a Service)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

This trust policy says: EC2 instances can assume this role. Attach the trust policy when creating the role; attach permission policies to define what the role can do.

#### CLI Operations
```bash
# Create role with trust policy
aws iam create-role \
  --role-name MyAppRole \
  --assume-role-policy-document file://trust-policy.json

# Attach managed policy to role
aws iam attach-role-policy \
  --role-name MyAppRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Attach inline policy
aws iam put-role-policy \
  --role-name MyAppRole \
  --policy-name S3WriteAccess \
  --policy-document file://s3-write-policy.json

# Who am I?
aws sts get-caller-identity

# Simulate a policy (check what actions are allowed)
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::123456789:role/MyAppRole \
  --action-names s3:PutObject \
  --resource-arns arn:aws:s3:::my-bucket/*
```

#### IAM Best Practices
```
✓ Use roles for everything — EC2, Lambda, EKS pods (never hardcode keys)
✓ Enable MFA on root and human IAM users
✓ Enable CloudTrail to log all API calls
✓ Use IAM Access Analyzer to find over-permissive policies
✓ Rotate access keys regularly (or eliminate them with OIDC)
✗ Never use root account for day-to-day operations
✗ Never embed access keys in code or Docker images
```

## Examples

### Setting Up a Deployment Role
```bash
# 1. Create the trust policy (allows GitHub Actions to assume the role)
cat > trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:myorg/myrepo:*"
      }
    }
  }]
}
EOF

# 2. Create the role
aws iam create-role --role-name github-actions-deploy --assume-role-policy-document file://trust-policy.json

# 3. Attach deployment permissions
aws iam put-role-policy \
  --role-name github-actions-deploy \
  --policy-name deploy-permissions \
  --policy-document file://deploy-policy.json
```

## Exercises

1. Launch a t3.micro EC2 instance with a user data script that installs and starts nginx. SSH in and verify nginx is running. Then describe the instance using the AWS CLI and extract the public IP with `--query`.
2. Create an S3 bucket with versioning enabled. Upload three versions of the same file. Use `aws s3api list-object-versions` to see all versions. Delete the latest version and verify the previous version is accessible.
3. Create an IAM role for EC2 with a policy that allows read-only access to a specific S3 bucket. Attach the role to an EC2 instance. SSH in and verify `aws s3 ls s3://your-bucket` works without configuring credentials.
4. Write a least-privilege IAM policy that allows only `s3:PutObject` on a specific bucket path (`s3:::my-bucket/uploads/*`). Test it with `aws iam simulate-principal-policy`. Then add `s3:DeleteObject` and re-test.


---

### Quick Checks

5. Extract the S3 bucket name from an ARN. Run: `echo "arn:aws:s3:::my-app-bucket-prod" | cut -d: -f6`

```expected_output
my-app-bucket-prod
```

6. Extract the account ID from an IAM ARN. Run: `echo "arn:aws:iam::123456789012:role/MyRole" | cut -d: -f5`

```expected_output
123456789012
```

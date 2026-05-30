---
title: boto3 — AWS SDK
module: python
duration_min: 25
difficulty: intermediate
tags: [python, boto3, aws, s3, ec2, iam, automation]
exercises: 4
---

## Overview

boto3 is the official AWS SDK for Python, maintained by AWS and built on top of the lower-level `botocore` library. Every major AWS service — EC2, S3, Lambda, ECS, RDS, Route53, SSM, Secrets Manager — has a boto3 client, and most DevOps automation that runs on or targets AWS will use it. Whether you're writing a deployment script, a Lambda function that rotates credentials, a CI pipeline step that invalidates a CloudFront distribution, or a compliance tool that audits resource tagging, you're writing boto3. Understanding its patterns well means you can automate anything in AWS without reaching for the console.

boto3's design reflects two guiding principles. First, it mirrors the AWS API surface almost exactly — the method names, response shapes, and parameter names in boto3 match the underlying HTTP API documented in the AWS reference. This means the AWS documentation and the SDK are always in sync: if you know the API call, you know the boto3 call. Second, it handles the undifferentiated heavy lifting of cloud API interaction: automatic retries with exponential backoff, streaming multipart transfers, paginator abstractions over cursor-based APIs, and a flexible credential chain that works the same whether your code runs on a laptop, an EC2 instance, or a Lambda function.

In the DevOps toolchain, boto3 fills the gap between infrastructure-as-code tools (Terraform, CloudFormation) and day-to-day operational scripts. IaC tools declare desired state; boto3 scripts query current state, react to events, orchestrate workflows, and automate tasks that don't map cleanly to resource definitions. It's also how you extend other tools: custom Terraform providers, Ansible modules targeting AWS, and serverless event handlers are all boto3 at the core.

---

## Concepts

### Clients vs Resources

boto3 exposes two distinct programming interfaces for interacting with AWS services.

| | Client | Resource |
|---|---|---|
| Level | Low-level, mirrors the REST API exactly | High-level, object-oriented wrapper |
| Returns | Plain Python dicts | Python objects with attributes and methods |
| Coverage | Every AWS service | EC2, S3, IAM, SQS, Glacier only |
| API shape | Matches AWS documentation 1:1 | Abstracts over common patterns |
| Prefer when | Full API access needed, any service | EC2/S3 convenience, cleaner code |

```python
import boto3

# Client — always works, returns dicts
s3_client = boto3.client("s3", region_name="us-east-1")
response = s3_client.list_buckets()
# response is a dict: {"Buckets": [...], "Owner": {...}, "ResponseMetadata": {...}}

# Resource — higher-level, EC2/S3/IAM/SQS only
s3 = boto3.resource("s3")
bucket = s3.Bucket("my-bucket")
for obj in bucket.objects.all():   # returns ObjectSummary objects, not dicts
    print(obj.key, obj.size)
```

**Which to use in practice:** For new code targeting EC2 or S3, resources are more ergonomic. For any other service, use clients — there is no resource interface. For production scripts where you need predictable response shapes and the full API surface, clients are safer. Many teams standardize on clients everywhere to avoid mixing paradigms.

**Important:** The Resource interface is in maintenance mode. AWS has not extended it to new services and has stated it will not. Don't build new abstractions on top of it.

---

### Authentication and the Credential Chain

boto3 resolves credentials automatically by walking a chain of providers in order. You almost never need to hardcode credentials — instead, you configure the environment correctly and boto3 finds them.

**Credential resolution order:**

| Priority | Source | How to configure |
|----------|--------|-----------------|
| 1 | Explicit in code | `boto3.client("s3", aws_access_key_id=..., aws_secret_access_key=...)` |
| 2 | Environment variables | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` |
| 3 | AWS CLI config file | `~/.aws/credentials` (named profiles) |
| 4 | AWS config file | `~/.aws/config` (role assumption, SSO) |
| 5 | Container credentials | ECS task role, injected via metadata endpoint |
| 6 | EC2 instance metadata | IAM role attached to the instance |

**Hardcoding credentials in source code is never acceptable.** Use environment variables in CI, instance/task roles in AWS, and named profiles locally.

```python
# Named profile — for multi-account local development
session = boto3.Session(profile_name="prod-account")
s3 = session.client("s3")

# Explicit region (override the profile's default)
ec2 = session.client("ec2", region_name="eu-west-1")
```

**Cross-account access via role assumption** is the standard pattern for multi-account deployments. Your script runs with credentials from account A, assumes a role in account B, and operates there:

```python
import boto3

def assume_role(role_arn: str, session_name: str) -> boto3.Session:
    """
    Assume an IAM role and return a boto3 Session using the temporary credentials.
    The calling principal must have sts:AssumeRole permission on the target role.
    """
    sts = boto3.client("sts")
    response = sts.assume_role(
        RoleArn=role_arn,
        RoleSessionName=session_name,
        DurationSeconds=3600,   # max 1h for most roles; up to 12h if role allows
    )
    creds = response["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],   # required — these are temporary creds
    )

target_session = assume_role(
    "arn:aws:iam::123456789012:role/DeployRole",
    "deploy-session"
)
ec2 = target_session.client("ec2", region_name="us-east-1")
```

**Session token gotcha:** Temporary credentials from `assume_role`, SSO, or MFA always require `aws_session_token`. If you pass `AccessKeyId` and `SecretAccessKey` from a temporary credential without the session token, every API call will return `InvalidClientTokenId`.

---

### S3 Operations

S3 is the most common boto3 target in DevOps scripts. The key distinction is between the **transfer methods** (`upload_file`, `download_file`) and the **API methods** (`put_object`, `get_object`).

```python
import json
import boto3

s3 = boto3.client("s3")

# --- Bucket operations ---
buckets = s3.list_buckets()["Buckets"]
for b in buckets:
    print(b["Name"], b["CreationDate"])

# --- Object listing (paginated — see Pagination section) ---
response = s3.list_objects_v2(Bucket="my-bucket", Prefix="logs/2024/")
for obj in response.get("Contents", []):   # "Contents" absent if prefix matches nothing
    print(obj["Key"], obj["Size"])

# --- Upload/download via Transfer Manager ---
# These use multipart upload for large files, automatic retries, and concurrency.
# Prefer these over put_object/get_object for files on disk.
s3.upload_file("local.txt", "my-bucket", "remote/path/local.txt")
s3.download_file("my-bucket", "remote/path/local.txt", "local_copy.txt")

# Upload with metadata and server-side encryption
s3.upload_file(
    "artifact.tar.gz",
    "deploy-artifacts",
    "releases/v1.2.3/artifact.tar.gz",
    ExtraArgs={
        "ServerSideEncryption": "AES256",
        "Metadata": {"git-sha": "abc1234", "built-by": "ci"},
    },
)

# --- Read object content into memory (no temp file) ---
body = s3.get_object(Bucket="my-bucket", Key="config.json")["Body"].read()
config = json.loads(body)

# --- Streaming large objects (avoid loading into memory) ---
response = s3.get_object(Bucket="my-bucket", Key="large-export.csv")
with open("output.csv", "wb") as f:
    for chunk in response["Body"].iter_chunks(chunk_size=65536):
        f.write(chunk)

# --- Delete ---
s3.delete_object(Bucket="my-bucket", Key="old-file.txt")

# Bulk delete (up to 1000 objects per call)
s3.delete_objects(
    Bucket="my-bucket",
    Delete={"Objects": [{"Key": "a.txt"}, {"Key": "b.txt"}]},
)

# --- Pre-signed URL (share private object without AWS credentials) ---
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "my-bucket", "Key": "report.pdf"},
    ExpiresIn=3600,   # seconds
)
```

**`list_objects_v2` vs `list_objects`:** Always use `list_objects_v2`. The original `list_objects` is a legacy API. `list_objects_v2` is more efficient, supports continuation tokens properly, and is what AWS recommends.

**`put_object` vs `upload_file`:** `put_object` is a single HTTP PUT — it will fail or produce a corrupted object for files over 5 GB, and has no retry logic for partial failures. `upload_file` uses the S3 Transfer Manager, which automatically switches to multipart upload above a configurable threshold (default 8 MB) and retries failed parts. Use `upload_file` for anything going to or from disk.

---

### EC2 Operations

EC2's API response structure is unusual: instances are nested inside Reservations, a historical artifact from the original AWS API design.

```python
ec2 = boto3.client("ec2")

# --- List running instances ---
response = ec2.describe_instances(
    Filters=[{"Name": "instance-state-name", "Values": ["running"]}]
)

for reservation in response["Reservations"]:       # outer loop: reservation groups
    for instance in reservation["Instances"]:      # inner loop: actual instances
        name = next(
            (t["Value"] for t in instance.get("Tags", []) if t["Key"] == "Name"),
            "unnamed",
        )
        print(
            instance["InstanceId"],
            name,
            instance.get("PrivateIpAddress", "no-ip"),
            instance["InstanceType"],
        )

# --- Filter by tag ---
response = ec2.describe_instances(
    Filters=[
        {"Name": "tag:Environment", "Values": ["production"]},
        {"Name": "instance-state-name", "Values": ["running", "stopped"]},
    ]
)

# --- Start / stop / terminate ---
ec2.start_instances(InstanceIds=["i-1234567890abcdef0"])
ec2.stop_instances(InstanceIds=["i-1234567890abcdef0"])
ec2.terminate_instances(InstanceIds=["i-1234567890abcdef0"])  # irreversible

# --- Waiters: block until state is reached ---
# Waiters poll the API with backoff. Much better than time.sleep() loops.
waiter = ec2.get_waiter("instance_running")
waiter.wait(
    InstanceIds=["i-1234567890abcdef0"],
    WaiterConfig={"Delay": 10, "MaxAttempts": 30},  # poll every 10s, up to 5 min
)
print("Instance is running")
```

**Available EC2 waiters** (most commonly used):

| Waiter name | Waits for |
|-------------|-----------|
| `instance_running` | Instance reaches `running` state |
| `instance_stopped` | Instance reaches `stopped` state |
| `instance_terminated` | Instance reaches `terminated` state |
| `instance_status_ok` | Instance passes both status checks |
| `image_available` | AMI snapshot is complete |
| `snapshot_completed` | EBS snapshot is complete |

**Reservation gotcha:** `describe_instances` returns `Reservations`, not a flat list of instances. A Reservation can contain multiple instances (from the same `RunInstances` call). Always double-loop. Forgetting the outer loop and iterating `response["Reservations"]` directly will give you dicts with `Instances` keys, not instance data.

---

### Pagination

AWS API responses are paginated. `list_objects_v2` returns at most 1000 objects. `describe_instances` returns at most 1000 instances. `describe_log_streams` returns at most 50 streams. If you don't paginate, you silently get incomplete data — one of the most common bugs in boto3 scripts.

**Use paginators. Always.**

```python
s3 = boto3.client("s3")

# Manual pagination — works but verbose and error-prone
response = s3.list_objects_v2(Bucket="my-bucket", Prefix="data/")
all_keys = [obj["Key"] for obj in response.get("Contents", [])]
while response.get("IsTruncated"):
    response = s3.list_objects_v2(
        Bucket="my-bucket",
        Prefix="data/",
        ContinuationToken=response["NextContinuationToken"],
    )
    all_keys.extend(obj["Key"] for obj in response.get("Contents", []))

# Paginator — the boto3 way; handles continuation tokens automatically
paginator = s3.get_paginator("list_objects_v2")
pages = paginator.paginate(Bucket="my-bucket", Prefix="data/")

all_keys = []
for page in pages:
    for obj in page.get("Contents", []):
        all_keys.append(obj["Key"])

# Paginator with ceiling — stop after 5000 total results regardless of bucket size
pages = paginator.paginate(
    Bucket="my-bucket",
    Prefix="logs/",
    PaginationConfig={"MaxItems": 5000, "PageSize": 500},
)

# EC2 paginator — same pattern, different service
ec2 = boto3.client("ec2")
paginator = ec2.get_paginator("describe_instances")
for page in paginator.paginate(Filters=[{"Name": "instance-state-name", "Values": ["running"]}]):
    for reservation in page["Reservations"]:
        for instance in reservation["Instances"]:
            print(instance["InstanceId"])
```

**Checking paginator availability:**
```python
client = boto3.client("ec2")
print(client.can_paginate("describe_instances"))  # True
print(client.can_paginate("run_instances"))        # False
```

**Which operations need pagination:**

| Service | Operation | Default page size |
|---------|-----------|-------------------|
| S3 | `list_objects_v2` | 1,000 objects |
| EC2 | `describe_instances` | 1,000 instances |
| EC2 | `describe_snapshots` | 1,000 snapshots |
| CloudWatch Logs | `describe_log_streams` | 50 streams |
| IAM | `list_users` | 100 users |
| Route53 | `list_resource_record_sets` | 300 records |

**Silent truncation is the danger.** A script that lists IAM users in a small account will work fine for years, then silently return only the first 100 users after the org grows. Always use paginators from the start.

---

### Error Handling

boto3 raises exceptions from the `botocore.exceptions` module. Understanding the error hierarchy lets you handle expected failure modes cleanly while letting unexpected errors propagate.

```python
from botocore.exceptions import ClientError, NoCredentialsError

def get_secret(secret_name: str) -> str:
    client = boto3.client("secretsmanager", region_name="us-east-1")
    try:
        response = client.get_secret_value(SecretId=secret_name)
        return response["SecretString"]

    except ClientError as e:
        # ClientError wraps all HTTP 4xx/5xx responses from the AWS API.
        # The error code is in the response dict — not encoded in the exception class.
        code = e.response["Error"]["Code"]

        if code == "ResourceNotFoundException":
            raise KeyError(f"Secret '{secret_name}' does not exist") from e
        elif code == "AccessDeniedException":
            raise PermissionError(f"No access to secret '{secret_name}'") from e
        elif code == "ThrottlingException":
            # Caller should implement retry; re-raise so the caller decides
            raise
        else:
            # Unexpected AWS error — let it propagate with full context
            raise

    except NoCredentialsError:
        raise RuntimeError("No AWS credentials found. Configure ~/.aws/credentials or set env vars.") from None
```

**Common `ClientError` codes by service:**

| Service | Code | Meaning |
|---------|------|---------|
| S3 | `NoSuchBucket` | Bucket does not exist |
| S3 | `NoSuchKey` | Object key not found |
| EC2 | `InvalidInstanceID.NotFound` | Instance ID doesn't exist |
| IAM | `EntityAlreadyExists` | User/role/policy already exists |
| SecretsManager | `ResourceNotFoundException` | Secret not found |
| Any | `AccessDeniedException` | IAM permission denied |
| Any | `ThrottlingException` | Rate limit exceeded |
| Any | `RequestExpired` | System clock skew too large (>5 min) |

**The `RequestExpired` gotcha:** If your clock is more than 5 minutes off from AWS time, every API call fails with `RequestExpired`. This is common in VMs that were suspended and resumed. Fix with `sudo ntpdate -u pool.ntp.org` or `chronyc makestep`.

**Don't catch `Exception` broadly.** Catch `ClientError` and inspect the code. Catching everything masks misconfiguration, credential issues, and SDK bugs that should surface immediately.

```python
# Pattern: idempotent resource creation
def ensure_bucket_exists(bucket_name: str, region: str) -> None:
    s3 = boto3.client("s3", region_name=region)
    try:
        s3.create_bucket(
            Bucket=bucket_name,
            CreateBucketConfiguration={"LocationConstraint": region},
        )
        print(f"Created bucket {bucket_name}")
    except ClientError as e:
        if e.response["Error"]["Code"] == "BucketAlreadyOwnedByYou":
            print(f"Bucket {bucket_name} already exists — continuing")
        else:
            raise
```

---

### SSM Parameter Store and Secrets Manager

These two services are the standard way to inject configuration and credentials into applications. boto3 is how scripts and Lambda functions retrieve them at runtime.

```python
import boto3
import json

ssm = boto3.client("ssm", region_name="us-east-1")

# --- Read a single parameter ---
response = ssm.get_parameter(
    Name="/myapp/prod/db_host",
    WithDecryption=True,   # required for SecureString parameters; no-op for String
)
db_host = response["Parameter"]["Value"]

# --- Read multiple parameters at once (cheaper than N individual calls) ---
response = ssm.get_parameters(
    Names=[
        "/myapp/prod/db_host",
        "/myapp/prod/db_port",
        "/myapp/prod/db_name",
    ],
    WithDecryption=True,
)
params = {p["Name"]: p["Value"] for p in response["Parameters"]}
# response["InvalidParameters"] lists names that didn't exist — always check this
if response["InvalidParameters"]:
    raise ValueError(f"Missing parameters: {response['InvalidParameters']}")

# --- Read all parameters under a path (paginated) ---
paginator = ssm.get_paginator("get_parameters_by_path")
all_params = {}
for page in paginator.paginate(Path="/myapp/prod/", WithDecryption=True, Recursive=True):
    for p in page["Parameters"]:
        all_params[p["Name"]] = p["Value"]

# --- Secrets Manager (for credentials, API keys, anything that rotates) ---
sm = boto3.client("secretsmanager", region_name="us-east-1")

response = sm.get_secret_value(SecretId="myapp/prod/db_credentials")
# Secret may be a plain string or a JSON blob
secret = json.loads(response["SecretString"])
db_password = secret["password"]
```

**SSM Parameter Store vs Secrets Manager:**

| | Parameter Store | Secrets Manager |
|---|---|---|
| Cost | Free (Standard tier) | $0.40/secret/month |
| Automatic rotation | No | Yes (Lambda-based) |
| Cross-account access | With resource policy | With resource policy |
| Best for | Config values, feature flags, non-rotating secrets | Passwords, API keys, anything that rotates |

**`WithDecryption=True` is not optional for SecureString.** If you omit it, you get the raw encrypted ciphertext — not an error. This is a silent failure mode that can propagate garbage values into your application.

---

## Examples

### Example 1: S3 Artifact Cleanup — Delete Objects Older Than N Days

A common CI/CD maintenance task: remove build artifacts from S3 that are older than a retention window to control storage costs.

```python
#!/usr/bin/env python3
"""
s3_cleanup.py — Delete S3 objects older than RETENTION_DAYS under a given prefix.

Usage:
    python s3_cleanup.py --bucket my-artifacts --prefix builds/ --days 30 --dry-run
    python s3_cleanup.py --bucket my-artifacts --prefix builds/ --days 30
"""

import argparse
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError


def delete_old_objects(bucket: str, prefix: str, days: int, dry_run: bool) -> None:
    s3 = boto3.client("s3")
    paginator = s3.get_paginator("list_objects_v2")

    cutoff = datetime.now(timezone.utc).timestamp() - (days * 86400)
    to_delete = []

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            # LastModified is a timezone-aware datetime object
            if obj["LastModified"].timestamp() < cutoff:
                to_delete.append({"Key": obj["Key"]})
                print(f"  {'[DRY RUN] ' if dry_run else ''}Marking for deletion: {obj['Key']} "
                      f"({obj['Size']} bytes, modified {obj['LastModified'].date()})")

    if not to_delete:
        print("No objects to delete.")
        return

    if dry_run:
        print(f"\nDry run: would delete {len(to_delete)} objects.")
        return

    # delete_objects accepts at most 1000 keys per call — chunk accordingly
    for i in range(0, len(to_delete), 1000):
        chunk = to_delete[i:i + 1000]
        response = s3.delete_objects(Bucket=bucket, Delete={"Objects": chunk})
        deleted = len(response.get("Deleted", []))
        errors = response.get("Errors", [])
        print(f"Deleted {deleted} objects.", end="")
        if errors:
            print(f" {len(errors)} errors: {errors}")
        else:
            print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    delete_old_objects(args.bucket, args.prefix, args.days, args.dry_run)
```

**Verify it worked:**
```bash
# Run dry-run first
python s3_cleanup.py --bucket my-artifacts --prefix builds/ --days 30 --dry-run

# Execute
python s3_cleanup.py --bucket my-artifacts --prefix builds/ --days 30

# Confirm remaining objects
aws s3 ls s3://my-artifacts/builds/ --recursive | wc -l
```

---

### Example 2: EC2 Instance Inventory with Tag Enforcement

Query all EC2 instances across a region, report their state and tags, and flag any missing required tags — useful for cost allocation audits.

```python
#!/usr/bin/env python3
"""
ec2_inventory.py — List all EC2 instances and flag missing required tags.
Exits with code 1 if any instance is missing a required tag (useful in CI).
"""

import sys
import boto3

REQUIRED_TAGS = {"Environment", "Owner", "CostCenter"}

def get_instance_tags(instance: dict) -> dict:
    return {t["Key"]: t["Value"] for t in instance.get("Tags", [])}

def audit_instances(region: str) -> bool:
    ec2 = boto3.client("ec2", region_name=region)
    paginator = ec2.get_paginator("describe_instances")

    violations = []
    total = 0

    for page in paginator.paginate():
        for reservation in page["Reservations"]:
            for instance in reservation["Instances"]:
                # Skip terminated instances — they can't be tagged retroactively
                if instance["State"]["Name"] == "terminated":
                    continue

                total += 1
                tags = get_instance_tags(instance)
                missing = REQUIRED_TAGS - set(tags.keys())

                name = tags.get("Name", "<unnamed>")
                state = instance["State"]["Name"]
                itype = instance["InstanceType"]

                status = "OK" if not missing else f"MISSING: {', '.join(sorted(missing))}"
                print(f"  {instance['InstanceId']:25s}  {name:30s}  {state:10s}  {itype:15s}  {status}")

                if missing:
                    violations.append(instance["InstanceId"])

    print(f"\nTotal: {total} instances, {len(violations)} with missing tags.")
    return len(violations) == 0


if __name__ == "__main__":
    region = sys.argv[1] if len(sys.argv) > 1 else "us-east-1"
    print(f"Auditing EC2 instances in {region}...\n")
    clean = audit_instances(region)
    sys.exit(0 if clean else 1)
```

**Verify:**
```bash
python ec2_inventory.py us-east-1
echo "Exit code: $?"   # 0 = all tagged, 1 = violations found

# Pipe to a file for the compliance report
python ec2_inventory.py us-east-1 > ec2_audit_$(date +%Y%m%d).txt
```

---

### Example 3: Cross-Account Secret Retrieval with Role Assumption

A Lambda function running in the tooling account needs to fetch a database password stored in Secrets Manager in the production account.

```python
#!/usr/bin/env python3
"""
cross_account_secret.py — Retrieve a secret from a different AWS account via role assumption.

IAM prerequisites:
  - Calling principal has sts:AssumeRole on arn:aws:iam::PROD_ACCOUNT:role/SecretReaderRole
  - SecretReaderRole trust policy allows the calling principal
  - SecretReaderRole has secretsmanager:GetSecretValue on the target secret
"""

import json
import boto3
from botocore.exceptions import ClientError


PROD_ACCOUNT_ID = "123456789012"
READER_ROLE = f"arn:aws:iam::{PROD_ACCOUNT_ID}:role/SecretReaderRole"
SECRET_NAME = "myapp/prod/db_credentials"
REGION = "us-east-1"


def get_cross_account_secret(role_arn: str, secret_name: str, region: str) -> dict:
    # Step 1: assume the role in the target account
    sts = boto3.client("sts")
    try:
        assumed = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName="secret-fetch",
            DurationSeconds=900,   # 15 min is enough for a single operation
        )
    except ClientError as e:
        raise RuntimeError(f"Could not assume role {role_arn}: {e}") from e

    creds = assumed["Credentials"]

    # Step 2: build a session using the temporary credentials
    session = boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )

    # Step 3: retrieve the secret using the assumed identity
    sm = session.client("secretsmanager", region_name=region)
    try:
        response = sm.get_secret_value(SecretId=secret_name)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "ResourceNotFoundException":
            raise KeyError(f"Secret '{secret_name}' not found in account") from e
        raise

    return json.loads(response["SecretString"])


if __name__ == "__main__":
    secret = get_cross_account_secret(READER_ROLE, SECRET_NAME, REGION)
    # Never print secrets in production — this is for demonstration only
    print(f"Retrieved secret with keys: {list(secret.keys())}")
```

**Verify:**
```bash
# Check which identity you're currently using
aws sts get-caller-identity

# Run the script
python cross_account_secret.py

# Verify role assumption worked by checking CloudTrail in the target account:
# Event: AssumeRole, Source: your tooling account principal
```

---

### Example 4: Parameter Store Config Loader for a 12-Factor App

Load all configuration for an application from SSM Parameter Store at startup, falling back to environment variables for local development.

```python
#!/usr/bin/env python3
"""
config_loader.py — Load app config from SSM Parameter Store with local env fallback.

In production: parameters live at /myapp/{env}/{key}
Locally: set the same keys as environment variables (without the path prefix).

Usage:
    config = load_config(app="myapp", env="prod", region="us-east-1")
    db_host = config["db_host"]
"""

import os
import boto3
from botocore.exceptions import ClientError, NoCredentialsError


def load_config(app: str, env: str, region: str) -> dict:
    """
    Returns a flat dict of config values. Keys are the final path component:
    /myapp/prod/db_host -> {"db_host": "..."}
    """
    ssm_path = f"/{app}/{env}/"

    try:
        ssm = boto3.client("ssm", region_name=region)
        paginator = ssm.get_paginator("get_parameters_by_path")
        config = {}

        for page in paginator.paginate(
            Path=ssm_path,
            WithDecryption=True,   # decrypt SecureString params transparently
            Recursive=False,       # don't descend into sub-paths
        ):
            for param in page["Parameters"]:
                # Strip the path prefix to get a clean key name
                key = param["Name"].removeprefix(ssm_path)
                config[key] = param["Value"]

        if not config:
            raise ValueError(f"No parameters found at path {ssm_path}")

        return config

    except (NoCredentialsError, ClientError):
        # Local fallback: read from environment variables
        print(f"[config] SSM unavailable, falling back to environment variables")
        keys = ["db_host", "db_port", "db_name", "db_user", "db_password", "log_level"]
        config = {}
        for key in keys:
            val = os.environ.get(key.upper())
            if val is not None:
                config[key] = val
        return config


if __name__ == "__main__":
    cfg = load_config(app="myapp", env="prod", region="us-east-1")
    print(f"Loaded {len(cfg)} config values: {list(cfg.keys())}")

    # Demonstrate safe usage: log keys but not values
    for key in sorted(cfg):
        masked = cfg[key] if "password" not in key else "***"
        print(f"  {key} = {masked}")
```

**Setup and verify:**
```bash
# Write test parameters to SSM
aws ssm put-parameter --name "/myapp/prod/db_host" --value "prod-db.internal" --type String
aws ssm put-parameter --name "/myapp/prod/db_port" --value "5432" --type String
aws ssm put-parameter --name "/myapp/prod/db_password" --value "s3cr3t" --type SecureString

# Run the loader
python config_loader.py

# Verify the parameter exists and is readable
aws ssm get-parameter --name "/myapp/prod/db_host" --with-decryption
```

---

## Exercises

### Exercise 1: Paginated S3 Inventory

Write a script that accepts a bucket name as a command-line argument and prints a summary: total object count, total size in MB, and the 5 largest objects by size. The bucket will have more than 1000 objects — your solution must paginate correctly or it will produce wrong answers.

**Requirements:**
- Use a paginator, not manual token management
- Format the size output in human-readable MB (2 decimal places)
- The 5 largest objects should be sorted descending by size

**Verify:** Create a bucket with more than 1000 objects using the AWS CLI:
```bash
for i in $(seq 1 1200); do aws s3 cp /dev/urandom s3://my-test-bucket/obj-$i --content-length 1024 2>/dev/null; done
```
Then confirm your script's count matches `aws s3 ls s3://my-test-bucket --recursive | wc -l`.

---

### Exercise 2: EC2 Start/Stop with Waiter

Write a function `cycle_instance(instance_id: str)` that stops a running EC2 instance, waits for it to reach `stopped` state, then starts it again and waits for it to reach `running` state. Print a timestamped log line at each state transition.

**Requirements:**
- Use waiters — no `time.sleep()` loops
- Handle the case where the instance is already stopped (start it directly)
- The function should raise a clear error if the instance ID doesn't exist

**Stretch goal:** Accept a `--dry-run` flag that calls the EC2 API with `DryRun=True` to validate IAM permissions without actually stopping the instance.

---

### Exercise 3: Multi-Account IAM Audit

Write a script that assumes a read-only role in a target account (provide the role ARN as an argument) and lists all IAM users who have not used their password in more than 90 days (check `PasswordLastUsed` on the user object). Output a CSV with columns: `username,last_used,days_inactive`.

**Requirements:**
- Use role assumption — do not hardcode credentials
- Use a paginator for `list_users`
- Handle users who have never logged in (`PasswordLastUsed` may be absent)
- Exit code 1 if any inactive users are found (useful in a CI compliance gate)

**Verify:** Compare your output against:
```bash
aws iam generate-credential-report
aws iam get-credential-report --query 'Content' --output text | base64 -d
```

---

### Exercise 4: SSM Parameter Bulk Migration

You have a set of plaintext SSM parameters under `/myapp/staging/` and need to copy them to `/myapp/prod/` as `SecureString` (KMS-encrypted) parameters. Write a script that:

1. Read all parameters under the source path using `get_parameters_by_path`
2. Write each one to the destination path as `SecureString` using the account's default KMS key (`alias/aws/ssm`)
3. Skip any parameter that already exists at the destination (idempotent)
4. Print a summary: created, skipped, failed

**Requirements:**
- Handle `ParameterAlreadyExists` as a skip, not an error
- Use `--overwrite False` behavior (do not overwrite existing destination params)
- Paginate the source read
- Accept `--src-path` and `--dst-path` as CLI arguments

**Verify:**
```bash
# After running, list destination params
aws ssm get-parameters-by-path --path /myapp/prod/ --with-decryption \
  --query 'Parameters[*].{Name:Name,Type:Type}' --output table
```

---

### Quick Checks

1. Filter a list of instance dicts by state — the same pattern boto3 responses require.

   ```python
   instances = [{'id': 'i-1', 'state': 'running'}, {'id': 'i-2', 'state': 'stopped'}]; print([i['id'] for i in instances if i['state'] == 'running'])
   ```

   ```expected_output
   ['i-1']
   ```

hint: Think about how you can loop through or filter a list of dictionaries by checking the value of a specific key in each dict.
hint: Use a list comprehension with a condition like `if instance['state'] == 'running'` to select only the matching instances, then extract the instance id.

2. Build a flat dict from a list of AWS-style tag records.

   ```python
   tags = [{'Key': 'Env', 'Value': 'prod'}, {'Key': 'Team', 'Value': 'ops'}]; print({t['Key']: t['Value'] for t in tags})
   ```

   ```expected_output
   {'Env': 'prod', 'Team': 'ops'}
   ```
hint: Think about how you can iterate over a list of dictionaries and extract specific key-value pairs to build a new dictionary.
hint: Use a dict comprehension with the pattern {item['Key']: item['Value'] for item in tags} to map each tag record into a flat dictionary.

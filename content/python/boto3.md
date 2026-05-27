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

**Reservation gotcha:** `describe_instances` returns `Reservations`, not a flat list of instances. A Reservation can contain multiple instances (from the same RunInstances call). Always double-loop. Forgetting the outer loop and iterating `response["Reservations"]` directly will give you dicts with `Instances` keys, not instance data.

---

### Pagination

AWS API responses are paginated. `list_objects_v2` returns at most 1000 objects. `describe_instances` returns at most 1000 instances. `describe_log_streams` returns at most 50 streams. If you don't paginate, you silently get incomplete data — one of the most common bugs in boto3 scripts.

**Use paginators. Always.**

```python
# Manual pagination — works but verbose
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

# Paginator with filtering (server-side, reduces data transfer)
pages = paginator.paginate(
    Bucket="my-bucket",
    Prefix="logs/",
    PaginationConfig={"MaxItems": 5000, "PageSize": 500},  # stop after 5000 total
)
```

**Checking paginator availability:**
```python
# See all paginatable operations for a service
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

---

### Error Handling

boto3 raises exceptions from the `botocore.exceptions` module. Understanding the error hierarchy lets you handle expected failure modes cleanly while letting unexpected errors propagate.

```python
from botocore.exceptions import ClientError, NoCredentialsError, EndpointResolutionError

def get_secret(secret_name: str) -> str:
    client = boto3.client("secretsmanager", region_name="us-east-1")
    try:
        response = client.get_secret_value(SecretId=secret_name)
        return response["SecretString"]

    except ClientError as e:
        # ClientError wraps all HTTP 4xx/5xx responses from the AWS API.
        # The error code is inside the response dict — not in the exception class.
        code = e.response["Error"]["Code"]
        message = e.response["Error"]["Message"]

        if code == "ResourceNotFoundException":
            raise KeyError(f"Secret '{secret_name}' does not exist") from e
        elif code == "AccessDeniedException":
            raise PermissionError(f"No access to secret '{
---
title: boto3 — AWS SDK
module: python
duration_min: 25
difficulty: intermediate
tags: [python, boto3, aws, s3, ec2, iam, automation]
exercises: 4
---

## Overview
boto3 is the official AWS SDK for Python. Every major AWS service — EC2, S3, Lambda, ECS, RDS, Route53 — has a boto3 client. Learning boto3 means you can write infrastructure scripts, automate deployments, query resource state, and build custom tooling on top of AWS without clicking through the console. This lesson covers the patterns that come up in almost every real boto3 script.

## Concepts

### Clients vs Resources
boto3 has two interfaces for most services:

| | Client | Resource |
|---|---|---|
| Level | Low-level, mirrors the API exactly | High-level, object-oriented wrapper |
| Returns | Dicts | Python objects with attributes |
| Coverage | Every service | EC2, S3, IAM, SQS, Glacier only |
| Prefer when | Full API access needed | EC2/S3 convenience |

```python
import boto3

# Client — always works
s3_client = boto3.client("s3", region_name="us-east-1")
ec2_client = boto3.client("ec2", region_name="us-east-1")

# Resource — higher-level, EC2/S3 only
s3 = boto3.resource("s3")
ec2 = boto3.resource("ec2")
```

### Authentication
boto3 uses the same credential chain as the AWS CLI:
1. Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
2. `~/.aws/credentials` file
3. IAM instance role (when running on EC2 or ECS)
4. IAM role for Lambda (automatic)

For multi-account scripts, use named profiles:
```python
session = boto3.Session(profile_name="prod-account")
s3 = session.client("s3")
```

For cross-account access, assume a role:
```python
sts = boto3.client("sts")
creds = sts.assume_role(
    RoleArn="arn:aws:iam::123456789012:role/DeployRole",
    RoleSessionName="deploy-session",
)["Credentials"]

session = boto3.Session(
    aws_access_key_id=creds["AccessKeyId"],
    aws_secret_access_key=creds["SecretAccessKey"],
    aws_session_token=creds["SessionToken"],
)
```

### S3
```python
s3 = boto3.client("s3")

# List buckets
buckets = s3.list_buckets()["Buckets"]
for b in buckets:
    print(b["Name"], b["CreationDate"])

# List objects in a bucket
response = s3.list_objects_v2(Bucket="my-bucket", Prefix="logs/2024/")
for obj in response.get("Contents", []):
    print(obj["Key"], obj["Size"])

# Upload file
s3.upload_file("local.txt", "my-bucket", "remote/path/local.txt")

# Download file
s3.download_file("my-bucket", "remote/path/local.txt", "local_copy.txt")

# Read object content directly (no temp file)
body = s3.get_object(Bucket="my-bucket", Key="config.json")["Body"].read()
import json
config = json.loads(body)

# Delete object
s3.delete_object(Bucket="my-bucket", Key="old-file.txt")

# Generate a pre-signed URL (expires in 1 hour)
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "my-bucket", "Key": "report.pdf"},
    ExpiresIn=3600,
)
```

### EC2
```python
ec2 = boto3.client("ec2")

# List running instances
response = ec2.describe_instances(
    Filters=[{"Name": "instance-state-name", "Values": ["running"]}]
)
for reservation in response["Reservations"]:
    for instance in reservation["Instances"]:
        name = next(
            (t["Value"] for t in instance.get("Tags", []) if t["Key"] == "Name"),
            "unnamed"
        )
        print(instance["InstanceId"], name, instance["PrivateIpAddress"])

# Start / stop
ec2.start_instances(InstanceIds=["i-1234567890abcdef0"])
ec2.stop_instances(InstanceIds=["i-1234567890abcdef0"])

# Wait for state change (blocks until done)
waiter = ec2.get_waiter("instance_running")
waiter.wait(InstanceIds=["i-1234567890abcdef0"])
print("Instance is running")
```

### Pagination
AWS API responses are paginated — `list_objects_v2` returns max 1000 items by default. Never assume you got everything. Use paginators:

```python
paginator = s3.get_paginator("list_objects_v2")
pages = paginator.paginate(Bucket="my-bucket", Prefix="data/")

all_keys = []
for page in pages:
    for obj in page.get("Contents", []):
        all_keys.append(obj["Key"])

print(f"Total objects: {len(all_keys)}")
```

### Error Handling
```python
from botocore.exceptions import ClientError, NoCredentialsError

try:
    s3.get_object(Bucket="my-bucket", Key="missing.txt")
except ClientError as e:
    code = e.response["Error"]["Code"]
    if code == "NoSuchKey":
        print("File not found")
    elif code == "AccessDenied":
        print("Permission denied")
    else:
        raise  # re-raise unexpected errors
except NoCredentialsError:
    print("AWS credentials not configured")
```

## Examples

### Script: Find Untagged EC2 Instances
```python
#!/usr/bin/env python3
import boto3

REQUIRED_TAGS = {"Environment", "Owner", "Project"}

ec2 = boto3.client("ec2", region_name="us-east-1")
paginator = ec2.get_paginator("describe_instances")

for page in paginator.paginate():
    for reservation in page["Reservations"]:
        for instance in reservation["Instances"]:
            if instance["State"]["Name"] == "terminated":
                continue
            tags = {t["Key"] for t in instance.get("Tags", [])}
            missing = REQUIRED_TAGS - tags
            if missing:
                print(f"{instance['InstanceId']} missing tags: {', '.join(missing)}")
```

### Script: Sync Local Directory to S3
```python
#!/usr/bin/env python3
import boto3
import sys
from pathlib import Path

local_dir = Path(sys.argv[1])
bucket = sys.argv[2]
prefix = sys.argv[3] if len(sys.argv) > 3 else ""

s3 = boto3.client("s3")
uploaded = 0

for path in local_dir.rglob("*"):
    if path.is_file():
        key = f"{prefix}/{path.relative_to(local_dir)}" if prefix else str(path.relative_to(local_dir))
        s3.upload_file(str(path), bucket, key)
        print(f"Uploaded: {key}")
        uploaded += 1

print(f"\nDone: {uploaded} files")
```

## Exercises

1. Write a function that lists all S3 buckets and for each bucket prints its name and total size in bytes (hint: use the `list_objects_v2` paginator and sum `obj["Size"]`).
2. Write a script that finds all EC2 instances stopped for more than 7 days (hint: `StateTransitionReason` contains the stop time for stopped instances) and prints their IDs and names.
3. Write a function that reads a JSON config file from S3 (`s3://bucket/path/config.json`) and returns it as a Python dict — handle `NoSuchKey` with a clear error message.
4. Write a script that copies all objects from one S3 bucket prefix to another prefix within the same bucket (hint: `s3.copy_object`).

---
title: AWS Lambda
module: aws
duration_min: 25
difficulty: intermediate
tags: [aws, lambda, serverless, functions, triggers, layers, api-gateway, sam]
exercises: 4
---

## Overview

AWS Lambda is a serverless compute service that executes your code in response to events and manages all underlying infrastructure automatically. For DevOps engineers, Lambda is a foundational tool: it eliminates the operational overhead of provisioning, patching, and scaling servers for workloads that are inherently event-driven or intermittent. You pay only for the compute time consumed (measured in 1ms increments), making it cost-effective for tasks that would otherwise require always-on EC2 instances sitting idle most of the day.

Lambda's design is shaped by three principles: statelessness (each invocation is independent — no shared memory between calls), event-driven execution (Lambda reacts to triggers from dozens of AWS services), and ephemeral compute (execution environments are created and destroyed automatically). These constraints drive the patterns you'll use: caching state in external stores like DynamoDB or ElastiCache, structuring code to handle idempotent retries, and keeping packages small to minimize cold start latency.

In the DevOps toolchain, Lambda fills several roles simultaneously. It acts as glue code connecting AWS services (S3 → Lambda → DynamoDB), as a backend for API Gateway HTTP endpoints, as a consumer for SQS and Kinesis streams, as a scheduled task runner via EventBridge, and increasingly as the execution engine for infrastructure automation — rotating secrets, enforcing compliance rules, and responding to CloudWatch alarms. Understanding Lambda deeply means understanding how AWS's event-driven architecture fits together.

## Concepts

### Function Anatomy

Every Lambda function receives two arguments: `event` and `context`. The `event` is the trigger payload — its shape depends entirely on the source (S3, SQS, API Gateway, etc.). The `context` object provides runtime metadata.

```python
# handler.py
import json
import os
import boto3

def handler(event, context):
    """
    event   — the trigger payload (dict); shape varies by trigger source
    context — runtime info: function name, remaining time, request ID, log stream
    """
    print(f"Request ID: {context.aws_request_id}")
    print(f"Function name: {context.function_name}")
    print(f"Remaining time: {context.get_remaining_time_in_millis()}ms")
    print(f"Log stream: {context.log_stream_name}")
    print(f"Event: {json.dumps(event)}")

    bucket = os.environ['BUCKET_NAME']
    key = event.get('key', 'default')

    s3 = boto3.client('s3')
    obj = s3.get_object(Bucket=bucket, Key=key)
    content = obj['Body'].read().decode('utf-8')

    return {
        'statusCode': 200,
        'body': json.dumps({'content': content})
    }
```

**Return value semantics:** for API Gateway integrations, return a dict with `statusCode`, `headers`, and `body`. For SQS, Kinesis, and DynamoDB stream triggers, return a failure report dict (covered under SQS Trigger). For S3, SNS, and EventBridge triggers, the return value is ignored — side effects are what matter.

**Module-level code runs once per execution environment, not once per invocation.** Use this to cache SDK clients, parse config, and establish connections outside the handler function. Execution environments are reused across invocations (until they're recycled), so module-level initialization is a legitimate and important optimization.

```python
# Good: SDK client created once per execution environment
s3 = boto3.client('s3')
db = boto3.resource('dynamodb').Table(os.environ['TABLE_NAME'])

def handler(event, context):
    # s3 and db are already initialized — no overhead here
    ...
```

### Runtime and Memory Configuration

| Runtime | Cold start (typical) | Notes |
|---------|---------------------|-------|
| Python 3.12 | 100–300ms | Fast, good ecosystem |
| Node.js 20.x | 100–250ms | Fastest for small functions |
| Java 21 (SnapStart) | 1–3s (200ms with SnapStart) | JVM warmup is expensive; use SnapStart |
| .NET 8 | 300ms–1s | AOT compilation improves cold starts |
| Go (provided.al2) | 50–150ms | Compiled binary, very fast |
| Container image | 1–5s | Depends on image size |

Memory is the primary configuration lever. Lambda allocates CPU proportionally to memory — at 1,769 MB you get exactly one full vCPU. For CPU-bound workloads, increasing memory (and therefore CPU) often reduces duration enough to lower total cost.

```bash
# Test a function at different memory settings to find the cost-optimal point
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --memory-size 512   # try 128, 256, 512, 1024 and compare billed duration
```

**Memory gotcha:** Lambda includes `/tmp` ephemeral storage (512 MB by default, configurable up to 10 GB). Data written to `/tmp` persists within an execution environment across warm invocations but is not shared between concurrent instances and disappears when the environment is recycled. Never treat `/tmp` as durable storage.

### Deploying with AWS CLI

The deployment workflow: package code → create or update function → verify.

```bash
# Package handler and any local modules
zip function.zip handler.py utils.py

# Create function (first deploy)
aws lambda create-function \
  --function-name myapp-processor \
  --runtime python3.12 \
  --handler handler.handler \           # filename.function_name
  --role arn:aws:iam::123456789:role/lambda-execution-role \
  --zip-file fileb://function.zip \
  --timeout 30 \                        # seconds; max is 900 (15 minutes)
  --memory-size 256 \
  --environment Variables='{BUCKET_NAME=my-bucket}'

# Update code only (subsequent deploys)
aws lambda update-function-code \
  --function-name myapp-processor \
  --zip-file fileb://function.zip

# Update configuration (timeout, memory, env vars)
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --timeout 60 \
  --memory-size 512

# Invoke synchronously and capture the response
aws lambda invoke \
  --function-name myapp-processor \
  --payload '{"key": "test.txt"}' \
  --cli-binary-format raw-in-base64-out \
  output.json

cat output.json   # check the function's return value

# Check for errors (Lambda returns HTTP 200 even if the function threw)
aws lambda invoke \
  --function-name myapp-processor \
  --payload '{"key": "test.txt"}' \
  --cli-binary-format raw-in-base64-out \
  --log-type Tail \                     # returns last 4KB of logs base64-encoded
  output.json | jq -r '.LogResult' | base64 -d
```

**Invocation error gotcha:** `aws lambda invoke` exits with status 0 even when your function throws an exception. Always check `output.json` for a `FunctionError` key, or inspect the `StatusCode` field. A function error returns `"FunctionError": "Unhandled"` alongside `StatusCode: 200`.

### Triggers

Lambda integrates with AWS services through two models: **push** (the source directly invokes Lambda) and **pull/poll** (Lambda polls the source for records).

| Trigger | Model | Retry behavior | Concurrency |
|---------|-------|---------------|-------------|
| API Gateway / ALB | Push (sync) | Caller handles retries | 1 per request |
| S3 | Push (async) | Lambda retries 2x, then DLQ | Per object event |
| SNS | Push (async) | Lambda retries 2x, then DLQ | Per message |
| EventBridge | Push (async) | Lambda retries 2x, then DLQ | Per rule match |
| SQS | Pull | Messages become invisible; requeued on failure | Scales with queue depth |
| Kinesis / DynamoDB Streams | Pull | Retries until TTL or success; can block shard | 1 per shard (default) |

**Async retry gotcha:** for push-async sources (S3, SNS, EventBridge), Lambda retries your function twice on failure. If all three attempts fail, the event is lost unless you configure a Dead Letter Queue (DLQ) or an EventBridge Pipes failure destination. Always configure a DLQ for async invocations handling important data.

```bash
# Configure a DLQ on the function for async failures
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --dead-letter-config TargetArn=arn:aws:sqs:us-east-1:123456789:myapp-dlq
```

#### S3 Trigger

```bash
# Step 1: Grant S3 permission to invoke the function
aws lambda add-permission \
  --function-name myapp-processor \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::my-bucket \
  --source-account 123456789 \          # prevents confused deputy attack
  --statement-id s3-trigger

# Step 2: Configure S3 event notification
aws s3api put-bucket-notification-configuration \
  --bucket my-bucket \
  --notification-configuration '{
    "LambdaFunctionConfigurations": [{
      "LambdaFunctionArn": "arn:aws:lambda:us-east-1:123456789:function:myapp-processor",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [{"Name": "suffix", "Value": ".csv"}]
        }
      }
    }]
  }'
```

The S3 event payload includes records with bucket name, object key, size, and ETag. Always URL-decode the key — S3 encodes spaces and special characters.

```python
import urllib.parse

def handler(event, context):
    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = urllib.parse.unquote_plus(record['s3']['object']['key'])
        print(f"Processing s3://{bucket}/{key}")
```

#### SQS Trigger

```bash
# Create event source mapping — Lambda polls the queue
aws lambda create-event-source-mapping \
  --function-name myapp-processor \
  --event-source-arn arn:aws:sqs:us-east-1:123456789:my-queue \
  --batch-size 10 \                         # messages per invocation
  --maximum-batching-window-in-seconds 5 \  # wait up to 5s to fill the batch
  --function-response-types ReportBatchItemFailures
```

With `ReportBatchItemFailures`, your handler returns a `batchItemFailures` list identifying which messages failed. Lambda requeues only those messages — the rest are deleted from the queue.

```python
def handler(event, context):
    failures = []
    for record in event['Records']:
        message_id = record['messageId']
        try:
            body = json.loads(record['body'])
            process_message(body)
        except Exception as e:
            print(f"Failed to process {message_id}: {e}")
            failures.append({'itemIdentifier': message_id})

    # Return failures; Lambda deletes successful messages automatically
    return {'batchItemFailures': failures}
```

**SQS concurrency scaling:** Lambda scales up by adding concurrency to drain the queue — roughly one concurrent execution per 60 messages in the queue (standard queues), up to the function's reserved concurrency. If you don't set reserved concurrency, a large queue burst can consume your entire account concurrency limit (default 1,000).

#### EventBridge Schedule

```bash
# Create a scheduled rule (cron or rate expression)
aws events put-rule \
  --name every-5-minutes \
  --schedule-expression "rate(5 minutes)"
  # cron alternative: "cron(0 12 * * ? *)" — noon UTC daily

# Add Lambda as a target
aws events put-targets \
  --rule every-5-minutes \
  --targets '[{
    "Id": "MyLambda",
    "Arn": "arn:aws:lambda:us-east-1:123456789:function:myapp-processor",
    "Input": "{\"source\": \"scheduled\"}"
  }]'

# Grant EventBridge permission to invoke
aws lambda add-permission \
  --function-name myapp-processor \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:123456789:rule/every-5-minutes \
  --statement-id eventbridge-trigger
```

### Environment Variables and Secrets

Environment variables are the right place for non-sensitive configuration (URLs, table names, feature flags). For sensitive values, use AWS Secrets Manager or SSM Parameter Store and fetch at cold start.

```python
import os
import boto3
import json

# Fetched once at cold start, reused across warm invocations
_secret_cache = {}

def get_secret(secret_arn: str) -> dict:
    if secret_arn not in _secret_cache:
        client = boto3.client('secretsmanager')
        response = client.get_secret_value(SecretId=secret_arn)
        _secret_cache[secret_arn] = json.loads(response['SecretString'])
    return _secret_cache[secret_arn]

def handler(event, context):
    api_url = os.environ['API_URL']                    # non-sensitive: env var
    secret = get_secret(os.environ['DB_SECRET_ARN'])   # sensitive: Secrets Manager
    db_password = secret['password']
```

**Encryption gotcha:** Lambda encrypts environment variables at rest using KMS (AWS-managed key by default). However, environment variable values are visible in plaintext in the Lambda console and in CloudTrail `GetFunctionConfiguration` events. Never put raw passwords or API keys in environment variables — use Secrets Manager or SSM SecureString parameters.

```bash
# Set env vars via CLI (use Secrets Manager ARN, not the secret value)
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --environment 'Variables={
    API_URL=https://api.example.com,
    DB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789:secret:myapp/db
  }'
```

### Layers

Layers are versioned ZIP archives shared across functions. They're mounted at `/opt` inside the execution environment. Python packages go in `/opt/python/`, Node.js in `/opt/nodejs/node_modules/`, binaries in `/opt/bin/`.

```bash
# Build the layer — directory structure must match the runtime path
mkdir -p python
pip install requests boto3 -t python/
zip -r deps-layer.zip python/

# Publish a new layer version
aws lambda publish-layer-version \
  --layer-name myapp-deps \
  --description "requests + boto3" \
  --zip-file fileb://deps-layer.zip \
  --compatible-runtimes python3.12 python3.11

# Attach to a function (use the full ARN with version number)
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --layers arn:aws:lambda:us-east-1:123456789:layer:myapp-deps:3

# Attach multiple layers (up to 5; applied in order, last wins on conflict)
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --layers \
    arn:aws:lambda:us-east-1:123456789:layer:myapp-deps:3 \
    arn:aws:lambda:us-east-1:123456789:layer:datadog-extension:45
```

**Layer size limits:** each layer ZIP can be up to 50 MB compressed (250 MB uncompressed). Total unzipped size of function + all layers must stay under 250 MB. For larger dependencies, use container image deployment instead.

Layers are also the standard way
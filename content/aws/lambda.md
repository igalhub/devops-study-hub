---
title: AWS Lambda
module: aws
duration_min: 25
difficulty: intermediate
tags: [aws, lambda, serverless, functions, triggers, layers, api-gateway, sam]
exercises: 4
---

## Overview

AWS Lambda is a serverless compute service that executes your code in response to events and manages all underlying infrastructure automatically. For DevOps engineers, Lambda is a foundational tool: it eliminates the operational overhead of provisioning, patching, and scaling servers for workloads that are inherently event-driven or intermittent. You pay only for the compute time consumed (measured in 1ms increments), making it cost-effective for tasks that would otherwise require always-on EC2 instances sitting idle most of the day. Lambda's managed scaling — from zero to thousands of concurrent executions in seconds — removes the capacity-planning burden that dominates traditional server-based deployments.

Lambda's design is shaped by three principles: statelessness (each invocation is independent — no shared memory between calls), event-driven execution (Lambda reacts to triggers from dozens of AWS services), and ephemeral compute (execution environments are created and destroyed automatically). These constraints drive the patterns you'll use: caching state in external stores like DynamoDB or ElastiCache, structuring code to handle idempotent retries, and keeping packages small to minimize cold start latency. Understanding these constraints upfront prevents entire classes of bugs that appear only in production under concurrency.

In the DevOps toolchain, Lambda fills several roles simultaneously. It acts as glue code connecting AWS services (S3 → Lambda → DynamoDB), as a backend for API Gateway HTTP endpoints, as a consumer for SQS and Kinesis streams, as a scheduled task runner via EventBridge, and increasingly as the execution engine for infrastructure automation — rotating secrets, enforcing compliance rules, and responding to CloudWatch alarms. Mastering Lambda means understanding not just the function itself, but the entire event-driven substrate that AWS is built on.

## Concepts

### Function Anatomy

Every Lambda function receives two arguments: `event` and `context`. The `event` is the trigger payload — its shape depends entirely on the source (S3, SQS, API Gateway, etc.). The `context` object provides runtime metadata: request ID, function name, remaining execution time, and the CloudWatch log stream for this invocation.

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

**Return value semantics:** for API Gateway integrations, return a dict with `statusCode`, `headers`, and `body`. For SQS triggers, return a `batchItemFailures` list. For S3, SNS, and EventBridge triggers, the return value is ignored — side effects are what matter. Returning the wrong shape for an API Gateway integration produces a `502 Bad Gateway` with no clear error message — always validate the response format.

**Module-level code runs once per execution environment, not once per invocation.** Execution environments are reused across invocations until they are recycled (typically after minutes to hours of inactivity). Use this to cache SDK clients, parse config, and establish connections outside the handler.

```python
# Good: SDK client and table reference created once, reused across warm invocations
import boto3, os

s3 = boto3.client('s3')
db = boto3.resource('dynamodb').Table(os.environ['TABLE_NAME'])

def handler(event, context):
    # s3 and db are already initialized — no per-invocation overhead
    ...
```

### Runtime and Memory Configuration

| Runtime | Cold start (typical) | Notes |
|---------|---------------------|-------|
| Python 3.12 | 100–300ms | Fast, mature ecosystem |
| Node.js 20.x | 100–250ms | Fastest for small functions |
| Java 21 (SnapStart) | 1–3s (200ms with SnapStart) | JVM warmup is expensive; SnapStart snapshots the initialized state |
| .NET 8 | 300ms–1s | AOT compilation reduces cold starts significantly |
| Go (provided.al2023) | 50–150ms | Compiled binary, minimal runtime overhead |
| Container image | 1–5s | Depends on image size; use slim base images |

Memory is the **primary configuration lever** for performance. Lambda allocates CPU proportionally to memory — at 1,769 MB you get exactly one full vCPU; at 3,538 MB you get two vCPUs. For CPU-bound workloads, increasing memory often reduces duration enough to lower total cost even though the per-GB-second price is constant.

```bash
# Update memory and test billed duration at multiple settings
# Try 128, 256, 512, 1024 and compare cost = (billed_ms / 1000) * (memory_gb) * $0.0000166667
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --memory-size 512

# AWS Lambda Power Tuning (open source Step Functions state machine) automates this
# https://github.com/alexcasalboni/aws-lambda-power-tuning
```

**Timeout configuration:** the default timeout is 3 seconds; the maximum is 900 seconds (15 minutes). Set the timeout to slightly above the 99th-percentile observed duration — a too-generous timeout increases cost when functions hang waiting on network I/O. Always set an explicit timeout; the 3-second default will silently terminate functions making slow downstream calls.

**`/tmp` storage:** Lambda provides 512 MB of ephemeral `/tmp` storage by default (configurable up to 10 GB). Data written to `/tmp` persists within a warm execution environment across invocations but is never shared between concurrent instances and disappears when the environment is recycled. Use `/tmp` for caching downloaded assets within a single environment — never as durable storage.

### Deploying with the AWS CLI

The deployment workflow is: package code → create or update function → verify. For production, use SAM or Terraform, but understanding the raw CLI workflow is essential for debugging and scripting.

```bash
# Package handler and any local modules into a ZIP
zip function.zip handler.py utils.py

# Create function (first deploy)
aws lambda create-function \
  --function-name myapp-processor \
  --runtime python3.12 \
  --handler handler.handler \           # filename.function_name
  --role arn:aws:iam::123456789012:role/lambda-execution-role \
  --zip-file fileb://function.zip \
  --timeout 30 \
  --memory-size 256 \
  --environment Variables='{BUCKET_NAME=my-bucket,ENV=production}'

# Update code only (subsequent deploys)
aws lambda update-function-code \
  --function-name myapp-processor \
  --zip-file fileb://function.zip

# Update configuration separately — code and config are independent operations
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --timeout 60 \
  --memory-size 512

# Invoke synchronously and capture the response payload
aws lambda invoke \
  --function-name myapp-processor \
  --payload '{"key": "test.txt"}' \
  --cli-binary-format raw-in-base64-out \
  output.json

cat output.json

# Invoke with log tail — returns last 4KB of logs, base64-encoded
aws lambda invoke \
  --function-name myapp-processor \
  --payload '{"key": "test.txt"}' \
  --cli-binary-format raw-in-base64-out \
  --log-type Tail \
  output.json | jq -r '.LogResult' | base64 -d
```

**Invocation error gotcha:** `aws lambda invoke` exits with status 0 even when your function throws an unhandled exception. The HTTP status code is 200 but the response body contains `"FunctionError": "Unhandled"`. Always inspect `output.json` and check for the `FunctionError` field in CI pipelines — otherwise failed deployments look like successes.

```bash
# In CI: fail the pipeline if the function errored
aws lambda invoke --function-name myapp-processor \
  --payload '{"key":"test.txt"}' \
  --cli-binary-format raw-in-base64-out \
  output.json

if jq -e '.FunctionError' output.json > /dev/null 2>&1; then
  echo "Function invocation failed"
  cat output.json
  exit 1
fi
```

### Triggers

Lambda integrates with AWS services through two models: **push** (the source directly invokes Lambda) and **pull/poll** (Lambda polls the source for records and invokes the function with a batch).

| Trigger | Model | Retry behavior | Scaling |
|---------|-------|---------------|---------|
| API Gateway / ALB | Push (sync) | Caller handles retries | 1 concurrent exec per request |
| S3 | Push (async) | Lambda retries 2×, then DLQ | Per object event |
| SNS | Push (async) | Lambda retries 2×, then DLQ | Per message |
| EventBridge | Push (async) | Lambda retries 2×, then DLQ | Per rule match |
| SQS (standard) | Pull | Messages re-queued on failure; DLQ after maxReceiveCount | Scales with queue depth |
| SQS (FIFO) | Pull | Same; ordering preserved per MessageGroupId | Limited by message group count |
| Kinesis / DynamoDB Streams | Pull | Retries until TTL or success; blocks the shard | 1 concurrent exec per shard (default) |

**Async retry gotcha:** for push-async sources (S3, SNS, EventBridge), Lambda retries your function twice on failure. If all three attempts fail, the event is lost unless you configure a Dead Letter Queue or an on-failure event destination. Always configure a DLQ for async invocations handling important data.

```bash
# Add a DLQ for async invocation failures
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --dead-letter-config TargetArn=arn:aws:sqs:us-east-1:123456789012:myapp-dlq
```

#### S3 Trigger

S3 invokes Lambda asynchronously when objects are created, deleted, or restored. The event payload contains a `Records` array; a single notification can contain multiple records in theory, but in practice S3 sends one record per event.

```bash
# Step 1: grant S3 permission to invoke the function
aws lambda add-permission \
  --function-name myapp-processor \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::my-bucket \
  --source-account 123456789012 \   # prevents confused deputy — always include this
  --statement-id s3-trigger

# Step 2: configure the bucket notification
aws s3api put-bucket-notification-configuration \
  --bucket my-bucket \
  --notification-configuration '{
    "LambdaFunctionConfigurations": [{
      "LambdaFunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:myapp-processor",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [{"Name": "suffix", "Value": ".csv"}]
        }
      }
    }]
  }'
```

**Key encoding gotcha:** S3 URL-encodes object keys in event payloads. A file named `my file.csv` becomes `my+file.csv` in the event. Always `unquote_plus` the key before using it.

```python
import urllib.parse

def handler(event, context):
    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = urllib.parse.unquote_plus(record['s3']['object']['key'])
        size = record['s3']['object']['size']
        print(f"Processing s3://{bucket}/{key} ({size} bytes)")
```

#### SQS Trigger

Lambda polls SQS and invokes your function with a batch of messages. This is the preferred pattern for reliable, at-least-once message processing.

```bash
# Create event source mapping
aws lambda create-event-source-mapping \
  --function-name myapp-processor \
  --event-source-arn arn:aws:sqs:us-east-1:123456789012:my-queue \
  --batch-size 10 \
  --maximum-batching-window-in-seconds 5 \      # wait up to 5s to fill a batch
  --function-response-types ReportBatchItemFailures  # partial batch success
```

With `ReportBatchItemFailures`, return a `batchItemFailures` list containing the `messageId` of each failed message. Lambda deletes successful messages and requeues only the failures.

```python
import json

def handler(event, context):
    failures = []
    for record in event['Records']:
        message_id = record['messageId']
        try:
            body = json.loads(record['body'])
            process_message(body)
        except Exception as e:
            print(f"Failed {message_id}: {e}")
            failures.append({'itemIdentifier': message_id})

    return {'batchItemFailures': failures}
```

**Without `ReportBatchItemFailures`:** if your function raises an exception, the entire batch is requeued — including successfully processed messages. This causes duplicate processing. Always enable partial batch success for SQS triggers.

**SQS concurrency scaling:** Lambda adds concurrency to drain queues — roughly one concurrent execution per 60 messages in a standard queue, scaling up to 1,000 concurrent executions over the first 10 minutes. Without a reserved concurrency limit, a sudden queue burst can consume your entire account concurrency, starving other functions. Set reserved concurrency on high-volume SQS consumers.

#### EventBridge Schedule

```bash
# Rate expression: every 5 minutes
aws events put-rule \
  --name every-5-minutes \
  --schedule-expression "rate(5 minutes)"

# Cron expression: 8 AM UTC on weekdays
# aws events put-rule --name weekday-morning --schedule-expression "cron(0 8 ? * MON-FRI *)"

# Add Lambda as target with a static input payload
aws events put-targets \
  --rule every-5-minutes \
  --targets '[{
    "Id": "MyLambda",
    "Arn": "arn:aws:lambda:us-east-1:123456789012:function:myapp-processor",
    "Input": "{\"source\": \"scheduled\"}"
  }]'

# Grant EventBridge permission to invoke
aws lambda add-permission \
  --function-name myapp-processor \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:123456789012:rule/every-5-minutes \
  --statement-id eventbridge-schedule
```

**EventBridge cron syntax differs from Unix cron.** The sixth field is year, not seconds, and you must use `?` (any) in either day-of-month or day-of-week — not both. `cron(0 8 * * MON-FRI *)` is invalid; `cron(0 8 ? * MON-FRI *)` is correct.

### Concurrency and Throttling

| Concurrency type | What it controls |
|-----------------|-----------------|
| **Account limit** | Total concurrent executions across all functions in a region (default: 1,000; requestable increase) |
| **Reserved concurrency** | Maximum concurrency for a specific function; counts against the account limit; requests above this are throttled (429) |
| **Provisioned concurrency** | Pre-initialized execution environments that eliminate cold starts; billed whether invoked or not |

```bash
# Reserve 100 concurrent executions for a critical function
# This also guarantees capacity — no other function can consume these slots
aws lambda put-function-concurrency \
  --function-name myapp-api \
  --reserved-concurrent-executions 100

# Remove reserved concurrency limit (function uses account pool again)
aws lambda delete-function-concurrency \
  --function-name myapp-api

# Enable provisioned concurrency on an alias (for latency-sensitive APIs)
aws lambda put-provisioned-concurrency-config \
  --function-name myapp-api \
  --qualifier prod \           # alias name
  --provisioned-concurrent-executions 10
```

**Throttle behavior by invocation type:**
- **Synchronous** (API Gateway, ALB): returns HTTP 429. The caller must implement retry with backoff.
- **Asynchronous** (S3, SNS, EventBridge): Lambda queues the event internally and retries for up to 6 hours before sending to DLQ.
- **Polling** (SQS, Kinesis): messages stay in the queue/stream; Lambda retries when capacity is available.

**Setting reserved concurrency to 0** effectively disables a function — useful for emergency shutoff of a runaway function without deleting it.

### Environment Variables and Secrets

Environment variables are the right place for non-sensitive configuration (URLs, table names, feature flags, region). For sensitive values, use AWS Secrets Manager or SSM Parameter Store and fetch at cold start.

```python
import os
import boto3
import json

# Module-level cache — fetched once per execution environment
_secret_cache = {}

def get_secret(secret_arn: str) -> dict:
    if secret_arn not in _secret_cache:
        client = boto3.client('secretsmanager')
        response = client.get_secret_value(SecretId=secret_arn)
        _secret_cache[secret_arn] = json.loads(response['SecretString'])
    return _secret_cache[secret_arn]

# Pre-load at cold start — not inside the handler
_db_secret = get_secret(os.environ['DB_SECRET_ARN'])

def handler(event, context):
    api_url = os.environ['API_URL']          # non-sensitive: env var is fine
    db_password = _db_secret['password']     # sensitive: Secrets Manager
```

**Encryption gotcha:** Lambda encrypts environment variables at rest using KMS (AWS-managed key by default). However, values are visible in plaintext in the Lambda console and in CloudTrail `GetFunctionConfiguration` API calls. Anyone with `lambda:GetFunctionConfiguration` IAM permission can read them. Never put raw credentials or API keys in environment variables — use Secrets Manager or SSM SecureString.

```bash
# Store the ARN in env vars, not the secret value
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --environment 'Variables={
    API_URL=https://api.example.com,
    TABLE_NAME=myapp-events,
    DB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:myapp/db-xK3p2q
  }'
```

### Layers

Layers are versioned ZIP archives shared across functions. They are mounted read-only at `/opt` inside the execution environment. Python packages go in `/opt/python/`, Node.js in `/opt/nodejs/node_modules/`, and binaries in `/opt/bin/` (which Lambda adds to `PATH`).

```bash
# Build a Python dependency layer — directory structure must match the runtime import path
mkdir -p python
pip install requests psycopg2-binary -t python/
zip -r deps-layer.zip python/

# Publish
aws lambda publish-layer-version \
  --layer-name myapp-deps \
  --description "requests + psycopg2-binary" \
  --zip-file fileb://deps-layer.zip \
  --compatible-runtimes python3.12 python3.11

# Attach to a function — use the full ARN including the version number
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --layers arn:aws:lambda:us-east-1:123456789012:layer:myapp-deps:3

# Multiple layers (up to 5; applied in order — last wins on file conflicts)
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --layers \
    arn:aws:lambda:us-east-1:123456789012:layer:myapp-deps:3 \
    arn:aws:lambda:us-east-1:123456789012:layer:datadog-extension:45
```

**Layer size limits:** each layer ZIP can be up to 50 MB compressed, 250 MB unzipped. Total unzipped size of function code + all layers must stay under 250 MB. For larger dependency trees (e.g., ML inference with numpy/scipy/torch), use container image deployment — the limit is 10 GB.

Layers are also the standard mechanism for deploying Lambda Extensions — agents that run in the same execution environment as your function to collect telemetry, inject secrets, or proxy network traffic (e.g., the Datadog extension, AWS AppConfig extension).

### IAM Execution Role

Every Lambda function assumes an **execution role** at invocation time. This is the identity Lambda uses to call other AWS services. The role must trust `lambda.amazonaws.com` as a principal.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

```bash
# Minimum permissions: write logs to CloudWatch
# AWSLambdaBasicExecutionRole is the AWS managed policy for this
aws iam attach-role-policy \
  --role-name lambda-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Add S3 read access for specific bucket
aws iam put-role-policy \
  --role-name lambda-execution-role \
  --policy-name s3-read-my-bucket \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::my-bucket/*"
    }]
  }'
```

**Least privilege principle:** never attach `AdministratorAccess` or `AmazonS3FullAccess` to a Lambda execution role in production. Scope permissions to the exact actions and resources the function needs. A compromised function with broad permissions is a lateral movement path through your entire AWS account.

### Observability

Lambda automatically ships logs to CloudWatch Logs. Each function gets a log group at `/aws/lambda/<function-name>`. Each execution environment generates a new log stream.

```bash
# Tail logs in real time (requires CloudWatch Logs Insights or awslogs tool)
aws logs tail /aws/lambda/myapp-processor --follow

# Query logs with CloudWatch Logs Insights
aws logs start-query \
  --log-group-name /aws/lambda/myapp-processor \
  --start-time $(date -d '1 hour ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message
    | filter @message like /ERROR/
    | sort @timestamp desc
    | limit 20'
```

Every invocation automatically emits a `REPORT` log line with duration, billed duration, memory used, and max memory used:

```
REPORT RequestId: abc-123  Duration: 142.73 ms  Billed Duration: 143 ms
       Memory Size: 256 MB  Max Memory Used: 89 MB  Init Duration: 312.14 ms
```

**`Init Duration` in the REPORT line indicates a cold start.** If you see it consistently, consider provisioned concurrency or optimizing your initialization code. `Max Memory Used` tells you whether to right-size memory.

For structured observability, use AWS Lambda Powertools (Python, Java, TypeScript) — it provides structured JSON logging, tracing with X-Ray, and custom metrics with minimal boilerplate.

```python
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

logger = Logger()     # structured JSON logs with request_id, function_name auto-injected
tracer = Tracer()     # X-Ray tracing
metrics = Metrics(namespace="MyApp", service="processor")

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics
def handler(event, context):
    logger.info("Processing event", extra={"record_count": len(event.get("Records", []))})
    metrics.add_metric(name="RecordsProcessed", unit=MetricUnit.Count, value=1)
    ...
```

---

## Examples

### Example 1: S3-Triggered CSV Processor

Process CSV files uploaded to S3, validate rows, and write results to DynamoDB.

```bash
# --- Setup ---

# 1. Create the DynamoDB table
aws dynamodb create-table \
  --table-name csv-records \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# 2. Create the IAM role
aws iam create-role \
  --role-name csv-processor-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam attach-role-policy \
  --role-name csv-processor-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam put-role-policy \
  --role-name csv-processor-role \
  --policy-name csv-processor-perms \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[
      {"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::my-csv-bucket/*"},
      {"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:BatchWriteItem"],"Resource":"arn:aws:dynamodb:us-east-1:123456789012:table/csv-records"}
    ]
  }'
```

```python
# handler.py
import boto3, csv, io, os, urllib.parse, uuid

s3 = boto3.client('s3')
table = boto3.resource('dynamodb').Table(os.environ['TABLE_NAME'])

def handler(event, context):
    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = urllib.parse.unquote_plus(record['s3']['object']['key'])

        response = s3.get_object(Bucket=bucket, Key=key)
        content = response['Body'].read().decode('utf-8')

        reader = csv.DictReader(io.StringIO(content))
        items = []
        for row in reader:
            if not row.get('email'):    # basic validation
                continue
            items.append({
                'PutRequest': {
                    'Item': {
                        'id': str(uuid.uuid4()),
                        'email': row['email'],
                        'name': row.get('name', ''),
                        'source_key': key
                    }
                }
            })

        # BatchWriteItem accepts up to 25 items per call
        for i in range(0, len(items), 25):
            table.meta.client.batch_write_item(
                RequestItems={os.environ['TABLE_NAME']: items[i:i+25]}
            )

        print(f"Wrote {len(items)} records from {key}")
```

```bash
# Deploy
zip function.zip handler.py

aws lambda create-function \
  --function-name csv-processor \
  --runtime python3.12 \
  --handler handler.handler \
  --role arn:aws:iam::123456789012:role/csv-processor-role \
  --zip-file fileb://function.zip \
  --timeout 60 \
  --memory-size 256 \
  --environment Variables='{TABLE_NAME=csv-records}'

# Grant S3 permission and configure trigger
aws lambda add-permission \
  --function-name csv-processor \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::my-csv-bucket \
  --source-account 123456789012 \
  --statement-id s3-csv-trigger

aws s3api put-bucket-notification-configuration \
  --bucket my-csv-bucket \
  --notification-configuration '{
    "LambdaFunctionConfigurations":[{
      "LambdaFunctionArn":"arn:aws:lambda:us-east-1:123456789012:function:csv-processor",
      "Events":["s3:ObjectCreated:*"],
      "Filter":{"Key":{"FilterRules":[{"Name":"suffix","Value":".csv"}]}}
    }]
  }'

# --- Verify ---
# Upload a test file and watch logs
echo "email,name
alice@example.com,Alice
bob@example.com,Bob" > test.csv

aws s3 cp test.csv s3://my-csv-bucket/test.csv

# Poll logs for output
aws logs tail /aws/lambda/csv-processor --follow --since 2m

# Verify DynamoDB records were written
aws dynamodb scan --table-name csv-records --max-items 5
```

---

### Example 2: SQS Worker with Partial Batch Failure Handling

Process order events from an SQS queue with reliable partial failure semantics.

```python
# handler.py
import boto3, json, os

orders_table = boto3.resource('dynamodb').Table(os.environ['ORDERS_TABLE'])

def process_order(order: dict):
    if not order.get('order_id') or not order.get('amount'):
        raise ValueError(f"Invalid order payload: {order}")

    orders_table.put_item(Item={
        'order_id': order['order_id'],
        'amount': str(order['amount']),    # DynamoDB requires Decimal for floats; use str for simplicity
        'status': 'received',
        'customer_id': order.get('customer_id', 'unknown')
    })

def handler(event, context):
    failures = []
    for record in event['Records']:
        try:
            order = json.loads(record['body'])
            process_order(order)
            print(f"Processed order {order.get('order_id')}")
        except Exception as e:
            print(f"ERROR processing message {record['messageId']}: {e}")
            failures.append({'itemIdentifier': record['messageId']})

    return {'batchItemFailures': failures}
```

```bash
# Create SQS queue with a DLQ
aws sqs create-queue --queue-name orders-dlq
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/orders-dlq \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

aws sqs create-queue \
  --queue-name orders \
  --attributes "{
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
  }"

# Deploy
zip function.zip handler.py

aws lambda create-function \
  --function-name order-worker \
  --runtime python3.12 \
  --handler handler.handler \
  --role arn:aws:iam::123456789012:role/lambda-execution-role \
  --zip-file fileb://function.zip \
  --timeout 30 \
  --memory-size 256 \
  --environment Variables='{ORDERS_TABLE=orders}'

# Create event source mapping with partial batch success
QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/orders \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

aws lambda create-event-source-mapping \
  --function-name order-worker \
  --event-source-arn $QUEUE_ARN \
  --batch-size 10 \
  --maximum-batching-window-in-seconds 5 \
  --function-response-types ReportBatchItemFailures

# --- Verify ---
# Send test messages (one valid, one invalid)
aws sqs send-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/orders \
  --message-body '{"order_id":"ord-001","amount":99.99,"customer_id":"cust-42"}'

aws sqs send-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/orders \
  --message-body '{"broken":"payload"}'    # missing order_id — will fail

# Check logs: should show one success and one failure
aws logs tail /aws/lambda/order-worker --follow --since 2m

# Check DLQ for the failed message after maxReceiveCount retries
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/orders-dlq \
  --attribute-names ApproximateNumberOfMessages
```

---

### Example 3: Scheduled Cleanup Job with EventBridge

Run a nightly DynamoDB TTL cleanup report using EventBridge Scheduler.

```python
# handler.py
import boto3, os, json
from datetime import datetime, timezone

table = boto3.resource('dynamodb').Table(os.environ['TABLE_NAME'])
sns = boto3.client('sns')

def handler(event, context):
    source = event.get('source', 'unknown')
    run_time = datetime.now(timezone.utc).isoformat()

    # Scan for expired-but-not-yet-deleted items (TTL is eventually consistent)
    response = table.scan(
        FilterExpression='#ttl < :now AND attribute_exists(#ttl)',
        ExpressionAttributeNames={'#ttl': 'ttl'},
        ExpressionAttributeValues={':now': int(datetime.now(timezone.utc).timestamp())}
    )

    stale_count = response['Count']
    print(f"Found {stale_count} stale items at {run_time}")

    if stale_count > 100:   # alert if TTL cleanup is falling behind
        sns.publish(
            TopicArn=os.environ['ALERT_TOPIC_ARN'],
            Subject='Lambda TTL Cleanup Alert',
            Message=json.dumps({
                'table': os.environ['TABLE_NAME'],
                'stale_items': stale_count,
                'timestamp': run_time
            })
        )

    return {'stale_items': stale_count, 'run_time': run_time}
```

```bash
zip function.zip handler.py

aws lambda create-function \
  --function-name nightly-cleanup \
  --runtime python3.12 \
  --handler handler.handler \
  --role arn:aws:iam::123456789012:role/lambda-execution-role \
  --zip-file fileb://function.zip \
  --timeout 300 \    # 5 minutes for large table scans
  --memory-size 512 \
  --environment Variables='{TABLE_NAME=myapp-events,ALERT_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:alerts}'

# Schedule to run at 2 AM UTC daily
aws events put-rule \
  --name nightly-cleanup-schedule \
  --schedule-expression "cron(0 2 * * ? *)" \
  --state ENABLED

aws events put-targets \
  --rule nightly-cleanup-schedule \
  --targets '[{
    "Id": "NightlyCleanup",
    "Arn": "arn:aws:lambda:us-east-1:123456789012:function:nightly-cleanup",
    "Input": "{\"source\": \"eventbridge-scheduled\"}"
  }]'

aws lambda add-permission \
  --function-name nightly-cleanup \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:123456789012:rule/nightly-cleanup-schedule \
  --statement-id eventbridge-nightly

# --- Verify: invoke manually to test before waiting for the schedule ---
aws lambda invoke \
  --function-name nightly-cleanup \
  --payload '{"source": "manual-test"}' \
  --cli-binary-format raw-in-base64-out \
  output.json

cat output.json   # should show {"stale_items": N, "run_time": "..."}

# Confirm scheduled rule is active
aws events describe-rule --name nightly-cleanup-schedule \
  | jq '{State: .State, ScheduleExpression: .ScheduleExpression}'
```

---

## Exercises

### Exercise 1: Deploy and Debug an Intentionally Broken Function

Write a Lambda function that reads an environment variable `REQUIRED_VAR` and raises a `ValueError` if it is missing. Deploy it twice: first **without** the environment variable set, invoke it, and capture the error output. Then update the configuration to add the variable and confirm the function succeeds.

The goal is to practice the full CLI deploy-invoke-debug loop and to understand why `aws lambda invoke` returning status 0 is not a success signal. Your solution must parse `output.json` to detect the `FunctionError` field programmatically.

**Hints:**
- Use `--log-type Tail` on the broken invocation and decode the base64 log to see the traceback.
- Write a small bash `if` block that exits non-zero when `FunctionError` is present.

---

### Exercise 2: SQS Fan-Out with Concurrency Limit

Create an SQS queue, deploy an SQS-triggered Lambda that simulates slow processing (use `time.sleep(2)`), and send 50 messages to the queue in a loop. Then:

1. Observe how many concurrent executions Lambda scales to using CloudWatch metrics (`ConcurrentExecutions`).
2. Set reserved concurrency to 5 on the function and re-send 50 messages.
3. Measure how long the queue takes to drain in each scenario and explain the tradeoff.

**What to compare:** total drain time with unrestricted concurrency vs. reserved concurrency of 5. Explain in one paragraph when you would choose to limit concurrency on an SQS consumer.

---

### Exercise 3: Dependency Layer for a Third-Party Package

Your Lambda function needs the `httpx` package, which is not included in the Python 3.12 runtime. Package `httpx` into a layer, publish it, attach it to a function, and verify the import works at invocation time.

Requirements:
- The function's deployment ZIP must contain **only** your handler code — no `httpx` files.
- The layer must be published with `--compatible-runtimes python3.12`.
- Confirm success by having the handler print `httpx.__version__` and checking the log output.

**Extension:** check the size of your layer ZIP. What is the maximum compressed size a single layer can be? What would you do if your ML inference dependencies (numpy, scipy, torch) exceeded that limit?

---

### Exercise 4: End-to-End Async Event Pipeline with DLQ

Build a pipeline: EventBridge rule (rate 1 minute) → Lambda → intentional failure → DLQ.

1. Write a Lambda function that always raises an exception (simulating a broken processor).
2. Configure an SQS DLQ on the function's async failure destination.
3. Create an EventBridge rule that triggers the function every minute.
4. Wait 10–15 minutes, then inspect the DLQ to confirm failed invocation records are arriving.
5. Read one DLQ message and decode its body — document what fields Lambda includes in the async failure record.

**What you're learning:** async retry behavior (Lambda retries 2×, then routes to the DLQ), the structure of Lambda's async failure payload, and the difference between a function-level DLQ and an event source DLQ. Disable the EventBridge rule when you're done to avoid ongoing charges.
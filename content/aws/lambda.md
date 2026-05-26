---
title: AWS Lambda
module: aws
duration_min: 25
difficulty: intermediate
tags: [aws, lambda, serverless, functions, triggers, layers, api-gateway, sam]
exercises: 4
---

## Overview
Lambda runs code in response to events without provisioning or managing servers. You pay only for the compute time consumed — no idle cost. The model maps well to event-driven tasks: API backends, file processing, scheduled jobs, stream consumers, and glue code between AWS services. The main gotchas are cold starts, execution time limits (15 minutes max), and the stateless model (no persistent filesystem across invocations).

## Concepts

### Function Anatomy
```python
# handler.py
import json
import os
import boto3

def handler(event, context):
    """
    event   — the trigger payload (dict)
    context — runtime info (function name, remaining time, request ID)
    """
    print(f"Request ID: {context.aws_request_id}")
    print(f"Remaining time: {context.get_remaining_time_in_millis()}ms")
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

Return a dict with `statusCode` and `body` for API Gateway integration. For other triggers, return whatever the consumer expects (or nothing).

### Deploying with AWS CLI
```bash
# Package
zip function.zip handler.py

# Create function
aws lambda create-function \
  --function-name myapp-processor \
  --runtime python3.12 \
  --handler handler.handler \
  --role arn:aws:iam::123456789:role/lambda-execution-role \
  --zip-file fileb://function.zip \
  --timeout 30 \
  --memory-size 256 \
  --environment Variables='{BUCKET_NAME=my-bucket}'

# Update code
aws lambda update-function-code \
  --function-name myapp-processor \
  --zip-file fileb://function.zip

# Update config
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --timeout 60 \
  --memory-size 512

# Invoke
aws lambda invoke \
  --function-name myapp-processor \
  --payload '{"key": "test.txt"}' \
  --cli-binary-format raw-in-base64-out \
  output.json
cat output.json
```

### Triggers
```
API Gateway / ALB    — HTTP requests
S3                   — object created/deleted in a bucket
SQS                  — messages in a queue (Lambda polls, processes batches)
SNS                  — push notifications from SNS topics
EventBridge          — scheduled events, rule-based event routing
DynamoDB Streams     — record changes in a DynamoDB table
Kinesis              — streaming data records
CloudWatch Logs      — log events (rare, usually for alerting)
```

#### S3 Trigger
```bash
# Allow S3 to invoke the function
aws lambda add-permission \
  --function-name myapp-processor \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::my-bucket \
  --statement-id s3-trigger

# Configure S3 to notify Lambda on object creation
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

#### SQS Trigger
```bash
aws lambda create-event-source-mapping \
  --function-name myapp-processor \
  --event-source-arn arn:aws:sqs:us-east-1:123456789:my-queue \
  --batch-size 10 \
  --function-response-types ReportBatchItemFailures
```

The `ReportBatchItemFailures` response type lets your function report partial batch failures — only failed messages are requeued, not the entire batch.

#### EventBridge Schedule
```bash
# Create a rule to invoke Lambda every 5 minutes
aws events put-rule \
  --name every-5-minutes \
  --schedule-expression "rate(5 minutes)"

aws events put-targets \
  --rule every-5-minutes \
  --targets '[{
    "Id": "MyLambda",
    "Arn": "arn:aws:lambda:us-east-1:123456789:function:myapp-processor"
  }]'

aws lambda add-permission \
  --function-name myapp-processor \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:123456789:rule/every-5-minutes \
  --statement-id eventbridge-trigger
```

### Environment Variables and Secrets
```python
import os
import boto3
import json

def get_secret(secret_name: str) -> dict:
    client = boto3.client('secretsmanager')
    response = client.get_secret_value(SecretId=secret_name)
    return json.loads(response['SecretString'])

def handler(event, context):
    # Simple env var
    api_url = os.environ['API_URL']

    # Sensitive: fetch from Secrets Manager at cold start
    # Cache in module-level variable to avoid per-invocation cost
    secret = get_secret(os.environ['DB_SECRET_ARN'])
    db_password = secret['password']
```

### Layers
Layers are ZIP archives containing dependencies, shared code, or runtimes. Multiple functions can share a layer instead of bundling deps into each function:

```bash
# Create a layer with Python packages
pip install -r requirements.txt -t python/
zip -r layer.zip python/

aws lambda publish-layer-version \
  --layer-name myapp-deps \
  --zip-file fileb://layer.zip \
  --compatible-runtimes python3.12

# Attach layer to function
aws lambda update-function-configuration \
  --function-name myapp-processor \
  --layers arn:aws:lambda:us-east-1:123456789:layer:myapp-deps:1
```

### Container Image Deployment
For larger packages or custom runtimes:

```dockerfile
FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY handler.py .

CMD ["handler.handler"]
```

```bash
# Push to ECR, then deploy
aws lambda update-function-code \
  --function-name myapp-processor \
  --image-uri 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest
```

### Concurrency and Cold Starts
```bash
# Set reserved concurrency (limit max concurrent executions)
aws lambda put-function-concurrency \
  --function-name myapp-processor \
  --reserved-concurrent-executions 50

# Provisioned concurrency (pre-warmed instances, no cold starts)
aws lambda put-provisioned-concurrency-config \
  --function-name myapp-processor \
  --qualifier prod \
  --provisioned-concurrent-executions 5
```

Cold start: the first invocation after a function has been idle initiates a new execution environment (~100ms–1s depending on runtime and package size). Python and Node cold starts are typically faster than Java or .NET.

### SAM (Serverless Application Model)
SAM is a CloudFormation extension for Lambda applications:

```yaml
# template.yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Runtime: python3.12
    Timeout: 30
    MemorySize: 256
    Environment:
      Variables:
        BUCKET_NAME: !Ref DataBucket

Resources:
  ProcessorFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.handler
      CodeUri: src/
      Events:
        S3Event:
          Type: S3
          Properties:
            Bucket: !Ref DataBucket
            Events: s3:ObjectCreated:*

  DataBucket:
    Type: AWS::S3::Bucket
```

```bash
sam build
sam local invoke ProcessorFunction --event event.json   # local test
sam deploy --guided
```

## Exercises

1. Write a Lambda function (Python) triggered by S3 that reads a CSV file on upload, counts the rows, and logs the result. Deploy it with the AWS CLI. Test by uploading a CSV to the trigger bucket.
2. Set up a Lambda triggered by an SQS queue with `batch-size 10`. Write the handler to process each message and use `ReportBatchItemFailures` to report partial failures. Send 20 test messages and verify processing.
3. Create a Lambda that runs on an EventBridge schedule (every 5 minutes) and checks an HTTP endpoint, logging its response time. Use CloudWatch Logs to verify it runs on schedule.
4. Build a Lambda layer containing `requests` and `boto3` (custom version). Attach it to two different functions and verify both can `import requests` without bundling the package in each function zip.

---
title: Cloud Functions
module: gcp
duration_min: 20
difficulty: intermediate
tags: [gcp, cloud-functions, serverless, triggers, pubsub, eventarc, python, gcloud]
exercises: 4
---

## Overview
Cloud Functions is GCP's serverless function platform. 2nd generation functions (now the default) are built on Cloud Run under the hood, giving you longer timeouts (60 minutes), higher concurrency (up to 1000 concurrent requests per instance), and more memory. The programming model is identical to Lambda: write a handler function, configure a trigger, deploy. Cloud Functions 2nd gen runs on Cloud Run behind the scenes — if you need more control, use Cloud Run directly.

## Concepts

### Function Types
```
HTTP functions   — invoked by HTTP requests (GET, POST, etc.)
Event functions  — triggered by Pub/Sub, Cloud Storage, Eventarc, Firestore
```

### HTTP Function (Python)
```python
# main.py
import functions_framework
import json

@functions_framework.http
def hello_http(request):
    """HTTP Cloud Function."""
    request_json = request.get_json(silent=True)
    name = request_json.get('name', 'World') if request_json else 'World'
    return json.dumps({'message': f'Hello, {name}!'})
```

```
# requirements.txt
functions-framework==3.*
```

```bash
# Local testing
functions-framework --target hello_http --debug

# Deploy (2nd gen)
gcloud functions deploy hello-http \
  --gen2 \
  --runtime python312 \
  --region us-central1 \
  --source . \
  --entry-point hello_http \
  --trigger-http \
  --allow-unauthenticated \
  --memory 256Mi \
  --timeout 60s \
  --min-instances 0 \
  --max-instances 10

# Invoke
gcloud functions call hello-http \
  --region us-central1 \
  --data '{"name": "Igal"}'
```

### Pub/Sub Event Function
```python
import functions_framework
import base64
import json

@functions_framework.cloud_event
def process_message(cloud_event):
    """Triggered by a Pub/Sub message."""
    # Pub/Sub message data is base64-encoded
    data = base64.b64decode(cloud_event.data["message"]["data"]).decode("utf-8")
    message = json.loads(data)
    print(f"Processing: {message}")
    # Return None (Pub/Sub functions don't return a response)
```

```bash
# Deploy with Pub/Sub trigger
gcloud functions deploy process-message \
  --gen2 \
  --runtime python312 \
  --region us-central1 \
  --source . \
  --entry-point process_message \
  --trigger-topic my-topic \
  --memory 512Mi

# Send a test message
gcloud pubsub topics publish my-topic \
  --message '{"key": "value"}'
```

### Cloud Storage Event Function
```python
import functions_framework
from google.cloud import storage

@functions_framework.cloud_event
def on_file_upload(cloud_event):
    """Triggered when a file is uploaded to GCS."""
    data = cloud_event.data
    bucket_name = data["bucket"]
    file_name = data["name"]

    print(f"File uploaded: gs://{bucket_name}/{file_name}")

    # Process the file
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(file_name)
    content = blob.download_as_text()
    # ...
```

```bash
# Deploy with Cloud Storage trigger via Eventarc
gcloud functions deploy on-file-upload \
  --gen2 \
  --runtime python312 \
  --region us-central1 \
  --source . \
  --entry-point on_file_upload \
  --trigger-event-filters="type=google.cloud.storage.object.v1.finalized" \
  --trigger-event-filters="bucket=my-trigger-bucket" \
  --trigger-location us-central1
```

### Environment Variables and Secrets
```bash
# Set environment variables at deploy time
gcloud functions deploy myfunction \
  --set-env-vars API_URL=https://api.example.com,APP_ENV=production

# Reference Secret Manager secrets (recommended for sensitive values)
gcloud functions deploy myfunction \
  --set-secrets DB_PASSWORD=projects/my-project/secrets/db-password:latest
```

```python
import os
import functions_framework

@functions_framework.http
def handler(request):
    api_url = os.environ['API_URL']
    db_password = os.environ['DB_PASSWORD']   # injected from Secret Manager
```

### Service Account and IAM
```bash
# Deploy with a specific service account
gcloud functions deploy myfunction \
  --service-account myfunction-sa@my-project.iam.gserviceaccount.com \
  ...

# Grant the function's SA access to GCS
gcloud projects add-iam-policy-binding my-project \
  --member serviceAccount:myfunction-sa@my-project.iam.gserviceaccount.com \
  --role roles/storage.objectAdmin
```

### Authenticated HTTP Functions
```bash
# Deploy without --allow-unauthenticated (requires Identity Token to call)
gcloud functions deploy secure-function \
  --gen2 \
  --runtime python312 \
  --trigger-http
  # no --allow-unauthenticated

# Call with an identity token
TOKEN=$(gcloud auth print-identity-token)
curl -H "Authorization: Bearer $TOKEN" \
  https://us-central1-my-project.cloudfunctions.net/secure-function
```

### Concurrency (2nd gen only)
```bash
# 2nd gen: one instance can handle multiple requests simultaneously
gcloud functions deploy myfunction \
  --gen2 \
  --concurrency 80 \
  --cpu 1 \
  --memory 512Mi
```

Unlike Lambda (one request per instance), 2nd gen functions share an instance across concurrent requests. This dramatically reduces cold starts for moderate traffic — the same instance handles multiple requests.

### Logs and Monitoring
```bash
# View function logs
gcloud functions logs read hello-http \
  --region us-central1 \
  --limit 50

# Stream logs (follow)
gcloud functions logs read hello-http \
  --region us-central1 \
  --limit 50 \
  --format json | jq '.[]'

# View via gcloud logging
gcloud logging read 'resource.type=cloud_function AND resource.labels.function_name=hello-http' \
  --limit 20 \
  --format 'value(timestamp, textPayload)'
```

### Local Development
```bash
# Install the Functions Framework
pip install functions-framework

# Test HTTP function locally
functions-framework --target hello_http --port 8080

# Send test request
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"name": "test"}'

# Test event function locally
functions-framework --target process_message \
  --signature-type cloudevent
```

## Examples

### Image Processing Pipeline
```python
# main.py — triggered when an image is uploaded to a raw bucket
import functions_framework
from google.cloud import storage
from PIL import Image
import io

@functions_framework.cloud_event
def resize_image(cloud_event):
    data = cloud_event.data
    source_bucket = data["bucket"]
    source_blob = data["name"]

    if not source_blob.lower().endswith(('.jpg', '.jpeg', '.png')):
        return

    client = storage.Client()
    src = client.bucket(source_bucket).blob(source_blob)
    img_bytes = src.download_as_bytes()

    img = Image.open(io.BytesIO(img_bytes))
    img.thumbnail((800, 800))

    output = io.BytesIO()
    img.save(output, format=img.format)
    output.seek(0)

    dest_bucket = client.bucket('my-processed-images')
    dest_bucket.blob(source_blob).upload_from_file(output, content_type=src.content_type)
    print(f"Resized {source_blob}")
```

## Exercises

1. Write and deploy an HTTP Cloud Function (2nd gen, Python) that accepts a JSON body with a `text` field and returns the text reversed. Test with `gcloud functions call` and with `curl`.
2. Create a Pub/Sub topic and deploy a Cloud Function triggered by it. The function should log the decoded message content. Publish 5 test messages and verify all appear in the function logs.
3. Deploy a Cloud Storage-triggered function that logs the name and size of every file uploaded to a specific bucket. Verify by uploading several files and checking the logs.
4. Deploy a secure (authenticated) HTTP function. Write a Python script that calls it with a valid identity token obtained via `gcloud auth print-identity-token`. Verify the same URL returns 403 without the token.

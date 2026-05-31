# GCP — Quick Reference

## gcloud Setup

| Command | Description |
|---------|-------------|
| `gcloud init` | Initialize SDK and login |
| `gcloud auth login` | Authenticate |
| `gcloud auth application-default login` | Auth for application code |
| `gcloud config list` | Show active config |
| `gcloud config set project PROJECT_ID` | Set default project |
| `gcloud config set compute/zone us-central1-a` | Set default zone |
| `gcloud config configurations list` | List named configurations |
| `gcloud info` | SDK environment info |

## Compute Engine

| Command | Description |
|---------|-------------|
| `gcloud compute instances list` | List VMs |
| `gcloud compute instances create name --zone=z --machine-type=e2-micro` | Create VM |
| `gcloud compute instances start name --zone=z` | Start instance |
| `gcloud compute instances stop name --zone=z` | Stop instance |
| `gcloud compute instances delete name --zone=z` | Delete instance |
| `gcloud compute ssh name --zone=z` | SSH into instance |
| `gcloud compute scp file name:~/dest --zone=z` | Copy file to instance |
| `gcloud compute firewall-rules list` | List firewall rules |

## GKE

| Command | Description |
|---------|-------------|
| `gcloud container clusters list` | List GKE clusters |
| `gcloud container clusters create name --zone=z --num-nodes=3` | Create cluster |
| `gcloud container clusters get-credentials name --zone=z` | Configure kubectl |
| `gcloud container clusters delete name --zone=z` | Delete cluster |
| `gcloud container images list` | List images in Container Registry |

## Cloud Storage

| Command | Description |
|---------|-------------|
| `gsutil ls` | List buckets |
| `gsutil ls gs://bucket/` | List bucket contents |
| `gsutil cp file gs://bucket/path` | Upload file |
| `gsutil cp gs://bucket/path file` | Download file |
| `gsutil rsync -r dir/ gs://bucket/` | Sync directory |
| `gsutil rm gs://bucket/path` | Delete object |
| `gsutil mb gs://bucket-name` | Create bucket |
| `gsutil du -sh gs://bucket/` | Bucket size |

## IAM

| Command | Description |
|---------|-------------|
| `gcloud iam service-accounts list` | List service accounts |
| `gcloud iam service-accounts create name` | Create service account |
| `gcloud projects add-iam-policy-binding PROJECT --member=... --role=...` | Bind role |
| `gcloud iam service-accounts keys create key.json --iam-account=SA_EMAIL` | Create SA key |

## Cloud Functions & Run

| Command | Description |
|---------|-------------|
| `gcloud functions list` | List Cloud Functions |
| `gcloud functions deploy name --runtime=python39 --trigger-http` | Deploy function |
| `gcloud functions logs read name` | Function logs |
| `gcloud run services list` | List Cloud Run services |
| `gcloud run deploy svc --image=img --platform=managed` | Deploy Cloud Run service |

## Logging

| Command | Description |
|---------|-------------|
| `gcloud logging read "resource.type=gce_instance"` | Read logs with filter |
| `gcloud logging read "severity=ERROR" --limit=50` | Recent errors |
| `gcloud logging tail "resource.type=cloud_run_revision"` | Follow logs |

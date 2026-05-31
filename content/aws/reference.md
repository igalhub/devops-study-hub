# AWS — Quick Reference

## CLI Setup

| Command | Description |
|---------|-------------|
| `aws configure` | Set access key, secret, region, format |
| `aws configure list` | Show current config |
| `aws configure list-profiles` | Show named profiles |
| `aws --profile name cmd` | Use named profile |
| `AWS_PROFILE=name aws cmd` | Profile via env var |
| `aws sts get-caller-identity` | Verify current identity |

## EC2

| Command | Description |
|---------|-------------|
| `aws ec2 describe-instances` | List all instances |
| `aws ec2 describe-instances --filters "Name=tag:Name,Values=myapp"` | Filter by tag |
| `aws ec2 start-instances --instance-ids i-xxx` | Start instance |
| `aws ec2 stop-instances --instance-ids i-xxx` | Stop instance |
| `aws ec2 describe-images --owners amazon --filters "Name=name,Values=amzn2*"` | Find AMIs |
| `aws ec2 describe-security-groups` | List security groups |
| `aws ec2 describe-key-pairs` | List key pairs |

## S3

| Command | Description |
|---------|-------------|
| `aws s3 ls` | List buckets |
| `aws s3 ls s3://bucket/` | List bucket contents |
| `aws s3 cp file s3://bucket/path` | Upload file |
| `aws s3 cp s3://bucket/path file` | Download file |
| `aws s3 sync dir/ s3://bucket/` | Sync directory to bucket |
| `aws s3 sync s3://bucket/ dir/` | Sync bucket to directory |
| `aws s3 rm s3://bucket/path` | Delete object |
| `aws s3 rb s3://bucket --force` | Delete bucket and contents |
| `aws s3 presign s3://bucket/key --expires-in 3600` | Generate presigned URL |

## IAM

| Command | Description |
|---------|-------------|
| `aws iam list-users` | List IAM users |
| `aws iam list-roles` | List IAM roles |
| `aws iam list-policies --scope Local` | List custom policies |
| `aws iam get-role --role-name name` | Get role details |
| `aws iam attach-role-policy --role-name r --policy-arn arn` | Attach policy |
| `aws iam create-user --user-name name` | Create user |
| `aws iam create-access-key --user-name name` | Create access key |

## EKS

| Command | Description |
|---------|-------------|
| `aws eks list-clusters` | List EKS clusters |
| `aws eks describe-cluster --name name` | Cluster details |
| `aws eks update-kubeconfig --name name --region r` | Add cluster to kubeconfig |

## CloudWatch Logs

| Command | Description |
|---------|-------------|
| `aws logs describe-log-groups` | List log groups |
| `aws logs describe-log-streams --log-group-name name` | List streams |
| `aws logs tail /aws/lambda/func --follow` | Follow log stream |
| `aws logs filter-log-events --log-group-name name --filter-pattern "ERROR"` | Filter logs |

## Common Flags

| Flag | Description |
|------|-------------|
| `--region us-east-1` | Override region |
| `--output json` | JSON output |
| `--output text` | Plain text output |
| `--output table` | Tabular output |
| `--query 'Items[*].Name'` | JMESPath filter |
| `--no-paginate` | Disable auto-pagination |
| `--dry-run` | Validate without executing (EC2) |

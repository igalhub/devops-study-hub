---
title: AWS Cost Management
module: aws
duration_min: 20
difficulty: intermediate
tags: [aws, cost, billing, cost-explorer, budgets, savings-plans, spot, tagging]
exercises: 4
---

## Overview
AWS bills grow silently. An undeleted NAT Gateway, a forgotten EC2 instance, or an S3 bucket accumulating 10 GB/day can go unnoticed for weeks. Cost management is an operational discipline: understand what you're spending, why, and how to reduce it without degrading reliability. The tools are Cost Explorer, Budgets, and the pricing model for each service.

## Concepts

### Cost Explorer
```bash
# Get last month's top 5 services by cost
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[0].Groups | sort_by(@, &Metrics.BlendedCost.Amount) | reverse(@) | [:5].[Keys[0], Metrics.BlendedCost.Amount]' \
  --output table

# Daily cost for the last 7 days
aws ce get-cost-and-usage \
  --time-period Start=2025-05-19,End=2025-05-26 \
  --granularity DAILY \
  --metrics BlendedCost \
  --query 'ResultsByTime[].[TimePeriod.Start, Total.BlendedCost.Amount]' \
  --output table

# Cost by tag (requires tagged resources)
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=TAG,Key=Environment
```

### Budgets and Alerts
```bash
# Create a monthly budget with email alert at 80% and 100%
aws budgets create-budget \
  --account-id 123456789 \
  --budget '{
    "BudgetName": "monthly-total",
    "BudgetType": "COST",
    "TimeUnit": "MONTHLY",
    "BudgetLimit": {"Amount": "500", "Unit": "USD"}
  }' \
  --notifications-with-subscribers '[
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 80,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "igal@example.com"}]
    },
    {
      "Notification": {
        "NotificationType": "FORECASTED",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 100,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "igal@example.com"}]
    }
  ]'
```

Set budgets for: total account, per service (EC2, RDS, data transfer), per team (using tags).

### EC2 Pricing Models

| Model | Use Case | Savings vs On-Demand |
|---|---|---|
| On-Demand | Unpredictable, short-term | — |
| Savings Plans | Steady baseline workload | up to 72% |
| Reserved Instances | Predictable, 1-3 year commitment | up to 75% |
| Spot | Fault-tolerant, interruptible | up to 90% |
| Scheduled Reserved | Predictable but periodic | up to 25% |

#### Spot Instances
```bash
# Request a spot instance
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type m6i.large \
  --instance-market-options '{
    "MarketType": "spot",
    "SpotOptions": {
      "SpotInstanceType": "persistent",
      "InstanceInterruptionBehavior": "stop"
    }
  }'

# Check spot price history
aws ec2 describe-spot-price-history \
  --instance-types m6i.large c6i.large \
  --product-descriptions Linux/UNIX \
  --start-time 2025-05-20 \
  --query 'SpotPriceHistory | sort_by(@, &Timestamp) | [-5:].[InstanceType, SpotPrice, AvailabilityZone]' \
  --output table
```

Spot instances are reclaimed with a 2-minute warning when AWS needs the capacity. Design for interruption: use termination handlers, checkpoint state, and run stateless or easily-restartable workloads.

#### Savings Plans
Savings Plans commit to a spend level ($/hour) for 1 or 3 years in exchange for a discount. Two types:
- **Compute Savings Plans** — most flexible, applies to EC2, Lambda, Fargate regardless of region/instance family
- **EC2 Instance Savings Plans** — highest discount, tied to specific instance family and region

```bash
# See your current Savings Plans utilization
aws ce get-savings-plans-utilization \
  --time-period Start=2025-04-01,End=2025-05-01
```

### S3 Storage Classes

| Class | Use Case | Cost |
|---|---|---|
| Standard | Frequently accessed | ~$0.023/GB |
| Standard-IA | Infrequent access, rapid retrieval | ~$0.0125/GB + retrieval fee |
| One Zone-IA | Infrequent, single AZ | ~$0.01/GB |
| Glacier Instant Retrieval | Archives accessed once/quarter | ~$0.004/GB |
| Glacier Flexible Retrieval | Archives, 1-12 hour retrieval | ~$0.0036/GB |
| Glacier Deep Archive | Rarely accessed, 12-48h retrieval | ~$0.00099/GB |
| Intelligent-Tiering | Unknown/changing access patterns | monitoring fee + tiered |

```bash
# Move objects to Glacier after 90 days, delete after 365
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "archive-old-objects",
      "Status": "Enabled",
      "Prefix": "logs/",
      "Transitions": [
        {"Days": 90, "StorageClass": "GLACIER"},
        {"Days": 365, "StorageClass": "DEEP_ARCHIVE"}
      ],
      "Expiration": {"Days": 2555}
    }]
  }'
```

### Resource Tagging for Cost Allocation
Tags are key-value pairs attached to AWS resources. Without consistent tagging, you can't tell which team or application is driving costs.

```bash
# Tag resources at creation
aws ec2 run-instances ... \
  --tag-specifications '
    ResourceType=instance,Tags=[
      {Key=Environment,Value=production},
      {Key=Team,Value=platform},
      {Key=Application,Value=myapp}
    ]'

# Tag existing resources
aws ec2 create-tags \
  --resources i-1234567890abcdef0 \
  --tags Key=Environment,Value=production

# List untagged EC2 instances
aws ec2 describe-instances \
  --query 'Reservations[*].Instances[?!not_null(Tags[?Key==`Environment`])].[InstanceId]' \
  --output text
```

Activate cost allocation tags in **Billing → Cost Allocation Tags** before they appear in Cost Explorer.

### Cost Optimization Practices

**Right-sizing**
```bash
# Check CPU/memory utilization — if consistently <10%, downsize
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-1234567890abcdef0 \
  --start-time 2025-05-01T00:00:00Z \
  --end-time 2025-05-26T00:00:00Z \
  --period 86400 \
  --statistics Average \
  --query 'Datapoints | sort_by(@, &Timestamp) | [*].[Timestamp, Average]' \
  --output table
```

**Idle resource detection**
```bash
# Find stopped EC2 instances (still incurring EBS costs)
aws ec2 describe-instances \
  --filters Name=instance-state-name,Values=stopped \
  --query 'Reservations[*].Instances[*].[InstanceId, InstanceType, Tags[?Key==`Name`].Value|[0]]' \
  --output table

# Find unattached EBS volumes
aws ec2 describe-volumes \
  --filters Name=status,Values=available \
  --query 'Volumes[*].[VolumeId, Size, CreateTime]' \
  --output table

# Find unused Elastic IPs (costs $0.005/hr when not attached)
aws ec2 describe-addresses \
  --query 'Addresses[?!InstanceId].[PublicIp, AllocationId]' \
  --output table
```

**Data transfer costs**
```
Free: data in, within same AZ
$0.01/GB: cross-AZ (biggest hidden cost for multi-AZ architectures)
$0.09/GB: out to internet (first 10 TB/month)
Free: out via CloudFront from S3/EC2
```

## Exercises

1. Use Cost Explorer CLI to break down last month's spend by service. Identify your top 3 cost drivers. Then filter by a specific tag (e.g. Environment=production) to see production-only costs.
2. Create a monthly budget for $50 with email alerts at 80% (actual) and 100% (forecasted). Verify the alert configuration with `aws budgets describe-budgets`.
3. Find all unattached EBS volumes, unused Elastic IPs, and stopped EC2 instances in your account. Calculate the monthly cost of these idle resources using current AWS pricing.
4. Add a lifecycle policy to an S3 bucket that transitions objects in the `logs/` prefix to Glacier Instant Retrieval after 30 days and deletes them after 365 days. Verify the policy with `aws s3api get-bucket-lifecycle-configuration`.

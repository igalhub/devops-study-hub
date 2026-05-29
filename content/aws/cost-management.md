---
title: AWS Cost Management
module: aws
duration_min: 20
difficulty: intermediate
tags: [aws, cost, billing, cost-explorer, budgets, savings-plans, spot, tagging]
exercises: 4
---

## Overview

AWS bills grow silently. An undeleted NAT Gateway costs ~$32/month before you move a single byte through it. A forgotten EC2 instance running idle, an S3 bucket accumulating 10 GB/day, an Elastic IP sitting unattached — these are the real failure modes of cloud operations. Cost management is not a finance function; it is an operational discipline that belongs in the same category as reliability and security. In a DevOps role you will be expected to understand what the infrastructure costs, explain why it costs that, and reduce waste without degrading service.

The guiding principle of AWS cost management is **visibility before action**: you cannot optimize what you cannot see. The toolchain follows a natural sequence — tag resources so costs are attributable, use Cost Explorer to understand current spending, set Budgets to detect anomalies early, then apply the right pricing model and storage class to each workload. Every step depends on the previous one. An account with no tags produces Cost Explorer reports that are useless for team-level attribution.

In the broader DevOps toolchain, cost management sits alongside infrastructure provisioning and monitoring. Terraform and CloudFormation enforce tagging at creation time; CloudWatch provides the utilization data needed for right-sizing decisions; CI/CD pipelines are the right place to enforce tag policies before resources are ever created. AWS-native tools (Cost Explorer, Budgets, Trusted Advisor, Compute Optimizer) handle the analysis layer. The skills in this lesson apply directly to reducing cloud spend in production environments and will be tested in interviews through scenario questions like "our AWS bill jumped 40% last month — walk me through how you'd investigate."

---

## Concepts

### Cost Explorer

Cost Explorer is the primary analysis tool for AWS spend. It provides a console UI and a full CLI/API surface. The API is useful for scripting cost reports into Slack, dashboards, or runbooks.

**Key metrics:**

| Metric | What it measures | When to use it |
|--------|-----------------|----------------|
| `BlendedCost` | Effective cost after blending Reserved and On-Demand rates across an org | Total-spend reporting at org level |
| `UnblendedCost` | Actual charge on each account's line item | Per-account billing in AWS Organizations |
| `AmortizedCost` | Spreads upfront RI and Savings Plan payments across commitment period | Accurate per-day trending |
| `NetAmortizedCost` | Amortized minus RI/SP discounts and credits | True net cost after all discounts |

Use `AmortizedCost` for day-to-day trending — it smooths out the large upfront spike that `UnblendedCost` shows in the month you purchase a Reserved Instance, giving you a cleaner signal for anomaly detection.

```bash
# Top 5 services by cost last month
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[0].Groups | sort_by(@, &Metrics.BlendedCost.Amount) | reverse(@) | [:5].[Keys[0], Metrics.BlendedCost.Amount]' \
  --output table

# Daily cost trend for the last 7 days — useful for pinpointing the exact day a cost spiked
aws ce get-cost-and-usage \
  --time-period Start=2025-05-19,End=2025-05-26 \
  --granularity DAILY \
  --metrics BlendedCost \
  --query 'ResultsByTime[].[TimePeriod.Start, Total.BlendedCost.Amount]' \
  --output table

# Cost by tag — requires tags to be activated as cost allocation tags in Billing console first
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=TAG,Key=Environment

# EC2-only costs broken down by region — useful when investigating compute sprawl
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["Amazon Elastic Compute Cloud - Compute"]}}' \
  --group-by Type=DIMENSION,Key=REGION \
  --output table
```

**Cost Explorer has a 24-48 hour data lag.** It does not show real-time spend. For real-time visibility on a specific service, use CloudWatch billing metrics or set a Budget with SNS.

**The API costs $0.01 per request.** Running a Cost Explorer query 10,000 times a month in a Lambda loop will add $100 to your bill. Cache results and run queries on a schedule, not per-request.

**Activating cost allocation tags is a manual step that most teams forget.** After you add a tag to resources, you must separately go to the Billing console → Cost Allocation Tags and activate it. Tags added to resources today will not appear in Cost Explorer groupings until they are activated, and historical data before activation is not backfilled.

---

### Budgets and Alerts

Budgets are proactive guardrails. Cost Explorer tells you what happened; Budgets tell you what is about to happen. Set them up before you need them — the notification lag on `ACTUAL` alerts is up to 8 hours, so you are not getting real-time interruption, but you will catch runaway spend within a day.

**Budget types:**

| Type | What it tracks |
|------|---------------|
| `COST` | Dollar spend |
| `USAGE` | Service-unit usage (e.g., EC2 instance-hours, S3 GB) |
| `SAVINGS_PLANS_UTILIZATION` | Whether your Savings Plan commitment is being fully used |
| `SAVINGS_PLANS_COVERAGE` | Fraction of eligible spend covered by a Savings Plan |
| `RI_UTILIZATION` | Reserved Instance utilization percentage |
| `RI_COVERAGE` | Fraction of eligible instance-hours covered by RIs |

```bash
# Monthly cost budget: alert at 80% actual spend, 100% forecasted spend
# Two separate notifications — one email-only, one SNS for automation
aws budgets create-budget \
  --account-id 123456789012 \
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
      "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "oncall@example.com"}]
    },
    {
      "Notification": {
        "NotificationType": "FORECASTED",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 100,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        {"SubscriptionType": "EMAIL", "Address": "oncall@example.com"},
        {"SubscriptionType": "SNS", "Address": "arn:aws:sns:us-east-1:123456789012:billing-alerts"}
      ]
    }
  ]'

# Verify the budget was created correctly
aws budgets describe-budgets \
  --account-id 123456789012 \
  --query 'Budgets[?BudgetName==`monthly-total`].[BudgetName, BudgetLimit.Amount, BudgetType]' \
  --output table

# Add a per-team budget using cost allocation tags
# Requires the Team tag to be activated in Cost Allocation Tags first
aws budgets create-budget \
  --account-id 123456789012 \
  --budget '{
    "BudgetName": "team-platform-monthly",
    "BudgetType": "COST",
    "TimeUnit": "MONTHLY",
    "BudgetLimit": {"Amount": "200", "Unit": "USD"},
    "CostFilters": {
      "TagKeyValue": ["user:Team$platform"]
    }
  }' \
  --notifications-with-subscribers '[
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 90,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "platform-lead@example.com"}]
    }
  ]'
```

**Budget coverage strategy:** create budgets at three levels:
1. **Account total** — catches any unexpected overall growth
2. **Per service** — EC2, RDS, and data transfer are the usual top spenders; budget them individually
3. **Per tag** — one budget per team (`Team=platform`, `Team=data`) if you use cost allocation tags

**SNS integration enables automation.** Wire the SNS topic to a Lambda that posts to Slack or creates a PagerDuty incident. Email-only budgets get ignored; SNS-backed ones get actioned.

**`FORECASTED` budgets require at least 5 days of current-month spend data** before AWS has enough signal to generate a forecast. In the first few days of a month, only `ACTUAL` alerts will fire.

---

### EC2 Pricing Models

Understanding EC2 pricing models is one of the highest-leverage cost decisions in AWS. Most interviews will include a scenario question on which model fits which workload.

| Model | Use Case | Savings vs On-Demand | Commitment |
|-------|----------|---------------------|------------|
| On-Demand | Unpredictable, short-term, testing | — | None |
| Savings Plans (Compute) | Steady baseline, any instance family | up to 66% | 1 or 3 year hourly spend |
| Savings Plans (EC2 Instance) | Steady baseline, fixed family/region | up to 72% | 1 or 3 year hourly spend |
| Reserved Instances (Standard) | Stable, single instance type, multi-year | up to 75% | 1 or 3 year |
| Reserved Instances (Convertible) | Predictable but may need to change type | up to 54% | 1 or 3 year |
| Spot | Batch, CI, stateless, fault-tolerant | up to 90% | None — can be reclaimed |

**Do not commit before you have 2-3 months of utilization data.** Buying a 3-year Reserved Instance for an instance type you later right-size is an expensive mistake. Use Compute Optimizer and Cost Explorer RI/Savings Plan recommendations only after your workload is stable.

#### Spot Instances

Spot instances run on AWS spare capacity. When AWS needs that capacity back, your instance receives a 2-minute interruption notice via instance metadata and EventBridge, then is stopped or terminated depending on your configuration.

```bash
# Launch a spot instance with stop-on-interruption behavior
# persistent type means AWS will re-launch it when capacity returns
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type m6i.large \
  --instance-market-options '{
    "MarketType": "spot",
    "SpotOptions": {
      "SpotInstanceType": "persistent",
      "InstanceInterruptionBehavior": "stop"
    }
  }' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=spot-worker},{Key=Team,Value=data}]'

# Poll the instance metadata endpoint for a 2-minute warning inside the instance
# Run this as a background daemon in your userdata or systemd unit
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/spot/termination-time
# Returns 404 if no interruption is pending; returns a timestamp if one is imminent

# Check current spot prices across instance types and AZs to find cheapest pool
aws ec2 describe-spot-price-history \
  --instance-types m6i.large c6i.large r6i.large \
  --product-descriptions Linux/UNIX \
  --start-time 2025-05-20 \
  --query 'SpotPriceHistory | sort_by(@, &Timestamp) | [-15:].[InstanceType, SpotPrice, AvailabilityZone]' \
  --output table
```

**Interruption handling is mandatory, not optional.** Your application must handle `SIGTERM` gracefully. A termination handler should checkpoint state (write progress to SQS or DynamoDB), drain in-flight work, and exit cleanly within 2 minutes. CI/CD workers, EMR nodes, and batch processing jobs are natural fits. Databases and stateful services are not.

**Use Spot with Auto Scaling Groups and multiple instance types.** A `capacity-optimized` allocation strategy picks the pool with the most available capacity, reducing interruption frequency. Never target a single instance type in a single AZ with Spot — you are guaranteed an outage when that pool runs dry.

```bash
# Create a mixed instance policy ASG — baseline On-Demand + Spot for scale
# 2 on-demand base, then 80% spot / 20% on-demand for any additional capacity
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name mixed-worker-asg \
  --min-size 2 \
  --max-size 20 \
  --desired-capacity 5 \
  --vpc-zone-identifier "subnet-aaa,subnet-bbb,subnet-ccc" \
  --mixed-instances-policy '{
    "LaunchTemplate": {
      "LaunchTemplateSpecification": {
        "LaunchTemplateName": "worker-lt",
        "Version": "$Latest"
      },
      "Overrides": [
        {"InstanceType": "m6i.large"},
        {"InstanceType": "m5.large"},
        {"InstanceType": "m5a.large"},
        {"InstanceType": "c6i.large"}
      ]
    },
    "InstancesDistribution": {
      "OnDemandBaseCapacity": 2,
      "OnDemandPercentageAboveBaseCapacity": 20,
      "SpotAllocationStrategy": "capacity-optimized"
    }
  }'
```

#### Savings Plans

Savings Plans commit to a minimum hourly spend (e.g., $1.50/hour) across any eligible compute in exchange for a discount. They are more flexible than Reserved Instances and the recommended path for most teams today.

```bash
# Check current Savings Plans utilization — are you getting full value from your commitment?
aws ce get-savings-plans-utilization \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --query 'Total.Utilization'
# UtilizationPercentage below 90% means you are wasting committed spend

# Get Savings Plans purchase recommendations based on actual usage
# lookback SIXTY_DAYS smooths over weekly patterns better than SEVEN_DAYS
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days SIXTY_DAYS \
  --query 'Recommendations[0].{
    HourlyCommitment: RecommendationDetail.HourlyCommitmentToPurchase,
    EstimatedSavings: RecommendationDetail.EstimatedSavingsAmount,
    Coverage: RecommendationDetail.EstimatedAverageCoverage
  }'
```

**Compute Savings Plans vs EC2 Instance Savings Plans:**

| | Compute SP | EC2 Instance SP |
|-|-----------|-----------------|
| Scope | EC2 (any family/region/OS), Lambda, Fargate | Specific instance family in specific region |
| Discount | ~66% | ~72% |
| Flexibility | Any instance type, region, OS | Locked to family; can change size within family |
| Best for | Teams that resize or migrate regions | Workloads stable for 1-3 years |

**All-Upfront vs No-Upfront:** All-Upfront gives the deepest discount and eliminates monthly billing complexity. No-Upfront preserves cash flow at a slightly lower discount. For most engineering teams, No-Upfront 1-year Compute SP is the practical starting point — commit conservatively to your guaranteed baseline, let spikes run On-Demand.

**Savings Plans apply automatically to eligible usage.** You do not configure which instances they cover. AWS applies the discount to the most expensive eligible usage first. This means an underutilized Savings Plan is pure waste — the committed hourly spend is charged whether or not you have instances running.

---

### S3 Storage Classes

S3 costs have two components: **storage cost per GB** and **request/retrieval fees**. Choosing the wrong storage class for access patterns wastes money in both directions — Standard is expensive for cold data; Glacier has retrieval costs that exceed storage savings if you access data frequently.

| Class | Use Case | ~Storage Cost | Retrieval Fee | Min Duration |
|-------|----------|--------------|---------------|--------------|
| Standard | Frequently accessed | $0.023/GB | None | None |
| Standard-IA | Monthly access, rapid retrieval | $0.0125/GB | $0.01/GB | 30 days |
| One Zone-IA | Infrequent, tolerate single-AZ loss | $0.01/GB | $0.01/GB | 30 days |
| Glacier Instant Retrieval | Quarterly access, millisecond retrieval | $0.004/GB | $0.03/GB | 90 days |
| Glacier Flexible Retrieval | Yearly access, hours acceptable | $0.0036/GB | $0.01/GB (std) | 90 days |
| Glacier Deep Archive | Rarely accessed, 12-48h retrieval | $0.00099/GB | $0.02/GB | 180 days |
| Intelligent-Tiering | Unknown or changing access patterns | $0.023/GB + $0.0025/1k objects | None | None |

**Minimum duration billing:** if you delete a Standard-IA object after 15 days, you are still billed for 30 days. Factor this into lifecycle rule design — do not transition short-lived objects to IA classes. A log file that is deleted after 14 days should stay in Standard.

```bash
# Lifecycle policy: transition logs/ through classes then expire
# Chaining transitions reduces per-request cost on large object volumes
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-app-logs \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "archive-logs",
      "Status": "Enabled",
      "Filter": {"Prefix": "logs/"},
      "Transitions": [
        {"Days": 30, "StorageClass": "STANDARD_IA"},
        {"Days": 90, "StorageClass": "GLACIER"},
        {"Days": 365, "StorageClass": "DEEP_ARCHIVE"}
      ],
      "Expiration": {"Days": 2555}
    }]
  }'

# Verify the policy applied correctly — inspect all rules
aws s3api get-bucket-lifecycle-configuration --bucket my-app-logs

# Abort incomplete multipart uploads — these are invisible storage costs
# Files stuck mid-upload accumulate charges forever unless you clean them up
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-app-logs \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "abort-multipart",
        "Status": "Enabled",
        "Filter": {},
        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}
      }
    ]
  }'

# Find total size of each bucket to prioritize lifecycle work
for bucket in $(aws s3api list-buckets --query 'Buckets[*].Name' --output text); do
  echo -n "$bucket: "
  aws s3 ls s3://${bucket} --recursive --summarize 2>/dev/null | grep "Total Size"
done
```

**Intelligent-Tiering costs $0.0025 per 1,000 objects per month for monitoring.** On a bucket with 10 million small objects, the monitoring fee is $25/month regardless of how small those objects are. For workloads with many tiny files and predictable access patterns, a manual lifecycle rule is cheaper. Intelligent-Tiering is a fit for large objects (>128KB) with genuinely unpredictable access.

**Objects smaller than 128KB are always billed at Standard-IA pricing even when stored in Standard-IA.** The per-request overhead makes small-object IA transitions a net cost increase, not a saving.

---

### Resource Tagging for Cost Allocation

Tags are the foundation of cost accountability. Without consistent tagging, Cost Explorer shows you total AWS spend but cannot tell you which team, application, or environment is responsible for it. Tagging is an operational standard that must be enforced at the infrastructure level, not left to individual engineers.

**Recommended minimum tag set:**

| Tag Key | Example Values | Purpose |
|---------|---------------|---------|
| `Environment` | `production`, `staging`, `dev` | Environment-level cost breakdown |
| `Team` | `platform`, `data`, `backend` | Team-level chargeback |
| `Application` | `payments-api`, `ml-pipeline` | Application-level cost tracking |
| `CostCenter` | `CC-1042` | Finance chargeback codes |
| `ManagedBy` | `terraform`, `cloudformation` | Identify unmanaged/rogue resources |

**Tags must be activated as Cost Allocation Tags** in the Billing console before they appear in Cost Explorer groupings. This is a separate step from adding tags to resources. Only the management account (in AWS Organizations) can activate tags.

#### Enforcing Tags with AWS Config

Use an AWS Config managed rule to detect non-compliant resources automatically. This does not block creation but creates a compliance record you can act on.

```bash
# Deploy the required-tags Config rule via CLI
# Flags any EC2 instance missing the Environment or Team tag
aws configservice put-config-rule \
  --config-rule '{
    "ConfigRuleName": "required-tags-ec2",
    "Source": {
      "Owner": "AWS",
      "SourceIdentifier": "REQUIRED_TAGS"
    },
    "Scope": {
      "ComplianceResourceTypes": ["AWS::EC2::Instance"]
    },
    "InputParameters": "{\"tag1Key\":\"Environment\",\"tag2Key\":\"Team\"}"
  }'

# Check compliance — see which instances are violating the tag policy
aws configservice get-compliance-details-by-config-rule \
  --config-rule-name required-tags-ec2 \
  --compliance-types NON_COMPLIANT \
  --query 'EvaluationResults[*].EvaluationResultIdentifier.EvaluationResultQualifier.ResourceId' \
  --output text
```

#### Enforcing Tags in Terraform

The cleanest enforcement point is infrastructure-as-code. Require tags at the provider level so any resource missing them fails the plan.

```hcl
# In your root module or shared provider config
# These default tags apply to every resource created by this provider
provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Environment = var.environment    # e.g., "production"
      Team        = var.team           # e.g., "platform"
      Application = var.application    # e.g., "payments-api"
      ManagedBy   = "terraform"
    }
  }
}

# Sentinel or OPA policy (pseudo-code) to enforce tags in CI
# Fails the plan if required tags are missing on any resource
# Run this in your CI pipeline before terraform apply
rule "required_tags" {
  required_keys = ["Environment", "Team", "Application"]
  resources     = terraform.plan.resource_changes
  condition     = all resources have required_keys in tags
}
```

**Finding untagged resources at scale:** use the Resource Groups Tagging API to query across all resource types and regions without manually checking each service.

```bash
# Find all resources missing the Team tag — works across EC2, RDS, S3, Lambda, etc.
aws resourcegroupstaggingapi get-resources \
  --tag-filters 'Key=Team' \
  --resource-type-filters 'ec2:instance' 'rds:db' 's3' \
  --query 'ResourceTagMappingList[?!(Tags[?Key==`Team`])].[ResourceARN]' \
  --output text

# Alternatively: find resources with no tags at all
aws resourcegroupstaggingapi get-resources \
  --resource-type-filters 'ec2:instance' \
  --query 'ResourceTagMappingList[?length(Tags)==`0`].[ResourceARN]' \
  --output text
```

---

### Right-Sizing and Compute Optimizer

Compute Optimizer analyzes CloudWatch utilization metrics and recommends the optimal instance type for EC2, ECS on Fargate, Lambda, and EBS volumes. It requires at least 14 days of data and the Compute Optimizer service to be opted in (it is not enabled by default).

```bash
# Enable Compute Optimizer for the account (one-time setup)
aws compute-optimizer update-enrollment-status --status Active

# Get EC2 right-sizing recommendations
aws compute-optimizer get-ec2-instance-recommendations \
  --query 'instanceRecommendations[*].{
    Instance: instanceArn,
    CurrentType: currentInstanceType,
    Finding: finding,
    RecommendedType: recommendationOptions[0].instanceType,
    EstimatedSavings: recommendationOptions[0].estimatedMonthlySavings.value
  }' \
  --output table

# Get EBS volume recommendations — oversized volumes are common and easy to fix
aws compute-optimizer get-ebs-volume-recommendations \
  --query 'volumeRecommendations[*].{
    Volume: volumeArn,
    CurrentType: currentConfiguration.volumeType,
    CurrentSize: currentConfiguration.volumeSize,
    RecommendedType: volumeRecommendationOptions[0].configuration.volumeType,
    EstimatedSavings: volumeRecommendationOptions[0].estimatedMonthlySavings.value
  }' \
  --output table
```

**Compute Optimizer `finding` values:**

| Finding | Meaning | Action |
|---------|---------|--------|
| `OVER_PROVISIONED` | CPU/memory consistently underutilized | Downsize |
| `UNDER_PROVISIONED` | CPU/memory consistently at or near limit | Upsize |
| `OPTIMIZED` | Current type fits the workload | No action |
| `NOT_OPTIMIZED` | Insufficient data or not enrolled | Wait for more data |

**Right-sizing in production requires coordination with the application team.** A p-95 CPU of 15% does not always mean the instance is safe to downsize — the headroom may be intentional for traffic spikes. Treat Compute Optimizer recommendations as leads, not directives.

---

## Examples

### Example 1: Investigating a 40% Cost Spike

This is the canonical interview scenario. Follow a structured investigation process using only CLI tools.

```bash
# Step 1: Compare this month vs last month by service to find the culprit
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-26 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[].[TimePeriod.Start, Groups[*].[Keys[0], Metrics.BlendedCost.Amount]]' \
  --output json | jq '.[] | {month: .[0], services: .[1]}'

# Step 2: Once you identify the spike service (e.g., EC2), drill into daily granularity
# This tells you which day the cost jumped, which narrows down which deployment triggered it
aws ce get-cost-and-usage \
  --time-period Start=2025-05-01,End=2025-05-26 \
  --granularity DAILY \
  --metrics BlendedCost \
  --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["Amazon Elastic Compute Cloud - Compute"]}}' \
  --group-by Type=DIMENSION,Key=REGION \
  --query 'ResultsByTime[].[TimePeriod.Start, Groups[*].[Keys[0], Metrics.BlendedCost.Amount]]' \
  --output json

# Step 3: Break down by usage type to see whether it is instance-hours, data transfer, etc.
aws ce get-cost-and-usage \
  --time-period Start=2025-05-15,End=2025-05-26 \
  --granularity DAILY \
  --metrics BlendedCost \
  --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["Amazon Elastic Compute Cloud - Compute"]}}' \
  --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --query 'ResultsByTime[0].Groups | sort_by(@, &Metrics.BlendedCost.Amount) | reverse(@) | [:10].[Keys[0], Metrics.BlendedCost.Amount]' \
  --output table

# Step 4: If data transfer is the culprit, identify NAT Gateway charges
# DataTransfer-Out-Bytes is a common hidden cost
aws ce get-cost-and-usage \
  --time-period Start=2025-05-01,End=2025-05-26 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["Amazon Virtual Private Cloud"]}}' \
  --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --output table

# Step 5: Find all NAT Gateways — unused ones cost ~$32/month in idle charges alone
aws ec2 describe-nat-gateways \
  --filter Name=state,Values=available \
  --query 'NatGateways[*].{ID: NatGatewayId, State: State, Created: CreateTime, VPC: VpcId}' \
  --output table
```

**Verification:** after identifying and removing the waste (e.g., deleting unused NAT Gateways), set a Budget for `Amazon Virtual Private Cloud` service at the previous month's spend + 10%. If the Budget triggers again within 30 days, the root cause was not fully resolved.

---

### Example 2: Setting Up Full Cost Visibility for a New Account

This is the sequence to run when taking over a new AWS account or onboarding a new team.

```bash
# 1. Enable Cost Explorer (takes ~24 hours to populate)
aws ce get-cost-and-usage \
  --time-period Start=2025-05-01,End=2025-05-02 \
  --granularity DAILY \
  --metrics BlendedCost 2>/dev/null || echo "Cost Explorer not yet enabled — enable in Billing console"

# 2. Activate cost allocation tags — must be done in the Billing console (no CLI available)
# Tags to activate: Environment, Team, Application, CostCenter
# Console path: Billing → Cost Allocation Tags → Activate

# 3. Create three-tier budget structure
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Account-level total
aws budgets create-budget \
  --account-id $ACCOUNT_ID \
  --budget '{
    "BudgetName": "account-monthly-total",
    "BudgetType": "COST",
    "TimeUnit": "MONTHLY",
    "BudgetLimit": {"Amount": "1000", "Unit": "USD"}
  }' \
  --notifications-with-subscribers '[
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 80,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "devops@example.com"}]
    },
    {
      "Notification": {
        "NotificationType": "FORECASTED",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 100,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        {"SubscriptionType": "SNS", "Address": "arn:aws:sns:us-east-1:${ACCOUNT_ID}:billing-alerts"}
      ]
    }
  ]'

# EC2-specific budget — typically the largest single line item
aws budgets create-budget \
  --account-id $ACCOUNT_ID \
  --budget '{
    "BudgetName": "ec2-monthly",
    "BudgetType": "COST",
    "TimeUnit": "MONTHLY",
    "BudgetLimit": {"Amount": "600", "Unit": "USD"},
    "CostFilters": {
      "Service": ["Amazon Elastic Compute Cloud - Compute"]
    }
  }' \
  --notifications-with-subscribers '[
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 90,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "devops@example.com"}]
    }
  ]'

# 4. Enable Compute Optimizer
aws compute-optimizer update-enrollment-status --status Active

# 5. Deploy required-tags Config rule
aws configservice put-config-rule \
  --config-rule '{
    "ConfigRuleName": "required-tags-all-resources",
    "Source": {
      "Owner": "AWS",
      "SourceIdentifier": "REQUIRED_TAGS"
    },
    "Scope": {
      "ComplianceResourceTypes": [
        "AWS::EC2::Instance",
        "AWS::RDS::DBInstance",
        "AWS::S3::Bucket",
        "AWS::Lambda::Function"
      ]
    },
    "InputParameters": "{\"tag1Key\":\"Environment\",\"tag2Key\":\"Team\",\"tag3Key\":\"Application\"}"
  }'

echo "Setup complete. Cost Explorer data available in 24-48h. Compute Optimizer in 14 days."
```

---

### Example 3: S3 Lifecycle Optimization for an Existing Bucket

A bucket with 5 TB of old application logs is costing ~$115/month in Standard storage. Apply lifecycle rules and validate the projected savings.

```bash
BUCKET="myapp-application-logs"

# Step 1: Understand what is in the bucket and how old it is
# Get a breakdown of object counts and sizes by age prefix (year/month structure)
aws s3api list-objects-v2 \
  --bucket $BUCKET \
  --prefix "logs/2024/" \
  --query '{Count: length(Contents), TotalKeys: Contents[*].Key}' \
  --output json | jq '{ObjectCount: .Count}'

# Step 2: Check if a lifecycle policy already exists
aws s3api get-bucket-lifecycle-configuration --bucket $BUCKET 2>&1 \
  || echo "No lifecycle policy — proceed with creation"

# Step 3: Apply a multi-stage lifecycle policy
# Assumes log files are never accessed after 30 days, verified with access logs
aws s3api put-bucket-lifecycle-configuration \
  --bucket $BUCKET \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "logs-tiering",
        "Status": "Enabled",
        "Filter": {"Prefix": "logs/"},
        "Transitions": [
          {"Days": 30,  "StorageClass": "STANDARD_IA"},
          {"Days": 90,  "StorageClass": "GLACIER_IR"},
          {"Days": 365, "StorageClass": "DEEP_ARCHIVE"}
        ],
        "Expiration": {"Days": 2555}
      },
      {
        "ID": "abort-multipart-uploads",
        "Status": "Enabled",
        "Filter": {},
        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 3}
      }
    ]
  }'

# Step 4: Verify the policy is in place
aws s3api get-bucket-lifecycle-configuration \
  --bucket $BUCKET \
  --query 'Rules[*].{ID: ID, Status: Status, Transitions: Transitions}' \
  --output table

# Step 5: Use S3 Storage Lens to monitor storage class distribution over time
# Enable Storage Lens dashboard (free tier available)
aws s3control create-storage-lens-configuration \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --config-id myapp-storage-lens \
  --storage-lens-configuration '{
    "Id": "myapp-storage-lens",
    "IsEnabled": true,
    "AccountLevel": {
      "BucketLevel": {}
    }
  }'
```

**Expected outcome:** after 90 days, the 5 TB of logs older than 90 days transitions to Glacier IR at $0.004/GB vs $0.023/GB — a reduction from ~$115/month to ~$20/month for that data set. Monitor in Cost Explorer under `Amazon Simple Storage Service` grouped by usage type (`TimedStorage-ByteHrs`).

---

### Example 4: Implementing a Spot Worker Fleet for CI/CD

Replace On-Demand CI runners with a Spot-backed Auto Scaling Group. Target 70-80% cost reduction on compute-intensive build jobs.

```bash
# Step 1: Create a launch template with spot-friendly configuration
# User data installs and registers a GitHub Actions runner
aws ec2 create-launch-template \
  --launch-template-name ci-runner-lt \
  --version-description "Spot CI runner" \
  --launch-template-data '{
    "ImageId": "ami-0c55b159cbfafe1f0",
    "InstanceType": "m6i.xlarge",
    "IamInstanceProfile": {"Name": "ci-runner-profile"},
    "TagSpecifications": [{
      "ResourceType": "instance",
      "Tags": [
        {"Key": "Name",        "Value": "ci-runner-spot"},
        {"Key": "Team",        "Value": "platform"},
        {"Key": "Environment", "Value": "production"},
        {"Key": "Application", "Value": "ci-cd"}
      ]
    }],
    "UserData": "IyEvYmluL2Jhc2gKYXB0LWdldCB1cGRhdGUgLXkKIyBJbnN0YWxsIEdpdEh1YiBBY3Rpb25zIHJ1bm5lcgojIFJlZ2lzdGVyIHdpdGggdG9rZW4gZnJvbSBTZWNyZXRzIE1hbmFnZXIK",
    "MetadataOptions": {
      "HttpTokens": "required",
      "HttpPutResponseHopLimit": 1
    }
  }'

# Step 2: Create ASG with multiple instance types and capacity-optimized strategy
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name ci-runner-spot-asg \
  --min-size 0 \
  --max-size 30 \
  --desired-capacity 0 \
  --vpc-zone-identifier "subnet-aaa,subnet-bbb,subnet-ccc" \
  --mixed-instances-policy '{
    "LaunchTemplate": {
      "LaunchTemplateSpecification": {
        "LaunchTemplateName": "ci-runner-lt",
        "Version": "$Latest"
      },
      "Overrides": [
        {"InstanceType": "m6i.xlarge"},
        {"InstanceType": "m5.xlarge"},
        {"InstanceType": "m5a.xlarge"},
        {"InstanceType": "m4.xlarge"},
        {"InstanceType": "c6i.xlarge"},
        {"InstanceType": "c5.xlarge"}
      ]
    },
    "InstancesDistribution": {
      "OnDemandBaseCapacity": 0,
      "OnDemandPercentageAboveBaseCapacity": 0,
      "SpotAllocationStrategy": "capacity-optimized"
    }
  }' \
  --lifecycle-hook-specification-list '[
    {
      "LifecycleHookName": "drain-on-termination",
      "LifecycleTransition": "autoscaling:EC2_INSTANCE_TERMINATING",
      "HeartbeatTimeout": 120,
      "DefaultResult": "CONTINUE"
    }
  ]'

# Step 3: Add scheduled scaling — scale to 0 overnight, scale up before business hours
aws autoscaling put-scheduled-update-group-action \
  --auto-scaling-group-name ci-runner-spot-asg \
  --scheduled-action-name scale-down-night \
  --recurrence "0 22 * * 1-5" \
  --desired-capacity 0 \
  --min-size 0

aws autoscaling put-scheduled-update-group-action \
  --auto-scaling-group-name ci-runner-spot-asg \
  --scheduled-action-name scale-up-morning \
  --recurrence "0 7 * * 1-5" \
  --desired-capacity 5 \
  --min-size 0

# Step 4: Verify spot price vs on-demand for the target types
aws ec2 describe-spot-price-history \
  --instance-types m6i.xlarge m5.xlarge c6i.xlarge \
  --product-descriptions Linux/UNIX \
  --start-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --query 'SpotPriceHistory | sort_by(@, &SpotPrice) | [:6].[InstanceType, SpotPrice, AvailabilityZone]' \
  --output table

# Compare against on-demand price (~$0.192/hr for m6i.xlarge us-east-1)
# Spot should be 60-80% cheaper
```

**Verification:** after one week, query Cost Explorer for the `ci-cd` application tag and compare EC2 spend to the previous month's On-Demand baseline.

```bash
aws ce get-cost-and-usage \
  --time-period Start=2025-05-01,End=2025-05-26 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --filter '{"Tags": {"Key": "Application", "Values": ["ci-cd"]}}' \
  --query 'ResultsByTime[0].Total.BlendedCost.Amount'
```

---

## Exercises

### Exercise 1: Identify the Top 3 Cost Drivers in Your Account

**Goal:** practice navigating Cost Explorer CLI to build the same investigation skill used in the spike scenario.

1. Run a Cost Explorer query to find the top 5 AWS services by spend for the last full calendar month. Sort descending by cost.
2. For the top service, drill into daily granularity for the last 30 days. Identify the day with the highest spend and the day with the lowest spend.
3. Further filter to that top service and break it down by usage type. Identify which usage type (e.g., `BoxUsage`, `DataTransfer-Out-Bytes`, `NatGateway-Hours`) is the largest cost component.
4. Write a one-paragraph explanation of what is driving the cost and what you would investigate next if this were production.

**Requirement:** do not use the AWS console. All queries must be CLI. Format the final output as a table using `--output table`.

---

### Exercise 2: Build a Tag Compliance Report

**Goal:** enforce the operational standard that every EC2 instance must have `Environment`, `Team`, and `Application` tags.

1. Use the Resource Groups Tagging API to list all EC2 instances in the account.
2. From that output, filter to instances missing any of the three required tags. Do this with a CLI query, not manual inspection.
3. For each non-compliant instance, output the instance ID and which tags are missing.
4. Write an AWS Config rule (using the `REQUIRED_TAGS` managed rule) that enforces this policy going forward. Deploy it and verify it appears in `describe-config-rules`.
5. **Bonus:** write a bash script that takes an instance ID as an argument and adds a default `Environment=unknown` tag if the tag is missing — then re-queries the Tagging API to confirm the tag was applied.

**Requirement:** the solution must not require console access. A teammate should be able to run your script on a fresh account.

---

### Exercise 3: Design and Justify a Pricing Model Strategy

**Goal:** apply the pricing model decision framework to a real scenario. This is a common interview question format.

You are given three workloads:

| Workload | Description |
|----------|-------------|
| **API servers** | 4× m6i.large instances, running 24/7, stable for 18 months, traffic varies ±20% |
| **Nightly batch** | 20× c6i.2xlarge instances, runs 4 hours/night, fault-tolerant, can retry |
| **ML training** | 2× p3.8xlarge instances, runs 2-3 times per week, 8-hour jobs, cannot resume mid-run |

1. For each workload, choose the most cost-effective pricing model (On-Demand, Spot, Savings Plan, Reserved Instance) and justify your choice.
2. For the workloads where you chose Spot or Savings Plans: what specific configuration parameters would you use and why? (e.g., `capacity-optimized` vs `price-capacity-optimized`, Compute SP vs EC2 Instance SP, 1-year vs 3-year)
3. Calculate the approximate monthly savings vs full On-Demand pricing for each workload. Use the following reference prices for us-east-1:
   - m6i.large On-Demand: $0.096/hr | Compute SP 1yr: $0.061/hr | Spot avg: $0.029/hr
   - c6i.2xlarge On-Demand: $0.340/hr | Spot avg: $0.085/hr
   - p3.8xlarge On-Demand: $12.24/hr | Spot avg: $3.67/hr (interruption rate: high)
4. For the ML training workload, explain the risk of using Spot and what application-level change would be required to make it viable.

---

### Exercise 4: Set Up a Cost Anomaly Detection Baseline

**Goal:** go beyond static budgets to configure AWS Cost Anomaly Detection, which uses ML to detect unusual spend patterns without requiring you to set a fixed threshold.

1. Create a Cost Anomaly Monitor for EC2 using the CLI:
   ```bash
   aws ce create-anomaly-monitor \
     --anomaly-monitor '{
       "MonitorName": "ec2-monitor",
       "MonitorType": "DIMENSIONAL",
       "MonitorDimension": "SERVICE"
     }'
   ```
   Capture the `MonitorArn` from the output.

2. Create an Anomaly Subscription that alerts when an anomaly exceeds $20 absolute impact or 20% percentage impact, whichever triggers first:
   ```bash
   aws ce create-anomaly-subscription \
     --anomaly-subscription '{
       "SubscriptionName": "ec2-anomaly-alert",
       "MonitorArnList": ["<MonitorArn from step 1>"],
       "Subscribers": [{
         "Address": "your-email@example.com",
         "Type": "EMAIL"
       }],
       "Threshold": 20,
       "Frequency": "DAILY"
     }'
   ```

3. List all anomaly monitors and subscriptions to verify the setup:
   ```bash
   aws ce get-anomaly-monitors --query 'AnomalyMonitors[*].{Name: MonitorName, Type: MonitorType, Arn: MonitorArn}'
   aws ce get-anomaly-subscriptions --query 'AnomalySubscriptions[*].{Name: SubscriptionName, Threshold: Threshold, Frequency: Frequency}'
   ```

4. Explain the difference between a Cost Anomaly Detection alert and a Budget alert. In what scenario would Anomaly Detection catch something that a Budget would not? Write a 3-5 sentence answer covering: how Anomaly Detection establishes a baseline, why it handles seasonal variation better than static thresholds, and one limitation compared to Budgets.

**Requirement:** complete steps 1-3 in a real AWS account (free tier eligible — Cost Anomaly Detection has no charge for monitoring). Submit the output of step 3 as verification.

---

### Quick Checks

5. Calculate monthly EC2 cost from an hourly rate. Run: `python3 -c "print(round(0.096 * 24 * 30, 2))"`

```expected_output
69.12
```

6. Find the most expensive service in a cost breakdown. Run: `printf 'EC2: 450\nS3: 45\nRDS: 280\nDataTransfer: 120\n' | sort -t: -k2 -rn | head -1 | cut -d: -f1`

```expected_output
EC2
```

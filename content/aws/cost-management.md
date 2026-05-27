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
- `BlendedCost` — your effective cost after blending reserved and on-demand rates across an organization. Use this for total-spend reporting.
- `UnblendedCost` — the actual charge on each account's line item. Use this for per-account billing in AWS Organizations.
- `AmortizedCost` — spreads upfront Reserved Instance and Savings Plan payments across the commitment period. Use this for accurate per-day cost tracking.

```bash
# Top 5 services by cost last month
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[0].Groups | sort_by(@, &Metrics.BlendedCost.Amount) | reverse(@) | [:5].[Keys[0], Metrics.BlendedCost.Amount]' \
  --output table

# Daily cost trend for the last 7 days — useful for spotting a specific day a cost spiked
aws ce get-cost-and-usage \
  --time-period Start=2025-05-19,End=2025-05-26 \
  --granularity DAILY \
  --metrics BlendedCost \
  --query 'ResultsByTime[].[TimePeriod.Start, Total.BlendedCost.Amount]' \
  --output table

# Cost by tag — requires tags to be activated as cost allocation tags first
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=TAG,Key=Environment

# Cost for a specific service (e.g., just EC2) broken down by region
aws ce get-cost-and-usage \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["Amazon Elastic Compute Cloud - Compute"]}}' \
  --group-by Type=DIMENSION,Key=REGION \
  --output table
```

**Cost Explorer has a 24-48 hour data lag.** It does not show real-time spend. For real-time visibility on a specific service, use CloudWatch billing metrics or set a Budget with SNS.

**The API costs $0.01 per request.** Running a cost Explorer query 10,000 times a month in a Lambda loop will add $100 to your bill. Cache results and run queries on a schedule, not per-request.

---

### Budgets and Alerts

Budgets are proactive guardrails. Cost Explorer tells you what happened; Budgets tell you what is about to happen. Set them up before you need them — the notification lag on `ACTUAL` alerts is up to 8 hours, so you are not getting real-time interruption, but you will catch runaway spend within a day.

**Budget types:**
| Type | What it tracks |
|------|---------------|
| `COST` | Dollar spend |
| `USAGE` | Service-unit usage (e.g., EC2 instance-hours) |
| `SAVINGS_PLANS_UTILIZATION` | Whether your Savings Plan commitment is being used |
| `SAVINGS_PLANS_COVERAGE` | What fraction of eligible spend is covered by a Savings Plan |
| `RI_UTILIZATION` | Reserved Instance utilization |
| `RI_COVERAGE` | RI coverage of eligible usage |

```bash
# Monthly cost budget: alert at 80% actual, 100% forecasted
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
```

**Budget coverage strategy:** create budgets at three levels:
1. **Account total** — catches any unexpected overall growth
2. **Per service** — EC2, RDS, and data transfer are the usual top spenders; budget them individually
3. **Per tag** — one budget per team (`Team=platform`, `Team=data`) if you use cost allocation tags

**SNS integration enables automation.** Wire the SNS topic to a Lambda that posts to Slack or creates a PagerDuty incident. Email-only budgets get ignored; SNS-backed ones get actioned.

---

### EC2 Pricing Models

Understanding EC2 pricing models is one of the highest-leverage cost decisions in AWS. Most interviews will include a scenario question on which model fits which workload.

| Model | Use Case | Savings vs On-Demand | Commitment |
|-------|----------|---------------------|------------|
| On-Demand | Unpredictable, short-term, testing | — | None |
| Savings Plans (Compute) | Steady baseline, any instance family | up to 66% | 1 or 3 year hourly spend |
| Savings Plans (EC2 Instance) | Steady baseline, fixed family/region | up to 72% | 1 or 3 year hourly spend |
| Reserved Instances (Standard) | Stable, predictable, single instance type | up to 75% | 1 or 3 year |
| Reserved Instances (Convertible) | Predictable but may change instance type | up to 54% | 1 or 3 year |
| Spot | Batch, CI, stateless, fault-tolerant | up to 90% | None — can be reclaimed |

**Do not commit before you have 2-3 months of utilization data.** Buying a 3-year Reserved Instance for an instance type you later right-size is an expensive mistake. Use Compute Optimizer and Cost Explorer RI/Savings Plan recommendations only after your workload is stable.

#### Spot Instances

Spot instances run on AWS spare capacity. When AWS needs that capacity back, your instance receives a 2-minute interruption notice via instance metadata and CloudWatch Events, then is stopped or terminated.

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
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=spot-worker}]'

# Check current spot prices and pick the cheapest AZ
aws ec2 describe-spot-price-history \
  --instance-types m6i.large c6i.large \
  --product-descriptions Linux/UNIX \
  --start-time 2025-05-20 \
  --query 'SpotPriceHistory | sort_by(@, &Timestamp) | [-10:].[InstanceType, SpotPrice, AvailabilityZone]' \
  --output table
```

**Interruption handling is mandatory, not optional.** Your application must handle `SIGTERM` gracefully. A termination handler should checkpoint state (write progress to SQS or DynamoDB), drain in-flight work, and exit cleanly. CI/CD workers, EMR nodes, and batch processing jobs are natural fits. Databases and stateful services are not.

**Use Spot with Auto Scaling Groups and multiple instance types.** A `capacity-optimized` allocation strategy picks the pool with the most available capacity, reducing interruption frequency. Never target a single instance type in a single AZ with Spot.

#### Savings Plans

Savings Plans commit to a minimum hourly spend (e.g., $1.50/hour) across any eligible compute in exchange for a discount. They are more flexible than Reserved Instances and the recommended path for most teams today.

```bash
# Check current Savings Plans utilization — are you getting value from your commitment?
aws ce get-savings-plans-utilization \
  --time-period Start=2025-04-01,End=2025-05-01 \
  --query 'Total.[{Utilized: SavingsPlansUtilizationByTime[0].Utilization.UtilizationPercentage}]'

# Get Savings Plans purchase recommendations based on your actual usage
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days SIXTY_DAYS
```

**Compute Savings Plans vs EC2 Instance Savings Plans:**
- Compute SP: discounts EC2 (any family, region, OS), Lambda, and Fargate. Discount is slightly lower (~66%) but applies everywhere.
- EC2 Instance SP: locked to a specific instance family (e.g., `m6i`) in a specific region. Higher discount (~72%) but no flexibility.

**All-Upfront vs No-Upfront:** All-Upfront gives the deepest discount and reduces billing complexity; No-Upfront preserves cash flow. For most engineering teams, No-Upfront 1-year Compute SP is the practical starting point.

---

### S3 Storage Classes

S3 costs have two components: **storage cost per GB** and **request/retrieval fees**. Choosing the wrong storage class for access patterns wastes money in both directions — Standard is expensive for cold data; Glacier has retrieval costs that exceed storage savings if you access data frequently.

| Class | Use Case | ~Storage Cost | Retrieval Fee | Min Duration |
|-------|----------|--------------|---------------|--------------|
| Standard | Frequently accessed | $0.023/GB | None | None |
| Standard-IA | Monthly access, rapid retrieval | $0.0125/GB | $0.01/GB | 30 days |
| One Zone-IA | Infrequent, tolerate single-AZ loss | $0.01/GB | $0.01/GB | 30 days |
| Glacier Instant Retrieval | Quarterly access, ms retrieval | $0.004/GB | $0.03/GB | 90 days |
| Glacier Flexible Retrieval | Yearly access, hours OK | $0.0036/GB | $0.01/GB (std) | 90 days |
| Glacier Deep Archive | Rarely accessed, 12-48h retrieval | $0.00099/GB | $0.02/GB | 180 days |
| Intelligent-Tiering | Unknown/changing access patterns | $0.023/GB + $0.0025/1k objects | None | None |

**Minimum duration billing:** if you delete a Standard-IA object after 15 days, you are still billed for 30 days. Factor this into lifecycle rule design — don't transition short-lived objects to IA classes.

```bash
# Lifecycle policy: logs/ goes to Glacier after 90 days, deleted after 365
# Objects transition through classes; you can chain transitions
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

# Verify the policy applied correctly
aws s3api get-bucket-lifecycle-configuration --bucket my-app-logs

# Find large buckets to prioritize for lifecycle work
aws s3api list-buckets --query 'Buckets[*].Name' --output text | \
  xargs -I{} aws s3 ls s3://{} --recursive --human-readable --summarize 2>/dev/null | \
  grep "Total Size"
```

**Intelligent-Tiering costs $0.0025 per 1,000 objects per month for monitoring.** On a bucket with 10 million small objects, the monitoring fee is $25/month regardless of storage size. For workloads with many tiny files and predictable access patterns, a manual lifecycle rule is cheaper.

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
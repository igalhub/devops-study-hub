---
title: VPC and Route 53
module: aws
duration_min: 25
difficulty: intermediate
tags: [aws, vpc, subnets, route53, networking, nat-gateway, security-groups, dns]
exercises: 4
---

## Overview
VPC gives you a private, isolated network in AWS. Route 53 is AWS's DNS service. Together they control how traffic enters your infrastructure, how it's routed between services, and how the outside world discovers your endpoints. Most real infrastructure issues trace back to VPC misconfiguration — wrong route table, overly permissive security group, or missing NAT gateway.

## Concepts

### VPC Structure
```
VPC (10.0.0.0/16)
├── Public Subnet (10.0.1.0/24) — AZ us-east-1a
│   └── EC2 instances accessible from internet
│   └── Internet Gateway (IGW) route
├── Public Subnet (10.0.2.0/24) — AZ us-east-1b
├── Private Subnet (10.0.10.0/24) — AZ us-east-1a
│   └── RDS, internal services
│   └── NAT Gateway route (for outbound internet)
└── Private Subnet (10.0.11.0/24) — AZ us-east-1b
```

A **public subnet** has a route to an Internet Gateway (IGW).
A **private subnet** has no IGW route — outbound-only internet via NAT Gateway.

### Creating a VPC (CLI)
```bash
# Create VPC
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --query 'Vpc.VpcId' --output text)
aws ec2 create-tags --resources $VPC_ID --tags Key=Name,Value=prod-vpc

# Enable DNS hostnames (required for some services)
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames

# Create subnets
aws ec2 create-subnet \
  --vpc-id $VPC_ID \
  --cidr-block 10.0.1.0/24 \
  --availability-zone us-east-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=public-1a}]'

# Create and attach Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --internet-gateway-id $IGW_ID --vpc-id $VPC_ID

# Create public route table
RT_ID=$(aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text)
aws ec2 create-route --route-table-id $RT_ID --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
aws ec2 associate-route-table --route-table-id $RT_ID --subnet-id <public-subnet-id>
```

### NAT Gateway
Private subnets need a NAT Gateway for outbound internet access (package installs, API calls):

```bash
# Allocate Elastic IP for NAT Gateway
EIP=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)

# Create NAT Gateway in a PUBLIC subnet
NAT_ID=$(aws ec2 create-nat-gateway \
  --subnet-id <public-subnet-id> \
  --allocation-id $EIP \
  --query 'NatGateway.NatGatewayId' --output text)

# Private route table: route outbound traffic through NAT
PRIVATE_RT=$(aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text)
aws ec2 create-route --route-table-id $PRIVATE_RT --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT_ID
aws ec2 associate-route-table --route-table-id $PRIVATE_RT --subnet-id <private-subnet-id>
```

NAT Gateways cost ~$0.045/hour + $0.045/GB processed. One per AZ for HA.

### Security Groups vs NACLs
```
Security Groups                 NACLs
─────────────────               ─────────────────
Stateful (track connections)    Stateless (explicit in+out rules needed)
Applied to instances/ENIs       Applied to subnets
Allow rules only                Allow AND deny rules
Evaluated all at once           Evaluated in rule number order
Default: deny all inbound       Default: allow all (VPC default NACL)
```

```bash
# Security group for web servers
SG_ID=$(aws ec2 create-security-group \
  --group-name web-sg \
  --description "Web server security group" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Allow HTTPS from anywhere
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp --port 443 --cidr 0.0.0.0/0

# Allow SSH from specific IP only
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp --port 22 --cidr 203.0.113.0/32

# Allow app traffic from another security group (not CIDR)
aws ec2 authorize-security-group-ingress \
  --group-id $DB_SG_ID \
  --protocol tcp --port 5432 \
  --source-group $APP_SG_ID
```

### VPC Endpoints
Access AWS services without leaving the AWS network:

```bash
# S3 Gateway endpoint (free — traffic stays on AWS backbone)
aws ec2 create-vpc-endpoint \
  --vpc-id $VPC_ID \
  --service-name com.amazonaws.us-east-1.s3 \
  --route-table-ids $PRIVATE_RT

# Interface endpoint for Secrets Manager (creates an ENI in your subnet)
aws ec2 create-vpc-endpoint \
  --vpc-id $VPC_ID \
  --vpc-endpoint-type Interface \
  --service-name com.amazonaws.us-east-1.secretsmanager \
  --subnet-ids <private-subnet-id> \
  --security-group-ids $SG_ID
```

---

### Route 53

#### Hosted Zones and Records
```bash
# Create hosted zone (public — for internet-facing DNS)
aws route53 create-hosted-zone \
  --name myapp.com \
  --caller-reference $(date +%s)

# Get hosted zone ID
HZ_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name myapp.com \
  --query 'HostedZones[0].Id' --output text | cut -d/ -f3)

# Create/update an A record
aws route53 change-resource-record-sets \
  --hosted-zone-id $HZ_ID \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.myapp.com",
        "Type": "A",
        "TTL": 300,
        "ResourceRecords": [{"Value": "203.0.113.10"}]
      }
    }]
  }'

# Alias record (for ALB/CloudFront — no TTL needed)
aws route53 change-resource-record-sets \
  --hosted-zone-id $HZ_ID \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "myapp.com",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z35SXDOTRQ7X7K",
          "DNSName": "my-alb-1234567890.us-east-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

#### Routing Policies
```
Simple           — single record, single value (default)
Weighted         — distribute traffic by weight (A/B testing, gradual rollout)
Latency          — route to region with lowest latency for the user
Failover         — primary/secondary, switch on health check failure
Geolocation      — route by user's country or continent
Geoproximity     — route by proximity, with configurable bias
```

```bash
# Weighted routing — 10% to canary
aws route53 change-resource-record-sets --hosted-zone-id $HZ_ID \
  --change-batch '{
    "Changes": [
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "api.myapp.com", "Type": "A",
          "SetIdentifier": "primary", "Weight": 90,
          "TTL": 60, "ResourceRecords": [{"Value": "203.0.113.10"}]
        }
      },
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "api.myapp.com", "Type": "A",
          "SetIdentifier": "canary", "Weight": 10,
          "TTL": 60, "ResourceRecords": [{"Value": "203.0.113.20"}]
        }
      }
    ]
  }'
```

#### Health Checks
```bash
# Create health check for an endpoint
HC_ID=$(aws route53 create-health-check \
  --caller-reference $(date +%s) \
  --health-check-config '{
    "IPAddress": "203.0.113.10",
    "Port": 443,
    "Type": "HTTPS",
    "ResourcePath": "/health",
    "FailureThreshold": 3,
    "RequestInterval": 30
  }' \
  --query 'HealthCheck.Id' --output text)
```

Associate a health check with a DNS record — Route 53 stops routing to unhealthy endpoints in failover and latency routing policies.

## Examples

### Standard 3-Tier VPC (Terraform)
```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "prod-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["us-east-1a", "us-east-1b", "us-east-1c"]
  public_subnets  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  private_subnets = ["10.0.10.0/24", "10.0.11.0/24", "10.0.12.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = false   # one per AZ for HA
}
```

## Exercises

1. Create a VPC with two public and two private subnets across two AZs. Add an Internet Gateway for the public subnets and a NAT Gateway (in one public subnet) for the private subnets. Verify a private subnet instance can reach the internet via the NAT Gateway by checking `curl https://example.com`.
2. Create two security groups: `web-sg` (allows 443 from 0.0.0.0/0) and `app-sg` (allows port 8080 only from `web-sg`). Demonstrate that restricting the app security group to the web security group source prevents direct internet access.
3. Set up Route 53 with a public hosted zone. Create an A record and verify DNS resolution with `dig`. Then set up weighted routing — 80% to one IP, 20% to another — and verify with repeated `dig` queries.
4. Configure a failover routing policy in Route 53: a primary record pointing to an active server with a health check, and a secondary pointing to a standby. Simulate failure by making the health check fail and verify Route 53 switches to the secondary.


---

### Quick Checks

5. Calculate the number of usable host addresses in a /24 subnet. Run: `python3 -c "print(2**(32-24) - 2)"`

```expected_output
254
```

hint: Think about how subnet math works — the total number of addresses minus reserved ones gives you usable hosts.
hint: Use Python's exponentiation with 2**(32-prefix) and subtract the reserved network and broadcast addresses.

6. Count the octets in an IPv4 address. Run: `echo "192.168.10.5" | tr '.' '\n' | wc -l`

```expected_output
4
```

hint: Think about how you can split the IP address into separate lines and then count those lines using standard Unix tools.
hint: Use tr to translate the dot separator into newline characters, then pipe the result into wc -l to count the resulting lines.

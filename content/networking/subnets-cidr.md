---
title: Subnets & CIDR
module: networking
duration_min: 15
difficulty: intermediate
tags: [networking, cidr, subnets, ip, vpc, routing]
exercises: 4
---

## Overview

CIDR (Classless Inter-Domain Routing) notation and subnetting are foundational skills for any DevOps engineer working with cloud infrastructure, containers, or on-premises networks. You encounter them constantly: defining a VPC, writing a security group rule that allows only your office IP, configuring Kubernetes pod and service CIDRs, setting up VPN split tunneling, or ensuring two peered VPCs don't have overlapping address spaces. Misunderstanding even one of these can result in silent routing failures, security holes, or a refactoring project when you run out of IP addresses six months after launch.

The core design principle behind subnetting is hierarchical address allocation — you take a large block of addresses and divide it into smaller blocks, each with a fixed network prefix and a variable host portion. The prefix length (the `/N`) tells you exactly where that boundary is. Everything follows from that single idea: how many hosts fit, whether two IPs share a subnet, whether traffic needs a router, and how to aggregate routes efficiently.

In the DevOps toolchain, CIDR knowledge sits at the infrastructure layer but surfaces constantly in higher-level tools: Terraform `aws_subnet` resources, Helm chart values for Kubernetes CNI plugins, Ansible firewall rules, and Docker network configurations all require you to reason about address blocks. Getting subnetting right at design time saves enormous pain later — you cannot easily re-CIDR a production VPC with running workloads.

---

## Concepts

### IP Addresses and Binary Representation

An IPv4 address is a 32-bit integer, written in dotted-decimal notation as four octets separated by dots. Every operation on subnets — masking, ANDing, range checks — happens at the binary level. The dotted-decimal form is just a human convenience.

```
192     .168    .1      .100
11000000.10101000.00000001.01100100
```

Each octet is 8 bits, so the full address is 32 bits. The maximum value per octet is 255 (all 8 bits set). A subnet divides those 32 bits into two parts:

- **Network part** (leftmost N bits): identifies the subnet — same for every host in it
- **Host part** (remaining 32−N bits): identifies a specific host within the subnet

The boundary between those two parts is the prefix length. Everything in subnetting reduces to: "where is that boundary, and what does it imply?"

To internalize binary conversion, practice these anchors:

| Decimal | Binary   |
|---------|----------|
| 128     | 10000000 |
| 192     | 11000000 |
| 224     | 11100000 |
| 240     | 11110000 |
| 248     | 11111000 |
| 252     | 11111100 |
| 254     | 11111110 |
| 255     | 11111111 |

These are exactly the values that appear in the last octet of non-octet-aligned subnet masks — memorize them.

### CIDR Notation

CIDR notation writes an address block as `<network address>/<prefix length>`. The network address has all host bits set to zero. The prefix length says how many of the 32 bits belong to the network part.

`10.0.1.0/24` means:
- First 24 bits (3 octets) are fixed: `10.0.1`
- Last 8 bits are variable: `.0` through `.255`
- Total addresses: 2⁸ = 256
- Usable host addresses: 254 (the network address `.0` and broadcast address `.255` are reserved)

| CIDR | Total addresses | Usable hosts | Typical use |
|------|----------------|--------------|-------------|
| /32  | 1              | 1            | Single host; security group rule for one IP |
| /31  | 2              | 2            | Point-to-point links (RFC 3021) |
| /30  | 4              | 2            | Smallest general-purpose subnet |
| /28  | 16             | 14           | Small isolated subnet |
| /27  | 32             | 30           | Small subnet tier |
| /26  | 64             | 62           | Medium subnet |
| /25  | 128            | 126          | Half a /24 |
| /24  | 256            | 254          | Standard per-AZ subnet |
| /23  | 512            | 510          | Two /24s combined |
| /22  | 1,024          | 1,022        | Node pool with growth room |
| /20  | 4,096          | 4,094        | Large subnet tier |
| /16  | 65,536         | 65,534       | Typical VPC CIDR |
| /8   | 16,777,216     | —            | Full RFC 1918 Class A block |

**Quick mental math:** every time you decrease the prefix by 1 (e.g., `/24` → `/23`), the address space doubles. Going the other direction, every +1 halves it. A `/24` has 256 addresses; a `/20` is 4 bits wider in the host part, so 2⁴ × 256 = 4,096 addresses.

**AWS and GCP reserved addresses:** cloud providers reserve more than just the network and broadcast addresses. AWS reserves 5 addresses per subnet (network address, VPC router, DNS resolver, future use, broadcast). A `/28` gives you only 11 usable IPs instead of 14. GCP reserves 4 per subnet. Always check your cloud provider's documentation before sizing tightly.

### The Subnet Mask

The subnet mask is an older representation of the prefix length: a 32-bit value with the first N bits set to 1 and the remaining bits set to 0. It communicates the same information as the CIDR prefix but in dotted-decimal form, still used in OS configuration files and legacy tools.

| CIDR prefix | Subnet mask       | Last octet binary |
|-------------|-------------------|-------------------|
| /24         | 255.255.255.0     | 00000000          |
| /25         | 255.255.255.128   | 10000000          |
| /26         | 255.255.255.192   | 11000000          |
| /27         | 255.255.255.224   | 11100000          |
| /28         | 255.255.255.240   | 11110000          |
| /29         | 255.255.255.248   | 11111000          |
| /16         | 255.255.0.0       | —                 |
| /8          | 255.0.0.0         | —                 |

The non-octet-aligned masks (`/25`, `/26`, `/27`, `/28`, `/29`) are where confusion happens. A `/26` mask of `255.255.255.192` in binary is `11000000` in the last octet — the top two bits of that octet belong to the network, the bottom six to the host. This means a `/26` block always starts at an address where the last octet is a multiple of 64: `.0`, `.64`, `.128`, or `.192`.

**Alignment rule:** a subnet of size S must start at an address that is a multiple of S. `10.0.1.64/26` is valid. `10.0.1.70/26` is not — the network address would have host bits set, which is illegal. Use `strict=True` in Python's `ipaddress` module to catch this mistake programmatically.

```python
import ipaddress

# This raises ValueError: host bits set
try:
    ipaddress.ip_network("10.0.1.70/26", strict=True)
except ValueError as e:
    print(e)  # 10.0.1.70/26 has host bits set

# Correct: strip host bits to get the network address
net = ipaddress.ip_network("10.0.1.70/26", strict=False)
print(net)  # 10.0.1.64/26
```

### How Subnet Membership Is Determined

The kernel decides whether a destination IP is on the local subnet or needs a router using a bitwise AND:

```
IP:      10.0.1.55  = 00001010.00000000.00000001.00110111
Mask:  255.255.255.0 = 11111111.11111111.11111111.00000000
AND:    10.0.1.0    = 00001010.00000000.00000001.00000000
```

If `IP AND mask == network address`, the destination is on the local subnet → send directly via ARP.  
If not → send to the default gateway, which routes it further.

This is exactly why `10.0.1.5/24` and `10.0.2.5/24` cannot communicate without a router even though both are inside `10.0.0.0/16`. Each host applies its own /24 mask:

```
10.0.1.5  AND 255.255.255.0 = 10.0.1.0   ← host A's network
10.0.2.5  AND 255.255.255.0 = 10.0.2.0   ← host B's network
```

Different results → host A considers B to be off-subnet and sends traffic to its gateway. The `/16` supernet is irrelevant to this decision — the kernel only uses the mask configured on the local interface.

**Common interview trap:** "They're both in 10.0.0.0/16, why can't they talk directly?" The answer is that the *configured prefix on each interface* determines local vs. remote, not some containing supernet. The route table handles inter-subnet communication.

```bash
# Check your interface's address and prefix length
ip addr show eth0

# See the routing table — "scope link" entries are local subnet routes
ip route show

# Which route would be used to reach a specific address?
ip route get 10.0.2.5
# output: 10.0.2.5 via 10.0.1.1 dev eth0 src 10.0.1.55
#         shows gateway is used → off-subnet

# Verify two IPs are in the same subnet using ipcalc
ipcalc 10.0.1.55/24
ipcalc 10.0.1.200/24
# Compare the "Network:" lines — if they match, same subnet
```

### Private Address Ranges (RFC 1918)

These three blocks are reserved for private use and are not routed on the public internet. Use them freely inside your infrastructure, but plan allocations carefully to avoid conflicts between your VPCs, on-premises networks, Docker, and Kubernetes.

| Name     | Range                         | CIDR           | Size    | Common use                      |
|----------|-------------------------------|----------------|---------|---------------------------------|
| Class A  | 10.0.0.0 – 10.255.255.255     | 10.0.0.0/8     | ~16M    | Enterprise VPCs, large clusters |
| Class B  | 172.16.0.0 – 172.31.255.255   | 172.16.0.0/12  | ~1M     | Docker default bridge networks  |
| Class C  | 192.168.0.0 – 192.168.255.255 | 192.168.0.0/16 | ~65K    | Home networks, small offices    |

**Docker default bridge conflict:** Docker uses `172.17.0.0/16` for its default bridge network. Additional user-defined networks are allocated from `172.18.0.0/16`, `172.19.0.0/16`, etc., stepping through the `172.16.0.0/12` block. If your VPC, VPN, or corporate network uses any address in `172.16.0.0/12`, containers on that host will have routing conflicts — packets destined for your corporate network will be incorrectly sent to the Docker bridge instead of the gateway.

Override Docker's address pool in `/etc/docker/daemon.json` and restart the daemon:

```json
{
  "bip": "192.168.200.1/24",
  "default-address-pools": [
    { "base": "192.168.201.0/24", "size": 28 }
  ]
}
```

```bash
sudo systemctl restart docker
# Verify the new bridge address
docker network inspect bridge | grep Subnet
```

**Kubernetes default CIDRs by CNI plugin:**

| CNI         | Default pod CIDR  | Default service CIDR | Notes                               |
|-------------|-------------------|----------------------|-------------------------------------|
| Flannel     | 10.244.0.0/16     | 10.96.0.0/12         | Set via `--pod-network-cidr` in kubeadm |
| Calico      | 192.168.0.0/16    | 10.96.0.0/12         | Conflicts with home/office networks |
| Weave       | 10.32.0.0/12      | 10.96.0.0/12         | Large pod range by default          |
| AWS VPC CNI | Same as node VPC  | 10.100.0.0/16        | Pods get real VPC IPs               |

With AWS VPC CNI, pods get real VPC IP addresses — which means your VPC subnets must be large enough to accommodate pods, not just nodes. A node pool of 10 nodes each running 110 pods needs 1,100+ IP addresses in those subnets. A `/24` per AZ is dangerously small for EKS with VPC CNI; use `/20` or larger.

**Overlapping CIDRs will silently break routing.** Two peered VPCs with overlapping CIDRs cannot communicate — AWS will reject the peering. VPN split tunneling will misdirect traffic. Always check for overlaps before allocating a new CIDR block.

```python
import ipaddress

def check_overlap(cidr1, cidr2):
    a = ipaddress.ip_network(cidr1)
    b = ipaddress.ip_network(cidr2)
    return a.overlaps(b)

print(check_overlap("10.0.0.0/16", "10.0.1.0/24"))  # True — contained within
print(check_overlap("10.0.0.0/24", "10.0.1.0/24"))  # False — adjacent, no overlap
print(check_overlap("172.16.0.0/12", "172.20.0.0/16"))  # True — 172.20 is inside /12
```

### Supernets and Route Aggregation

A supernet (or aggregate) is a larger block that encompasses multiple smaller blocks. Route aggregation reduces routing table size by replacing many specific routes with one summary route — this is critical for BGP scaling and clean security group rule sets.

`10.0.0.0/16` is the supernet for all of these:
- `10.0.1.0/24`
- `10.0.2.0/24`
- `10.0.128.0/17`

To check whether a CIDR is a valid aggregate, verify that all the specific blocks are contiguous and the supernet's network bits match across all of them.

```python
import ipaddress

# Find the immediate supernet (one prefix bit shorter)
net = ipaddress.ip_network("10.0.1.0/24")
print(net.supernet())  # 10.0.0.0/23

# Collapse a list of networks into the minimal set of CIDRs
addresses = [
    ipaddress.ip_network("10.0.0.0/25"),
    ipaddress.ip_network("10.0.0.128/25"),
]
collapsed = list(ipaddress.collapse_addresses(addresses))
print(collapsed)  # [IPv4Network('10.0.0.0/24')]

# Non-contiguous blocks do NOT collapse cleanly
addresses2 = [
    ipaddress.ip_network("10.0.0.0/24"),
    ipaddress.ip_network("10.0.2.0/24"),  # gap at 10.0.1.0/24
]
collapsed2 = list(ipaddress.collapse_addresses(addresses2))
print(collapsed2)  # [IPv4Network('10.0.0.0/24'), IPv4Network('10.0.2.0/24')]
# Cannot collapse — they don't form a valid supernet without including 10.0.1.0/24
```

This matters for security group rules and firewall policies — instead of 8 separate rules for 8 adjacent /24s, one /21 rule covers the same space with one rule. It also matters for Transit Gateway route tables: aggregate routes where possible to avoid hitting route table limits.

### Subnetting a Block: Splitting CIDRs

When you receive an address block and need to divide it, you extend the prefix length. Each additional bit splits the space in half.

Splitting `10.0.0.0/24` into four `/26` subnets:

| Subnet | CIDR            | Host range                | Usable hosts |
|--------|-----------------|---------------------------|--------------|
| 1st    | 10.0.0.0/26    | 10.0.0.1 – 10.0.0.62     | 62           |
| 2nd    | 10.0.0.64/26   | 10.0.0.65 – 10.0.0.126   | 62           |
| 3rd    | 10.0.0.128/26  | 10.0.0.129 – 10.0.0.190  | 62           |
| 4th    | 10.0.0.192/26  | 10.0.0.193 – 10.0.0.254  | 62           |

```python
import ipaddress

parent = ipaddress.ip_network("10.0.0.0/24")

# Split into /26 subnets
for subnet in parent.subnets(new_prefix=26):
    hosts = list(subnet.hosts())
    print(f"{subnet}  first={hosts[0]}  last={hosts[-1]}  count={len(hosts)}")

# Split into exactly 2 halves (/25 each)
for subnet in parent.subnets(prefixlen_diff=1):
    print(subnet)
# 10.0.0.0/25
# 10.0.0.128/25
```

**The new prefix must be longer than the parent prefix.** You can split a `/24` into `/25`, `/26`, `/27` etc. — but not into `/23`. Calling `subnets(new_prefix=23)` on a `/24` raises `ValueError`.

**Unequal splits are not directly supported in CIDR.** CIDR blocks are always powers of two. If you need 100 hosts and 50 hosts from a `/24`, you'd allocate a `/25` (126 hosts) and a `/26` (62 hosts), accepting some waste. This is the standard trade-off in VLSM (Variable Length Subnet Masking).

### Designing a VPC Subnet Layout

A production AWS VPC needs subnets that are:
- Spread across availability zones for resilience
- Sized for the workloads they'll contain (with growth room)
- Separated by tier (public / private / data) for security group and NACL control
- Planned with future expansion in mind — re-CIDRing a running VPC is painful

Example layout for `10.0.0.0/16` across two AZs with three tiers:

| Subnet name | CIDR           | AZ         | Tier    | Purpose                      |
|-------------|----------------|------------|---------|------------------------------|
| public-1a   | 10.0.0.0/24    | us-east-1a | Public  | ALB, NAT Gateway             |
| public-1b   | 10.0.1.0/24    | us-east-1b | Public  | ALB, NAT Gateway             |
| private-1a  | 10.0.16.0/20   | us-east-1a | Private | EKS nodes, app servers       |
| private-1b  | 10.0.32.0/20   | us-east-1b | Private | EKS nodes, app servers       |
| data-1a     | 10.0.48.0/24   | us-east-1a | Data    | RDS, ElastiCache             |
| data-1b     | 10.0.49.0/24   | us-east-1b | Data    | RDS, ElastiCache             |

The private subnets use `/20` (4,094 usable addresses each) rather than `/24` — intentional when EKS nodes each consume dozens of pod IPs via AWS VPC CNI. The gap between `10.0.1.0/24` and `10.0.16.0/20` (`10.0.2.0` through `10.0.15.255`) is deliberately reserved for a third AZ.

**Routing rules for each tier:**
- Public subnets: route `0.0.0.0/0 → internet gateway`; instances can have public IPs
- Private subnets: route `0.0.0.0/0 → NAT gateway` (which lives in the public subnet); no inbound from internet
- Data subnets: no internet route at all; only VPC-local routes; access controlled by security groups

**Reserve the upper half of your VPC CIDR.** With `10.0.0.0/16`, you have 256 possible `/24` subnets. Use the low range now; reserve `10.0.128.0/17` for future expansion — adding AZs, VPC peering, or Transit Gateway attachments that require non-overlapping space.

```hcl
# Terraform example: defining subnets programmatically
variable "vpc_cidr" {
  default = "10.0.0.0/16"
}

locals {
  # Public subnets: 10.0.0.0/24 and 10.0.1.0/24
  public_cidrs = ["10.0.0.0/24", "10.0.1.0/24"]
  # Private subnets: /20 each for EKS pod IP headroom
  private_cidrs = ["10.0.16.0/20", "10.0.32.0/20"]
  azs = ["us-east-1a", "us-east-1b"]
}

resource "aws_subnet" "public" {
  count             = length(local.public_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = local.azs[count.index]

  # Instances in public subnets get public IPs automatically
  map_public_ip_on_launch = true

  tags = {
    Name = "public-${local.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count             = length(local.private_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]

  # No public IPs in private subnets
  map_public_ip_on_launch = false

  tags = {
    Name                              = "private-${local.azs[count.index]}"
    Tier                              = "private"
    # Required tag for EKS to discover subnets for internal load balancers
    "kubernetes.io/role/internal-elb" = "1"
  }
}
```

### Using `ipcalc` and `sipcalc` for Quick Verification

You shouldn't do subnet math by hand in production. Use command-line tools to verify your calculations before committing to Terraform or a YAML config.

```bash
# ipcalc: shows network, broadcast, first/last host, and mask
ipcalc 10.0.16.0/20
# Network:   10.0.16.0/20
# Broadcast: 10.0.31.255
# HostMin:   10.0.16.1
# HostMax:   10.0.31.254
# Hosts/Net: 4094

# Check if an IP is inside a given CIDR (exit code 0 = yes)
ipcalc -c 10.0.16.50/20  # checks if .50 is a valid host in /20

# sipcalc: more verbose, shows binary representation
sipcalc 10.0.16.0/20

# Python one-liner for quick checks in scripts
python3 -c "
import ipaddress
n = ipaddress.ip_network('10.0.16.0/20')
print(f'first={n.network_address+1} last={n.broadcast_address-1} size={n.num_addresses}')
"

# Check if an IP belongs to a subnet
python3 -c "
import ipaddress
ip = ipaddress.ip_address('10.0.16.50')
net = ipaddress.ip_network('10.0.16.0/20')
print(ip in net)  # True
"
```

---

## Examples

### Example 1: Auditing a VPC for Overlapping Subnets Before Peering

You want to peer two VPCs. Before requesting the peering, verify their subnets don't overlap — AWS will reject the peering if they do, but better to catch it before writing the Terraform.

```python
#!/usr/bin/env python3
# check_vpc_overlap.py
import ipaddress

# Subnet CIDRs from VPC A (us-east-1)
vpc_a = [
    "10.0.0.0/24",    # public-1a
    "10.0.1.0/24",    # public-1b
    "10.0.16.0/20",   # private-1a
    "10.0.32.0/20",   # private-1b
]

# Subnet CIDRs from VPC B (us-west-2) — note 10.0.16.0/20 appears in both!
vpc_b = [
    "10.0.100.0/24",
    "10.0.101.0/24",
    "10.0.16.0/20",   # ← conflict
    "10.0.120.0/20",
]

nets_a = [ipaddress.ip_network(c) for c in vpc_a]
nets_b = [ipaddress.ip_network(c) for c in vpc_b]

conflicts = []
for a in nets_a:
    for b in nets_b:
        if a.overlaps(b):
            conflicts.append((str(a), str(b)))

if conflicts:
    print("OVERLAP DETECTED — peering will fail:")
    for a, b in conflicts:
        print(f"  VPC-A {a} overlaps VPC-B {b}")
else:
    print("No overlaps found — safe to peer.")
```

```bash
python3 check_vpc_overlap.py
# OVERLAP DETECTED — peering will fail:
#   VPC-A 10.0.16.0/20 overlaps VPC-B 10.0.16.0/20
```

**Fix:** reassign VPC B's private subnets to `10.1.16.0/20` and `10.1.32.0/20`. Re-run the script to confirm no overlap before proceeding.

---

### Example 2: Calculating Kubernetes Node Capacity for AWS VPC CNI

With AWS VPC CNI, each pod gets a real VPC IP. The number of pods per node is limited by the instance type's network interfaces and IPs per interface. You need to ensure your subnets have enough IPs before scaling.

```bash
# Check the max pods per node type (requires aws CLI and kubectl)
# AWS publishes these limits: https://github.com/awslabs/amazon-eks-ami/blob/master/files/eni-max-pods.txt

# m5.xlarge: 4 ENIs × 15 IPs − 4 (one per ENI for the ENI itself) = 56 pods max
# (formula: (ENIs × (IPs_per_ENI − 1)) + 2 for kube-system daemonsets)

# For a cluster: 20 nodes × 56 pods = 1,120 pod IPs
# Plus 20 node IPs = 1,140 total IPs needed per AZ (if spread across 2 AZs → 570 per AZ)

python3 - <<'EOF'
import ipaddress

subnet_cidr = "10.0.16.0/20"
net = ipaddress.ip_network(subnet_cidr)

total_ips = net.num_addresses
# AWS reserves 5 IPs per subnet
usable_ips = total_ips - 5

nodes = 10
pods_per_node = 56
node_ips = nodes
pod_ips = nodes * pods_per_node

required = node_ips + pod_ips
print(f"Subnet: {subnet_cidr}")
print(f"Usable IPs: {usable_ips}")
print(f"Required IPs ({nodes} nodes × {pods_per_node} pods): {required}")
print(f"Remaining after allocation: {usable_ips - required}")
print(f"Sufficient: {usable_ips >= required}")
EOF
# Subnet: 10.0.16.0/20
# Usable IPs: 4091
# Required IPs (10 nodes × 56 pods): 570
# Remaining after allocation: 3521
# Sufficient: True
```

**Verify after cluster creation:**

```bash
# Check IPs currently in use in a subnet
aws ec2 describe-network-interfaces \
  --filters "Name=subnet-id,Values=subnet-xxxxxxxx" \
  --query 'NetworkInterfaces[*].PrivateIpAddresses[*].PrivateIpAddress' \
  --output text | wc -w

# Check available IPs remaining in the subnet
aws ec2 describe-subnets \
  --subnet-ids subnet-xxxxxxxx \
  --query 'Subnets[0].AvailableIpAddressCount'
```

---

### Example 3: Fixing a Docker / VPN Routing Conflict

Your corporate VPN uses `172.16.0.0/12`. Docker's default bridge allocates from the same range. After connecting to VPN, containers can't reach corporate services.

```bash
# Diagnose: see what Docker networks exist and their CIDRs
docker network ls
docker network inspect bridge | grep -A2 '"Subnet"'
# "Subnet": "172.17.0.0/16"   ← overlaps corporate VPN range

# Check routing table — both Docker and VPN are competing for 172.x traffic
ip route show | grep 172

# Fix: reconfigure Docker to use a non-conflicting range
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "bip": "192.168.200.1/24",
  "default-address-pools": [
    {
      "base": "192.168.201.0/24",
      "size": 28
    }
  ]
}
EOF

# Restart Docker — WARNING: this stops all running containers
sudo systemctl restart docker

# Verify the new bridge address
docker network inspect bridge | grep Subnet
# "Subnet": "192.168.200.0/24"   ← no longer conflicts with VPN

# Test: spin up a container and verify it gets an IP from the new range
docker run --rm alpine ip addr show eth0
# inet 192.168.200.2/24 ...

# Test: from inside the container, reach a corporate host
docker run --rm alpine ping -c 2 172.16.10.5
# Should now route via VPN instead of Docker bridge
```

---

### Example 4: Generating a Subnet Plan for a Three-Tier, Three-AZ VPC in Terraform

You need to programmatically compute subnet CIDRs for a new VPC without hardcoding every CIDR. Use Terraform's `cidrsubnet` function to derive subnets from the parent VPC CIDR.

```hcl
# variables.tf
variable "vpc_cidr" {
  description = "Parent VPC CIDR block"
  default     = "10.10.0.0/16"
}

variable "azs" {
  description = "Availability zones to deploy into"
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}
```

```hcl
# main.tf
locals {
  # cidrsubnet(prefix, newbits, netnum)
  # newbits: how many bits to add to the prefix length
  # netnum:  which subnet number (0-indexed)

  # Public subnets: /24 each (newbits=8 from /16, nets 0-2)
  public_cidrs = [for i, az in var.azs :
    cidrsubnet(var.vpc_cidr, 8, i)
    # i=0 → 10.10.0.0/24, i=1 → 10.10.1.0/24, i=2 → 10.10.2.0/24
  ]

  # Private subnets: /20 each (newbits=4 from /16, nets 4-6)
  # Start at netnum=4 to leave a gap from public subnets
  private_cidrs = [for i, az in var.azs :
    cidrsubnet(var.vpc_cidr, 4, i + 4)
    # i=0 → 10.10.64.0/20, i=1 → 10.10.80.0/20, i=2 → 10.10.96.0/20
  ]

  # Data subnets: /24 each (newbits=8, nets 48-50)
  data_cidrs = [for i, az in var.azs :
    cidrsubnet(var.vpc_cidr, 8, i + 48)
    # i=0 → 10.10.48.0/24, i=1 → 10.10.49.0/24, i=2 → 10.10.50.0/24
  ]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = { Name = "main" }
}

resource "aws_subnet" "public" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = var.azs[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "public-${var.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = var.azs[count.index]
  tags = {
    Name                              = "private-${var.azs[count.index]}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_subnet" "data" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.data_cidrs[count.index]
  availability_zone = var.azs[count.index]
  tags = { Name = "data-${var.azs[count.index]}", Tier = "data" }
}

# Verify the computed CIDRs before applying
output "public_cidrs"  { value = local.public_cidrs }
output "private_cidrs" { value = local.private_cidrs }
output "data_cidrs"    { value = local.data_cidrs }
```

```bash
# Preview the computed CIDRs without deploying anything
terraform init
terraform plan -target=output.public_cidrs -target=output.private_cidrs -target=output.data_cidrs
# Changes to Outputs:
#   + data_cidrs    = ["10.10.48.0/24", "10.10.49.0/24", "10.10.50.0/24"]
#   + private_cidrs = ["10.10.64.0/20", "10.10.80.0/20", "10.10.96.0/20"]
#   + public_cidrs  = ["10.10.0.0/24",  "10.10.1.0/24",  "10.10.2.0/24"]
```

---

## Exercises

### Exercise 1: Binary Subnet Math Without a Calculator

Given the following, answer all questions by hand, then verify with `ipcalc` or Python:

1. What is the network address of `10.4.67.200/26`?
2. What is the broadcast address?
3. Is `10.4.67.250` in the same subnet as `10.4.67.200/26`?
4. Is `10.4.67.128` the correct network address for a `/26`? Why or why not?

**Procedure:**
- Convert `67` and `200` to binary
- Apply the `/26` mask (`255.255.255.192`, last octet `11000000`)
- AND to find the network address
- Set all host bits to 1 for the broadcast address

```bash
# Verify your answers
ipcalc 10.4.67.200/26
python3 -c "
import ipaddress
net = ipaddress.ip_network('10.4.67.200/26', strict=False)
print('Network:', net.network_address)
print('Broadcast:', net.broadcast_address)
print('10.4.67.250 in subnet:', ipaddress.ip_address('10.4.67.250') in net)
"
```

---

### Exercise 2: Design a Subnet Layout Under Constraints

You are given `172.20.0.0/22` (1,024 addresses) and must allocate subnets for:

- 3 public subnets (one per AZ) — each needs ~20 usable IPs for load balancers
- 3 private subnets (one per AZ) — each needs ~100 usable IPs for app servers
- 1 management subnet — needs ~10 usable IPs
- Reserve at least 25% of the block for future use

Write out your allocation table (subnet name, CIDR, first host, last host, usable IPs). Then verify that:
1. No two CIDRs overlap
2. All CIDRs fit within `172.20.0.0/22`
3. The reserved space is contiguous and documented

```python
# Starter: enumerate possible subnets from the parent
import ipaddress
parent = ipaddress.ip_network("172.20.0.0/22")
# List all /27 subnets within the parent to see what you have to work with
for s in parent.subnets(new_prefix=27):
    print(s, "hosts:", s.num_addresses - 2)
```

---

### Exercise 3: Diagnose a Routing Problem

Set up two network namespaces on a Linux host to simulate two hosts on different subnets, then diagnose why they can't communicate and fix it.

```bash
# Create two namespaces simulating hosts on different /24 subnets
sudo ip netns add host-a
sudo ip netns add host-b

# Create veth pairs and assign IPs
sudo ip link add veth-a type veth peer name veth-b
sudo ip link set veth-a netns host-a
sudo ip link set veth-b netns host-b

# Assign IPs — same /16 supernet, different /24 subnets
sudo ip netns exec host-a ip addr add 10.1.1.10/24 dev veth-a
sudo ip netns exec host-b ip addr add 10.1.2.10/24 dev veth-b
sudo ip netns exec host-a ip link set veth-a up
sudo ip netns exec host-b ip link set veth-b up

# Try to ping — this will fail
sudo ip netns exec host-a ping -c 2 10.1.2.10
# Why does it fail? What does 'ip route show' tell you inside host-a?
sudo ip netns exec host-a ip route show

# Your task: add the correct static routes to make communication work
# Hint: each host needs a route to the other's /24 via the peer veth IP
# Fix it, verify ping succeeds, then explain why this mirrors how
# a router enables inter-subnet communication in a VPC

# Cleanup
sudo ip netns del host-a
sudo ip netns del host-b
```

---

### Exercise 4: Audit and Resize a Kubernetes Cluster's IP Allocation

You have a kubeadm cluster with the following configuration. Answer the questions and implement the check as a shell script.

Given:
- Node subnet: `192.168.10.0/24`
- Pod CIDR: `10.244.0.0/16` (Flannel)
- Service CIDR: `10.96.0.0/12`
- Current nodes: 5, max planned nodes: 20
- Flannel allocates one `/24` per node from the pod CIDR

1. How many `/24` pod subnets can Flannel allocate from `10.244.0.0/16`?
2. Is the pod CIDR large enough for 20 nodes?
3. Does the service CIDR `10.96.0.0/12` overlap with the pod CIDR `10.244.0.0/16`? Show your work.
4. The node subnet is `192.168.10.0/24` — how many nodes can it support (accounting for 2 reserved addresses)?

Write a Python script that takes three CIDRs as arguments (node subnet, pod CIDR, service CIDR) and outputs:
- Whether any two overlap
- Maximum node count from the node subnet
- Maximum per-node pod subnets allocatable from the pod CIDR (assuming `/24` per node)

```bash
python3 audit_cidrs.py 192.168.10.0/24 10.244.0.0/16 10.96.0.0/12
# Expected output:
# Overlap check: no overlaps detected
# Max nodes (node subnet): 254
# Max pod subnets (/24 per node from pod CIDR): 256
# Sufficient for 20 planned nodes: yes
```
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

In the DevOps toolchain, CIDR knowledge sits at the infrastructure layer but surfaces constantly in higher-level tools: Terraform `aws_subnet` resources, Helm chart values for Kubernetes CNI plugins, Ansible firewall rules, and Dockerfile network configurations all require you to reason about address blocks. Getting subnetting right at design time saves enormous pain later — you cannot easily re-CIDR a production VPC with running workloads.

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
- **Host part** (remaining 32-N bits): identifies a specific host within the subnet

The boundary between those two parts is the prefix length. Everything in subnetting reduces to: "where is that boundary, and what does it imply?"

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

**Quick mental math:** every time you drop the prefix by 1 (e.g., `/24` → `/23`), the address space doubles. Going the other direction, every +1 halves it. A `/24` has 256 addresses; a `/20` is 4 bits wider in the host part, so 2⁴ × 256 = 4,096 addresses.

**AWS and GCP reserved addresses:** cloud providers reserve more than just the network and broadcast addresses. AWS reserves 5 addresses per subnet (network, router, DNS, future use, broadcast), so a `/28` gives you only 11 usable IPs instead of 14. Always check your cloud provider's documentation before sizing tightly.

### The Subnet Mask

The subnet mask is an older representation of the prefix length: it's a 32-bit value with the first N bits set to 1 and the remaining bits set to 0. It communicates the same information as the CIDR prefix but in dotted-decimal form, still used in some OS configuration files and legacy tools.

| CIDR prefix | Subnet mask       | Binary (last octet) |
|-------------|-------------------|---------------------|
| /24         | 255.255.255.0     | 00000000            |
| /25         | 255.255.255.128   | 10000000            |
| /26         | 255.255.255.192   | 11000000            |
| /27         | 255.255.255.224   | 11100000            |
| /28         | 255.255.255.240   | 11110000            |
| /16         | 255.255.0.0       | —                   |
| /8          | 255.0.0.0         | —                   |

The non-octet-aligned masks (`/25`, `/26`, `/27`, `/28`) are where confusion happens. A `/26` mask of `255.255.255.192` in binary is `11000000` in the last octet — the top two bits of that octet belong to the network, the bottom six to the host. This means a `/26` block always starts at an address where the last octet is a multiple of 64: `.0`, `.64`, `.128`, or `.192`.

**Alignment rule:** a subnet of size S must start at an address that is a multiple of S. `10.0.1.64/26` is valid. `10.0.1.70/26` is not — use `strict=True` in Python's `ipaddress` module to catch this.

### How Subnet Membership Is Determined

The kernel decides whether a destination IP is on the local subnet or needs a router using a bitwise AND:

```
IP:      10.0.1.55  = 00001010.00000000.00000001.00110111
Mask:  255.255.255.0 = 11111111.11111111.11111111.00000000
AND:    10.0.1.0    = 00001010.00000000.00000001.00000000
```

If `IP AND mask == network address`, the host is on the local subnet → send directly via ARP.
If not → send to the default gateway, which routes it further.

This is exactly why `10.0.1.5/24` and `10.0.2.5/24` cannot communicate without a router even though both are inside `10.0.0.0/16`. Each host applies its own /24 mask:

```
10.0.1.5  AND 255.255.255.0 = 10.0.1.0   ← host A's network
10.0.2.5  AND 255.255.255.0 = 10.0.2.0   ← host B's network
```

Different results → host A considers B to be off-subnet and sends traffic to its gateway. The `/16` fact is irrelevant to this decision — the kernel only uses the mask configured on the local interface.

**A common interview trap:** "They're both in 10.0.0.0/16, why can't they talk?" The answer is that the *configured prefix on each interface* determines local vs. remote, not some containing supernet. The route table handles inter-subnet communication.

```bash
# Check your interface's address and prefix
ip addr show eth0

# See the routing table — "scope link" entries are local subnet
ip route show

# Which route would be used to reach 10.0.2.5?
ip route get 10.0.2.5
```

### Private Address Ranges (RFC 1918)

These three blocks are reserved for private use — they are not routed on the public internet. Use them freely inside your infrastructure.

| Name       | Range                           | CIDR           | Size     | Common use                        |
|------------|---------------------------------|----------------|----------|-----------------------------------|
| Class A    | 10.0.0.0 – 10.255.255.255       | 10.0.0.0/8     | ~16M     | Enterprise VPCs, large clusters   |
| Class B    | 172.16.0.0 – 172.31.255.255     | 172.16.0.0/12  | ~1M      | Docker default bridge networks    |
| Class C    | 192.168.0.0 – 192.168.255.255   | 192.168.0.0/16 | ~65K     | Home networks, small offices      |

**Docker default bridge:** Docker uses `172.17.0.0/16` for its default bridge network. Additional user-defined networks are allocated from `172.18.0.0/16`, `172.19.0.0/16`, etc. If your VPC or VPN uses `172.16.0.0/12`, Docker containers on that host will have routing conflicts. Override this in `/etc/docker/daemon.json`:

```json
{
  "bip": "192.168.200.1/24",
  "default-address-pools": [
    { "base": "192.168.201.0/24", "size": 28 }
  ]
}
```

**Kubernetes default CIDRs by CNI plugin:**

| CNI        | Default pod CIDR      | Default service CIDR |
|------------|-----------------------|----------------------|
| Flannel    | 10.244.0.0/16         | 10.96.0.0/12         |
| Calico     | 192.168.0.0/16        | 10.96.0.0/12         |
| Weave      | 10.32.0.0/12          | 10.96.0.0/12         |
| AWS VPC CNI| Same as node VPC CIDR | 10.100.0.0/16        |

With AWS VPC CNI, pods get real VPC IPs — which means your VPC subnets must be large enough to accommodate pods, not just nodes. A node pool of 10 nodes each running 110 pods needs 1,100+ IP addresses in those subnets.

### Supernets and Route Aggregation

A supernet (or aggregate) is a larger block that encompasses multiple smaller blocks. Route aggregation reduces routing table size by replacing many specific routes with one summary route.

`10.0.0.0/16` is the supernet for all of these:
- `10.0.1.0/24`
- `10.0.2.0/24`
- `10.0.128.0/17`

To check whether a CIDR is a valid aggregate, verify that all the specific blocks are contiguous and the supernet's network bits match across all of them.

```python
import ipaddress

# Find the supernet for a list of networks
nets = [
    ipaddress.ip_network("10.0.1.0/24"),
    ipaddress.ip_network("10.0.2.0/24"),
]
supernet = nets[0].supernet()
print(supernet)  # 10.0.0.0/23

# Collapse a list of networks into the minimal set of CIDRs
addresses = [
    ipaddress.ip_network("10.0.0.0/25"),
    ipaddress.ip_network("10.0.0.128/25"),
]
collapsed = list(ipaddress.collapse_addresses(addresses))
print(collapsed)  # [IPv4Network('10.0.0.0/24')]
```

This matters for security group rules and firewall policies — instead of 8 separate rules for 8 adjacent /24s, one /21 rule covers the same space cleanly.

### Subnetting a Block: Splitting CIDRs

When you receive an address block and need to divide it, you extend the prefix length. Each additional bit splits the space in half.

Splitting `10.0.0.0/24` into four `/26` subnets:

| Subnet | CIDR           | Host range                  |
|--------|----------------|-----------------------------|
| 1st    | 10.0.0.0/26   | 10.0.0.1 – 10.0.0.62       |
| 2nd    | 10.0.0.64/26  | 10.0.0.65 – 10.0.0.126     |
| 3rd    | 10.0.0.128/26 | 10.0.0.129 – 10.0.0.190    |
| 4th    | 10.0.0.192/26 | 10.0.0.193 – 10.0.0.254    |

```python
import ipaddress

parent = ipaddress.ip_network("10.0.0.0/24")

# Split into /26 subnets
for subnet in parent.subnets(new_prefix=26):
    hosts = list(subnet.hosts())
    print(f"{subnet}  first={hosts[0]}  last={hosts[-1]}  count={len(hosts)}")
```

**Prefix must be longer than the parent's prefix.** You can split a `/24` into `/25`, `/26`, `/27`, etc. — but not into `/23`.

### Designing a VPC Subnet Layout

A production AWS VPC needs subnets that are:
- Spread across availability zones for resilience
- Sized for the workloads they'll contain (with growth room)
- Separated by tier (public / private / data) for security group and NACL control

Example layout for `10.0.0.0/16` across two AZs with three tiers:

| Subnet name  | CIDR           | AZ           | Tier    | Purpose                        |
|--------------|----------------|--------------|---------|--------------------------------|
| public-1a    | 10.0.0.0/24    | us-east-1a   | Public  | ALB, NAT Gateway               |
| public-1b    | 10.0.1.0/24    | us-east-1b   | Public  | ALB, NAT Gateway               |
| private-1a   | 10.0.16.0/20   | us-east-1a   | Private | EKS nodes, app servers         |
| private-1b   | 10.0.32.0/20   | us-east-1b   | Private | EKS nodes, app servers         |
| data-1a      | 10.0.48.0/24   | us-east-1a   | Data    | RDS, ElastiCache               |
| data-1b      | 10.0.49.0/24   | us-east-1b   | Data    | RDS, ElastiCache               |

Note the private subnets use `/20` (4,096 addresses each) rather than `/24` — this is intentional when EKS nodes each consume dozens of pod IPs via AWS VPC CNI.

**Routing rules for each tier:**
- Public subnets: route `0.0.0.0/0 → internet gateway`
- Private subnets: route `0.0.0.0/0 → NAT gateway` (which lives in the public subnet)
- Data subnets: no internet route at all; only routes within the VPC

Leave the upper half of your VPC CIDR unallocated. With `10.0.0.0/16`, you have 256 possible `/24` subnets. Use the low range now; reserve `10.0.128.0/17` for future expansion, VPC peering additions
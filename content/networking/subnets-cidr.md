---
title: Subnets & CIDR
module: networking
duration_min: 15
difficulty: intermediate
tags: [networking, cidr, subnets, ip, vpc, routing]
exercises: 4
---

## Overview
CIDR notation and subnetting appear everywhere in DevOps: VPC design, security group rules, Kubernetes pod CIDRs, load balancer target groups, firewall rules. You need to read a CIDR block and know what it means, size subnets correctly for your architecture, and understand why `10.0.1.0/24` and `10.0.2.0/24` are in the same `/16` VPC but can't talk without a route.

## Concepts

### IP Addresses and Binary
An IPv4 address is 32 bits written as 4 octets: `192.168.1.100`
```
192     .168    .1      .100
11000000.10101000.00000001.01100100
```

A subnet divides the address into a **network part** (fixed) and **host part** (variable). The network part is determined by the **prefix length** (the `/N` in CIDR).

### CIDR Notation
`192.168.1.0/24` means:
- First 24 bits = network prefix (fixed): `192.168.1`
- Last 8 bits = host addresses: `.0` to `.255`
- This subnet contains 2^8 = 256 addresses, 254 usable (first=network addr, last=broadcast)

| CIDR | Hosts | Usable | Example use |
|---|---|---|---|
| /32 | 1 | 1 | Single host, security group rule for one IP |
| /31 | 2 | 2 | Point-to-point link |
| /30 | 4 | 2 | Smallest practical subnet |
| /28 | 16 | 14 | Small subnet |
| /27 | 32 | 30 | Small subnet |
| /26 | 64 | 62 | Medium subnet |
| /25 | 128 | 126 | Medium subnet |
| /24 | 256 | 254 | Standard subnet (one per AZ is common) |
| /22 | 1024 | 1022 | Larger subnet |
| /20 | 4096 | 4094 | VPC subnet |
| /16 | 65536 | 65534 | VPC CIDR |
| /8 | 16M | — | Class A / private range |

**Quick mental math:** each bit you remove from the prefix doubles the address space. `/24` = 256 hosts, `/23` = 512, `/22` = 1024, `/21` = 2048...

### The Subnet Mask
The subnet mask is an alternative representation of the prefix length:

| CIDR prefix | Subnet mask |
|---|---|
| /8 | 255.0.0.0 |
| /16 | 255.255.0.0 |
| /24 | 255.255.255.0 |
| /25 | 255.255.255.128 |
| /26 | 255.255.255.192 |
| /28 | 255.255.255.240 |

### Private Address Ranges (RFC 1918)
| Range | CIDR | Size | Common use |
|---|---|---|---|
| 10.0.0.0 – 10.255.255.255 | 10.0.0.0/8 | 16M | Large VPCs, corporate networks |
| 172.16.0.0 – 172.31.255.255 | 172.16.0.0/12 | 1M | Docker default networks |
| 192.168.0.0 – 192.168.255.255 | 192.168.0.0/16 | 65K | Home/small office |

Docker uses `172.17.0.0/16` by default. Kubernetes pod CIDRs are often `10.244.0.0/16` or `192.168.0.0/16`. Choose VPC CIDRs that don't overlap with your on-premises network or VPN ranges.

### Checking if an IP Is in a Subnet
The network address of a subnet = IP bitwise AND subnet mask:
```
IP:   192.168.1.100  = 11000000.10101000.00000001.01100100
Mask: 255.255.255.0  = 11111111.11111111.11111111.00000000
AND:  192.168.1.0    = 11000000.10101000.00000001.00000000
```
If `IP AND mask == network address`, the IP is in the subnet.

```bash
# Python: check if IP is in subnet
python3 -c "
import ipaddress
net = ipaddress.ip_network('10.0.1.0/24')
ip = ipaddress.ip_address('10.0.1.55')
print(ip in net)   # True
"

# ipcalc — human-friendly subnet info
ipcalc 192.168.1.0/24
ipcalc 10.0.0.0/16
```

### Designing a VPC Subnet Layout
A typical AWS VPC with `10.0.0.0/16`:

| Subnet | CIDR | AZ | Purpose |
|---|---|---|---|
| public-1a | 10.0.1.0/24 | us-east-1a | ALB, NAT Gateway |
| public-1b | 10.0.2.0/24 | us-east-1b | ALB, NAT Gateway |
| private-1a | 10.0.11.0/24 | us-east-1a | App servers, EKS nodes |
| private-1b | 10.0.12.0/24 | us-east-1b | App servers, EKS nodes |
| data-1a | 10.0.21.0/24 | us-east-1a | RDS, ElastiCache |
| data-1b | 10.0.22.0/24 | us-east-1b | RDS, ElastiCache |

Rules:
- Public subnets have a route to the internet gateway
- Private subnets route to internet via NAT Gateway (in the public subnet)
- Data subnets have no internet route

Leave room to grow: a `/16` gives you 256 `/24` subnets, plenty for expansion.

### Kubernetes CIDR Planning
Three non-overlapping CIDRs must be planned:
1. **VPC CIDR** — the cluster nodes live here: `10.0.0.0/16`
2. **Pod CIDR** — each pod gets an IP here: `10.100.0.0/16`
3. **Service CIDR** — ClusterIP services get IPs here: `10.200.0.0/16`

They must not overlap with each other or with any network you'll peer with.

## Examples

### Subnet Calculator in Python
```python
#!/usr/bin/env python3
import ipaddress
import sys

cidr = sys.argv[1] if len(sys.argv) > 1 else "10.0.1.0/24"
net = ipaddress.ip_network(cidr, strict=False)

print(f"Network:     {net.network_address}")
print(f"Broadcast:   {net.broadcast_address}")
print(f"Netmask:     {net.netmask}")
print(f"Hosts:       {net.num_addresses - 2} usable")
print(f"First host:  {net.network_address + 1}")
print(f"Last host:   {net.broadcast_address - 1}")
print(f"Prefix len:  /{net.prefixlen}")
```

### Check for Overlapping CIDR Blocks
```python
import ipaddress

def overlaps(cidr1: str, cidr2: str) -> bool:
    return ipaddress.ip_network(cidr1).overlaps(ipaddress.ip_network(cidr2))

networks = ["10.0.0.0/16", "10.1.0.0/16", "10.0.128.0/17"]
for i, a in enumerate(networks):
    for b in networks[i+1:]:
        if overlaps(a, b):
            print(f"OVERLAP: {a} and {b}")
```

## Exercises

1. For the CIDR `172.16.0.0/20`, calculate manually: the subnet mask, number of usable hosts, first and last host address, and broadcast address. Verify with `ipcalc` or Python.
2. Design a VPC CIDR layout for a 3-tier application (web/app/data) across 2 availability zones using `10.0.0.0/16` as the VPC CIDR. List each subnet's name, CIDR, and purpose.
3. Write a Python script using `ipaddress` that reads a list of CIDR blocks (one per line from a file) and reports any overlapping pairs.
4. Explain in writing why two hosts with IPs `10.0.1.5/24` and `10.0.2.5/24` can't communicate without a router, even though they're in the same `10.0.0.0/16` range. What does the kernel check to decide "same subnet or not"?

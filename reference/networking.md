# Networking Essentials — Quick Reference

## Connectivity Testing

| Command | Description |
|---------|-------------|
| `ping -c 4 host` | ICMP echo test (4 packets) |
| `traceroute host` | Trace packet route |
| `tracepath host` | Like traceroute, no root needed |
| `mtr host` | Interactive combined traceroute/ping |
| `nc -zv host port` | Test TCP port reachability |
| `nc -zvw3 host port` | With 3s timeout |
| `telnet host port` | Manual TCP connect test |
| `curl -I url` | HTTP response headers only |
| `curl -v url` | Verbose HTTP (shows TLS, headers) |

## DNS

| Command | Description |
|---------|-------------|
| `nslookup domain` | Basic DNS query |
| `dig domain` | Detailed DNS query |
| `dig domain A` | Query A records |
| `dig domain MX` | Query MX records |
| `dig @8.8.8.8 domain` | Query specific resolver |
| `dig +short domain` | Just the IP |
| `dig -x 1.2.3.4` | Reverse DNS lookup |
| `host domain` | Simple DNS + reverse lookup |
| `resolvectl query domain` | systemd-resolved lookup |

## Ports & Sockets

| Command | Description |
|---------|-------------|
| `ss -tlnp` | TCP listening sockets + PIDs |
| `ss -ulnp` | UDP listening sockets |
| `ss -s` | Socket statistics summary |
| `netstat -tlnp` | (older) TCP listening sockets |
| `lsof -i :port` | What's using a port |
| `lsof -i tcp:8080` | Specific TCP port |
| `fuser port/tcp` | PID using a port |

## Interfaces & Routing

| Command | Description |
|---------|-------------|
| `ip addr` | Show interfaces and IPs |
| `ip link` | Show interface status |
| `ip route` | Show routing table |
| `ip route add 10.0.0.0/8 via gw` | Add static route |
| `ip neigh` | ARP/neighbor table |
| `ifconfig` | (older) interface config |
| `route -n` | (older) routing table |
| `ethtool eth0` | Interface hardware details |

## curl Patterns

| Command | Description |
|---------|-------------|
| `curl -X POST -d '{"k":"v"}' -H "Content-Type: application/json" url` | POST JSON |
| `curl -u user:pass url` | Basic auth |
| `curl -H "Authorization: Bearer TOKEN" url` | Bearer token |
| `curl -o file url` | Download to file |
| `curl -L url` | Follow redirects |
| `curl -k url` | Skip TLS verification |
| `curl -w "%{http_code}" -o /dev/null -s url` | Just HTTP status code |
| `curl --max-time 5 url` | Set timeout |
| `curl -x proxy:port url` | Use proxy |

## Firewall (iptables / nftables)

| Command | Description |
|---------|-------------|
| `iptables -L -n` | List rules |
| `iptables -A INPUT -p tcp --dport 22 -j ACCEPT` | Allow SSH |
| `iptables -A INPUT -j DROP` | Default deny |
| `iptables-save > rules.v4` | Save rules |
| `ufw status` | Ubuntu firewall status |
| `ufw allow 22/tcp` | Allow port |
| `ufw enable` | Enable firewall |

## Packet Capture

| Command | Description |
|---------|-------------|
| `tcpdump -i eth0` | Capture on interface |
| `tcpdump -i eth0 port 80` | Filter by port |
| `tcpdump -i eth0 host 1.2.3.4` | Filter by host |
| `tcpdump -i eth0 -w file.pcap` | Write to file |
| `tcpdump -r file.pcap` | Read from file |

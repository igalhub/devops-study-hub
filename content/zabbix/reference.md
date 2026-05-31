# Zabbix — Quick Reference

## zabbix_agentd

| Command | Description |
|---------|-------------|
| `zabbix_agentd -t system.cpu.load` | Test a metric locally |
| `zabbix_agentd -t vfs.fs.size[/,used]` | Test filesystem metric |
| `zabbix_agentd --print` | Print supported items |
| `systemctl status zabbix-agent2` | Agent service status |
| `systemctl restart zabbix-agent2` | Restart agent |
| `zabbix_agentd -c /etc/zabbix/zabbix_agentd.conf --foreground` | Run in foreground (debug) |

## zabbix_get (from server to agent)

| Command | Description |
|---------|-------------|
| `zabbix_get -s host -k system.cpu.load` | Get metric from agent |
| `zabbix_get -s host -p 10050 -k agent.ping` | Test connectivity |
| `zabbix_get -s host -k vm.memory.size[available]` | Available memory |
| `zabbix_get -s host -k net.if.in[eth0]` | Network interface RX |

## zabbix_sender

| Command | Description |
|---------|-------------|
| `zabbix_sender -z server -s "Hostname" -k key -o value` | Send one value |
| `zabbix_sender -z server -i data.txt` | Send from file |
| `zabbix_sender -z server -s "Host" -k key -o val --real-time` | Real-time send |

Data file format (one item per line):
```
Hostname key value
Hostname key value timestamp
```

## Zabbix API (curl)

```bash
ZABBIX="http://zabbix/api_jsonrpc.php"

# Login and get token
curl -X POST "$ZABBIX" -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0", "method": "user.login",
  "params": {"user": "Admin", "password": "zabbix"},
  "id": 1
}'

# Get hosts (replace TOKEN)
curl -X POST "$ZABBIX" -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0", "method": "host.get",
  "params": {"output": ["hostid", "host", "status"]},
  "auth": "TOKEN", "id": 2
}'

# Get active problems
curl -X POST "$ZABBIX" -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0", "method": "problem.get",
  "params": {"recent": true, "sortfield": "eventid", "sortorder": "DESC"},
  "auth": "TOKEN", "id": 3
}'
```

## Key Built-in Item Keys

| Key | Description |
|-----|-------------|
| `system.cpu.load[,avg1]` | 1-min CPU load average |
| `vm.memory.size[available]` | Available memory (bytes) |
| `vfs.fs.size[/,pfree]` | Disk free percent |
| `net.if.in[eth0]` | Network RX bytes/sec |
| `net.if.out[eth0]` | Network TX bytes/sec |
| `proc.num[nginx]` | Running nginx processes |
| `agent.ping` | Agent reachability (1=OK) |
| `system.uptime` | System uptime (seconds) |
| `log[/var/log/app.log,ERROR]` | Log monitoring |
| `web.page.get[url]` | HTTP page content |

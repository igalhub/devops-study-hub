# Linux — Quick Reference

## File System Navigation

| Command | Description |
|---------|-------------|
| `ls -lah` | Long list, all files, human sizes |
| `ls -lt` | Sort by modification time |
| `find . -name "*.log"` | Find by name |
| `find . -mtime -7` | Files modified in last 7 days |
| `find . -size +100M` | Files larger than 100 MB |
| `find . -type f -exec rm {} \;` | Find and execute on each |
| `locate filename` | Fast search via index (update: `updatedb`) |
| `du -sh dir/` | Directory size summary |
| `df -h` | Disk usage by filesystem |
| `pwd` | Print working directory |

## File Permissions

| Command | Description |
|---------|-------------|
| `chmod 755 file` | rwxr-xr-x |
| `chmod 644 file` | rw-r--r-- |
| `chmod +x file` | Add execute bit |
| `chmod -R 750 dir/` | Recursive |
| `chown user:group file` | Change owner |
| `chown -R user:group dir/` | Recursive ownership change |
| `umask 022` | Default permissions mask |
| `stat file` | Detailed file metadata |

## Process Management

| Command | Description |
|---------|-------------|
| `ps aux` | All running processes |
| `ps aux \| grep name` | Find process by name |
| `top` | Interactive process viewer |
| `htop` | Enhanced top (if installed) |
| `kill PID` | Send SIGTERM |
| `kill -9 PID` | Send SIGKILL (force) |
| `pkill name` | Kill by process name |
| `jobs` | List background jobs |
| `bg %1` | Resume job 1 in background |
| `fg %1` | Bring job 1 to foreground |
| `nohup cmd &` | Run immune to hangups |
| `nice -n 10 cmd` | Run with lower priority |

## User & Groups

| Command | Description |
|---------|-------------|
| `whoami` | Current user |
| `id` | Current user ID + groups |
| `useradd -m username` | Add user with home dir |
| `passwd username` | Set password |
| `usermod -aG group user` | Add user to group |
| `groupadd groupname` | Create group |
| `su - username` | Switch user |
| `sudo cmd` | Run as root |
| `sudo -u user cmd` | Run as another user |
| `visudo` | Edit sudoers safely |

## Systemd / Services

| Command | Description |
|---------|-------------|
| `systemctl start svc` | Start service |
| `systemctl stop svc` | Stop service |
| `systemctl restart svc` | Restart service |
| `systemctl enable svc` | Start on boot |
| `systemctl disable svc` | Remove from boot |
| `systemctl status svc` | Check status |
| `journalctl -u svc` | View service logs |
| `journalctl -u svc -f` | Follow service logs |
| `journalctl --since "1 hour ago"` | Recent logs |
| `systemctl list-units --failed` | List failed services |

## Package Management (apt / yum)

| Command | Description |
|---------|-------------|
| `apt update` | Refresh package index |
| `apt install pkg` | Install package |
| `apt remove pkg` | Remove package |
| `apt upgrade` | Upgrade all packages |
| `apt search term` | Search packages |
| `dpkg -l` | List installed packages |
| `yum install pkg` | (RHEL/CentOS) install |
| `yum update` | Update all |
| `rpm -qa` | List all RPM packages |

## Archives & Compression

| Command | Description |
|---------|-------------|
| `tar -czf archive.tar.gz dir/` | Create gzipped tar |
| `tar -xzf archive.tar.gz` | Extract gzipped tar |
| `tar -tzf archive.tar.gz` | List contents without extracting |
| `zip -r archive.zip dir/` | Create zip |
| `unzip archive.zip` | Extract zip |
| `gzip file` | Compress file |
| `gunzip file.gz` | Decompress |

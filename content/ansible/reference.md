# Ansible — Quick Reference

## Core Commands

| Command | Description |
|---------|-------------|
| `ansible all -m ping` | Ping all hosts |
| `ansible all -m ping -i inventory` | Use specific inventory |
| `ansible-playbook play.yml` | Run a playbook |
| `ansible-playbook play.yml -i inventory` | With explicit inventory |
| `ansible-playbook play.yml --check` | Dry run (check mode) |
| `ansible-playbook play.yml --diff` | Show file diffs |
| `ansible-playbook play.yml -t tag` | Run specific tags |
| `ansible-playbook play.yml --skip-tags tag` | Skip tags |
| `ansible-playbook play.yml -l host` | Limit to hosts |
| `ansible-playbook play.yml -v` | Verbose (use -vvv for more) |

## Ad-hoc Commands

| Command | Description |
|---------|-------------|
| `ansible host -m command -a "cmd"` | Run command (no shell) |
| `ansible host -m shell -a "cmd \| pipe"` | Run shell command |
| `ansible host -m copy -a "src=f dest=/path"` | Copy file |
| `ansible host -m file -a "path=/dir state=directory"` | Create directory |
| `ansible host -m service -a "name=nginx state=started"` | Manage service |
| `ansible host -m yum -a "name=pkg state=present"` | Install package |
| `ansible host -m apt -a "name=pkg state=present"` | Install (Debian) |
| `ansible host -m user -a "name=u state=present"` | Create user |
| `ansible host -a "df -h" -b` | Run with sudo (become) |
| `ansible host -m setup` | Gather facts |

## Inventory

| Pattern | Description |
|---------|-------------|
| `ansible-inventory --list` | Show inventory as JSON |
| `ansible-inventory --graph` | Show inventory tree |
| `[web]` | Inventory group header |
| `web[1:3]` | Range: web1, web2, web3 |
| `ansible_host=1.2.3.4` | Override connection host |
| `ansible_user=ubuntu` | Override SSH user |
| `ansible_ssh_private_key_file=~/.ssh/key` | Override key |
| `[all:vars]` | Variables for all hosts |

## Vault

| Command | Description |
|---------|-------------|
| `ansible-vault create file` | Create encrypted file |
| `ansible-vault edit file` | Edit encrypted file |
| `ansible-vault encrypt file` | Encrypt existing file |
| `ansible-vault decrypt file` | Decrypt file |
| `ansible-vault view file` | View without decrypting to disk |
| `ansible-playbook play.yml --ask-vault-pass` | Prompt for vault password |
| `ansible-playbook play.yml --vault-password-file=.vault` | Use password file |

## Common Modules

| Module | Key args | Description |
|--------|----------|-------------|
| `copy` | `src`, `dest`, `mode` | Copy local file to remote |
| `template` | `src`, `dest` | Jinja2 template |
| `file` | `path`, `state`, `mode` | Manage files/dirs |
| `lineinfile` | `path`, `line`, `regexp` | Manage lines in file |
| `service` | `name`, `state`, `enabled` | Manage services |
| `package` | `name`, `state` | OS-agnostic package install |
| `command` | `cmd` | Run command (no shell) |
| `shell` | `cmd` | Run in shell |
| `stat` | `path` | Get file info |
| `debug` | `msg`, `var` | Print debug message |
| `assert` | `that`, `fail_msg` | Validate condition |
| `include_tasks` | `file` | Include task file dynamically |
| `block` | — | Group tasks with shared attrs |

## Task Patterns

| Pattern | Description |
|---------|-------------|
| `when: ansible_os_family == "Debian"` | Conditional |
| `loop: "{{ list_var }}"` | Loop over list |
| `register: result` | Store task output |
| `result.rc == 0` | Check return code |
| `ignore_errors: true` | Continue on failure |
| `become: true` | Privilege escalation |
| `notify: handler_name` | Trigger handler |
| `tags: [install, config]` | Tag a task |
| `delegate_to: localhost` | Run on different host |

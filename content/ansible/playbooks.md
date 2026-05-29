---
title: Playbooks & Inventory
module: ansible
duration_min: 20
difficulty: beginner
tags: [ansible, playbooks, inventory, tasks, modules, idempotent]
exercises: 4
---

## Overview
Ansible automates configuration management and application deployment across many servers simultaneously, over SSH, with no agent required. A **playbook** describes what to do; the **inventory** describes where to do it. Everything runs from a control node — your laptop or CI server — pushing changes via SSH. This lesson covers the fundamentals of both.

## Concepts

### Key Principles
- **Agentless** — only SSH and Python required on managed nodes
- **Idempotent** — running a playbook twice produces the same result; no harmful side effects
- **Declarative** — you describe the desired state, Ansible figures out what needs to change
- **Push model** — the control node connects to managed nodes (vs Puppet/Chef pull model)

### Inventory
The inventory tells Ansible which hosts to manage:

```ini
# inventory.ini (INI format)
[webservers]
web01.example.com
web02.example.com
192.168.1.10

[databases]
db01.example.com ansible_user=ubuntu ansible_port=22

[production:children]  # group of groups
webservers
databases

[all:vars]  # variables for all hosts
ansible_user=deploy
ansible_python_interpreter=/usr/bin/python3
```

```yaml
# inventory.yaml (YAML format — more powerful)
all:
  vars:
    ansible_user: deploy
    ansible_python_interpreter: /usr/bin/python3

  children:
    webservers:
      hosts:
        web01.example.com:
          http_port: 80
        web02.example.com:
          http_port: 8080
    databases:
      hosts:
        db01.example.com:
```

```bash
# Test inventory
ansible -i inventory.ini all --list-hosts
ansible -i inventory.ini webservers --list-hosts

# Ping all hosts (test connectivity)
ansible -i inventory.ini all -m ping

# Run an ad-hoc command
ansible -i inventory.ini webservers -m shell -a "uptime"
ansible -i inventory.ini all -m shell -a "df -h" -b   # -b: become (sudo)
```

### Playbook Structure
```yaml
# deploy.yml
---
- name: Deploy web application        # play name
  hosts: webservers                   # target hosts/group
  become: true                        # use sudo for all tasks
  vars:
    app_version: "1.2.3"
    app_dir: /opt/myapp

  tasks:
    - name: Ensure nginx is installed
      ansible.builtin.package:
        name: nginx
        state: present                # present = installed, absent = removed

    - name: Ensure nginx is started and enabled
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

    - name: Copy application config
      ansible.builtin.template:
        src: templates/nginx.conf.j2
        dest: /etc/nginx/sites-enabled/myapp.conf
        owner: root
        group: root
        mode: "0644"
      notify: Reload nginx             # triggers handler

  handlers:
    - name: Reload nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
```

```bash
# Run a playbook
ansible-playbook -i inventory.ini deploy.yml

# Dry run (show what would change)
ansible-playbook -i inventory.ini deploy.yml --check

# Limit to specific hosts
ansible-playbook -i inventory.ini deploy.yml --limit web01.example.com

# Verbose output
ansible-playbook -i inventory.ini deploy.yml -v    # -vvv for maximum verbosity
```

### Core Modules
```yaml
tasks:
  # Package management
  - name: Install packages
    ansible.builtin.package:         # auto-detects apt/yum/dnf
      name: [nginx, curl, git]
      state: present

  - name: Install specific apt packages
    ansible.builtin.apt:
      name: nginx=1.24.0*
      update_cache: true             # apt-get update first

  # File operations
  - name: Create directory
    ansible.builtin.file:
      path: /opt/myapp
      state: directory               # file, directory, absent, link
      owner: myapp
      group: myapp
      mode: "0755"

  - name: Copy file
    ansible.builtin.copy:
      src: files/app.conf            # relative to playbook
      dest: /etc/myapp/app.conf
      mode: "0644"

  - name: Render template
    ansible.builtin.template:
      src: templates/config.j2       # Jinja2 template
      dest: /etc/myapp/config.conf

  # Commands
  - name: Run a command
    ansible.builtin.command:
      cmd: /opt/myapp/bin/migrate
      creates: /opt/myapp/.migrated  # skip if this file exists (idempotency)

  - name: Run a shell command (supports pipes, redirection)
    ansible.builtin.shell:
      cmd: "ps aux | grep nginx | grep -v grep"

  # Users
  - name: Create user
    ansible.builtin.user:
      name: myapp
      shell: /bin/bash
      groups: [myapp, docker]
      create_home: true

  # Git
  - name: Clone/update repo
    ansible.builtin.git:
      repo: https://github.com/org/myapp.git
      dest: /opt/myapp
      version: v1.2.3
      force: true
```

### Variables and Facts
```yaml
vars:
  app_port: 8080

# Access inventory variables: {{ hostvars['web01']['http_port'] }}
# Access facts: {{ ansible_facts['os_family'] }} → "Debian" or "RedHat"

tasks:
  - name: Gather facts
    ansible.builtin.setup:    # runs automatically at play start

  - name: Print OS
    ansible.builtin.debug:
      msg: "OS: {{ ansible_facts.distribution }} {{ ansible_facts.distribution_version }}"

  - name: Task only for Debian systems
    ansible.builtin.apt:
      name: nginx
      state: present
    when: ansible_facts.os_family == "Debian"
```

### Handlers
Handlers run only if notified, and only once, at the end of the play:
```yaml
tasks:
  - name: Update nginx config
    ansible.builtin.template:
      src: nginx.conf.j2
      dest: /etc/nginx/nginx.conf
    notify: Reload nginx    # fires the handler IF this task changed

  - name: Update another nginx file
    ansible.builtin.copy:
      src: mime.types
      dest: /etc/nginx/mime.types
    notify: Reload nginx    # same handler, still only fires once

handlers:
  - name: Reload nginx
    ansible.builtin.service:
      name: nginx
      state: reloaded
```

## Examples

### Nginx Setup Playbook
```yaml
---
- name: Configure nginx web server
  hosts: webservers
  become: true

  vars:
    server_name: "{{ inventory_hostname }}"
    document_root: /var/www/html

  tasks:
    - name: Install nginx
      ansible.builtin.package:
        name: nginx
        state: present

    - name: Create document root
      ansible.builtin.file:
        path: "{{ document_root }}"
        state: directory
        owner: www-data
        group: www-data
        mode: "0755"

    - name: Deploy site config
      ansible.builtin.template:
        src: templates/site.conf.j2
        dest: /etc/nginx/sites-available/mysite.conf
      notify: Reload nginx

    - name: Enable site
      ansible.builtin.file:
        src: /etc/nginx/sites-available/mysite.conf
        dest: /etc/nginx/sites-enabled/mysite.conf
        state: link
      notify: Reload nginx

    - name: Ensure nginx is running
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

  handlers:
    - name: Reload nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
```

## Exercises

1. Write an inventory file with two groups (`webservers` and `databases`) and at least one host each. Run `ansible -i inventory.ini all -m ping` to verify connectivity. Run an ad-hoc `uptime` command against one group.
2. Write a playbook that installs `nginx` on the `webservers` group, ensures it's started and enabled, and creates a simple `index.html` file. Use `--check` mode first to preview changes.
3. Add a `template` task that generates an nginx config from a Jinja2 template file using an inventory variable as the `server_name`. Use a handler to reload nginx when the config changes.
4. Add a conditional task that installs `htop` on Debian-based systems and `htop` on RedHat-based systems (same package, different package managers) using the `when: ansible_facts.os_family` condition.


---

### Quick Checks

5. Count tasks in an Ansible play stub. Run: `printf '- name: Install nginx\n  apt:\n- name: Start nginx\n  service:\n- name: Copy config\n  template:\n' | grep -c '^- name:'`

```expected_output
3
```

hint: Think about how you can search for a specific pattern in text output and count how many times it appears.
hint: Use grep with the -c flag to count lines matching the pattern '^- name:' from the piped printf output.

6. Extract the target hosts value from a play. Run: `printf '---\n- name: Deploy\n  hosts: webservers\n  become: true\n' | awk '/hosts:/{print $2}'`

```expected_output
webservers
```

hint: Think about how you can parse specific lines from text by matching a keyword pattern and printing a particular field.
hint: Use awk with a pattern match like /hosts:/ combined with print $2 to extract the second whitespace-separated field from the matching line.

---
title: Roles
module: ansible
duration_min: 20
difficulty: intermediate
tags: [ansible, roles, galaxy, reusability, defaults, handlers, templates]
exercises: 4
---

## Overview
Roles are the packaging mechanism for Ansible. Instead of one giant playbook, you split configuration into self-contained, reusable roles — a `nginx` role, a `postgres` role, a `common` role. Each role has a standard directory structure that Ansible understands automatically. Roles can be shared via Ansible Galaxy or kept private in your organization.

## Concepts

### Role Directory Structure
```
roles/
  nginx/
    tasks/
      main.yml       # entry point — tasks auto-loaded
    handlers/
      main.yml       # handlers auto-loaded
    templates/
      nginx.conf.j2  # Jinja2 templates
    files/
      mime.types     # static files (used with copy module)
    vars/
      main.yml       # role variables (high precedence, not easily overridden)
    defaults/
      main.yml       # default values (low precedence, easily overridden by caller)
    meta/
      main.yml       # role dependencies, metadata
    README.md        # documentation
```

Only the `tasks/` directory is required; the rest are optional.

### tasks/main.yml
```yaml
# roles/nginx/tasks/main.yml
---
- name: Install nginx
  ansible.builtin.package:
    name: nginx
    state: present

- name: Create log directory
  ansible.builtin.file:
    path: "{{ nginx_log_dir }}"
    state: directory
    owner: www-data
    mode: "0755"

- name: Deploy nginx configuration
  ansible.builtin.template:
    src: nginx.conf.j2              # Ansible looks in roles/nginx/templates/
    dest: /etc/nginx/nginx.conf
    validate: nginx -t -c %s       # validate before installing
  notify: Reload nginx

- name: Start and enable nginx
  ansible.builtin.service:
    name: nginx
    state: started
    enabled: true
```

### defaults/main.yml
```yaml
# roles/nginx/defaults/main.yml
nginx_worker_processes: auto
nginx_worker_connections: 1024
nginx_log_dir: /var/log/nginx
nginx_user: www-data
nginx_port: 80
nginx_server_name: "_"             # catch-all
nginx_extra_params: {}
```

Defaults are the lowest-priority variables — easily overridden by the caller.

### handlers/main.yml
```yaml
# roles/nginx/handlers/main.yml
---
- name: Reload nginx
  ansible.builtin.service:
    name: nginx
    state: reloaded

- name: Restart nginx
  ansible.builtin.service:
    name: nginx
    state: restarted
```

### templates/nginx.conf.j2
```jinja2
user {{ nginx_user }};
worker_processes {{ nginx_worker_processes }};

events {
    worker_connections {{ nginx_worker_connections }};
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log /var/log/nginx/access.log;
    error_log  /var/log/nginx/error.log;

    server {
        listen {{ nginx_port }};
        server_name {{ nginx_server_name }};

        {% for param, value in nginx_extra_params.items() %}
        {{ param }} {{ value }};
        {% endfor %}
    }
}
```

### meta/main.yml — Dependencies
```yaml
# roles/nginx/meta/main.yml
galaxy_info:
  author: igal
  description: Nginx web server role
  license: MIT
  min_ansible_version: "2.14"
  platforms:
    - name: Ubuntu
      versions: [22.04, 20.04]
    - name: EL
      versions: [8, 9]

dependencies:
  - role: common        # runs before this role
  - role: geerlingguy.git   # from Galaxy
```

### Using Roles in Playbooks
```yaml
---
- name: Configure web tier
  hosts: webservers
  become: true
  roles:
    - role: common
    - role: nginx
      vars:
        nginx_port: 8080              # override defaults for this play
        nginx_server_name: api.example.com
    - role: certbot
      when: ansible_facts.os_family == "Debian"
```

Alternative with `import_role` / `include_role` (allows conditionals, loops):
```yaml
tasks:
  - name: Apply nginx role
    ansible.builtin.import_role:
      name: nginx
    vars:
      nginx_port: 8080

  - name: Apply app role on primary only
    ansible.builtin.include_role:
      name: myapp
    when: inventory_hostname == groups['webservers'][0]
```

### Ansible Galaxy
Galaxy is the public hub for community roles and collections:

```bash
# Search for a role
ansible-galaxy search nginx

# Install a role
ansible-galaxy role install geerlingguy.nginx
ansible-galaxy role install geerlingguy.nginx --version 3.2.0

# Install from requirements.yml
ansible-galaxy install -r requirements.yml

# List installed roles
ansible-galaxy role list
```

```yaml
# requirements.yml
roles:
  - name: geerlingguy.nginx
    version: "3.2.0"
  - name: geerlingguy.postgresql
    version: "3.4.0"

collections:
  - name: community.postgresql
    version: "3.4.0"
  - name: amazon.aws
    version: "7.0.0"
```

### Collections
Collections bundle roles, modules, and plugins under a namespace:
```bash
ansible-galaxy collection install community.postgresql
ansible-galaxy collection install amazon.aws
ansible-galaxy collection install -r requirements.yml
```

After installing, use collection-qualified module names:
```yaml
- name: Create database
  community.postgresql.postgresql_db:
    name: myapp
    state: present
```

### Testing Roles with Molecule
Molecule is the standard testing framework for Ansible roles:

```bash
pip install molecule molecule-docker
cd roles/nginx
molecule init scenario           # creates molecule/default/ structure
molecule test                    # lint → create → converge → verify → destroy
molecule converge                # create + apply role (without destroying)
molecule verify                  # run tests only
molecule destroy                 # clean up
```

```yaml
# molecule/default/verify.yml
---
- name: Verify nginx role
  hosts: all
  tasks:
    - name: Check nginx is running
      ansible.builtin.service_facts:

    - name: Assert nginx is active
      ansible.builtin.assert:
        that:
          - "'nginx' in services"
          - "services.nginx.state == 'running'"

    - name: Check nginx port 80
      ansible.builtin.wait_for:
        port: 80
        timeout: 5
```

## Examples

### Common Role (Applied to All Hosts)
```yaml
# roles/common/tasks/main.yml
---
- name: Install common packages
  ansible.builtin.package:
    name:
      - curl
      - htop
      - vim
      - unzip
      - python3-pip
    state: present

- name: Set timezone
  community.general.timezone:
    name: "{{ common_timezone }}"

- name: Configure sysctl
  ansible.posix.sysctl:
    name: "{{ item.key }}"
    value: "{{ item.value }}"
    state: present
    reload: true
  loop: "{{ common_sysctl_params | dict2items }}"
```

## Exercises

1. Create a `nginx` role using `ansible-galaxy role init nginx`. Implement tasks to install nginx, deploy a template-based config, and handle service management. Apply it in a playbook.
2. Use the `defaults/main.yml` to define configurable variables (`nginx_port`, `nginx_worker_processes`). Override them from the playbook for one group of hosts and use defaults for another.
3. Add a `meta/main.yml` with a dependency on a `common` role you also write. Verify Ansible runs `common` before `nginx` without you having to specify the order in the playbook.
4. Write a Molecule test for your nginx role that verifies: the nginx package is installed, the service is running, and port 80 is listening. Run `molecule test` and confirm it passes.

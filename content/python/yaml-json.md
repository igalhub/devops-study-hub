---
title: YAML & JSON Parsing
module: python
duration_min: 15
difficulty: beginner
tags: [python, yaml, json, config, pyyaml, parsing]
exercises: 4
---

## Overview
DevOps config files are either YAML or JSON — Kubernetes manifests, Docker Compose, Terraform outputs, GitHub Actions workflows, Ansible inventories. Python reads and writes both natively (JSON) or with one library (PyYAML). This lesson covers the full read/write/validate cycle you'll use daily.

## Concepts

### JSON — Built In
```python
import json

# Parse JSON string
text = '{"host": "db.example.com", "port": 5432, "ssl": true}'
config = json.loads(text)        # dict
config["host"]                   # "db.example.com"

# Parse JSON file
with open("config.json") as f:
    data = json.load(f)          # json.load reads a file object

# Serialize to string
json.dumps(config, indent=2)     # pretty-print
json.dumps(config)               # compact

# Write JSON file
with open("output.json", "w") as f:
    json.dump(config, f, indent=2)
```

**Type mapping:** JSON object → `dict`, array → `list`, string → `str`, number → `int`/`float`, boolean → `bool`, null → `None`.

### JSON Edge Cases
```python
# Non-serializable types will raise TypeError
import datetime
json.dumps({"ts": datetime.datetime.now()})  # TypeError!

# Fix: use a custom encoder or convert first
json.dumps({"ts": datetime.datetime.now().isoformat()})  # OK

# Parsing unknown JSON safely
try:
    data = json.loads(raw)
except json.JSONDecodeError as e:
    print(f"Invalid JSON at line {e.lineno}: {e.msg}")
```

### YAML — PyYAML
```python
import yaml

# Parse YAML string
text = """
host: db.example.com
port: 5432
replicas: 3
ssl: true
tags:
  - prod
  - eu-west
"""
config = yaml.safe_load(text)    # dict
config["tags"]                   # ["prod", "eu-west"]

# Parse YAML file
with open("deployment.yaml") as f:
    manifest = yaml.safe_load(f)

# Write YAML (safe_dump handles basic Python types: dict, list, str, int, float, bool)
print(yaml.safe_dump(config, default_flow_style=False))

# Write YAML file
with open("output.yaml", "w") as f:
    yaml.safe_dump(config, f, default_flow_style=False)
```

**Always use `yaml.safe_load()`**, never `yaml.load()` — the unsafe version can execute arbitrary Python when parsing attacker-controlled input. On the write side, `yaml.safe_dump()` is the consistent counterpart; `yaml.dump()` also works for basic types but can serialize arbitrary Python objects.

### Multi-Document YAML
Kubernetes manifests often contain multiple documents separated by `---`:
```python
with open("manifests.yaml") as f:
    docs = list(yaml.safe_load_all(f))   # returns a generator

for doc in docs:
    print(doc.get("kind"), doc.get("metadata", {}).get("name"))
```

### Practical Patterns

#### Read → Modify → Write
```python
import yaml

with open("values.yaml") as f:
    values = yaml.safe_load(f)

# Bump image tag
values["image"]["tag"] = "v2.3.1"

with open("values.yaml", "w") as f:
    yaml.safe_dump(values, f, default_flow_style=False)
```

#### Merge Configs
```python
import json

def deep_merge(base: dict, override: dict) -> dict:
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result

base = json.load(open("config.base.json"))
env  = json.load(open("config.prod.json"))
merged = deep_merge(base, env)
```

#### Validate Required Keys
```python
def validate_config(config: dict, required: list[str]) -> list[str]:
    missing = [k for k in required if k not in config]
    return missing

config = yaml.safe_load(open("app.yaml"))
missing = validate_config(config, ["host", "port", "secret_key"])
if missing:
    raise ValueError(f"Config missing required keys: {missing}")
```

#### Parse Terraform Output
```python
import subprocess, json

result = subprocess.run(
    ["terraform", "output", "-json"],
    capture_output=True, text=True, check=True
)
outputs = json.loads(result.stdout)
# Each value is {"value": ..., "type": ...}
db_host = outputs["db_host"]["value"]
```

## Examples

### Script: Patch a Kubernetes Manifest
```python
#!/usr/bin/env python3
import sys
import yaml

manifest_path = sys.argv[1]
new_image = sys.argv[2]

with open(manifest_path) as f:
    docs = list(yaml.safe_load_all(f))

for doc in docs:
    if doc and doc.get("kind") == "Deployment":
        containers = doc["spec"]["template"]["spec"]["containers"]
        for c in containers:
            name, tag = new_image.split(":")
            if c["image"].split(":")[0] == name:
                c["image"] = new_image
                print(f"Updated container {c['name']} → {new_image}")

with open(manifest_path, "w") as f:
    yaml.dump_all(docs, f, default_flow_style=False)
```

### Script: Config Diff
```python
#!/usr/bin/env python3
import json, sys

def flatten(d, prefix=""):
    items = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            items.update(flatten(v, key))
        else:
            items[key] = v
    return items

a = flatten(json.load(open(sys.argv[1])))
b = flatten(json.load(open(sys.argv[2])))

all_keys = set(a) | set(b)
for key in sorted(all_keys):
    if a.get(key) != b.get(key):
        print(f"{key}: {a.get(key)!r} → {b.get(key)!r}")
```

## Exercises

1. Write a function that loads a YAML file and returns a flattened dict where nested keys are joined by dots (e.g. `{"db": {"host": "x"}}` → `{"db.host": "x"}`).
2. Write a script that reads a directory of JSON files and produces a merged JSON object where later files override earlier keys.
3. Given a Kubernetes Deployment YAML, write a script that prints the name, namespace, and all container image names.
4. Write a function `env_to_dict(path)` that reads a `.env` file (format: `KEY=value`, skip comments starting with `#`) and returns a dict. Handle quoted values and empty lines.

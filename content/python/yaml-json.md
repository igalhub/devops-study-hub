---
title: YAML & JSON Parsing
module: python
duration_min: 15
difficulty: beginner
tags: [python, yaml, json, config, pyyaml, parsing]
exercises: 4
---

## Overview

DevOps work is inseparable from structured text files. Kubernetes manifests, Helm values, Docker Compose stacks, Terraform outputs, GitHub Actions workflows, Ansible inventories, and virtually every CI/CD pipeline configuration is expressed in YAML or JSON. Python is the dominant scripting language for gluing these systems together — reading a manifest to patch an image tag, comparing two config snapshots, or extracting Terraform outputs to pass into a deployment script are daily tasks for a DevOps engineer. Knowing how to parse, transform, and write both formats reliably is a foundational skill, not a nice-to-have.

JSON is part of Python's standard library — no installation required. YAML requires the `PyYAML` package (`pip install pyyaml`), which is available in virtually every DevOps container base image and CI runner. Both formats map cleanly onto Python's native data structures (dicts, lists, strings, numbers, booleans, None), which means once you've parsed a document you work with ordinary Python — no special API, no query language.

In the broader DevOps toolchain these skills connect upward to infrastructure automation (Ansible, Terraform), container orchestration (Kubernetes), and GitOps pipelines (Argo CD, Flux), all of which expect you to programmatically produce or consume structured config. They also connect downward to basic shell scripting — `jq` and `yq` handle simple one-liners, but Python is what you reach for when logic, validation, or multi-file merging is involved.

---

## Concepts

### JSON — Built-In Parsing and Serialization

Python's `json` module handles the full read/write cycle. The two most important distinctions to internalize: `json.loads` / `json.load` (note the `s` = string) and `json.dumps` / `json.dump` (note the `s` = string).

| Function | Input | Output | Use when |
|---|---|---|---|
| `json.loads(s)` | JSON string | Python object | Parsing API responses, subprocess output |
| `json.load(f)` | File object | Python object | Reading a `.json` file from disk |
| `json.dumps(obj)` | Python object | JSON string | Sending to an API, printing to stdout |
| `json.dump(obj, f)` | Python object + file | Writes to file | Persisting a `.json` file to disk |

```python
import json

# Parse a JSON string (common when reading subprocess output or HTTP responses)
text = '{"host": "db.example.com", "port": 5432, "ssl": true, "tags": null}'
config = json.loads(text)
print(config["host"])    # "db.example.com"
print(config["tags"])    # None  — JSON null maps to Python None
print(config["ssl"])     # True  — JSON boolean maps to Python bool

# Read from a file
with open("config.json") as f:
    data = json.load(f)

# Serialize: indent=2 is the standard choice for human-readable output
print(json.dumps(config, indent=2))

# sort_keys=True makes diffs cleaner — key order is stable across writes
with open("output.json", "w") as f:
    json.dump(config, f, indent=2, sort_keys=True)
```

**Type mapping — memorize this table:**

| JSON type | Python type |
|---|---|
| `object` `{}` | `dict` |
| `array` `[]` | `list` |
| `string` `""` | `str` |
| `number` (integer) | `int` |
| `number` (float) | `float` |
| `true` / `false` | `True` / `False` |
| `null` | `None` |

**`sort_keys=True` gotcha:** it flattens key order globally. If your downstream system expects a specific key order (rare, but some legacy tools do), don't sort. Otherwise always sort — it makes version-controlled JSON files produce clean `git diff` output.

---

### JSON Edge Cases and Error Handling

Real-world JSON from APIs, Terraform, and CI tools is often messier than examples suggest.

```python
import json
import datetime
from pathlib import Path

# --- Non-serializable types ---
# datetime objects are not JSON-serializable by default
event = {"ts": datetime.datetime.utcnow(), "level": "info"}
# json.dumps(event)  →  TypeError: Object of type datetime is not JSON serializable

# Fix 1: convert before serializing
event["ts"] = event["ts"].isoformat()
json.dumps(event)  # OK: "ts": "2024-01-15T10:30:00"

# Fix 2: custom encoder for systematic handling across a codebase
class DevOpsEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime.datetime):
            return obj.isoformat()
        if isinstance(obj, Path):
            return str(obj)
        return super().default(obj)

json.dumps({"ts": datetime.datetime.utcnow()}, cls=DevOpsEncoder)

# --- Robust parsing with error context ---
def parse_json_safe(raw: str, source: str = "<unknown>") -> dict | None:
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        # e.lineno, e.colno, e.msg give you exact location
        print(f"[ERROR] Invalid JSON from {source} at line {e.lineno} col {e.colno}: {e.msg}")
        return None

# --- Handling large numbers ---
# Python int handles arbitrary precision; JSON spec doesn't cap integers
big = json.loads('{"id": 99999999999999999999}')
print(type(big["id"]))  # <class 'int'> — Python handles it fine

# --- Float precision ---
# JSON floats can have precision surprises
data = json.loads('{"ratio": 0.1}')
print(data["ratio"])          # 0.1
print(data["ratio"] + 0.2)   # 0.30000000000000004 — standard float behavior
```

**Trailing commas:** JSON does not allow trailing commas (`{"a": 1,}` is invalid). YAML does not have this problem. If you're consuming hand-edited JSON configs and hitting parse errors, trailing commas are a common culprit. Consider `json5` or `commentjson` packages for human-edited files, or enforce a linter.

---

### YAML — PyYAML Fundamentals

YAML is a superset of JSON but far more common in infrastructure tooling because it supports comments, multi-line strings, and a cleaner syntax for nested structures.

```python
import yaml

# safe_load parses a YAML string into a Python dict
text = """
# Database configuration
host: db.example.com
port: 5432
replicas: 3
ssl: true
credentials:
  username: app_user
  password: "${DB_PASSWORD}"   # variable reference — stays as a string
tags:
  - prod
  - eu-west-1
"""

config = yaml.safe_load(text)
print(config["credentials"]["username"])  # "app_user"
print(config["tags"])                     # ["prod", "eu-west-1"]

# Parse from a file
with open("deployment.yaml") as f:
    manifest = yaml.safe_load(f)

# Write YAML — default_flow_style=False forces block style (human-readable)
print(yaml.safe_dump(config, default_flow_style=False))

# Write to file with explicit encoding
with open("output.yaml", "w", encoding="utf-8") as f:
    yaml.safe_dump(config, f, default_flow_style=False, allow_unicode=True)
```

**Always use `yaml.safe_load()`, never `yaml.load()`.**  
`yaml.load()` with the default `Loader` can deserialize arbitrary Python objects — including executing code — from attacker-controlled YAML. This is a real CVE class. `safe_load` restricts deserialization to basic types only. There is no legitimate use case in DevOps scripting that requires `yaml.load()`.

**`default_flow_style=False`:** without this flag, `safe_dump` may render short lists and dicts on a single line (`{host: db.example.com, port: 5432}`). Setting it to `False` forces block style throughout, which is what Kubernetes and Helm tooling expect.

---

### YAML Type Coercion Traps

YAML's automatic type inference is convenient but has sharp edges that have caused production incidents.

```python
import yaml

# YAML booleans — these all parse as True/False in YAML 1.1 (PyYAML default)
booleans = yaml.safe_load("""
a: true
b: yes
c: on
d: True
e: YES
f: false
g: no
h: off
""")
print(booleans)
# {'a': True, 'b': True, 'c': True, 'd': True, 'e': True,
#  'f': False, 'g': False, 'h': False}

# This matters for Ansible variables, Helm values, and k8s configs
# A field named "enabled: yes" in a Helm values.yaml is boolean True, not string "yes"

# Octal integers — YAML 1.1 parses 0-prefixed numbers as octal
octal_trap = yaml.safe_load("mode: 0755")
print(octal_trap["mode"])   # 493 (decimal) — NOT the string "0755"
# For file modes, always quote: mode: "0755"

# Null coercion
nulls = yaml.safe_load("""
a: null
b: ~
c:          # empty value
""")
print(nulls)  # {'a': None, 'b': None, 'c': None}

# The Norway Problem — country code "NO" parses as False
country = yaml.safe_load("country: NO")
print(country)  # {'country': False}  ← production bug waiting to happen
# Fix: always quote strings that could be confused with booleans
country_fixed = yaml.safe_load("country: 'NO'")
print(country_fixed)  # {'country': 'NO'}
```

**Norway Problem summary:** in YAML 1.1, `NO`, `Yes`, `On`, `Off`, and variants are booleans. Country codes, environment names, and feature flags often match these strings. **Quote any string value that could be mistaken for a boolean or null.** YAML 1.2 fixes this, but PyYAML implements 1.1.

---

### Multi-Document YAML

Kubernetes manifests routinely bundle multiple resources (Deployment, Service, ConfigMap) in a single file, separated by `---`.

```python
import yaml

# safe_load_all returns a generator — wrap in list() to iterate multiple times
with open("manifests.yaml") as f:
    docs = list(yaml.safe_load_all(f))

# Filter to a specific kind
deployments = [d for d in docs if d and d.get("kind") == "Deployment"]

for doc in docs:
    if doc is None:
        continue  # trailing --- produces a None document
    kind = doc.get("kind", "Unknown")
    name = doc.get("metadata", {}).get("name", "unnamed")
    ns   = doc.get("metadata", {}).get("namespace", "default")
    print(f"{kind}/{name} in {ns}")

# Write multiple documents back out
with open("patched.yaml", "w") as f:
    yaml.dump_all(docs, f, default_flow_style=False)
```

**`safe_load_all` returns a generator:** if you consume it once (e.g., in a for loop), it's exhausted. Call `list()` on it immediately if you need to iterate more than once or check the length.

**`None` documents:** a file that ends with `---` or has `---` followed immediately by another `---` produces `None` entries in the generator. Always guard with `if doc is None: continue`.

---

### Practical Patterns

#### Read → Modify → Write

The most common DevOps scripting task: load a config, change one value, write it back.

```python
import yaml

def patch_image_tag(values_path: str, new_tag: str) -> None:
    with open(values_path) as f:
        values = yaml.safe_load(f)

    # Navigate nested structure safely with .get() chains
    if "image" not in values:
        raise KeyError(f"'image' key not found in {values_path}")

    old_tag = values["image"].get("tag", "<unset>")
    values["image"]["tag"] = new_tag
    print(f"Tag: {old_tag} → {new_tag}")

    with open(values_path, "w") as f:
        # sort_keys=False preserves original key order (important for Helm values)
        yaml.safe_dump(values, f, default_flow_style=False, sort_keys=False)

patch_image_tag("helm/values.yaml", "v2.3.1")
```

**Comment stripping warning:** PyYAML does not preserve comments. Loading and re-dumping a YAML file will silently strip all `#` comments. If your values files have important inline documentation, consider `ruamel.yaml` instead, which round-trips comments.

#### Deep Merge for Environment Overrides

A base config plus per-environment overrides is a standard pattern in Ansible, Helm, and custom deployment scripts.

```python
import json
from typing import Any

def deep_merge(base: dict, override: dict) -> dict:
    """
    Recursively merge override into base.
    override values win on conflict.
    Lists are replaced entirely, not concatenated.
    """
    result = base.copy()
    for key, value in override.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value  # override wins, including for lists
    return result

# Load base + environment-specific override
with open("config.base.json") as f:
    base = json.load(f)

with open(f"config.prod.json") as f:
    override = json.load(f)

merged = deep_merge(base, override)

# Write result — sort_keys ensures stable output for version control
with open("config.merged.json", "w") as f:
    json.dump(merged, f, indent=2, sort_keys=True)
```

#### Validate Required Keys (with Nested Path Support)

```python
import yaml
from typing import Any

def get_nested(data: dict, dotted_key: str) -> tuple[bool, Any]:
    """Resolve a dotted key path like 'database.host' into nested dict."""
    parts = dotted_key.split(".")
    current = data
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]
    return True, current

def validate_config(config: dict, required: list[str]) -> list[str]:
    """Return list of missing required keys (supports dot notation)."""
    missing = []
    for key in required:
        found, value = get_nested(config, key)
        if not found or value is None:
            missing.append(key)
    return missing

with open("app.yaml") as f:
    config = yaml.safe_load(f)

required_keys = ["host", "port", "database.host", "database.port", "auth.secret_key"]
missing = validate_config(config, required_keys)

if missing:
    raise ValueError(f"Config missing required keys: {missing}")

print("Config validation passed.")
```

#### Parse Terraform Output

Terraform's `-json` flag produces structured output that's easy to consume from Python.

```python
import subprocess
import json

def get_terraform_outputs(working_dir: str = ".") -> dict:
    result = subprocess.run(
        ["terraform", "output", "-json"],
        capture_output=True,
        text=True,
        check=True,          # raises CalledProcessError on non-zero exit
        cwd=working_dir      # run in the correct Terraform workspace
    )
    raw =
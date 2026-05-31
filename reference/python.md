# Python — Quick Reference

## Built-in Types & Operations

| Pattern | Description |
|---------|-------------|
| `[x for x in lst if cond]` | List comprehension |
| `{k: v for k, v in d.items()}` | Dict comprehension |
| `{x for x in lst}` | Set comprehension |
| `(x for x in lst)` | Generator expression |
| `*args, **kwargs` | Variadic positional / keyword args |
| `a, *rest = lst` | Unpack with rest |
| `d.get("key", default)` | Dict get with default |
| `sorted(lst, key=lambda x: x.val)` | Sort by attribute |
| `zip(a, b)` | Parallel iteration |
| `enumerate(lst)` | Index + value iteration |
| `any(cond for x in lst)` | Any element satisfies |
| `all(cond for x in lst)` | All elements satisfy |

## File & I/O

| Pattern | Description |
|---------|-------------|
| `with open("f") as fh:` | Safe file open |
| `fh.read()` | Read entire file |
| `fh.readlines()` | Read as list of lines |
| `for line in fh:` | Stream lines |
| `json.load(fh)` | Parse JSON file |
| `json.dump(obj, fh, indent=2)` | Write JSON file |
| `json.loads(s)` | Parse JSON string |
| `json.dumps(obj)` | Serialize to JSON string |
| `pathlib.Path("dir") / "file"` | Path join |
| `Path("f").read_text()` | Read file in one call |
| `Path("f").write_text(s)` | Write file in one call |

## subprocess

| Pattern | Description |
|---------|-------------|
| `subprocess.run(["ls", "-l"])` | Run command, wait |
| `subprocess.run(cmd, check=True)` | Raise on non-zero exit |
| `subprocess.run(cmd, capture_output=True, text=True)` | Capture stdout/stderr |
| `result.stdout` | Captured stdout string |
| `result.returncode` | Exit code |
| `subprocess.run(cmd, shell=True)` | Shell string (avoid if possible) |

## Error Handling

| Pattern | Description |
|---------|-------------|
| `try: ... except ValueError as e:` | Catch specific exception |
| `except (TypeError, KeyError):` | Multiple exception types |
| `except Exception as e:` | Catch any exception |
| `finally: ...` | Always executes |
| `raise ValueError("msg")` | Raise exception |
| `raise` | Re-raise current exception |

## Common CLI & DevOps Patterns

| Pattern | Description |
|---------|-------------|
| `import argparse` | CLI argument parsing |
| `import os; os.environ.get("VAR")` | Read env variable |
| `import sys; sys.exit(1)` | Exit with code |
| `import logging; logging.basicConfig(level=logging.INFO)` | Basic logging |
| `import re; re.findall(r"\d+", s)` | Find all matches |
| `import yaml; yaml.safe_load(fh)` | Parse YAML |
| `import requests; requests.get(url).json()` | HTTP GET + parse JSON |

## pip & Environments

| Command | Description |
|---------|-------------|
| `python -m venv .venv` | Create virtual environment |
| `source .venv/bin/activate` | Activate venv |
| `pip install package` | Install package |
| `pip install -r requirements.txt` | Install from file |
| `pip freeze > requirements.txt` | Capture dependencies |
| `pip list --outdated` | Show outdated packages |
| `python -m pytest` | Run tests |

---
title: Git Hooks
module: git
duration_min: 15
difficulty: intermediate
tags: [git, hooks, pre-commit, husky, automation, ci]
exercises: 4
---

## Overview
Git hooks are scripts that run automatically at specific points in the git workflow — before a commit, before a push, after a merge. They enforce code quality at the source: no linting errors committed, no broken tests pushed, no hardcoded secrets ever hitting the remote. Understanding hooks is essential for setting up any serious development workflow.

## Concepts

### Where Hooks Live
```bash
.git/hooks/          # local hooks — not committed, not shared
                     # (sample files with .sample extension exist by default)
```

Because `.git/` is not tracked, hooks don't share across clones by default. Solutions:
1. A shared `scripts/hooks/` directory + a setup script to symlink
2. `husky` (Node.js projects)
3. `pre-commit` (Python, cross-language)

### Common Hook Points
| Hook | When it runs | Return code behavior |
|---|---|---|
| `pre-commit` | Before commit message prompt | Non-zero aborts commit |
| `commit-msg` | After message written, before commit completes | Non-zero aborts commit |
| `prepare-commit-msg` | Before editor opens | Modify the message |
| `pre-push` | Before pushing to remote | Non-zero aborts push |
| `post-commit` | After commit completes | Return code ignored |
| `post-merge` | After `git merge` completes | Return code ignored |
| `pre-rebase` | Before rebase starts | Non-zero aborts rebase |

### Writing a Hook
Hooks are executable scripts in any language. Name must match exactly (no extension):

```bash
cat > .git/hooks/pre-commit << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

echo "Running pre-commit checks..."

# Run linter on staged Python files
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep '\.py$' || true)
if [ -n "$STAGED" ]; then
    echo "Linting Python files..."
    flake8 $STAGED
fi

# Check for debug breakpoints
if git diff --cached | grep -q "import pdb\|breakpoint()"; then
    echo "ERROR: Remove debug breakpoints before committing" >&2
    exit 1
fi

echo "Pre-commit checks passed."
EOF

chmod +x .git/hooks/pre-commit
```

### commit-msg Hook — Enforce Message Format
```bash
cat > .git/hooks/commit-msg << 'EOF'
#!/usr/bin/env bash
MSG=$(cat "$1")

# Enforce Conventional Commits format
if ! echo "$MSG" | grep -qE "^(feat|fix|docs|chore|refactor|test|ci|style|perf)(\(.+\))?: .{1,72}"; then
    echo "ERROR: Commit message must follow Conventional Commits format" >&2
    echo "  Example: feat(auth): add OAuth2 login" >&2
    echo "  Got: $MSG" >&2
    exit 1
fi
EOF

chmod +x .git/hooks/commit-msg
```

### pre-push Hook — Block Broken Pushes
```bash
cat > .git/hooks/pre-push << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

REMOTE="$1"
URL="$2"

# Don't run tests when deleting a branch (empty local ref)
while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
    if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
        continue   # branch deletion
    fi
    # Run tests before pushing to main or develop
    if [[ "$remote_ref" == "refs/heads/main" || "$remote_ref" == "refs/heads/develop" ]]; then
        echo "Running tests before push to $remote_ref..."
        npm test || { echo "Tests failed — push aborted" >&2; exit 1; }
    fi
done

exit 0
EOF

chmod +x .git/hooks/pre-push
```

### Sharing Hooks with the Team

#### Method 1: Symlinks Setup Script
```bash
#!/usr/bin/env bash
# scripts/install-hooks.sh
HOOKS_DIR=".git/hooks"
SHARED_DIR="scripts/hooks"

for hook in "$SHARED_DIR"/*; do
    name=$(basename "$hook")
    ln -sf "../../$SHARED_DIR/$name" "$HOOKS_DIR/$name"
    chmod +x "$hook"
    echo "Installed: $name"
done
```

Add to README: "Run `./scripts/install-hooks.sh` after cloning."

#### Method 2: Git core.hooksPath (Git 2.9+)
```bash
# Point git at a shared directory
git config core.hooksPath scripts/hooks
# Or globally for all repos:
git config --global core.hooksPath ~/.git-hooks
```

#### Method 3: husky (Node.js projects)
```bash
npm install --save-dev husky
npx husky init

# .husky/pre-commit
npm run lint

# .husky/commit-msg
npx commitlint --edit "$1"
```

#### Method 4: pre-commit (Python, cross-language)
```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: detect-private-key
  - repo: https://github.com/psf/black
    rev: 23.12.1
    hooks:
      - id: black
```

```bash
pip install pre-commit
pre-commit install   # installs .git/hooks/pre-commit
pre-commit run --all-files   # run manually
```

### Bypassing Hooks (use sparingly)
```bash
git commit --no-verify -m "WIP: skip hooks"
git push --no-verify
```

Use only for genuine emergencies — never make it a habit.

## Examples

### Secret Detection Hook
```bash
cat > .git/hooks/pre-commit << 'EOF'
#!/usr/bin/env bash
# Prevent committing common secret patterns

PATTERNS=(
    "AKIA[0-9A-Z]{16}"                    # AWS Access Key ID
    "-----BEGIN (RSA|EC|DSA) PRIVATE KEY" # Private key
    "password\s*=\s*['\"][^'\"]{8,}"      # Hardcoded password
    "api_key\s*=\s*['\"][^'\"]{8,}"       # Hardcoded API key
)

STAGED=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$STAGED" ] && exit 0

for PATTERN in "${PATTERNS[@]}"; do
    if git diff --cached | grep -qP "$PATTERN"; then
        echo "BLOCKED: Possible secret detected matching: $PATTERN" >&2
        echo "Review staged changes with: git diff --cached" >&2
        exit 1
    fi
done

exit 0
EOF
chmod +x .git/hooks/pre-commit
```

## Exercises

1. Write a `pre-commit` hook that checks all staged `.sh` files with `bash -n` (syntax check) and aborts the commit if any have syntax errors.
2. Write a `commit-msg` hook that enforces a minimum message length of 10 characters and rejects messages that are just "fix", "wip", "update", or "changes".
3. Set up `core.hooksPath` to point to a `scripts/hooks/` directory in a test repo, put a hook there, and verify it runs on commit.
4. Write a `pre-push` hook that prevents pushing directly to `main` or `master` (only branches are allowed), printing a message explaining the policy.

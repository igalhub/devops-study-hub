---
title: Git Hooks
module: git
duration_min: 15
difficulty: intermediate
tags: [git, hooks, pre-commit, husky, automation, ci]
exercises: 4
---

## Overview

Git hooks are shell scripts (or any executable) that Git invokes automatically at well-defined points in its workflow — before a commit is recorded, before a push is sent, after a merge completes. For DevOps practitioners, hooks are the first line of defense in a quality pipeline: they catch linting errors, enforce commit message standards, block accidental secret leaks, and run test suites before code ever reaches a remote repository. Shifting these checks to the developer's local machine reduces CI feedback loops from minutes to seconds.

The core design principle is simple: hooks are plain executables living in `.git/hooks/`. A non-zero exit code from a hook aborts the Git operation in progress. There is no special syntax or framework required — a five-line bash script is a fully functional hook. That simplicity is also the main friction point: because `.git/` is not version-controlled, hooks don't travel with a clone by default, so teams must establish a sharing strategy.

In the broader DevOps toolchain, hooks occupy the leftmost quality gate — they run on the developer's workstation before code reaches a pull request or CI pipeline. They complement but don't replace CI: hooks are fast and local; CI is authoritative and shared. A healthy workflow uses both: hooks prevent embarrassing pushes, CI enforces policy with full infrastructure access. Understanding how to write, share, and manage hooks is a practical skill interviewers expect from candidates working on developer experience, platform engineering, or any team that owns a CI/CD pipeline.

---

## Concepts

### How Git Invokes Hooks

When Git runs a hook, it looks for an executable file with the exact hook name in the `.git/hooks/` directory (or the path configured by `core.hooksPath`). No file extension — a file named `pre-commit.sh` will be silently ignored. Git sets `PATH` and a handful of environment variables before calling the hook, and it waits for the process to exit.

```
.git/hooks/
├── pre-commit          # ← Git finds and runs this
├── pre-commit.sh       # ← Git ignores this entirely
├── commit-msg.sample   # ← .sample files are disabled examples shipped by Git
└── pre-push
```

The hook receives context through arguments and environment variables that vary by hook type. For example, `commit-msg` receives the path to the message file as `$1`; `pre-push` receives the remote name as `$1` and the remote URL as `$2` and reads pushed refs from stdin.

**Execution model:** Git runs the hook synchronously and blocks until it exits. For hooks that can be slow (e.g., running a test suite in `pre-push`), this is intentional — the developer waits, sees the output, and gets feedback before anything is sent.

**Required permissions:** the hook file must be executable. Forgetting `chmod +x` is the most common reason a hook silently doesn't run. Git will not error — it just skips a non-executable file.

```bash
# Verify hook is executable and will actually fire
ls -la .git/hooks/pre-commit
# -rwxr-xr-x  1 user group  512 Jan 10 09:00 .git/hooks/pre-commit
```

### Hook Lifecycle and Return Codes

| Hook | Trigger | Non-zero exit effect | Arguments |
|------|---------|----------------------|-----------|
| `pre-commit` | Before commit message prompt | Aborts commit | None |
| `prepare-commit-msg` | Before editor opens for commit message | Aborts commit | `<msg-file> <commit-type> [<sha>]` |
| `commit-msg` | After message written, before commit object created | Aborts commit | `<msg-file>` |
| `post-commit` | After commit object created | Ignored | None |
| `pre-rebase` | Before rebase begins | Aborts rebase | `<upstream> [<branch>]` |
| `pre-push` | Before objects are sent to remote | Aborts push | `<remote-name> <remote-url>` |
| `post-merge` | After `git merge` completes | Ignored | `<squash-flag>` |
| `pre-receive` | Server-side: before refs are updated | Aborts entire push | None (reads stdin) |
| `update` | Server-side: once per ref being updated | Aborts that ref's update | `<ref> <old-sha> <new-sha>` |
| `post-receive` | Server-side: after refs are updated | Ignored | None (reads stdin) |

**Client vs. server hooks:** hooks in `.git/hooks/` are client-side — they run on the developer's machine and can be bypassed with `--no-verify`. Server-side hooks (`pre-receive`, `update`, `post-receive`) run on the hosting infrastructure (GitHub Actions, GitLab server hooks, Gitolite) and cannot be bypassed by the client. For policy enforcement that must be guaranteed, use server-side hooks or branch protection rules.

**`post-*` hooks for notifications:** `post-commit` and `post-merge` have their exit codes ignored, making them safe for side effects like sending Slack notifications or running `npm install` after a dependency file changes. They cannot block the operation.

### Writing a Hook: Shell Scripting Patterns

Hooks can be written in any language available in the PATH — bash, Python, Node, Ruby. Bash is most portable. A well-structured hook follows a consistent pattern:

```bash
#!/usr/bin/env bash
set -euo pipefail
# set -e: exit on any error
# set -u: treat unset variables as errors
# set -o pipefail: catch failures in pipes, not just the last command

# --- helpers ---
log_error() { echo "[hook error] $*" >&2; }
log_info()  { echo "[hook] $*"; }

# --- get staged files by type ---
# --diff-filter=ACM: Added, Copied, Modified (excludes Deleted)
# || true: prevent grep exit-1 from killing the script when no matches
STAGED_PY=$(git diff --cached --name-only --diff-filter=ACM | grep '\.py$' || true)
STAGED_JS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts)$' || true)

# --- run checks only if relevant files exist ---
if [ -n "$STAGED_PY" ]; then
    log_info "Linting Python files..."
    # Pass filenames as array to avoid word-splitting issues with spaces
    flake8 $STAGED_PY || { log_error "flake8 failed"; exit 1; }
fi

if [ -n "$STAGED_JS" ]; then
    log_info "Running ESLint..."
    npx eslint $STAGED_JS || { log_error "ESLint failed"; exit 1; }
fi

log_info "All checks passed."
exit 0
```

**`set -euo pipefail` is essential.** Without it, a failing command in the middle of a hook may be silently ignored and the hook exits 0, meaning Git proceeds as if checks passed. Always include this at the top of bash hooks.

**Quoting and word splitting:** filenames with spaces will break `flake8 $STAGED_PY` if not handled carefully. Use `read -ra` arrays or `xargs -0` with null-delimited output for production-grade hooks.

```bash
# Safer: null-delimited filenames
git diff --cached --name-only -z --diff-filter=ACM | \
  grep -z '\.py$' | \
  xargs -0 -r flake8
```

### commit-msg Hook — Enforcing Commit Conventions

Conventional Commits is a widely adopted standard in DevOps teams. It makes changelogs automatable, makes semantic versioning deterministic, and makes `git log` readable by machines and humans alike.

```
<type>(<scope>): <subject>     ← header (required)
                                ← blank line
<body>                          ← optional detail
                                ← blank line
<footer>                        ← optional: BREAKING CHANGE, closes #123
```

Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `style`, `perf`, `build`.

```bash
cat > .git/hooks/commit-msg << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

MSG_FILE="$1"
MSG=$(cat "$MSG_FILE")

# Strip comment lines (lines starting with #) before checking
CLEAN_MSG=$(grep -v '^#' "$MSG_FILE" | sed '/^$/d' | head -1)

PATTERN="^(feat|fix|docs|chore|refactor|test|ci|style|perf|build)(\(.+\))?: .{1,72}$"

if ! echo "$CLEAN_MSG" | grep -qE "$PATTERN"; then
    echo "" >&2
    echo "  ✗ Commit message does not follow Conventional Commits format." >&2
    echo "" >&2
    echo "  Required: <type>(<scope>): <subject>" >&2
    echo "  Example:  feat(api): add rate limiting to /search endpoint" >&2
    echo "  Example:  fix: handle null pointer in user service" >&2
    echo "" >&2
    echo "  Your message: $CLEAN_MSG" >&2
    echo "" >&2
    exit 1
fi
EOF
chmod +x .git/hooks/commit-msg
```

**`$1` is a file path, not the message itself.** A common mistake is treating `$1` as the string. It's the path to a temporary file Git created — use `cat "$1"` or `MSG_FILE="$1"` then read from it.

### Sharing Hooks with the Team

The single biggest operational challenge with Git hooks is distribution. A hook that exists only on one developer's machine is a policy that half the team ignores.

| Method | Best for | Committed to repo | Requires setup step |
|--------|----------|-------------------|---------------------|
| Symlinks + setup script | Any language | Hook scripts yes, symlinks no | Yes — run script after clone |
| `core.hooksPath` (Git 2.9+) | Any language, simplest | Yes | Yes — one `git config` command |
| `husky` | Node.js projects | Yes (via `package.json`) | Yes — `npm install` |
| `pre-commit` framework | Python/polyglot projects | Yes (`.pre-commit-config.yaml`) | Yes — `pre-commit install` |

#### `core.hooksPath` — Simplest Shared Approach

```bash
# In repo root, store hooks in a committed directory
mkdir -p scripts/hooks

# Tell Git to look there instead of .git/hooks/
git config core.hooksPath scripts/hooks

# Commit the hooks
git add scripts/hooks/
git commit -m "ci: add shared git hooks"
```

New team members run one command after cloning:
```bash
git config core.hooksPath scripts/hooks
```

Automate this with a Makefile target or onboarding script:
```makefile
# Makefile
.PHONY: setup
setup:
	git config core.hooksPath scripts/hooks
	@echo "Git hooks configured."
```

**`core.hooksPath` disables `.git/hooks/` entirely.** When set, Git only looks at the configured path — the default `.git/hooks/` directory is completely ignored. This is usually what you want (one authoritative location), but be aware that existing hooks in `.git/hooks/` will silently stop running.

#### husky (Node.js Projects)

husky integrates with `package.json` lifecycle scripts to auto-install hooks after `npm install`.

```bash
npm install --save-dev husky
npx husky init          # creates .husky/ directory, adds prepare script to package.json
```

```json
// package.json — husky auto-runs `npm run prepare` after install
{
  "scripts": {
    "prepare": "husky"
  },
  "devDependencies": {
    "husky": "^9.0.0"
  }
}
```

```bash
# .husky/pre-commit
npm run lint
npm run test:unit

# .husky/commit-msg
npx --no -- commitlint --edit "$1"
```

#### pre-commit Framework (Python / Polyglot)

The `pre-commit` framework manages hook dependencies as versioned, isolated environments — it downloads and runs linters without requiring them to be globally installed.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
        args: [--unsafe]          # allow custom YAML tags
      - id: check-json
      - id: detect-private-key   # blocks PEM keys, AWS keys
      - id: check-merge-conflict

  - repo: https://github.com/psf/black
    rev: 23.12.1
    hooks:
      - id: black
        language_version: python3.11

  - repo: https://github.com/pycqa/flake8
    rev: 7.0.0
    hooks:
      - id: flake8
        additional_dependencies: [flake8-bugbear]
```

```bash
pip install pre-commit
pre-commit install              # writes .git/hooks/pre-commit
pre-commit install --hook-type commit-msg  # also install commit-msg hook

# Test against all files without committing
pre-commit run --all-files

# Update hook versions to latest
pre-commit autoupdate
```

**`pre-commit` hooks auto-fix and re-stage:** some hooks (like `black`, `trailing-whitespace`) modify files and exit non-zero on the first run. Re-run the commit — the second attempt will pass because the files are now fixed. This surprises new users but is by design.

### Bypassing Hooks

```bash
git commit --no-verify -m "hotfix: emergency deploy, skipping hooks"
git push --no-verify
```

**`--no-verify` is an escape hatch, not a workflow.** If team members reach for it regularly, the hooks are too slow or too strict — fix the hooks, not the culture. Legitimate uses: emergency hotfixes, migration commits that don't match message conventions, seed data commits in new repos. Consider logging `--no-verify` usage with a `post-commit` audit hook that checks `$GIT_COMMIT_ARGS` if compliance tracking is needed.

### Hook Performance

Slow hooks destroy developer experience. A `pre-commit` hook taking 30 seconds will be bypassed daily.

| Technique | Impact |
|-----------|--------|
| Only lint staged files, not the entire project | 10× faster for large codebases |
| Run type-checkers only on changed modules | Avoids full `mypy` runs |
| Cache tool results (`pre-commit` does this automatically) | Eliminates repeated installs |
| Parallelize independent checks with `&` and `wait` | Cuts wall time |
| Move slow checks (integration tests) to `pre-push`, not `pre-commit` | Commit stays fast |

```bash
# Run linting and security checks in parallel
flake8 $STAGED_PY &
FLAKE_PID=$!

bandit -r $STAGED_PY &
BANDIT_PID=$!

wait $FLAKE_PID  || { echo "flake8 failed" >&2; exit 1; }
wait $BANDIT_PID || { echo "bandit failed" >&2; exit 1; }
```

---

## Examples

### Example 1: Full pre-commit Hook — Python Project

This hook lints, checks formatting, and blocks secrets on every commit. Designed to run in under 3 seconds on typical changesets.

```bash
#!/usr/bin/env bash
# scripts/hooks/pre-commit
set -euo pipefail

log()  { echo "  [pre-commit] $*"; }
fail() { echo "  [pre-commit] ✗ $*" >&2; exit 1; }
pass() { echo "  [pre-commit] ✓ $*"; }

# Collect staged Python files (avoid failing when none exist)
STAGED_PY=$(git diff --cached --name-only --diff-filter=ACM | grep '\.py$' || true)

# --- Secret detection (runs on all staged diffs, not just .py) ---
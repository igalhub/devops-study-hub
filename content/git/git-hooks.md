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

# Fix missing execute bit
chmod +x .git/hooks/pre-commit
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

**`post-*` hooks for side effects:** `post-commit` and `post-merge` have their exit codes ignored, making them safe for notifications or automation like running `npm install` after a dependency file changes. They cannot block the operation.

### Writing a Hook: Shell Scripting Patterns

Hooks can be written in any language available in `PATH` — bash, Python, Node, Ruby. Bash is most portable. A well-structured hook follows a consistent pattern:

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

**Quoting and word splitting:** filenames with spaces will break `flake8 $STAGED_PY` if not handled carefully. Use null-delimited output with `xargs -0` for production-grade hooks:

```bash
# Safer: null-delimited filenames handle spaces in paths correctly
git diff --cached --name-only -z --diff-filter=ACM | \
  grep -z '\.py$' | \
  xargs -0 -r flake8
# -r / --no-run-if-empty: skip flake8 entirely when no files match
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

# Strip comment lines before checking — git adds # lines when using -v
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

**`$1` is a file path, not the message string.** A common mistake is treating `$1` as the commit message directly. It is the path to a temporary file Git created — always read from it with `cat "$1"` or assign `MSG_FILE="$1"` and read from that variable.

**Subject line length:** the 72-character limit in the regex is a widely accepted convention — it keeps `git log --oneline` readable and prevents wrapping in most terminals and GitHub/GitLab UIs.

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
# Store hooks in a committed directory at repo root
mkdir -p scripts/hooks

# Tell Git to look there instead of .git/hooks/
git config core.hooksPath scripts/hooks

# Make hooks executable and commit them
chmod +x scripts/hooks/*
git add scripts/hooks/
git commit -m "ci: add shared git hooks"
```

New team members run one command after cloning:

```bash
git config core.hooksPath scripts/hooks
```

Automate this in onboarding with a Makefile target:

```makefile
# Makefile
.PHONY: setup
setup:
	git config core.hooksPath scripts/hooks
	@echo "Git hooks configured."
```

**`core.hooksPath` disables `.git/hooks/` entirely.** When set, Git only looks at the configured path. Any existing hooks in `.git/hooks/` silently stop running. This is usually the desired behavior (one authoritative location), but be aware of it when debugging.

**`core.hooksPath` is not committed in `.git/config`.** It lives in the local repo config (`.git/config`), which is not tracked. Each developer must still run the setup command — it cannot be committed and automatically applied. This is why an onboarding script or Makefile target is important.

#### husky (Node.js Projects)

husky integrates with `package.json` lifecycle scripts to auto-install hooks after `npm install`, making it zero-friction for Node.js teams.

```bash
npm install --save-dev husky
npx husky init     # creates .husky/ directory, adds prepare script to package.json
```

```json
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
# .husky/pre-commit — runs npm lint and unit tests before every commit
npm run lint
npm run test:unit

# .husky/commit-msg — validates message format using commitlint
npx --no -- commitlint --edit "$1"
```

**`prepare` runs on `npm install` automatically.** This means any developer who clones the repo and runs `npm install` gets hooks installed without any additional steps — the best onboarding experience of any sharing method.

#### pre-commit Framework (Python / Polyglot)

The `pre-commit` framework manages hook dependencies as versioned, isolated environments. It downloads and runs linters without requiring them to be globally installed — a major advantage in polyglot or onboarding-heavy teams.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
        args: [--unsafe]          # allow custom YAML tags (e.g., in Ansible)
      - id: check-json
      - id: detect-private-key   # blocks PEM keys, AWS keys, SSH keys
      - id: check-merge-conflict # catches leftover <<<<<<< markers

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
pre-commit install                          # installs pre-commit hook
pre-commit install --hook-type commit-msg  # also install commit-msg hook

# Test all hooks against every file without making a commit
pre-commit run --all-files

# Update pinned hook versions to latest tags
pre-commit autoupdate
```

**Auto-fix and re-stage behavior:** some hooks (like `black`, `trailing-whitespace`) modify files and exit non-zero on the first run. The files are fixed but not yet staged. Add the changes and commit again — the second attempt will pass. This surprises new users but is by design: the hook is telling you "I fixed it, now you confirm."

### Bypassing Hooks

```bash
git commit --no-verify -m "hotfix: emergency deploy, skipping hooks"
git push --no-verify
```

**`--no-verify` is an escape hatch, not a workflow.** If team members reach for it regularly, the hooks are too slow or too strict — fix the hooks, not the culture. Legitimate uses: emergency hotfixes, migration commits that intentionally don't match message conventions, seed data commits in fresh repos.

**Server-side hooks cannot be bypassed with `--no-verify`.** `--no-verify` only skips client-side hooks. If your team needs guaranteed policy enforcement — required ticket numbers in commit messages, branch naming conventions, signed commits — implement it as a `pre-receive` hook on the Git server or as branch protection rules in GitHub/GitLab.

### Hook Performance

Slow hooks destroy developer experience. A `pre-commit` hook taking 30 seconds will be bypassed daily.

| Technique | Impact |
|-----------|--------|
| Only lint staged files, not the entire project | 10× faster for large codebases |
| Run type-checkers only on changed modules | Avoids full `mypy` runs on every commit |
| Cache tool results (`pre-commit` framework does this automatically) | Eliminates repeated environment installs |
| Parallelize independent checks with `&` and `wait` | Cuts wall time proportionally |
| Move slow checks (integration tests, full type-check) to `pre-push` | Keeps commit fast; push is less frequent |

```bash
# Run linting and security scan in parallel; collect both exit codes
flake8 $STAGED_PY &
FLAKE_PID=$!

bandit -r $STAGED_PY &
BANDIT_PID=$!

# Wait for each job and check its exit code independently
wait $FLAKE_PID  || { echo "flake8 failed" >&2; FAILED=1; }
wait $BANDIT_PID || { echo "bandit failed" >&2; FAILED=1; }

# Exit after both finish so the developer sees all failures at once
[ "${FAILED:-0}" = "1" ] && exit 1
exit 0
```

**Parallel hooks with independent failure reporting:** the pattern above collects both failures before exiting. Without it, a failure in the first tool would kill the script before the second tool runs, and the developer would fix one issue, re-commit, and discover the second issue — two roundtrips instead of one.

---

## Examples

### Example 1: Full pre-commit Hook — Python Project

This hook lints, checks formatting, blocks secrets, and runs in under 3 seconds on typical changesets by only examining staged files.

```bash
#!/usr/bin/env bash
# scripts/hooks/pre-commit
set -euo pipefail

log()  { echo "  [pre-commit] $*"; }
fail() { echo "  [pre-commit] ✗ $*" >&2; exit 1; }
pass() { echo "  [pre-commit] ✓ $*"; }

FAILED=0

# --- Collect staged Python files (null-delimited for safety) ---
# xargs -r: don't run if stdin is empty
STAGED_PY=$(git diff --cached --name-only -z --diff-filter=ACM \
  | tr '\0' '\n' | grep '\.py$' || true)

# --- 1. Secret detection on ALL staged content, not just .py ---
log "Scanning for secrets..."
if git diff --cached | grep -qiE \
  '(password|secret|api_key|aws_secret|private_key)\s*=\s*["\x27][^"\x27]{8,}'; then
    fail "Possible secret detected in staged diff. Use environment variables or a secrets manager."
fi
pass "No secrets detected."

# --- 2. Python checks (only if .py files are staged) ---
if [ -n "$STAGED_PY" ]; then
    log "Running black (format check)..."
    echo "$STAGED_PY" | xargs black --check --quiet \
      || { echo "  Run 'black .' to fix formatting." >&2; FAILED=1; }

    log "Running flake8 (lint)..."
    echo "$STAGED_PY" | xargs flake8 --max-line-length=88 \
      || FAILED=1
fi

# --- Final result ---
[ "$FAILED" = "1" ] && fail "One or more checks failed. Fix issues and re-commit." || true
pass "All checks passed."
exit 0
```

**Setup and verification:**

```bash
# Install the hook
cp scripts/hooks/pre-commit .git/hooks/pre-commit   # or use core.hooksPath
chmod +x .git/hooks/pre-commit

# Trigger it: stage a file with a formatting issue
echo 'x=1' > bad.py
git add bad.py
git commit -m "test"
# Expected: hook blocks commit and prints black failure message

# Verify it passes with clean code
black bad.py
git add bad.py
git commit -m "test: add placeholder"
# Expected: hook passes, commit proceeds
```

---

### Example 2: commit-msg Hook — Conventional Commits with JIRA Ticket Enforcement

Many enterprise teams require both Conventional Commits format and a JIRA ticket reference. This hook validates both.

```bash
#!/usr/bin/env bash
# scripts/hooks/commit-msg
set -euo pipefail

MSG_FILE="$1"
CLEAN_MSG=$(grep -v '^#' "$MSG_FILE" | head -1)

# Pattern: conventional type + optional scope + optional JIRA ticket in footer or subject
CC_PATTERN="^(feat|fix|docs|chore|refactor|test|ci|style|perf|build)(\(.+\))?: .{1,72}$"
JIRA_PATTERN="[A-Z]{2,10}-[0-9]+"   # e.g., PROJ-123, INFRA-456

# Check Conventional Commits format
if ! echo "$CLEAN_MSG" | grep -qE "$CC_PATTERN"; then
    echo "" >&2
    echo "  ✗ Commit message format invalid." >&2
    echo "  Required: <type>(<scope>): <description>" >&2
    echo "  Your message: $CLEAN_MSG" >&2
    exit 1
fi

# Check for JIRA ticket anywhere in the full message
FULL_MSG=$(grep -v '^#' "$MSG_FILE")
if ! echo "$FULL_MSG" | grep -qE "$JIRA_PATTERN"; then
    echo "" >&2
    echo "  ✗ No JIRA ticket reference found." >&2
    echo "  Include a ticket in the subject or footer:" >&2
    echo "    feat(auth): add OAuth2 support PROJ-789" >&2
    echo "    -- or --" >&2
    echo "    Refs: PROJ-789" >&2
    echo "" >&2
    exit 1
fi

echo "  ✓ Commit message OK."
exit 0
```

**Setup and verification:**

```bash
chmod +x scripts/hooks/commit-msg
git config core.hooksPath scripts/hooks

# Should fail — no JIRA ticket
git commit -m "feat: add login page"
# Output: ✗ No JIRA ticket reference found.

# Should fail — wrong format
git commit -m "PROJ-123 add login page"
# Output: ✗ Commit message format invalid.

# Should pass
git commit -m "feat(auth): add login page PROJ-123"
# Output: ✓ Commit message OK.
```

---

### Example 3: pre-push Hook — Run Unit Tests Before Push

`pre-push` is the right place for checks that are too slow for `pre-commit` but still worth running locally before CI sees the code.

```bash
#!/usr/bin/env bash
# scripts/hooks/pre-push
set -euo pipefail

log()  { echo "  [pre-push] $*"; }
fail() { echo "  [pre-push] ✗ $*" >&2; exit 1; }

# Read what's being pushed from stdin
# Format: <local-ref> <local-sha> <remote-ref> <remote-sha>
while read local_ref local_sha remote_ref remote_sha; do
    # Skip deletion pushes (local_sha is all zeros)
    if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
        continue
    fi

    log "Running unit tests before pushing $local_ref..."
    # Run only fast unit tests — integration tests stay in CI
    if ! python -m pytest tests/unit/ -q --tb=short; then
        fail "Unit tests failed. Fix failures before pushing."
    fi
    log "✓ Unit tests passed."
done

exit 0
```

**Setup and verification:**

```bash
chmod +x scripts/hooks/pre-push
git config core.hooksPath scripts/hooks

# Verify the hook fires on push
git push origin feature/my-branch
# If tests fail: hook blocks push, shows pytest output
# If tests pass: push proceeds normally

# Emergency bypass (documented, use sparingly)
git push --no-verify origin feature/my-branch
```

---

### Example 4: post-merge Hook — Auto-install Dependencies

This hook automatically runs `npm install` when `package-lock.json` changes after a merge or pull, preventing "why is this broken" moments from stale node_modules.

```bash
#!/usr/bin/env bash
# scripts/hooks/post-merge
# Exit codes are ignored by Git for post-merge — this hook cannot block anything

CHANGED_FILES=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD)

# Check if package-lock.json was modified in the merge
if echo "$CHANGED_FILES" | grep -q "package-lock.json"; then
    echo "  [post-merge] package-lock.json changed — running npm install..."
    npm install
    echo "  [post-merge] ✓ Dependencies updated."
fi

# Also reinstall Python deps if requirements changed
if echo "$CHANGED_FILES" | grep -qE "requirements.*\.txt|pyproject\.toml"; then
    echo "  [post-merge] Python dependencies changed — running pip install..."
    pip install -q -r requirements.txt
    echo "  [post-merge] ✓ Python dependencies updated."
fi
```

**Setup and verification:**

```bash
chmod +x scripts/hooks/post-merge
git config core.hooksPath scripts/hooks

# Verify: have a teammate add a new npm package, merge their branch
git merge feature/add-axios
# Expected: hook detects package-lock.json changed, runs npm install automatically
# No manual step required
```

---

## Exercises

### Exercise 1: Write and Install a pre-commit Hook from Scratch

**Goal:** practice the full hook creation workflow without using a framework.

1. Create a new git repository: `git init hook-lab && cd hook-lab`.
2. Write a `pre-commit` hook at `scripts/hooks/pre-commit` that:
   - Uses `set -euo pipefail`.
   - Collects staged files matching `*.sh`.
   - Runs `shellcheck` on each staged shell file if any exist (install shellcheck if needed: `brew install shellcheck` or `apt install shellcheck`).
   - Exits 0 if no shell files are staged.
3. Configure `core.hooksPath` to point at `scripts/hooks`.
4. Verify the hook blocks a commit containing a shell script with a syntax error (try `if [ $foo = "bar" ]` without quoting).
5. Fix the script so shellcheck passes and confirm the commit succeeds.

**What to confirm:** `git log --oneline` shows the commit only after shellcheck passes.

---

### Exercise 2: Enforce Conventional Commits with a commit-msg Hook

**Goal:** understand how `commit-msg` receives and processes the message file.

1. In an existing repo, write a `commit-msg` hook that rejects any commit message not matching `^(feat|fix|docs|chore): .+`.
2. Test three scenarios and record the outcome:
   - `git commit -m "add new feature"` — should be rejected.
   - `git commit -m "feat: "` (empty description) — should be rejected.
   - `git commit -m "feat: add login button"` — should be accepted.
3. Extend the hook to also reject subject lines longer than 72 characters.
4. **Bonus:** add a helpful error message that shows the user exactly what their message was and what the expected format is.

**What to confirm:** each test case produces the expected outcome; the error message clearly explains the failure.

---

### Exercise 3: Share Hooks Across a Team Using `core.hooksPath`

**Goal:** simulate the full team onboarding workflow.

1. In a repo, create `scripts/hooks/pre-commit` with a hook that prints `[hook] commit check passed` and exits 0.
2. Commit the hook file to the repo.
3. Simulate a fresh clone: `git clone . /tmp/hook-lab-clone && cd /tmp/hook-lab-clone`.
4. Verify the hook does NOT fire yet (make a commit — the message will not appear).
5. Run `git config core.hooksPath scripts/hooks` in the clone.
6. Make another commit and confirm the hook output appears.
7. Write a `Makefile` with a `setup` target that runs the `git config` command, and test that `make setup` followed by a commit activates the hook.

**What to confirm:** the hook only fires after `core.hooksPath` is configured; `make setup` automates that step.

---

### Exercise 4: Optimize a Slow Hook

**Goal:** understand staged-file filtering and parallelization.

You are given this slow `pre-commit` hook that lints the entire project on every commit:

```bash
#!/usr/bin/env bash
set -euo pipefail
flake8 .
eslint .
```

1. Rewrite it to only lint staged files (use `git diff --cached --name-only --diff-filter=ACM`).
2. Skip the linter entirely if no relevant files are staged (no `.py` files → skip flake8; no `.js`/`.ts` → skip eslint).
3. Run both linters in parallel using background processes (`&`) and collect both exit codes before exiting.
4. Time both versions against a repo with 500+ files but only 2 staged files: `time git commit --allow-empty-message -m ""` (reset with `git reset HEAD~1` after each run).
5. Record the wall-clock time for each version and explain where the speedup comes from.

**What to confirm:** the rewritten hook produces measurably faster output and still correctly blocks commits when either linter fails.

---

### Quick Checks

1. Validate a commit message against the conventional commit format — the same regex a `commit-msg` hook would use.

   ```bash
   echo "feat: add login button" | grep -qE '^(feat|fix|docs|chore|refactor|test|ci): .+' && echo valid || echo invalid
   ```

   ```expected_output
   valid
   ```

hint: Think about how you can use a shell command to test whether a string matches a regular expression pattern.
hint: Use grep with the -E flag and a conventional commit regex pattern like '^(feat|fix|docs|style|refactor|test|chore)(\(.+\))?: .+' against the commit message string, checking the exit code to determine validity.

2. Count how many `.py` files are in a staged-file list — the same check a pre-commit hook uses to decide whether to run a Python linter.

   ```bash
   printf 'src/app.py\nREADME.md\ntests/test_app.py\nstyle.css\n' | grep -c '\.py$'
   ```

   ```expected_output
   2
   ```
hint: Think about how you can filter a list of filenames by extension and then count the results.
hint: Use grep '\.py$' to match only Python files from the staged list, then pipe the output to wc -l to get the total count.

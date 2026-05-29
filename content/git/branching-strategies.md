---
title: Branching Strategies
module: git
duration_min: 20
difficulty: intermediate
tags: [git, branches, gitflow, trunk-based, feature-flags, release]
exercises: 4
---

## Overview

A branching strategy is the team agreement on how work flows through git into production. At its core, it answers three questions: where does new work start, where does it land, and how does it get to users? The wrong strategy creates merge hell — long-lived branches diverge, conflicts compound, and integrating becomes a multi-day project in itself. The right strategy matches your deployment frequency, team size, and operational maturity. Two strategies dominate the industry: Gitflow, which organizes work around scheduled releases with explicit stabilization phases, and trunk-based development (TBD), which keeps everyone integrated on a single branch at all times.

The core design tension is between isolation and integration. Isolation (long-lived branches) lets developers work independently without breaking each other, but defers the pain of integration until the end, where it concentrates. Continuous integration (short-lived branches or direct commits) distributes that pain evenly — every commit is a small integration — but requires strong automated test coverage and feature flag infrastructure to keep the main branch deployable at all times. This isn't a preference debate; it's an engineering tradeoff that depends on your constraints.

In the broader DevOps toolchain, your branching strategy is the upstream input to your CI/CD pipeline. Branch names or target branches typically control which pipelines run, what environments get deployed, and whether a merge is allowed. A Gitflow `release/*` branch might trigger a staging deploy and a QA notification. A trunk-based push to `main` might trigger immediate production deployment. Getting the strategy wrong cascades downstream: flaky branch protection rules, confused pipeline triggers, and deployment bottlenecks that slow down every team touching the codebase.

---

## Concepts

### The Core Branch Types

| Branch | Purpose | Merged into | Lifetime |
|---|---|---|---|
| `main` / `master` | Production-ready code | — | Permanent |
| `develop` | Integration branch (Gitflow only) | `main` | Permanent |
| `feature/*` | New feature work | `develop` or `main` | Short (days) |
| `release/*` | Release stabilization; only bugfixes | `main` + `develop` | Temporary (days–weeks) |
| `hotfix/*` | Emergency production fix | `main` + `develop` | Temporary (hours) |
| `chore/*` / `ops/*` | Infrastructure, tooling, non-feature work | `develop` or `main` | Short |

**Key principle:** permanent branches are protected. You never push directly to `main` (or `develop` in Gitflow) — you open a pull request. Branch protection rules in GitHub/GitLab enforce this, and CI gates prevent merges when tests fail.

---

### Gitflow

Gitflow was formalized by Vincent Driessen in 2010. It assumes a world where you ship versioned releases on a schedule — mobile apps, packaged software, APIs with consumers who can't upgrade instantly. It solves the problem of "we need to ship v1.4 while v1.5 is already being developed" with explicit branch structure.

**The two permanent branches:**
- `main` — always reflects production. Every commit here is tagged with a version number.
- `develop` — the integration target for all feature work. Reflects the latest delivered development changes.

**The three temporary branch types:**
- `feature/*` — branched from `develop`, merged back to `develop`
- `release/*` — branched from `develop` when the release is feature-complete; only bugfixes go here; merged to both `main` and `develop` when done
- `hotfix/*` — branched from `main` to fix a production bug; merged to both `main` and `develop`

```
main:     ──────────────────────────────●──────────────────►
           tag: v1.3.0         tag: v1.4.0 ↑
                                           │ merge
release/1.4.0:                     ────●──►
                                  ↑ from develop
develop:  ──●──────────●──────────────────●────────────────►
              ↑ merge        ↑ merge      ↑ merge (release back)
feature/A:  ──►              
feature/B:               ────►
```

**Full Gitflow workflow:**

```bash
# ── Feature work ──────────────────────────────────────────
git checkout develop
git pull origin develop
git checkout -b feature/TICKET-123-add-monitoring

# Work, commit...
git add .
git commit -m "feat: add prometheus /metrics endpoint"
git commit -m "test: add metrics endpoint unit tests"

# Push and open a pull request targeting develop (not main)
git push origin feature/TICKET-123-add-monitoring

# After PR approval and CI pass, merge with --no-ff to preserve history
# (typically done via the PR UI, but manually:)
git checkout develop
git merge --no-ff feature/TICKET-123-add-monitoring
git branch -d feature/TICKET-123-add-monitoring
git push origin develop

# ── Cut a release ─────────────────────────────────────────
# Branch from develop when features for this release are merged
git checkout develop
git pull origin develop
git checkout -b release/1.4.0

# Only bugfixes and version bumps happen here
echo "1.4.0" > VERSION
git commit -am "chore: bump version to 1.4.0"

# When stable, merge to main AND back to develop
git checkout main
git merge --no-ff release/1.4.0
git tag -a v1.4.0 -m "Release 1.4.0"
git push origin main --tags

git checkout develop
git merge --no-ff release/1.4.0   # brings bugfixes back to develop
git push origin develop

git branch -d release/1.4.0
git push origin --delete release/1.4.0

# ── Hotfix ────────────────────────────────────────────────
# Production is broken. Branch from main (not develop).
git checkout main
git pull origin main
git checkout -b hotfix/1.4.1-fix-auth-bypass

# Fix the bug, write a regression test
git commit -am "fix: prevent auth bypass on empty token"

# Merge to main first (it's the production emergency)
git checkout main
git merge --no-ff hotfix/1.4.1-fix-auth-bypass
git tag -a v1.4.1 -m "Hotfix 1.4.1"
git push origin main --tags

# Then bring the fix to develop so it doesn't regress
git checkout develop
git merge --no-ff hotfix/1.4.1-fix-auth-bypass
git push origin develop

git branch -d hotfix/1.4.1-fix-auth-bypass
git push origin --delete hotfix/1.4.1-fix-auth-bypass
```

**Gitflow gotcha:** if a release branch is open while feature development continues on `develop`, the release branch can fall behind `develop`. Only bugfixes go on `release/*` — never cherry-pick new features onto a release branch. When you merge the release branch back to `develop`, Git handles the reconciliation. If you skip the merge-back step, the same bug will reappear in the next release.

**`--no-ff` is not optional in Gitflow.** Without it, fast-forward merges eliminate branch commits from the history. With `--no-ff`, you get a merge commit that explicitly documents "feature X was merged into develop here." This is valuable during incident retrospectives and release auditing.

---

### Trunk-Based Development (TBD)

In trunk-based development, `main` (the trunk) is the only permanent branch. All developers integrate directly to `main`, or via feature branches that live no longer than one or two days. There are no `develop` or `release` branches — instead, every commit to `main` is expected to be deployable, and incomplete features are hidden behind feature flags rather than isolated on branches.

```
main:  ──●──●──●──●──●──●──●──●──►  (always deployable, often auto-deployed)
             │              │
feature:     ●──►           ●──►    (opened and merged within 1-2 days max)
```

**Why it forces better engineering:** long-lived branches are a signal that integration is painful. TBD removes the option of avoiding integration — you must integrate daily, which means you must write modular code, maintain a fast test suite, and use feature flags. The constraint improves the codebase over time.

**Core rules:**
1. No branch lives longer than 2 days. If it does, you've taken on a large change that should be broken into smaller increments.
2. `main` is always green. Broken tests block the merge; they never justify a workaround push directly to `main`.
3. Feature flags gate unreleased work in production. Code ships before the feature is visible to users.
4. CI runs on every push. Merges are blocked until CI passes.

```bash
# Short-lived feature branch (preferred for teams > 5)
git checkout main
git pull origin main
git checkout -b feat/TICKET-456-auth-v2

# Work for one or two days, committing small increments
git add src/auth/
git commit -m "feat: add oauth2 token validation (behind flag AUTH_V2)"
git push origin feat/TICKET-456-auth-v2

# Open PR targeting main. CI runs. Review happens.
# Merge as soon as CI is green — don't let it sit.
# After merge, delete the branch immediately.
git checkout main
git pull origin main
git branch -d feat/TICKET-456-auth-v2

# For very small changes, some teams commit directly to main
git checkout main
git pull origin main
git commit -am "fix: correct typo in error message"
git push origin main   # triggers CI + deploy pipeline
```

**TBD gotcha — stale branches are a smell, not a strategy.** If a branch is 3 days old, it hasn't been integrated. Every day it isn't merged, other commits on `main` create potential conflicts. The solution isn't to "just rebase later" — it's to merge smaller slices of work daily.

**TBD gotcha — "always deployable" means tested, not just compiling.** A common failure mode is teams adopting TBD without adequate test coverage, then deploying broken code to production and blaming the strategy. TBD requires a CI suite you trust enough to auto-deploy on green. If your test suite takes 45 minutes and has flaky tests, fix that before adopting TBD.

---

### Feature Flags

Feature flags (also called feature toggles) are the mechanism that makes trunk-based development viable. They decouple code deployment from feature release — code ships to production on `main`, but the feature is inactive until deliberately enabled.

**Flag implementation spectrum:**

| Level | Mechanism | Use case |
|---|---|---|
| Simple | Environment variable or config file | Single-server apps, local dev |
| Moderate | Database-backed toggle checked at runtime | Enable per environment or per tenant |
| Full | Feature flag service (LaunchDarkly, Unleash, Flagsmith) | A/B testing, canary releases, per-user targeting |

**Simple environment variable flag:**

```bash
# In your deployment environment or .env file
ENABLE_AUTH_V2=false       # prod: feature hidden
ENABLE_AUTH_V2=true        # staging: feature active for testing
```

```python
# Python — check flag at the entry point of the new code path
import os

def authenticate(request):
    if os.getenv("ENABLE_AUTH_V2", "false").lower() == "true":
        return _authenticate_v2(request)   # new, incomplete path
    return _authenticate_v1(request)       # existing, stable path
```

```javascript
// Node.js
const AUTH_V2_ENABLED = process.env.ENABLE_AUTH_V2 === 'true';

function authenticate(req) {
  if (AUTH_V2_ENABLED) {
    return authenticateV2(req);
  }
  return authenticateV1(req);
}
```

**Flag lifecycle — flags must be removed.** Every feature flag is technical debt with an expiry date. Once a feature is fully released and stable, the flag and the old code path should be deleted. Teams that don't enforce this accumulate dozens of dead flags and orphaned code paths, making the codebase progressively harder to understand.

```bash
# Good practice: create a tracking ticket when you create a flag
# Flag:        ENABLE_AUTH_V2
# Created:     2024-01-15
# Remove by:   2024-02-15 or when AUTH_V2 fully released to all users
# Ticket:      TICKET-789-remove-auth-v2-flag
```

**Flags in CI/CD pipelines (GitHub Actions YAML):**

```yaml
# Run integration tests with the flag enabled to validate the new code path
- name: Run integration tests (auth-v2 enabled)
  env:
    ENABLE_AUTH_V2: "true"
  run: |
    pytest tests/integration/ -k "auth"

# Also run with flag disabled to confirm the old path still works
- name: Run integration tests (auth-v2 disabled)
  env:
    ENABLE_AUTH_V2: "false"
  run: |
    pytest tests/integration/ -k "auth"
```

**Flag types beyond on/off:**

| Type | Description | Example |
|---|---|---|
| Release toggle | Hide incomplete features | `ENABLE_AUTH_V2` |
| Experiment toggle | A/B test two implementations | `USE_NEW_RANKING_ALGO` |
| Ops toggle | Circuit breaker, kill switch | `DISABLE_RECOMMENDATIONS` |
| Permission toggle | Enable for specific users/roles | `BETA_FEATURE_ENABLED` |

**Ops toggles are especially valuable in DevOps.** If a new feature is causing load issues in production, an ops toggle lets you disable it instantly without a code deployment. This is significantly faster than rolling back a release.

---

### Gitflow vs. Trunk-Based: Choosing

| Dimension | Gitflow | Trunk-Based |
|---|---|---|
| Deployment frequency | Weekly / monthly releases | Multiple times per day |
| Parallel versions in prod | Supported (v1.x, v2.x) | Not designed for it |
| Team size | Any; common in enterprise | Any; natural for small CI/CD teams |
| Feature flags required | Optional | Required for incomplete work |
| Merge complexity | High — long-lived branches diverge | Low — short branches, small diffs |
| Hotfix speed | Slower — follows process | Fast — direct to main |
| CI discipline required | Moderate | High — broken main blocks everyone |
| Release audit trail | Explicit via release branches | Via tags and deployment records |

**Decision heuristic:** if your team deploys more than once a week and you have CI/CD pipelines that auto-deploy on passing tests, use trunk-based development. If you maintain multiple shipped versions, have a defined QA sign-off gate before release, or ship packaged software, use Gitflow. Don't use Gitflow "because it's more structured" if you're deploying a web service — the overhead creates drag without providing the benefits it was designed for.

**A note on GitHub Flow:** GitHub Flow is a simplified alternative that has only `main` and short-lived feature branches — no `develop`, no `release/*`. It's essentially trunk-based development with pull requests enforced. It suits teams that deploy from `main` continuously but want code review on every change. It's a good default for web services that don't need Gitflow's versioned release machinery.

```
GitHub Flow:
main:      ──●──────────────●──────────────●──►
                │            │              │
feature:        ●──●──●──PR──►    ●──●──PR──►
                  (CI)            (CI)
```

---

### Branch Naming Conventions

Naming conventions matter because branch names control CI/CD behavior. Pipeline YAML files match on patterns like `refs/heads/release/*` or `feature/**`. Inconsistent naming breaks automation silently — your release pipeline simply doesn't trigger, and no error is raised.

```bash
# Feature work — include ticket number for traceability
feature/TICKET-123-add-user-auth
feat/oauth-integration            # shorter form for TBD teams

# Bugfixes
fix/TICKET-456-login-redirect
bugfix/null-pointer-on-empty-cart

# Infrastructure / ops / tooling — no user-facing change
chore/upgrade-node-18
ops/add-prometheus-scrape-config
ci/fix-failing-integration-test

# Releases and hotfixes (Gitflow)
release/1.4.0
hotfix/1.4.1
hotfix/fix-auth-bypass

# Experiments / spikes — won't necessarily be merged
spike/evaluate-graphql-migration
experiment/rust-parser-perf
```

**Pipeline integration example (GitHub Actions):**

```yaml
on:
  push:
    branches:
      - main
      - 'release/**'      # triggers release pipeline for any release/* branch
  pull_request:
    branches:
      - main
      - develop

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make test

  deploy-staging:
    # Only run for release branches, not for every PR
    if: startsWith(github.ref, 'refs/heads/release/')
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: make deploy-staging

  deploy-production:
    # Only run on direct pushes to main (i.e., after PR merge)
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: make deploy-production
```

**Enforce naming via a CI check if your team is large.** A branch named `johns-thing` will silently skip all pipeline matching rules. A simple CI step that validates branch names against a regex prevents this:

```bash
# In CI — validate branch name on PR open
BRANCH="${GITHUB_HEAD_REF}"
if [[ ! "$BRANCH" =~ ^(feat|feature|fix|bugfix|hotfix|chore|ops|ci|release|spike|experiment)/ ]]; then
  echo "Branch name '$BRANCH' does not follow naming convention."
  echo "Expected: feat/, fix/, hotfix/, release/, chore/, etc."
  exit 1
fi
```

---

### Branch Protection Rules

Branch protection rules are the enforcement layer for your branching strategy. Without them, the strategy is a social agreement that breaks under deadline pressure — someone will push directly to `main` at 11pm during an incident and bypass every process.

**GitHub branch protection settings:**

| Rule | What it prevents |
|---|---|
| Require pull request reviews (N approvals) | Direct pushes without review; self-merges |
| Require status checks to pass | Merging with failing CI |
| Require branches to be up to date before merging | Merging stale branches that haven't tested against recent main |
| Restrict who can push to matching branches | Force-pushes or non-PR commits to `main` |
| Require signed commits | Unverified / spoofed commit authorship |
| Do not allow bypassing the above rules | Admins bypassing rules under pressure |

**Setting branch protection via GitHub CLI:**

```bash
# Require 1 approving review, require CI jobs "test" and "lint" to pass,
# and require the branch to be up to date with main before merge.
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --field required_status_checks='{"strict":true,"contexts":["test","lint"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field restrictions=null
```

**GitLab equivalent — protected branches via `.gitlab-ci.yml` + UI:**

```yaml
# In GitLab, pipeline rules control what runs on protected branches
workflow:
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: always
    - if: '$CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"'
      when: always
    - when: never
```

**`enforce_admins: true` is critical.** If admins can bypass branch protection, it will happen. The value of protection rules comes from consistent enforcement, not from having them configured 95% of the time.

---

## Examples

### Example 1: Setting Up a New Repo with Trunk-Based Development

This walks through initializing a repo, configuring branch protection, and running the first feature branch workflow end-to-end.

```bash
# 1. Initialize the repo and push initial commit
mkdir myservice && cd myservice
git init
echo "# myservice" > README.md
git add README.md
git commit -m "chore: initial commit"
git remote add origin git@github.com:org/myservice.git
git push -u origin main

# 2. Protect main via GitHub CLI (requires gh auth login)
gh api repos/org/myservice/branches/main/protection \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --field required_status_checks='{"strict":true,"contexts":["test"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field restrictions=null

# 3. Create a feature branch, do work, open a PR
git checkout -b feat/TICKET-001-add-health-endpoint

# Create the feature
cat > health.py << 'EOF'
from flask import Flask, jsonify
app = Flask(__name__)

ENABLE_HEALTH_V2 = os.getenv("ENABLE_HEALTH_V2", "false").lower() == "true"

@app.route("/health")
def health():
    if ENABLE_HEALTH_V2:
        return jsonify({"status": "ok", "version": "2", "checks": {}})
    return jsonify({"status": "ok"})
EOF

git add health.py
git commit -m "feat: add /health endpoint (v2 behind flag ENABLE_HEALTH_V2)"
git push origin feat/TICKET-001-add-health-endpoint

# 4. Open PR — CI runs automatically via branch protection
gh pr create --title "feat: add /health endpoint" \
  --body "Adds a /health check. V2 response format hidden behind ENABLE_HEALTH_V2 flag." \
  --base main

# 5. After approval and CI green, merge and clean up
gh pr merge --squash --delete-branch

# 6. Verify main is up to date and the branch is gone
git checkout main
git pull origin main
git branch -a | grep TICKET-001   # should return nothing
```

**Verify it worked:**
- `gh pr list` shows no open PRs for this feature
- `git log --oneline -5` on `main` shows the squash commit
- The branch no longer appears in `git branch -r`

---

### Example 2: Gitflow Release and Hotfix Cycle

Simulates cutting a release while a hotfix is needed in parallel.

```bash
# Precondition: repo has main and develop branches
git checkout -b develop
git push origin develop

# ── Feature lands on develop ──────────────────────────────
git checkout -b feature/TICKET-200-new-checkout develop
# ... development work ...
git commit -am "feat: redesign checkout flow"
git checkout develop
git merge --no-ff feature/TICKET-200-new-checkout -m "Merge feature/TICKET-200-new-checkout into develop"
git branch -d feature/TICKET-200-new-checkout
git push origin develop

# ── Cut the release branch ────────────────────────────────
git checkout -b release/2.0.0 develop

# Bump version and update changelog
echo "2.0.0" > VERSION
cat > CHANGELOG.md << 'EOF'
## 2.0.0 (2024-03-01)
- Redesigned checkout flow
EOF
git commit -am "chore: bump version to 2.0.0, update changelog"
git push origin release/2.0.0

# QA finds a bug on the release branch — fix it here only
git commit -am "fix: correct tax calculation on release branch"
git push origin release/2.0.0

# ── Hotfix on production (v1.9.x) fires while release is open ──
git checkout main
git pull origin main
git checkout -b hotfix/1.9.1-fix-payment-timeout

git commit -am "fix: increase payment gateway timeout to 30s"

git checkout main
git merge --no-ff hotfix/1.9.1-fix-payment-timeout -m "Hotfix: payment timeout"
git tag -a v1.9.1 -m "Hotfix 1.9.1 — payment timeout"
git push origin main --tags

# Bring hotfix to develop AND to the open release branch
git checkout develop
git merge --no-ff hotfix/1.9.1-fix-payment-timeout
git push origin develop

git checkout release/2.0.0
git merge --no-ff hotfix/1.9.1-fix-payment-timeout
git push origin release/2.0.0

git branch -d hotfix/1.9.1-fix-payment-timeout
git push origin --delete hotfix/1.9.1-fix-payment-timeout

# ── Finalize the release ──────────────────────────────────
git checkout main
git merge --no-ff release/2.0.0 -m "Release 2.0.0"
git tag -a v2.0.0 -m "Release 2.0.0"
git push origin main --tags

git checkout develop
git merge --no-ff release/2.0.0   # ensures release bugfixes reach develop
git push origin develop

git branch -d release/2.0.0
git push origin --delete release/2.0.0
```

**Verify it worked:**
```bash
git log --oneline --graph main | head -20
git tag --list "v*" --sort=-version:refname | head -5
# Should show v2.0.0, v1.9.1 — both on main
git log --oneline develop | grep "payment timeout"
# Should appear — hotfix was merged back to develop
```

---

### Example 3: Feature Flag with Per-Environment Control in CI/CD

Shows how a single codebase uses flags to behave differently across environments without branching.

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install deps
        run: pip install -r requirements.txt
      - name: Test with flag OFF (default prod behavior)
        env:
          ENABLE_NEW_PRICING: "false"
        run: pytest tests/
      - name: Test with flag ON (validates new code path)
        env:
          ENABLE_NEW_PRICING: "true"
        run: pytest tests/

  deploy-staging:
    needs: test
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging with flag enabled
        env:
          ENABLE_NEW_PRICING: "true"   # staging sees the new feature
          DEPLOY_ENV: staging
        run: ./scripts/deploy.sh

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production with flag disabled
        env:
          ENABLE_NEW_PRICING: "false"  # prod users don't see it yet
          DEPLOY_ENV: production
        run: ./scripts/deploy.sh
```

```python
# pricing.py — the flag check in application code
import os

ENABLE_NEW_PRICING = os.getenv("ENABLE_NEW_PRICING", "false").lower() == "true"

def calculate_price(item, user):
    if ENABLE_NEW_PRICING:
        return _new_pricing_engine(item, user)
    return _legacy_pricing(item, user)
```

**Verify it worked:**
- In staging, call the pricing API — response should use new pricing logic.
- In production, same call — response uses legacy logic.
- No code difference between environments; only environment variable differs.
- When the new pricing is validated in staging, flip `ENABLE_NEW_PRICING=true` in the production environment secrets and redeploy — no code change required.

---

### Example 4: Enforcing Branch Naming in a CI Pipeline

Prevents branches with non-standard names from opening PRs against `main`.

```yaml
# .github/workflows/branch-lint.yml
name: Branch Name Check

on:
  pull_request:
    branches: [main, develop]

jobs:
  check-branch-name:
    runs-on: ubuntu-latest
    steps:
      - name: Validate branch name
        run: |
          BRANCH="${{ github.head_ref }}"
          echo "Branch: $BRANCH"

          # Allow: feat/, feature/, fix/, bugfix/, hotfix/,
          #        chore/, ops/, ci/, release/, spike/, experiment/
          PATTERN="^(feat|feature|fix|bugfix|hotfix|chore|ops|ci|release|spike|experiment)/.+"

          if [[ ! "$BRANCH" =~ $PATTERN ]]; then
            echo "❌ Branch name '$BRANCH' does not follow naming conventions."
            echo "Valid prefixes: feat/, fix/, hotfix/, release/, chore/, ops/, ci/, spike/"
            echo "Example: feat/TICKET-123-add-login"
            exit 1
          fi

          echo "✅ Branch name '$BRANCH' is valid."
```

**Verify it worked:**
- Open a PR from a branch named `johns-thing` — the `check-branch-name` job fails, blocking merge.
- Open a PR from `feat/TICKET-999-new-thing` — job passes.
- Branch protection requires this status check to pass, so the naming rule is machine-enforced.

---

## Exercises

### Exercise 1: Simulate a Gitflow Release Cycle

Initialize a local git repo (no remote required). Create `main` and `develop` branches. Create two feature branches off `develop`, merge them both with `--no-ff`, then cut a `release/1.0.0` branch, make one bugfix commit on it, and merge it into both `main` and `develop`. Tag `main` as `v1.0.0`.

After completing this, run `git log --oneline --graph --all` and verify you can identify: the two feature merge commits on `develop`, the release branch merge commit on `main`, and the `v1.0.0` tag. Explain in one sentence why `--no-ff` was important for making this graph readable.

---

### Exercise 2: Introduce and Then Remove a Feature Flag

In a small Python or Node.js project (or a script you write from scratch), implement a feature flag called `ENABLE_DARK_MODE` controlled by an environment variable. Write two tests: one that asserts the old behavior when the flag is `false`, and one that asserts the new behavior when the flag is `true`. Both tests must pass.

Then, simulate releasing the feature: remove the flag entirely, keep only the new code path, and update the tests to no longer reference the flag. Commit the removal as `chore: remove ENABLE_DARK_MODE flag (fully released)`. The goal is to practice the full flag lifecycle, not just the addition.

---

### Exercise 3: Write a GitHub Actions Workflow That Branches on Target Branch

Write a GitHub Actions workflow file (you can validate it locally with [`act`](https://github.com/nektos/act) or push to a test repo) that does the following:
- On any push to `main`: run tests AND trigger a deployment step that prints `Deploying to production`
- On any push to a `release/**` branch: run tests AND print `Deploying to staging`
- On any other push: run tests only

Use `if:` conditionals on jobs, not separate workflow files. Verify by checking that the conditional logic correctly selects jobs by inspecting `github.ref` in the conditions.

---

### Exercise 4: Resolve a Simulated Merge Conflict from a Stale Branch

Create a repo with a `main` branch containing a file `config.py` with a `TIMEOUT = 30` line. Create a feature branch `feat/increase-timeout` and change the value to `TIMEOUT = 60`. Without merging the feature branch, go back to `main` and change `TIMEOUT = 45` in a separate commit. Now attempt to merge `feat/increase-timeout` into `main`.

Resolve the conflict deliberately — choose `60` as the final value and explain in the commit message why. Then reflect: in a trunk-based workflow, how would you have avoided this conflict? What is the maximum branch age that would have made this a non-issue?

---

### Quick Checks

1. Initialize a repo with `main` as the default branch and confirm the starting branch name.

   ```bash
   d=$(mktemp -d)
   cd "$d"
   git init --initial-branch=main -q
   git symbolic-ref --short HEAD
   ```

   ```expected_output
   main
   ```

hint: Think about how git init allows you to specify the default branch name at the time of initialization.
hint: Use git init with the -b flag followed by your desired branch name, then run git branch to verify.

2. Validate a Gitflow-style branch name against the team's naming convention.

   ```bash
   echo "feat/PROJ-42-user-auth" | grep -qE '^(feat|feature|fix|hotfix|release|chore|ci)/.+' && echo valid || echo invalid
   ```

   ```expected_output
   valid
   ```
hint: Think about how you can use pattern matching to check whether a branch name conforms to a specific naming structure.
hint: Use a regular expression with grep or a bash conditional like [[ "$branch" =~ ^(feature|release|hotfix|bugfix)\/[a-z0-9._-]+$ ]] to test the branch name format.

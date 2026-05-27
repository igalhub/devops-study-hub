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
# Update version file, changelog, etc.
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

**Why it forces better engineering:** long-lived branches are a signal that integration is painful. TBD removes the option of avoiding integration — you must integrate daily, which means you must write modular code, maintain a fast test suite, and use feature flags. The constraint improves the codebase.

**Core rules:**
1. No branch lives longer than 2 days. If it does, you've taken on a large change that should be broken into smaller increments.
2. `main` is always green. Broken tests block the merge; they never block a workaround push.
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
# Make the change
git commit -am "fix: correct typo in error message"
git push origin main   # triggers CI + deploy pipeline
```

**TBD gotcha — stale branches are a smell, not a strategy.** If a branch is 3 days old, it hasn't been integrated. Every day it isn't merged, other commits on `main` create potential conflicts. The solution isn't to "just rebase later" — it's to merge smaller slices of work daily.

**TBD gotcha — "always deployable" means tested, not just compiling.** A common failure mode is teams adopting TBD without adequate test coverage, then deploying broken code to production and blaming the strategy. TBD requires a CI suite you trust enough to auto-deploy on green.

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
# Python example — check flag at the entry point of the new code path
import os

def authenticate(request):
    if os.getenv("ENABLE_AUTH_V2", "false").lower() == "true":
        return _authenticate_v2(request)   # new, incomplete path
    return _authenticate_v1(request)       # existing, stable path
```

```javascript
// Node.js example
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
# Good practice: create a ticket when you create a flag
# Flag: ENABLE_AUTH_V2
# Created: 2024-01-15
# Remove after: 2024-02-15 or when AUTH_V2 fully released
# Ticket: TICKET-789-remove-auth-v2-flag
```

**Flags in CI/CD pipelines (YAML example):**

```yaml
# GitHub Actions — run integration tests with the flag enabled
- name: Run integration tests (auth-v2 enabled)
  env:
    ENABLE_AUTH_V2: "true"
  run: |
    pytest tests/integration/ -k "auth"
```

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

---

### Branch Naming Conventions

Naming conventions matter because branch names control CI/CD behavior. Pipeline YAML files match on patterns like `refs/heads/release/*` or `feature/**`. Inconsistent naming breaks automation.

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
hotfix/1.4.1                      # or hotfix/fix-auth-bypass

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
      - 'release/**'      # triggers release pipeline
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
    if: startsWith(github.ref, 'refs/heads/release/')
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: make deploy-staging
```

---

### Branch Protection Rules

Branch protection rules are the enforcement layer for your branching strategy. Without them, the strategy is a social agreement that breaks under deadline pressure.

**GitHub branch protection (set via UI or API):**

| Rule | What it prevents |
|---|---|
| Require pull request reviews | Direct pushes without review |
| Require status checks to pass | Merging with failing CI |
| Require branches to be up to date | Merging stale branches that haven't tested against recent main |
| Restrict pushes to matching branches | Force-pushing or non-PR commits to `main` |
| Require signed commits | Unverified commit authorship |

**Setting branch protection via GitHub CLI:**

```bash
# Protect main: require 1 review, require CI to pass
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["test","lint"]}' \
  --field enforce_
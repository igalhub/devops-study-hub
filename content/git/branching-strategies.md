---
title: Branching Strategies
module: git
duration_min: 20
difficulty: intermediate
tags: [git, branches, gitflow, trunk-based, feature-flags, release]
exercises: 4
---

## Overview
A branching strategy is the team agreement on how work flows through git into production. The wrong strategy creates merge hell; the right one matches your deployment frequency and team size. This lesson covers the two dominant strategies (Gitflow and trunk-based development), when to use each, and the concrete git operations that support them.

## Concepts

### The Core Branch Types

| Branch | Purpose | Merged into | Lifetime |
|---|---|---|---|
| `main` / `master` | Production-ready code | — | Permanent |
| `develop` | Integration branch (Gitflow) | `main` | Permanent |
| `feature/*` | New feature work | `develop` or `main` | Short |
| `release/*` | Release stabilization | `main` + `develop` | Temporary |
| `hotfix/*` | Emergency production fix | `main` + `develop` | Temporary |

### Gitflow
Gitflow has two permanent branches (`main` and `develop`) and three temporary branch types:

```
main:     ──────────────────────────────────────►
           ↑ merge                ↑ merge
develop:  ──────────────────────────────────────►
           ↑ merge      ↑ merge
feature:  ─────►        ──────►
```

**When to use:** teams with scheduled releases, multiple versions in production simultaneously, or strict QA gates before shipping.

**Workflow:**
```bash
# Start a feature
git checkout develop
git checkout -b feature/add-monitoring

# Work, commit...
git commit -m "feat: add prometheus metrics endpoint"

# Merge feature into develop (via PR)
git checkout develop
git merge --no-ff feature/add-monitoring
git branch -d feature/add-monitoring

# Cut a release
git checkout -b release/1.4.0 develop
# Bugfixes on release branch only...
git checkout main
git merge --no-ff release/1.4.0
git tag -a v1.4.0 -m "Release 1.4.0"
git checkout develop
git merge --no-ff release/1.4.0
git branch -d release/1.4.0

# Hotfix
git checkout -b hotfix/fix-critical-bug main
# Fix...
git checkout main
git merge --no-ff hotfix/fix-critical-bug
git tag -a v1.4.1 -m "Hotfix 1.4.1"
git checkout develop
git merge --no-ff hotfix/fix-critical-bug
```

### Trunk-Based Development (TBD)
Everyone commits to `main` (or short-lived feature branches merging to `main` within 1-2 days). No `develop` branch. Feature flags gate unreleased work.

```
main:  ──●──●──●──●──●──●──●──►  (always deployable)
          │        │
feature:  ●──►     ●──►          (merged within 1-2 days)
```

**When to use:** teams practicing continuous delivery, deploying multiple times per day, with good test coverage and feature flag infrastructure.

**Key rules:**
- Branches live < 2 days
- `main` is always deployable
- Feature flags hide incomplete work
- CI runs on every commit; you don't merge if CI fails

```bash
# Short-lived feature branch
git checkout -b feat/auth-v2
# Work for a day or two...
git push origin feat/auth-v2
# Open PR → CI passes → merge
git checkout main
git pull
```

### Which to Choose
| | Gitflow | Trunk-Based |
|---|---|---|
| Deployment freq | Weekly/monthly releases | Multiple times/day |
| Team size | Any | Works best > 5 devs with CI |
| Feature flags | Optional | Required |
| Merge complexity | High (long-lived branches) | Low (short branches) |
| Hotfix speed | Slower (process overhead) | Fast (direct to main) |

### Branch Naming Conventions
```bash
# Feature work
feature/TICKET-123-add-user-auth
feat/oauth-integration

# Bugfixes
fix/TICKET-456-login-redirect
bugfix/null-pointer-on-empty-cart

# Infrastructure / ops
chore/upgrade-node-18
ops/add-prometheus-scrape

# Releases (Gitflow)
release/1.4.0
hotfix/1.4.1
```

### Useful Branch Commands
```bash
# List all branches (local + remote)
git branch -a

# List branches with last commit info
git branch -v
git branch -vv   # also shows tracking branch

# Delete merged branches
git branch -d feature/done   # safe — fails if unmerged
git branch -D feature/wip    # force delete

# Delete remote branch
git push origin --delete feature/old-branch

# See which branches are merged into current
git branch --merged
git branch --no-merged

# Track a remote branch
git checkout -b local-name origin/remote-name
# Or shorthand:
git checkout --track origin/remote-name
```

## Examples

### Automated Stale Branch Cleanup
```bash
#!/usr/bin/env bash
# Delete remote branches merged into main and older than 30 days
git fetch --prune

git branch -r --merged origin/main \
    | grep -v "origin/main" \
    | grep -v "origin/develop" \
    | while read -r branch; do
        DATE=$(git log -1 --format="%ci" "$branch")
        AGE_DAYS=$(( ($(date +%s) - $(date -d "$DATE" +%s)) / 86400 ))
        if [ "$AGE_DAYS" -gt 30 ]; then
            SHORT="${branch#origin/}"
            echo "Deleting $SHORT (${AGE_DAYS}d old)"
            git push origin --delete "$SHORT"
        fi
    done
```

### Check If Branch Is Behind Main
```bash
BEHIND=$(git rev-list HEAD..origin/main --count)
if [ "$BEHIND" -gt 0 ]; then
    echo "Branch is $BEHIND commits behind main — rebase before merging"
    exit 1
fi
```

## Exercises

1. Create a local git repo, set up a `main` and `develop` branch, simulate the Gitflow feature workflow: create a feature branch, make 2 commits, merge it into develop with `--no-ff`, and tag a release on main.
2. Create 5 branches with different names, make one commit on each, then merge 3 of them into main. Run `git branch --merged` and `git branch --no-merged` to verify the output, then delete the merged branches.
3. Write a bash script that lists all local branches, their last commit date, and whether they've been merged into main — sorted by date ascending.
4. Research feature flags: describe in writing (in your script as comments) how you would use an environment variable as a simple feature flag to hide an incomplete feature on the `main` branch while continuing to develop it.

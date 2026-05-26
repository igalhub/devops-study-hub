---
title: Rebase vs Merge
module: git
duration_min: 15
difficulty: intermediate
tags: [git, rebase, merge, history, squash, interactive-rebase]
exercises: 4
---

## Overview
Merge and rebase both integrate changes from one branch into another — but they produce different histories. Merge preserves context (who branched, when, what the parallel work was). Rebase produces a clean linear history at the cost of rewriting commits. The choice affects how readable your git log is, how easy bisect and blame are to use, and what happens when things go wrong.

## Concepts

### Merge
`git merge` creates a new *merge commit* that ties two branches together. The original commits are preserved exactly as they were.

```
Before:
main:    A ── B ── C
feature:      └── D ── E

After git merge feature:
main:    A ── B ── C ── M
                    └── D ── E ──┘
                (M is the merge commit)
```

```bash
git checkout main
git merge feature/add-auth          # fast-forward if possible
git merge --no-ff feature/add-auth  # always create a merge commit (preserves branch context)
git merge --squash feature/add-auth # stage all changes but don't commit (you write the commit)
```

**Fast-forward merge:** if main hasn't diverged from the branch, git just moves the pointer forward — no merge commit created. Use `--no-ff` to prevent this and always record that a branch existed.

### Rebase
`git rebase` replays your commits on top of another branch. The commits get new SHAs — they look identical in content but are technically new commits.

```
Before:
main:    A ── B ── C
feature:      └── D ── E

After git rebase main (from feature branch):
main:    A ── B ── C
feature:           └── D' ── E'
(D' and E' are new commits with same changes, new SHAs)
```

```bash
# From the feature branch:
git fetch origin
git rebase origin/main      # replay feature commits on top of latest main

# Resolve conflicts during rebase:
# ... fix conflict in file ...
git add conflicted-file.txt
git rebase --continue

# Abort if rebase goes wrong
git rebase --abort
```

### Interactive Rebase — Rewrite History
`git rebase -i` is the most powerful history-editing tool:

```bash
git rebase -i HEAD~4    # edit last 4 commits
git rebase -i origin/main   # edit all commits not in main
```

Opens an editor with each commit on a line:
```
pick a1b2c3 feat: add login endpoint
pick d4e5f6 WIP: forgot error handling
pick g7h8i9 fix: add error handling
pick j0k1l2 fix typo in comment
```

Change commands to:
```
pick a1b2c3 feat: add login endpoint
squash d4e5f6 WIP: forgot error handling  ← squashed into previous
squash g7h8i9 fix: add error handling      ← squashed into previous
drop j0k1l2 fix typo in comment            ← removed entirely

# Commands:
# pick   = use commit as-is
# squash = meld into previous commit (combines messages)
# fixup  = meld into previous commit (discards message)
# reword = use commit, but edit the message
# drop   = remove commit
# edit   = pause rebase to amend this commit
```

**Common use:** clean up "WIP", "fix typo", "oops" commits before opening a PR. Squash into logical units.

### The Golden Rule
**Never rebase commits that have been pushed to a shared branch.**

When you rebase, commits get new SHAs. If someone else has based work on your original commits, their history diverges — they'll have to force-push or deal with messy conflicts. Safe to rebase:
- Local commits not yet pushed
- Commits on your own feature branch (if you're the only one working on it)
- Commits on `origin/feature/your-branch` before opening a PR (you can force-push your own branch)

Never rebase `main`, `develop`, or any branch others are actively using.

### Squash on Merge
Many teams use "squash and merge" in their PR workflow — all commits from the PR become one commit on main. This gives a clean main branch while letting developers commit freely during development.

```bash
# Squash locally before merging:
git checkout main
git merge --squash feature/add-auth
git commit -m "feat: add auth module (closes #42)"
git branch -d feature/add-auth
```

### When to Use Each

| Scenario | Use |
|---|---|
| Updating a feature branch with latest main | `rebase` (linear history) |
| Merging a PR into main on GitHub/GitLab | Depends on team policy |
| Cleaning up messy local commits | `rebase -i` |
| Merging a hotfix | `merge --no-ff` (preserve context) |
| Merging a long-lived branch | `merge` (preserve the parallel history) |
| Keeping main history clean and linear | `squash and merge` |

## Examples

### Update Feature Branch with Latest Main
```bash
# The safe, clean way
git checkout feature/add-auth
git fetch origin
git rebase origin/main

# If you already pushed this branch and need to update remote:
git push --force-with-lease origin feature/add-auth
# --force-with-lease is safer than --force: fails if someone else pushed
```

### Clean Up Before PR
```bash
# You have 5 messy commits. Squash to 2 logical commits before review.
git log --oneline HEAD~5
# a1b2c3 oops, forgot to handle empty input
# d4e5f6 fix the fix
# g7h8i9 WIP saving progress
# j0k1l2 feat: input validation
# m5n6o7 feat: add config parser

git rebase -i HEAD~5
# In editor: squash/fixup the WIP and oops commits into their parent features
```

## Exercises

1. Create a repo with a `main` branch, create a `feature` branch from an early commit, add 2 commits to `main` and 2 to `feature`, then: (a) merge feature into main, observe the graph with `git log --oneline --graph`; (b) reset and try rebase instead — compare the resulting graphs.
2. Create 4 "messy" commits (including "WIP", "fix typo", "oops"), then use `git rebase -i` to squash them into one clean commit with a proper message.
3. Simulate the "golden rule" violation: push a feature branch, rebase it, try to push again. What error do you get? What does `--force-with-lease` do differently from `--force`?
4. Set up a scenario where a merge conflict occurs during `git rebase`. Resolve it, continue the rebase, and verify the final result with `git log --oneline`.

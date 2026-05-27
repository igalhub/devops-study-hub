---
title: Rebase vs Merge
module: git
duration_min: 15
difficulty: intermediate
tags: [git, rebase, merge, history, squash, interactive-rebase]
exercises: 4
---

## Overview

Merge and rebase both integrate changes from one branch into another, but they produce fundamentally different histories and carry different tradeoffs. `git merge` preserves the full truth of what happened: when branches diverged, who worked in parallel, and when the work was brought together. `git rebase` rewrites history to look as if development happened linearly, producing a cleaner log at the cost of replacing original commits with new ones. The choice between them is not just aesthetic — it affects how readable your `git log` is, how useful `git bisect` and `git blame` are when debugging, and how much pain colleagues experience when your commits land on a shared branch.

In a DevOps context, understanding this distinction is operationally important. CI/CD pipelines, automated changelogs, and release tooling all read commit history. A `main` branch full of merge commits from dozens of short-lived feature branches is harder to `bisect` than a linear history. Conversely, a team that rebases carelessly on shared branches can corrupt colleagues' working trees and break pipelines mid-flight. Most teams settle on a hybrid: free-form commits during development, squash or rebase on merge, strict no-rebase rules for long-lived shared branches.

Both strategies fit into the broader Git workflow regardless of whether you use GitHub Flow, GitLab Flow, or trunk-based development. Merge is the default and the safest; rebase is the power tool. Knowing when each is appropriate — and what the failure modes look like — is a baseline expectation for a DevOps engineer who touches release pipelines, reviews PRs, or maintains shared infrastructure repositories.

---

## Concepts

### How Merge Works

`git merge` joins two branch tips by creating a new **merge commit** that has two parents. The original commits on both branches are left entirely intact — their SHAs, timestamps, and messages do not change.

```
Before:
main:    A ── B ── C
feature:      └── D ── E

After: git checkout main && git merge feature
main:    A ── B ── C ── M
                   └────┘
              (M has parents C and E)
```

```bash
git checkout main
git merge feature/add-auth           # fast-forward if no divergence, else merge commit
git merge --no-ff feature/add-auth   # always create a merge commit
git merge --squash feature/add-auth  # collapse feature into staged changes; you write the commit
git merge --abort                    # bail out during a conflicted merge
```

**Fast-forward merge:** if `main` has not diverged from the branch tip, Git simply moves the `main` pointer forward — no merge commit is created, and the history looks linear. This loses the information that a branch existed at all. Use `--no-ff` when branch context matters (e.g., a hotfix or a release branch).

**`--squash` is not a merge:** `git merge --squash` stages all the changes from the feature branch as a single diff but does not create a merge commit or any branch relationship. You must `git commit` manually. The feature branch is not recorded as merged — `git branch --merged` will not show it.

| Flag | Merge commit created | Branch history visible | Use case |
|------|---------------------|----------------------|----------|
| (none) | Only if diverged | Yes | Default — preserve context |
| `--no-ff` | Always | Yes | Hotfixes, release branches |
| `--squash` | No (you commit manually) | No | Clean main, PR workflow |
| `--ff-only` | Never (fails if not possible) | No | Enforce linear, abort otherwise |

### How Rebase Works

`git rebase` takes the commits on your current branch that are not in the target branch, and **replays** them one by one on top of the target. Each replayed commit gets a new SHA — it has the same diff and message as the original, but a different parent, so it is technically a new object.

```
Before:
main:    A ── B ── C
feature:      └── D ── E

After: git checkout feature && git rebase main
main:    A ── B ── C
feature:           └── D' ── E'
(D' and E' are new commits — same diffs, new SHAs)
```

```bash
git checkout feature/add-auth
git fetch origin
git rebase origin/main          # replay feature commits on top of latest main

# During rebase, if a conflict occurs:
# 1. Git stops and marks the conflict
# 2. Fix the conflict in the file
git add path/to/conflicted-file
git rebase --continue           # move to the next commit

git rebase --skip               # discard this commit's changes and continue
git rebase --abort              # restore original branch state, cancel entirely
```

**Rebase replays commits one at a time.** If your branch has five commits and the first one conflicts with `main`, you fix it, continue, and might hit another conflict in the second commit. Each commit is applied independently — you may need to resolve conflicts multiple times during a single rebase.

**`git rebase` does not touch `main`.** It only moves your current branch. After rebasing, you still need to `git checkout main && git merge feature` (which will now be a fast-forward).

### Interactive Rebase — Rewriting History

`git rebase -i` (interactive rebase) opens an editor listing every commit to be replayed. You can reorder, edit, squash, or delete commits before they land anywhere permanent. This is the standard tool for cleaning up messy development history before opening a PR.

```bash
git rebase -i HEAD~4          # edit the last 4 commits on current branch
git rebase -i origin/main     # edit all commits not yet in origin/main
```

The editor opens with a file like this:

```
pick a1b2c3 feat: add login endpoint
pick d4e5f6 WIP: forgot error handling
pick g7h8i9 fix: add error handling
pick j0k1l2 fix typo in comment
```

Modify the commands to reshape history:

```
pick   a1b2c3 feat: add login endpoint
squash d4e5f6 WIP: forgot error handling   # folds into a1b2c3, merges commit messages
fixup  g7h8i9 fix: add error handling      # folds into a1b2c3, discards this message
drop   j0k1l2 fix typo in comment          # removes commit entirely
```

**Full command reference:**

| Command | Effect |
|---------|--------|
| `pick` | Use commit as-is |
| `reword` | Use commit, but open editor to change message |
| `edit` | Pause rebase here; lets you `git commit --amend` or split the commit |
| `squash` | Fold into previous commit; opens editor to combine messages |
| `fixup` | Fold into previous commit; silently discard this message |
| `drop` | Remove the commit entirely |
| `exec` | Run a shell command after this commit (useful for CI checks mid-rebase) |

**`squash` vs `fixup`:** use `squash` when the folded commit message contains useful detail to keep. Use `fixup` for "WIP", "oops", "typo" commits where the message adds no value.

**Order matters:** commits are listed oldest-first. Reordering lines reorders the commits. If two commits touch the same lines in opposite order, reordering them will cause a conflict.

### The Golden Rule of Rebase

**Never rebase commits that have already been pushed to a branch shared with other people.**

When you rebase, original commits are abandoned and replaced with new commits that have different SHAs. Anyone who pulled the original commits now has a diverged history. They cannot fast-forward — they must force-merge or reset. In a CI/CD environment this is worse: pipelines triggered against the original SHAs may still be running or reporting status against commits that no longer exist on the branch.

```
# You pushed D and E to origin/feature
# A colleague pulled and based work on E
# You rebase and force-push D' and E'
# Colleague now has:
#   origin/feature: ... C ── D' ── E'
#   local:          ... C ── D  ── E  ── F  (their commit)
# Git sees D and E as unrelated to D' and E' — total divergence
```

**Safe to rebase:**

- Local commits not yet pushed anywhere
- Your own feature branch before anyone else has pulled it
- A feature branch you own before opening a PR (force-push is acceptable here with team agreement)

**Never rebase:**

- `main`, `master`, `develop`, or any integration branch
- Any branch that is a merge target for CI
- Any branch another engineer has told you they're based on

**`--force-with-lease` vs `--force`:** if you have rebased your own feature branch and need to update the remote, always prefer `--force-with-lease`. It checks that the remote tip matches what you last fetched — it will refuse to push if someone else has pushed to that branch since your last fetch. Plain `--force` overwrites unconditionally.

```bash
git push --force-with-lease origin feature/add-auth  # safe force-push
git push --force origin feature/add-auth             # dangerous: overwrites unknown changes
```

### Squash on Merge

Many teams configure their Git host (GitHub, GitLab, Bitbucket) to **squash and merge** PRs. Every PR becomes exactly one commit on `main`, regardless of how many commits the developer made. This gives a clean, navigable main branch while allowing developers to commit freely during development.

```bash
# GitHub "Squash and merge" button is equivalent to:
git checkout main
git merge --squash feature/add-auth
git commit -m "feat: add auth module (#42)"   # write a clean, final message
git push origin main
git branch -d feature/add-auth               # optionally delete local branch
git push origin --delete feature/add-auth    # delete remote branch
```

**The tradeoff:** squash commits lose granular attribution. `git blame` on a line shows the squash commit, not the individual commit where that line was introduced. For small features this is fine. For large refactors spanning thousands of lines, the loss of granularity can make debugging harder.

**Squash and merge is irreversible from the remote perspective.** The individual commits still exist locally until garbage collected, but they are no longer reachable from any ref on the remote. If the developer deletes their local branch, those commits are gone.

### Merge Conflicts: Merge vs Rebase

Both merge and rebase can produce conflicts, but they present differently.

| Aspect | Merge conflict | Rebase conflict |
|--------|---------------|-----------------|
| When it occurs | Once, during the merge | Once per conflicting commit being replayed |
| Conflict markers | Between your branch tip and the merge base | Between the commit being replayed and the current HEAD |
| Resolution | `git add` + `git merge --continue` (or just `git commit`) | `git add` + `git rebase --continue` |
| Abort | `git merge --abort` | `git rebase --abort` |
| History after resolution | Merge commit records the resolution | Resolution is baked into the replayed commit |

**Rebase can create more conflict resolution work.** If your branch has ten commits and three of them conflict with changes in `main`, you resolve conflicts three separate times. With merge, you resolve all conflicts once in the final merge commit. For long-running branches with many conflicting commits, merge is often less painful.

### Reading History: `git log` Differences

The practical impact of your merge strategy is visible in `git log`.

```bash
# After a standard merge (--no-ff):
git log --oneline --graph
# *   f3a9c1e Merge branch 'feature/add-auth' into main
# |\
# | * e2d8b0f feat: add JWT validation
# | * d1c7a9e feat: add login endpoint
# * | c0b6a8d chore: update dependencies
# |/
# * b9a5a7c feat: initial setup

# After rebase + fast-forward merge (or squash and merge):
git log --oneline --graph
# * f3a9c1e feat: add JWT validation
# * e2d8b0f feat: add login endpoint
# * d1c7a9e chore: update dependencies
# * b9a5a7c feat: initial setup
```

Linear history makes `git bisect` faster and more intuitive — there is only one path through the history. Merge-heavy history requires bisect to navigate merge commits, which it handles correctly but which can be confusing when reviewing.

```bash
git log --oneline --graph --all        # full picture including all branches
git log --merges --oneline             # show only merge commits
git log --no-merges --oneline          # exclude merge commits
git shortlog -sn                       # commit count by author (useful for attribution)
```

---

## Examples

### Example 1: Update a Feature Branch with Latest Main

**Scenario:** you started `feature/add-auth` three days ago. `main` has received four commits since then. You want your branch to include those changes before opening a PR.

```bash
# 1. Confirm current state
git log --oneline --graph --all
# * c3d4e5f (origin/main, main) chore: bump base image to alpine 3.19
# * b2c3d4e fix: correct env var name in deployment.yaml
# * a1b2c3d feat: add health check endpoint
# * 9z0a1b2 feat: add config loader
# | * 8y9z0a1 (HEAD -> feature/add-auth) feat: JWT validation
# | * 7x8y9z0 feat: login endpoint
# |/
# * 6w7x8y9 feat: initial setup

# 2. Fetch latest without merging
git fetch origin

# 3. Rebase feature branch on top of latest main
git checkout feature/add-auth
git rebase origin/main
# Replaying: feat: login endpoint
# Replaying: feat: JWT validation

# 4. Verify the result — should be linear
git log --oneline --graph
# * 2b3c4d5 (HEAD -> feature/add-auth) feat: JWT validation
# * 1a2b3c4 feat: login endpoint
# * c3d4e5f (origin/main, main) chore: bump base image to alpine 3.19
# * b2c3d4e fix: correct env var name in deployment.yaml
# ...

# 5. Force-push the rebased branch (you own this branch, no one else uses it)
git push --force-with-lease origin feature/add-auth
```

### Example 2: Clean Up Commits Before a PR

**Scenario:** you have been working on a feature for two days and your commit log is full of WIP and fix commits. You want to present two clean, logical commits to reviewers.

```bash
# Current messy log:
git log --oneline HEAD~6
# 6f7a8b9 fix typo in error message
# 5e6f7a8 oops forgot to import module
# 4d5e6f7 WIP saving before standup
# 3c4d5e6 fix: handle empty input in validator
# 2b3c4d5 WIP not done yet
# 1a2b3c4 feat: add input validator

# Goal: two commits —
#   "feat: add input validator" (1a2b3c4 + 2b3c4d5 + 3c4d5e6 + 5e6f7a8 + 6f7a8b9)
#   is actually one logical unit; 4d5e6f7 is noise

git rebase -i HEAD~6

# Editor opens — modify to:
# pick   1a2b3c4 feat: add input validator
# fixup  2b3c4d5 WIP not done yet            ← silent squash, discard message
# fixup  3c4d5e6 fix: handle empty input     ← part of the same logical change
# drop   4d5e6f7 WIP saving before standup   ← pure noise, discard entirely
# fixup  5e6f7a8 oops forgot to import       ← belongs with the feature
# fixup  6f7a8b9 fix typo in error message   ← belongs with the feature

# Save and close editor
# Git replays the commits; result is one clean commit:
git log --oneline
# 9g0h1i2 (HEAD -> feature/input-validator) feat: add input validator
# ...

# Verify the diff is correct (all
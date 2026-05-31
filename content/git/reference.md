# Git & VCS — Quick Reference

## Core Workflow

| Command | Description |
|---------|-------------|
| `git init` | Initialize a new repo |
| `git clone url` | Clone a remote repo |
| `git status` | Show working tree state |
| `git add file` | Stage a file |
| `git add -p` | Stage hunks interactively |
| `git commit -m "msg"` | Commit staged changes |
| `git commit --amend` | Edit last commit message/content |
| `git push origin branch` | Push branch to remote |
| `git pull` | Fetch + merge remote changes |
| `git fetch` | Fetch without merging |

## Branches

| Command | Description |
|---------|-------------|
| `git branch` | List local branches |
| `git branch -a` | List all branches (incl. remote) |
| `git branch name` | Create branch |
| `git checkout name` | Switch to branch |
| `git checkout -b name` | Create and switch |
| `git switch name` | Modern branch switch |
| `git switch -c name` | Create and switch (modern) |
| `git branch -d name` | Delete merged branch |
| `git branch -D name` | Force delete branch |
| `git push origin --delete name` | Delete remote branch |

## Merging & Rebasing

| Command | Description |
|---------|-------------|
| `git merge branch` | Merge branch into current |
| `git merge --no-ff branch` | Merge with explicit merge commit |
| `git merge --squash branch` | Squash into one commit |
| `git rebase main` | Rebase current branch onto main |
| `git rebase -i HEAD~3` | Interactive rebase last 3 commits |
| `git cherry-pick abc123` | Apply a specific commit |
| `git merge --abort` | Abort in-progress merge |
| `git rebase --abort` | Abort in-progress rebase |

## History & Diff

| Command | Description |
|---------|-------------|
| `git log --oneline` | Compact commit history |
| `git log --oneline --graph` | ASCII branch graph |
| `git log -p` | Show diffs per commit |
| `git log --author="name"` | Filter by author |
| `git log --since="2 weeks ago"` | Filter by date |
| `git diff` | Unstaged changes |
| `git diff --staged` | Staged changes |
| `git diff branch1..branch2` | Diff between branches |
| `git blame file` | Show who wrote each line |
| `git show abc123` | Show commit details |

## Undoing Changes

| Command | Description |
|---------|-------------|
| `git restore file` | Discard unstaged changes |
| `git restore --staged file` | Unstage a file |
| `git reset HEAD~1` | Undo last commit, keep changes |
| `git reset --hard HEAD~1` | Undo last commit, discard changes |
| `git revert abc123` | Create reverse commit (safe) |
| `git stash` | Stash working changes |
| `git stash pop` | Restore stash |
| `git stash list` | List stashes |
| `git clean -fd` | Remove untracked files & dirs |

## Remotes & Tags

| Command | Description |
|---------|-------------|
| `git remote -v` | List remotes |
| `git remote add origin url` | Add remote |
| `git push -u origin branch` | Push and set upstream |
| `git tag v1.0.0` | Create lightweight tag |
| `git tag -a v1.0.0 -m "msg"` | Annotated tag |
| `git push origin --tags` | Push all tags |
| `git tag -d v1.0.0` | Delete local tag |

## Config & Hooks

| Command | Description |
|---------|-------------|
| `git config --global user.name "Name"` | Set global username |
| `git config --global user.email "e@m"` | Set global email |
| `git config --list` | Show all config |
| `git config --global alias.st status` | Create alias |
| `.git/hooks/pre-commit` | Script runs before each commit |
| `git bisect start` | Start binary search for bug |
| `git bisect good / bad` | Mark commits during bisect |

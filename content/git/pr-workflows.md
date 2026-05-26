---
title: PR Workflows
module: git
duration_min: 15
difficulty: beginner
tags: [git, pull-request, code-review, github, codeowners, workflow]
exercises: 4
---

## Overview
Pull requests (PRs) — called Merge Requests on GitLab — are the standard mechanism for code review and integration. A good PR workflow enforces quality without creating bottlenecks. This lesson covers the mechanics of PRs, how to write them well, and how to configure repository rules that enforce team standards automatically.

## Concepts

### Fork Model vs Branch Model
**Fork model:** contributor forks the repo, works in their fork, opens a PR back to the upstream. Used for open-source and external contributions. The maintainer never gives write access.

**Branch model:** everyone has write access to the same repo, works on branches, opens PRs from branch to `main`. Used by most company teams. Simpler, faster, no fork overhead.

```bash
# Branch model (most team workflows):
git checkout -b feature/add-retry-logic
git push origin feature/add-retry-logic
# → open PR on GitHub/GitLab

# Fork model (open source, external contributions):
# 1. Fork on GitHub UI
# 2. Clone your fork
git clone git@github.com:YOUR_USER/upstream-repo.git
cd upstream-repo
git remote add upstream git@github.com:original-org/upstream-repo.git
# 3. Keep fork up to date
git fetch upstream && git rebase upstream/main
git push origin main
# 4. Create branch, push, open PR from your fork
```

### Anatomy of a Good PR
A PR description should answer four questions:
1. **What changed?** — summary in the title
2. **Why?** — motivation, linked issue, business context
3. **How do I verify it works?** — testing steps
4. **What are the risks?** — migrations, breaking changes, performance implications

```markdown
## Summary
Adds automatic retry logic to the API client for transient 5xx errors.
Retries up to 3 times with exponential backoff.

Closes #247

## Changes
- `client.py`: new `retry_on_5xx` decorator
- `config.py`: added `MAX_RETRIES` and `RETRY_BACKOFF_BASE` settings
- `tests/test_client.py`: 8 new test cases

## Testing
1. Run `pytest tests/test_client.py -v`
2. Manually test: start a mock server that returns 503, verify client retries
3. Check logs for retry count output

## Notes
- Does NOT retry on 4xx (client errors are not transient)
- Jitter is not added yet — tracked in #251
```

### PR Size
Small PRs get reviewed quickly; large PRs get rubber-stamped or block for days. Aim for:
- < 400 lines changed
- One logical change per PR
- If a PR is large, split it into a stack of smaller PRs

### Keeping PRs Up to Date
```bash
# Update your branch with latest main before review/merge
git fetch origin
git rebase origin/main   # preferred: keeps history linear
# OR
git merge origin/main    # also acceptable

# Push updated branch (may need --force-with-lease after rebase)
git push --force-with-lease origin feature/add-retry-logic
```

### Branch Protection Rules (GitHub)
Set in repo Settings → Branches → Add rule for `main`:
- **Require pull request before merging** — no direct pushes to main
- **Require approvals** — min 1-2 reviewer approvals
- **Require status checks to pass** — CI must be green
- **Require branches to be up to date** — PR must include latest main
- **Restrict who can push** — only admins can bypass

### CODEOWNERS
`CODEOWNERS` automatically assigns reviewers based on what files changed:

```bash
# .github/CODEOWNERS (GitHub) or CODEOWNERS (GitLab root)

# Default: all changes require @lead-dev
*                           @org/lead-dev

# Infrastructure changes require the ops team
/infra/                     @org/platform-team
/terraform/                 @org/platform-team
*.tf                        @org/platform-team

# Security-sensitive files require security team
/secrets/                   @org/security-team
**/auth.py                  @org/security-team

# Frontend files
/frontend/                  @org/frontend-team

# Docs can be merged without engineering review
/docs/                      @org/docs-team
```

With CODEOWNERS enabled in branch protection, the assigned reviewers must approve before merge.

### Review Best Practices
**For the author:**
- Self-review before requesting review — read the diff yourself first
- Add comments explaining non-obvious decisions
- Keep scope tight — no unrelated cleanup in the same PR
- Respond to comments promptly

**For the reviewer:**
- Focus on correctness, security, and maintainability — not style (that's what linters are for)
- Distinguish blocking feedback from suggestions: "nit:", "optional:", "blocker:"
- Approve once major concerns are addressed — don't hold up for minor nits

### GitHub CLI — Working with PRs from the Terminal
```bash
# Create PR
gh pr create --title "feat: add retry logic" --body "$(cat pr-body.md)"
gh pr create --fill   # use last commit message as title/body

# List open PRs
gh pr list
gh pr list --author @me

# Review someone's PR locally
gh pr checkout 247

# Check CI status
gh pr checks 247

# Merge (respects branch protection)
gh pr merge 247 --squash --delete-branch
gh pr merge 247 --rebase

# View PR in browser
gh pr view 247 --web
```

## Examples

### PR Template (`.github/pull_request_template.md`)
```markdown
## Summary
<!-- What does this PR do? Link the issue it closes. -->

Closes #

## Changes
<!-- List the main files/components changed and why. -->

- 
- 

## Testing
<!-- How did you verify this works? What should reviewers check? -->

- [ ] Unit tests pass (`make test`)
- [ ] Manual testing steps:
  1. 
  2. 

## Checklist
- [ ] Self-reviewed the diff
- [ ] Added/updated tests
- [ ] Updated documentation if needed
- [ ] No hardcoded secrets or debug code
```

### Automate PR Checks with GitHub Actions
```yaml
# .github/workflows/pr-checks.yml
name: PR Checks
on:
  pull_request:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - run: flake8 .
      - run: pytest --tb=short
```

## Exercises

1. Create a PR template (`.github/pull_request_template.md`) for a DevOps project that includes sections for: type of change (feature/fix/chore), what was changed, testing instructions, and a checklist for secrets and docs.
2. Set up a `CODEOWNERS` file for a project with this structure: `backend/` owned by `@backend-team`, `infra/` owned by `@ops-team`, and any `*.tf` file owned by `@ops-team` regardless of location.
3. Write a GitHub Actions workflow (`.github/workflows/pr-check.yml`) that runs on pull requests to `main`, checks out code, and runs `bash -n` on every `.sh` file in the repo to validate shell syntax.
4. Practice the PR review process: fork a public repo on GitHub, make a small improvement (fix a typo in docs, add a missing `.gitignore` entry), and open a real PR. Document the steps you followed.

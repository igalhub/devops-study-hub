---
title: PR Workflows
module: git
duration_min: 15
difficulty: beginner
tags: [git, pull-request, code-review, github, codeowners, workflow]
exercises: 4
---

## Overview

Pull requests (PRs) — called Merge Requests on GitLab — are the primary mechanism through which code enters a shared codebase in professional software teams. In a DevOps context, a well-designed PR workflow is not just a courtesy for reviewers: it is the first gate in your delivery pipeline. PRs are where security vulnerabilities get caught before deployment, where infrastructure changes get a second pair of eyes before they touch production, and where the CI system proves that the change is safe to ship. Getting this workflow right is one of the most visible signs of engineering maturity on a team.

The core design principle behind PR workflows is that **no change merges unreviewed and untested**. This is enforced through a combination of social conventions (good PR descriptions, prompt review turnaround) and hard technical controls (branch protection rules, required status checks, CODEOWNERS). The human side and the automation side must both work together — automation without good conventions produces rubber-stamped approvals, while good conventions without automation produce bypassed rules the moment someone is in a hurry.

In the broader DevOps toolchain, the PR sits between local development and CI/CD. A developer opens a PR, which triggers automated checks (linting, tests, security scanning, infrastructure plan previews). A human reviewer approves it. Then automated merge gates confirm everything is green before the change lands on `main` and is picked up by continuous deployment. Understanding PR workflows means understanding the handoff between the human and automated parts of that chain.

---

## Concepts

### Fork Model vs Branch Model

The two dominant PR collaboration models differ on whether contributors share a single repository or work in isolated copies.

| Dimension | Fork Model | Branch Model |
|---|---|---|
| **Write access** | Contributor has none on upstream | Everyone has write access to the repo |
| **Typical use case** | Open source, external contributors | Company teams, internal projects |
| **PR origin** | `your-fork:feature-branch` → `upstream:main` | `origin:feature-branch` → `origin:main` |
| **Overhead** | Higher — fork, sync, manage two remotes | Lower — one remote, branch and push |
| **Security model** | Maintainer reviews before any code lands | Trust within the team; protection rules enforce quality |

```bash
# Branch model — most common in DevOps team settings
git checkout -b feature/add-retry-logic
git push origin feature/add-retry-logic
# → open PR on GitHub/GitLab from the UI or GitHub CLI

# Fork model — open source or external contributions
# 1. Fork on GitHub UI, then:
git clone git@github.com:YOUR_USER/upstream-repo.git
cd upstream-repo
git remote add upstream git@github.com:original-org/upstream-repo.git

# 2. Keep fork in sync with upstream before starting work
git fetch upstream
git rebase upstream/main
git push origin main

# 3. Work on a branch in your fork, then open PR upstream
git checkout -b fix/typo-in-readme
git push origin fix/typo-in-readme
# → PR: YOUR_USER/upstream-repo:fix/typo-in-readme → original-org/upstream-repo:main
```

**Fork model gotcha:** if you forget to add the `upstream` remote, `git pull` will only update your fork — not the original. Always add `upstream` immediately after cloning your fork. Regularly run `git fetch upstream && git rebase upstream/main` before starting new work.

---

### Anatomy of a Good PR

A PR description is documentation. Six months from now, someone will `git log --oneline`, see a merge commit, and click through to the PR to understand why a change was made. A poor description says "fix bug." A good description answers four questions:

1. **What changed?** — a short, scannable title and a summary of the diff
2. **Why?** — motivation, linked issue, business or operational context
3. **How do I verify it?** — concrete testing steps reviewers can reproduce
4. **What are the risks?** — database migrations, breaking changes, performance implications, rollback plan

```markdown
## Summary
Adds automatic retry logic to the API client for transient 5xx errors.
Retries up to 3 times with exponential backoff (1s, 2s, 4s base).

Closes #247

## Changes
- `client.py`: new `retry_on_5xx` decorator applied to all outbound requests
- `config.py`: added `MAX_RETRIES` (default 3) and `RETRY_BACKOFF_BASE` (default 1.0)
- `tests/test_client.py`: 8 new test cases covering retry exhaustion and success-on-retry

## Testing
1. `pytest tests/test_client.py -v` — all 8 new cases should pass
2. Start mock server: `python tests/mock_503_server.py`
3. Run `python -m scripts.smoke_test` — watch logs for retry attempts then success
4. Verify no retries on 400: mock server returns 400, confirm single attempt in logs

## Risks / Notes
- Does NOT retry 4xx errors — client errors are not transient, retrying wastes time
- Jitter not yet added — tracked in #251; acceptable for current traffic volume
- No impact on existing callers — decorator is opt-in per method
```

**Reviewer time is the bottleneck.** Every sentence in a PR description that saves a reviewer from reading source code or running the application themselves reduces total cycle time. Think of it as async documentation, not a formality.

---

### PR Size and Stacking

Large PRs are the most common cause of slow review cycles. A reviewer facing a 2,000-line diff will either defer it ("I'll get to it later") or approve it without real scrutiny ("LGTM" after a quick scroll). Both outcomes defeat the purpose of code review.

| PR size | Lines changed | Outcome |
|---|---|---|
| **Ideal** | < 400 | Reviewed in under 30 min, same day |
| **Acceptable** | 400–800 | Reviewed in 1–2 days with effort |
| **Too large** | > 800 | Rubber-stamped, deferred, or blocks for days |

**How to keep PRs small:**

- One logical change per PR. Refactoring and feature work in separate PRs.
- Extract pure preparatory work (renaming, reorganizing, adding test infrastructure) into its own PR that lands first.
- Use **stacked PRs** for dependent changes: PR-1 is the foundation, PR-2 targets PR-1's branch, PR-3 targets PR-2's branch. Each is small and reviewable independently. Merge in order.

```bash
# Stacked PR setup
git checkout main
git checkout -b feat/retry-base        # PR-1: add retry utility
git push origin feat/retry-base

git checkout -b feat/retry-api-client  # PR-2: apply to API client
# → on GitHub, set base branch to feat/retry-base, not main
git push origin feat/retry-api-client

# After PR-1 merges, rebase PR-2 onto main
git fetch origin
git rebase origin/main feat/retry-api-client
git push --force-with-lease origin feat/retry-api-client
# → update PR-2's base branch to main in the GitHub UI
```

---

### Keeping PRs Up to Date

A PR that was opened against a `main` branch that has since moved forward may have merge conflicts or may be missing changes that affect the correctness of the review. Most branch protection rules require the PR branch to be up to date before merge.

```bash
# Preferred: rebase keeps a linear history, easier to bisect
git fetch origin
git rebase origin/main

# Alternative: merge creates a merge commit, preserves topology
git merge origin/main

# After a rebase, history was rewritten — force push is required
# --force-with-lease is safer than --force: it refuses if someone
# else pushed to the branch since your last fetch
git push --force-with-lease origin feature/add-retry-logic
```

**`--force` vs `--force-with-lease`:** `--force` will overwrite whatever is on the remote branch, including commits from a teammate if they pushed to your branch. `--force-with-lease` checks that the remote tip matches what you last fetched and aborts if it doesn't. Always use `--force-with-lease` when force-pushing shared branches.

**Rebase vs merge on PRs:** rebase produces cleaner history but rewrites commit SHAs, which breaks any external references (comments, CI runs tied to specific commits). Some teams merge for this reason. Pick one convention and enforce it consistently.

---

### Branch Protection Rules

Branch protection rules are the technical enforcement layer. Without them, conventions are opt-in and will be bypassed under pressure. Configure them in GitHub under **Settings → Branches → Add rule** for `main` (or `master`/`release/*` as needed).

| Rule | What it does | Why it matters |
|---|---|---|
| **Require pull request before merging** | Blocks direct `git push` to protected branch | Forces all changes through review |
| **Require approvals (N)** | PR needs N human approvals to merge | Enforces code review |
| **Require status checks to pass** | Named CI jobs must be green | No merging broken code |
| **Require branches to be up to date** | PR must include latest base branch | Prevents "works on my branch" integration failures |
| **Require CODEOWNERS review** | CODEOWNERS-assigned reviewers must approve | Subject-matter experts review their domains |
| **Restrict pushes to matching branches** | Only specified users/roles can push | Prevents accidental bypasses |
| **Require signed commits** | All commits must have a verified GPG/SSH signature | Proves commit authorship |

**Bypass gotcha:** GitHub allows admins to bypass branch protection by default. In high-compliance environments, enable **"Do not allow bypassing the above settings"** — this forces even repository administrators through the PR process. This is a common interview topic for DevOps roles at regulated companies.

You can also manage branch protection as code using Terraform's GitHub provider:

```hcl
# terraform/github-branch-protection.tf
resource "github_branch_protection" "main" {
  repository_id = github_repository.app.node_id
  pattern       = "main"

  required_pull_request_reviews {
    required_approving_review_count = 2
    require_code_owner_reviews      = true
    dismiss_stale_reviews           = true
  }

  required_status_checks {
    strict   = true   # branch must be up to date
    contexts = ["lint-and-test", "security-scan"]
  }

  enforce_admins = true  # admins cannot bypass
}
```

---

### CODEOWNERS

`CODEOWNERS` maps file paths to GitHub teams or individual users. When a PR touches a file, Git automatically requests a review from the matching owner. Combined with the **Require CODEOWNERS review** branch protection rule, this guarantees that the right people review the right changes — automatically, without relying on the PR author to remember who to tag.

```bash
# .github/CODEOWNERS  (GitHub)
# CODEOWNERS          (GitLab — repo root or docs/ or .gitlab/)

# Rules are evaluated last-match-wins on GitLab, first-match-wins on GitHub.
# On GitHub: put more specific rules AFTER broader rules so they take precedence.

# Fallback: any file not matched below requires @org/lead-dev
*                           @org/lead-dev

# Infrastructure and Terraform — ops team required
/infra/                     @org/platform-team
/terraform/                 @org/platform-team
*.tf                        @org/platform-team

# Security-sensitive files — security team required
/secrets/                   @org/security-team
**/auth.py                  @org/security-team
**/permissions.py           @org/security-team

# Frontend — frontend team handles their own domain
/frontend/                  @org/frontend-team

# CI/CD pipeline definitions — platform team must approve
/.github/workflows/         @org/platform-team
```

**CODEOWNERS precedence on GitHub:** the **last** matching rule wins. This means if you want `*.tf` files inside `/infra/` to be owned by the platform team, put `*.tf` after `/infra/` — but since both point to the same team here, order doesn't matter. It matters when you have overlapping rules with *different* owners.

**CODEOWNERS doesn't replace normal review.** It ensures subject-matter experts are included. Regular approvals from other reviewers still count toward the required approval count unless you've configured CODEOWNERS as the *only* required reviewers.

---

### Review Best Practices

Code review is a skill separate from coding. Doing it well accelerates the team; doing it poorly creates friction and animosity.

**For the author:**
- Self-review your own diff before requesting review. Read it in the GitHub UI, not your editor — you'll catch more. Imagine you're reviewing someone else's code.
- Add inline comments on your own PR to explain non-obvious choices before a reviewer has to ask. This surfaces your reasoning and speeds up review.
- Keep scope tight. If you notice a bug while working on your feature, open a separate PR or issue. Bundling unrelated changes makes review harder and reverts messier.
- Respond to all comments before re-requesting review. Don't leave reviewers wondering if you saw their feedback.

**For the reviewer:**
- Focus on correctness, security, and maintainability — not formatting. Formatting is a linter's job. If your team doesn't have a linter for something, add one instead of reviewing it manually.
- Signal severity clearly. Reviewers often block PRs on opinions rather than issues, or approve PRs with buried blockers. Use explicit prefixes:

| Prefix | Meaning |
|---|---|
| `blocker:` | Must be fixed before merge |
| `nit:` | Minor style/preference — author's discretion |
| `optional:` | A better approach exists, but current is fine |
| `question:` | Asking for understanding, not requesting a change |

- Approve once your blocking concerns are resolved. Don't withhold approval over unresolved nits. If you have nits remaining, approve with a comment: "Approved — feel free to address nits or ignore."
- Review within one business day. Stale PRs lose context and create merge conflicts. If you can't review, say so and suggest someone else.

---

### GitHub CLI — Working with PRs from the Terminal

Switching between terminal and browser breaks flow. The GitHub CLI (`gh`) lets you manage the full PR lifecycle without leaving the command line.

```bash
# Install
brew install gh        # macOS
sudo apt install gh    # Debian/Ubuntu

# Authenticate
gh auth login

# Create a PR using a markdown file for the body
gh pr create \
  --title "feat: add retry logic to API client" \
  --body "$(cat .github/pr-body.md)" \
  --reviewer alice,@org/platform-team \
  --label "enhancement"

# Let gh infer title/body from last commit message
gh pr create --fill

# List PRs — filter by author, label, or assignee
gh pr list
gh pr list --author @me
gh pr list --label "needs-review"

# Check out someone else's PR locally to test it
gh pr checkout 247
# This creates a local branch tracking the PR's remote branch

# See CI check status for a PR
gh pr checks 247

# Merge options — each maps to a GitHub merge strategy
gh pr merge 247 --squash --delete-branch   # squash into one commit
gh pr merge 247 --rebase                    # rebase commits onto main
gh pr merge 247 --merge                     # traditional merge commit

# Open PR in browser from terminal
gh pr view 247 --web

# Add a review from the CLI
gh pr review 247 --approve --body "LGTM, tested locally"
gh pr review 247 --request-changes --body "blocker: see inline comments"
```

**`gh pr checkout` is underused.** When you check out a PR locally, you can run the application, run the test suite, inspect performance, or debug an issue — none of which are possible by reading the diff. For infrastructure PRs especially, checking out and running `terraform plan` locally before approving is a strong practice.

---

## Examples

### Example 1: Full Branch Model PR Lifecycle

This traces a complete PR from branch creation to merge using the GitHub CLI and branch protection.

```bash
# 1. Start from an up-to-date main
git checkout main
git pull origin main

# 2. Create a feature branch — use a consistent naming convention
#    format: <type>/<short-description>
#    types: feat, fix, chore, docs, refactor, infra
git checkout -b feat/add-healthcheck-endpoint

# 3.
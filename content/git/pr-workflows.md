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

Store a PR template in `.github/pull_request_template.md` so every PR on the repo starts with the same scaffolding. GitHub renders it automatically when a contributor opens a new PR.

```markdown
<!-- .github/pull_request_template.md -->
## Summary
<!-- What does this PR do? Link the issue it closes. -->
Closes #

## Changes
<!-- Bullet list of files and what changed in each -->

## Testing
<!-- Steps a reviewer can follow to verify the change works -->
1.
2.

## Risks / Notes
<!-- Migrations, breaking changes, rollback plan, performance impact -->
```

---

### PR Size and Stacking

Large PRs are the most common cause of slow review cycles. A reviewer facing a 2,000-line diff will either defer it ("I'll get to it later") or approve it without real scrutiny ("LGTM" after a quick scroll). Both outcomes defeat the purpose of code review.

| PR size | Lines changed | Typical outcome |
|---|---|---|
| **Ideal** | < 400 | Reviewed same day, under 30 min |
| **Acceptable** | 400–800 | Reviewed in 1–2 days with effort |
| **Too large** | > 800 | Rubber-stamped, deferred, or blocks for days |

**How to keep PRs small:**

- One logical change per PR. Refactoring and feature work go in separate PRs.
- Extract pure preparatory work (renaming, reorganizing, adding test infrastructure) into its own PR that lands first.
- Use **stacked PRs** for dependent changes: PR-1 is the foundation, PR-2 targets PR-1's branch, PR-3 targets PR-2's branch. Each is small and reviewable independently. Merge in order.

```bash
# Stacked PR setup
git checkout main
git checkout -b feat/retry-base        # PR-1: add retry utility
# ... make commits ...
git push origin feat/retry-base

git checkout -b feat/retry-api-client  # PR-2: apply to API client
# ... make commits ...
# → on GitHub, set base branch to feat/retry-base, NOT main
git push origin feat/retry-api-client

# After PR-1 merges to main, rebase PR-2 onto main
git fetch origin
git rebase origin/main feat/retry-api-client
git push --force-with-lease origin feat/retry-api-client
# → update PR-2's base branch to main in the GitHub UI
```

**Stacked PR gotcha:** if PR-1 is still open when you rebase PR-2 onto `main`, you'll lose the logical separation of your diffs — reviewers on PR-2 will now see PR-1's changes included. Only rebase the downstream PR after the upstream one has actually merged.

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

**`--force` vs `--force-with-lease`:** `--force` will overwrite whatever is on the remote branch, including commits from a teammate if they pushed to your branch since your last fetch. `--force-with-lease` checks that the remote tip matches your local tracking ref and aborts if it doesn't. Always use `--force-with-lease` when force-pushing shared branches.

**Rebase vs merge on PRs:** rebase produces cleaner, linear history and makes `git bisect` more reliable. However, rebasing rewrites commit SHAs, which breaks links in any CI runs or review comments tied to specific commits. Some teams merge instead for this reason. Pick one convention and enforce it consistently — the worst outcome is a repo where both strategies are used arbitrarily.

---

### Branch Protection Rules

Branch protection rules are the technical enforcement layer. Without them, conventions are opt-in and will be bypassed under pressure. Configure them in GitHub under **Settings → Branches → Add rule** for `main` (and any `release/*` branches that matter).

| Rule | What it does | Why it matters |
|---|---|---|
| **Require pull request before merging** | Blocks direct `git push` to protected branch | Forces all changes through review |
| **Require approvals (N)** | PR needs N human approvals to merge | Enforces code review |
| **Require status checks to pass** | Named CI jobs must be green | No merging broken code |
| **Require branches to be up to date** | PR must include latest base branch commits | Prevents "works on my branch" integration failures |
| **Require CODEOWNERS review** | CODEOWNERS-assigned reviewers must approve | Subject-matter experts review their domains |
| **Restrict pushes to matching branches** | Only specified users/roles can push | Prevents accidental bypasses |
| **Require signed commits** | All commits must have a verified GPG/SSH signature | Proves commit authorship |
| **Do not allow bypassing above settings** | Blocks admin bypass | Critical for compliance — admins are still subject to all rules |

**Bypass gotcha:** GitHub allows repository admins to bypass branch protection by default. In high-compliance environments (SOC 2, PCI-DSS, HIPAA), you must explicitly enable **"Do not allow bypassing the above settings"**. This is a common interview topic for DevOps roles at regulated companies — interviewers will ask how you prevent a panicked admin from pushing directly to `main` during an incident.

Manage branch protection as code using Terraform so the configuration is auditable and reproducible:

```hcl
# terraform/github-branch-protection.tf
resource "github_branch_protection" "main" {
  repository_id = github_repository.app.node_id
  pattern       = "main"

  required_pull_request_reviews {
    required_approving_review_count = 2
    require_code_owner_reviews      = true
    # Invalidate approvals when new commits are pushed
    dismiss_stale_reviews           = true
  }

  required_status_checks {
    # strict = true means the branch must be up to date before merge
    strict   = true
    # These strings must exactly match the job names in your CI config
    contexts = ["lint-and-test", "security-scan", "terraform-plan"]
  }

  # Forces even admins through the PR process
  enforce_admins = true
}
```

**`dismiss_stale_reviews` is critical.** Without it, a reviewer can approve a PR, the author pushes new commits (potentially introducing bad code), and the original approval still counts. With it, any new push invalidates existing approvals and forces re-review.

---

### CODEOWNERS

`CODEOWNERS` maps file paths to GitHub teams or individual users. When a PR touches a file, GitHub automatically requests a review from the matching owner. Combined with the **Require CODEOWNERS review** branch protection rule, this guarantees that the right people review the right changes — automatically, without relying on the PR author to remember who to tag.

```bash
# .github/CODEOWNERS  (GitHub — place here or in repo root or docs/)
# CODEOWNERS          (GitLab — repo root, docs/, or .gitlab/)

# IMPORTANT: On GitHub, the LAST matching rule wins.
# Put more specific rules AFTER broader rules so they take precedence.

# Fallback: any unmatched file requires review from lead-dev
*                           @org/lead-dev

# Infrastructure and Terraform — platform team required
/infra/                     @org/platform-team
/terraform/                 @org/platform-team
*.tf                        @org/platform-team

# Security-sensitive files — security team required
/secrets/                   @org/security-team
**/auth.py                  @org/security-team
**/permissions.py           @org/security-team

# Frontend — frontend team handles their own domain
/frontend/                  @org/frontend-team

# CI/CD pipeline definitions — platform team must approve pipeline changes
/.github/workflows/         @org/platform-team

# CODEOWNERS file itself — prevent unauthorized changes to ownership rules
/.github/CODEOWNERS         @org/lead-dev @org/security-team
```

**CODEOWNERS precedence on GitHub:** the **last** matching rule wins. Put broad patterns first and specific patterns last. For example, if you want `/infra/*.tf` to be owned by `@org/security-team` but all other `*.tf` files owned by `@org/platform-team`, the `/infra/*.tf` rule must appear after `*.tf`.

**CODEOWNERS doesn't replace normal review.** It ensures subject-matter experts are included. Regular approvals from other reviewers still count toward the required approval count. The CODEOWNERS review is *in addition to*, not instead of, the standard required approvals count — unless you've explicitly set the required count to 0 and rely solely on CODEOWNERS.

**Protect the CODEOWNERS file itself.** If anyone can edit `.github/CODEOWNERS`, they can remove themselves as a required reviewer and merge changes that bypass domain ownership. Always make CODEOWNERS a CODEOWNER of itself.

---

### Merge Strategies

When a PR merges, GitHub/GitLab offers three strategies. The choice affects history readability, bisectability, and rollback granularity.

| Strategy | What it does | History shape | Best for |
|---|---|---|---|
| **Merge commit** | Creates a new commit with two parents | Preserves branch topology | Teams that want to see full branch history |
| **Squash and merge** | Collapses all PR commits into one commit on `main` | Linear, one commit per PR | Teams with messy WIP commit habits; easier reverts |
| **Rebase and merge** | Replays each commit individually onto `main` | Linear, all commits preserved | Teams with disciplined commit hygiene |

```bash
# Via GitHub CLI
gh pr merge 247 --squash --delete-branch   # squash all commits into one
gh pr merge 247 --rebase                    # replay commits individually
gh pr merge 247 --merge                     # traditional merge commit

# After merge, clean up your local branches
git checkout main
git pull origin main
git branch -d feat/add-retry-logic          # delete local branch
```

**Squash merge gotcha:** when you squash, all the author attribution from individual commits collapses into the PR author. If multiple people contributed commits to a branch, those contributions become invisible in `git log`. Use merge commits or rebase-and-merge when co-authorship matters.

**`--delete-branch` is a habit, not a nice-to-have.** Stale branches accumulate quickly. Many teams enable automatic branch deletion after merge in GitHub (**Settings → General → Automatically delete head branches**) so developers don't have to remember.

---

### Review Best Practices

Code review is a skill separate from coding. Doing it well accelerates the team; doing it poorly creates friction and animosity.

**For the author:**
- Self-review your own diff before requesting review — read it in the GitHub UI, not your editor. You'll catch things you missed in context.
- Add inline comments on your own PR to explain non-obvious choices before a reviewer has to ask. This surfaces your reasoning and cuts async back-and-forth.
- Keep scope tight. If you discover a bug while working on your feature, fix it in a separate PR or file an issue. Bundling unrelated changes makes review harder and makes reverts messier.
- Respond to all review comments before re-requesting review. Don't leave reviewers wondering if feedback was seen.

**For the reviewer:**
- Focus on correctness, security, and maintainability — not formatting. Formatting is a linter's job. If your team debates formatting in review, add a formatter and auto-enforce it in CI instead.
- Signal severity clearly using explicit comment prefixes. Reviewers often block PRs on opinions, or bury actual blockers among nits, creating confusion about what must be fixed:

| Prefix | Meaning |
|---|---|
| `blocker:` | Must be fixed before merge — you will re-review |
| `nit:` | Minor style or preference — author's discretion |
| `optional:` | A better approach exists, but current code is acceptable |
| `question:` | Asking for understanding, not requesting a change |

- Approve once your blocking concerns are resolved. Don't withhold approval over open nits. Comment "Approved — feel free to address nits at your discretion" and move on.
- Review within one business day. Stale PRs lose context, accumulate merge conflicts, and create coordination overhead. If you can't review within the SLA, say so explicitly and nominate a substitute.

---

### GitHub CLI — Working with PRs from the Terminal

Switching between terminal and browser breaks flow. The GitHub CLI (`gh`) lets you manage the full PR lifecycle without leaving the command line.

```bash
# Install
brew install gh        # macOS
sudo apt install gh    # Debian/Ubuntu

# Authenticate (stores token in system keychain)
gh auth login

# Create a PR — body from a markdown file keeps descriptions rich
gh pr create \
  --title "feat: add retry logic to API client" \
  --body "$(cat .github/pr-body.md)" \
  --reviewer alice,@org/platform-team \
  --label "enhancement"

# Quick PR using last commit message as title/body
gh pr create --fill

# List open PRs; filter by author or label
gh pr list
gh pr list --author @me
gh pr list --label "needs-review"

# Check out a PR locally — essential for testing infrastructure changes
gh pr checkout 247
# Creates a local branch tracking the PR's remote branch
# Now you can run tests, `terraform plan`, etc. before approving

# See CI status for a PR without opening a browser
gh pr checks 247

# Review from the CLI
gh pr review 247 --approve --body "LGTM, tested locally"
gh pr review 247 --request-changes --body "blocker: see inline comments"

# Merge strategies
gh pr merge 247 --squash --delete-branch
gh pr merge 247 --rebase
gh pr merge 247 --merge

# Jump to the PR in browser when you do need the UI
gh pr view 247 --web
```

**`gh pr checkout` is underused.** Reading a diff is not the same as running the code. For infrastructure PRs, always check out locally and run `terraform plan` before approving. For application PRs, run the test suite against the actual branch — not just trust that CI passed on a different machine configuration.

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

# 3. Make changes and commit with a conventional commit message
#    format: <type>(<scope>): <short description>
echo 'GET /healthz → {"status":"ok"}' >> README.md
git add README.md src/routes/healthcheck.py tests/test_healthcheck.py
git commit -m "feat(api): add /healthz endpoint returning 200 + status payload"

# 4. Push the branch
git push origin feat/add-healthcheck-endpoint

# 5. Open a PR with a rich description from a file
cat > /tmp/pr-body.md << 'EOF'
## Summary
Adds a `/healthz` liveness endpoint for use by Kubernetes readiness probes.
Returns HTTP 200 and `{"status":"ok"}` when the application is healthy.

Closes #312

## Changes
- `src/routes/healthcheck.py`: new route handler, no auth required
- `tests/test_healthcheck.py`: 3 cases — 200 response, correct payload, no auth header needed
- `README.md`: documents the endpoint

## Testing
1. `pytest tests/test_healthcheck.py -v`
2. `uvicorn src.main:app --reload` then `curl http://localhost:8000/healthz`
3. Verify response: `{"status":"ok"}` with HTTP 200

## Risks / Notes
- Endpoint is unauthenticated by design — load balancers must be able to reach it
- No PII or sensitive data in the response payload
EOF

gh pr create \
  --title "feat(api): add /healthz liveness endpoint" \
  --body "$(cat /tmp/pr-body.md)" \
  --reviewer @org/backend-team \
  --label "enhancement"

# 6. CI runs automatically. Check status without leaving terminal.
gh pr checks 312

# 7. A teammate requests changes. Make the fix and push.
#    New commits on the branch automatically invalidate stale approvals
#    (if dismiss_stale_reviews is configured).
git add src/routes/healthcheck.py
git commit -m "fix(healthz): return 503 when db connection pool exhausted"
git push origin feat/add-healthcheck-endpoint

# 8. All checks pass, reviewer approves. Merge with squash.
gh pr merge 312 --squash --delete-branch

# 9. Pull the updated main locally
git checkout main
git pull origin main

# 10. Confirm the squash commit is visible
git log --oneline -5
```

---

### Example 2: Stacked PRs for a Multi-Layer Change

Adding a retry utility and then wiring it into the API client as two separate reviewable PRs.

```bash
# PR-1: Add the retry utility — self-contained, no external dependencies
git checkout main && git pull origin main
git checkout -b feat/retry-utility

# Create the utility file
cat > src/utils/retry.py << 'EOF'
import time, functools

def retry_on_5xx(max_attempts=3, backoff_base=1.0):
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            for attempt in range(max_attempts):
                resp = fn(*args, **kwargs)
                if resp.status_code < 500:
                    return resp
                if attempt < max_attempts - 1:
                    time.sleep(backoff_base * (2 ** attempt))
            return resp  # return last response after exhausting retries
        return wrapper
    return decorator
EOF

git add src/utils/retry.py tests/test_retry.py
git commit -m "feat(utils): add retry_on_5xx decorator with exponential backoff"
git push origin feat/retry-utility

# Open PR-1 — base branch is main
gh pr create \
  --title "feat(utils): add retry_on_5xx decorator" \
  --body "Standalone retry utility. No callers yet — wired in PR #2." \
  --base main

# PR-2: Wire the utility into the API client — depends on PR-1
git checkout -b feat/retry-api-client  # branches off feat/retry-utility

# Import and apply the decorator
sed -i 's/def get_resource/\@retry_on_5xx()\ndef get_resource/' src/client.py
git add src/client.py tests/test_client_retry.py
git commit -m "feat(client): apply retry_on_5xx to outbound API calls"
git push origin feat/retry-api-client

# Open PR-2 — base branch is feat/retry-utility, NOT main
# This means the diff only shows the client changes, not the utility
gh pr create \
  --title "feat(client): wire retry logic into API client" \
  --body "Depends on #PR1. Change base branch to main after PR-1 merges." \
  --base feat/retry-utility

# --- After PR-1 merges ---
git fetch origin
# Rebase PR-2 onto the now-updated main
git rebase origin/main feat/retry-api-client
git push --force-with-lease origin feat/retry-api-client

# Update the base branch in GitHub UI: PR-2 → base: main
# Now PR-2's diff shows only the client changes, not the utility
```

---

### Example 3: CODEOWNERS Enforcement with Terraform Branch Protection

Setting up a repository so that infrastructure changes always require the platform team.

```bash
# 1. Create CODEOWNERS — note last-rule-wins on GitHub
cat > .github/CODEOWNERS << 'EOF'
# Default owner for everything
*                           @org/lead-dev

# Platform team owns all infra and CI
/infra/                     @org/platform-team
/.github/workflows/         @org/platform-team
*.tf                        @org/platform-team

# CODEOWNERS itself requires both groups
/.github/CODEOWNERS         @org/lead-dev @org/platform-team
EOF

git add .github/CODEOWNERS
git commit -m "chore: add CODEOWNERS for infra and CI ownership"
git push origin main

# 2. Apply branch protection via Terraform
cat > terraform/github.tf << 'EOF'
terraform {
  required_providers {
    github = { source = "integrations/github", version = "~> 5.0" }
  }
}

resource "github_branch_protection" "main" {
  repository_id = var.repo_node_id
  pattern       = "main"

  required_pull_request_reviews {
    required_approving_review_count = 2
    require_code_owner_reviews      = true   # CODEOWNERS reviews are mandatory
    dismiss_stale_reviews           = true   # new commits invalidate approvals
  }

  required_status_checks {
    strict   = true
    contexts = ["test", "lint", "terraform-plan"]
  }

  enforce_admins = true  # no bypass — even for admins
}
EOF

terraform init
terraform plan    # review before applying
terraform apply

# 3. Verify enforcement: try to push directly to main — should be rejected
echo "test" >> README.md
git add README.md && git commit -m "test direct push"
git push origin main
# Expected: remote: error: GH006: Protected branch update failed
```

---

### Example 4: Diagnosing and Fixing a Stuck PR

A PR is blocked. This is the systematic flow for diagnosing why.

```bash
# Check what's blocking the PR
gh pr view 289 --json statusCheckRollup,reviewDecision,mergeable

# Sample output interpretation:
# statusCheckRollup: FAILURE  → a CI job failed
# reviewDecision: REVIEW_REQUIRED → not enough approvals
# mergeable: CONFLICTING → merge conflicts exist

# --- Fix 1: failing CI ---
# Read the logs without opening a browser
gh pr checks 289
# Click through to the specific failing check, or:
gh run view --log-failed   # shows logs for the most recent failed run

# --- Fix 2: missing approvals ---
# Re-request review from the right people
gh pr edit 289 --add-reviewer @org/platform-team

# --- Fix 3: merge conflicts ---
git fetch origin
git checkout feat/my-feature
git rebase origin/main
# Resolve conflicts in each file git marks:
git status   # shows which files have conflicts
# Edit conflicted files, then:
git add <resolved-file>
git rebase --continue
# Repeat until rebase completes, then:
git push --force-with-lease origin feat/my-feature

# --- Fix 4: branch out of date (no conflicts, just behind) ---
# GitHub shows "This branch is out of date with the base branch"
# Option A: update from the GitHub UI ("Update branch" button)
# Option B: rebase locally (preferred — keeps history linear)
git rebase origin/main
git push --force-with-lease origin feat/my-feature

# Verify everything is green
gh pr checks 289
gh pr view 289 --json mergeable,reviewDecision
```

---

## Exercises

### Exercise 1: Set Up a Complete PR Workflow from Scratch

**Goal:** practice the branch model lifecycle end-to-end with proper conventions.

1. Create a new GitHub repository (public or private). Enable branch protection on `main`: require 1 approval, require status checks to pass, require the branch to be up to date, and block admin bypass.
2. Create a `.github/pull_request_template.md` with sections for Summary, Changes, Testing, and Risks.
3. Clone the repo locally. Create a branch named `feat/setup-readme`. Add a `README.md` with a project description, commit it, and push.
4. Open a PR using `gh pr create`. Fill in every section of the template with real content — not placeholder text.
5. Review the PR yourself from a second GitHub account (or ask a friend), approve it, and merge using squash. Verify that the branch is automatically deleted if you configured that setting.

**What to verify:** the merge commit on `main` shows the squash message; direct push to `main` is rejected when you try `git push origin main` after making a local commit without a PR.

---

### Exercise 2: Practice Stacked PRs

**Goal:** build muscle memory for the stacked PR workflow and rebase mechanics.

1. In your repo, create branch `feat/base-util` off `main`. Add a file `utils.py` with a single helper function. Push and open a PR targeting `main`.
2. Without merging PR-1, create branch `feat/use-util` off `feat/base-util`. Add a second file `app.py` that imports and calls the function from `utils.py`. Push and open a PR targeting `feat/base-util`. Confirm in the GitHub UI that the diff only shows `app.py`.
3. Merge PR-1 (you can approve your own PR if you temporarily reduce the required approval count for this exercise). Then rebase `feat/use-util` onto `origin/main` and force-push with `--force-with-lease`. Update PR-2's base branch to `main` in the GitHub UI.
4. Confirm PR-2's diff still only shows `app.py`. Merge PR-2.

**What to verify:** `git log --oneline main` shows two separate squash commits — one for the utility, one for the app — even though they were developed as a stack.

---

### Exercise 3: Write and Test a CODEOWNERS File

**Goal:** understand CODEOWNERS path matching and precedence rules.

1. In your repo, create the following directory structure: `infra/`, `frontend/`, `src/auth/`, `.github/workflows/`.
2. Write a `.github/CODEOWNERS` file that assigns: all files to `@your-username` as fallback; `/infra/` and `*.tf` to a team you create called `@your-org/platform`; `src/auth/` to `@your-org/security`; `.github/workflows/` to `@your-org/platform`; and `.github/CODEOWNERS` itself to both `@your-username` and `@your-org/platform`.
3. Create a PR that modifies a file in `infra/`. Verify in the GitHub PR UI that `@your-org/platform` appears as a required reviewer under "Reviewers."
4. Create a second PR that modifies both `infra/main.tf` and `src/auth/permissions.py`. Verify that both `@your-org/platform` and `@your-org/security` are listed as required reviewers.

**What to verify:** a PR touching only `frontend/index.html` requires only `@your-username` (the fallback). A PR touching `src/auth/login.py` requires `@your-org/security`, not the fallback.

---

### Exercise 4: Diagnose and Resolve a Blocked PR

**Goal:** practice the real-world skill of unblocking a PR that has multiple issues simultaneously.

1. Create a branch `feat/intentionally-broken` from `main`. Add a Python file with a deliberate syntax error and push it. Open a PR. If you have a CI workflow that runs `python -m py_compile`, it will fail — if not, add a simple GitHub Actions workflow that runs `python -m py_compile **/*.py`.
2. While the PR is open, merge an unrelated commit directly to `main` (temporarily disable branch protection, make a commit, re-enable it). This puts the PR branch behind `main` and may create a conflict.
3. Now fix all three issues in order: (a) fix the syntax error and push a new commit; (b) rebase the branch onto `origin/main` and resolve any conflicts; (c) re-request review and confirm all status checks pass.
4. Use `gh pr view <number> --json statusCheckRollup,mergeable,reviewDecision` after each fix to observe the state change.

**What to verify:** you can explain from memory what each of the three JSON fields means, what value it had when the PR was broken, and what value it has when the PR is ready to merge.
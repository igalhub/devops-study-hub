---
title: Pipeline Best Practices
module: cicd
duration_min: 20
difficulty: intermediate
tags: [cicd, pipelines, caching, secrets, parallelism, security, shift-left]
exercises: 4
---

## Overview

A CI/CD pipeline is the heartbeat of a DevOps team's delivery process — it's the automated system that validates, builds, and ships code on every change. When pipelines are designed well, they act as a safety net: catching bugs within minutes, blocking insecure dependencies, and deploying to production with zero manual steps. When they're designed poorly, they become a bottleneck — slow builds that developers learn to ignore, flaky tests that get bypassed, and secrets scattered across config files waiting to be leaked. The difference between a good pipeline and a bad one is almost never tooling — it's design decisions.

The guiding principles here are: **fail fast** (surface problems at the earliest, cheapest point), **minimize wall-clock time** (parallelism and caching), **treat secrets as first-class concerns** (not afterthoughts), and **shift quality checks left** (security and correctness checks belong in CI, not post-production). These principles apply regardless of whether you're using GitHub Actions, GitLab CI, Jenkins, CircleCI, or any other platform — the YAML syntax changes, the concepts don't.

In the broader DevOps toolchain, the pipeline is the integration point between source control (Git) and everything downstream: artifact registries, Kubernetes clusters, infrastructure-as-code runners, and monitoring systems. It's also the enforcement point for organizational policies — branch protection, required status checks, and environment-scoped secrets all live here. Understanding pipeline design deeply makes you effective at the intersection of development, operations, and security — which is exactly where senior DevOps engineers spend most of their time.

## Concepts

### Fail Fast: Ordering Jobs by Cost

The fail-fast principle says: **order your pipeline stages so the cheapest, most discriminating checks run first.** A linting error that takes 5 seconds to detect should not sit behind a 10-minute Docker build. Every minute a developer waits for feedback they already know is coming is wasted time — multiplied across every push in a year.

| Stage | Typical duration | What it catches |
|-------|-----------------|-----------------|
| Lint / format check | 10–60 seconds | Syntax errors, style violations, type errors |
| Unit tests | 30 seconds – 3 minutes | Logic errors in isolated code |
| Integration tests | 2–10 minutes | Interactions between components |
| Build (Docker, binary) | 2–10 minutes | Compilation errors, missing deps |
| Security scan | 1–5 minutes | CVEs in dependencies and images |
| Deploy to staging | 2–15 minutes | Environment-specific failures |
| Deploy to production | 2–15 minutes | Final delivery |

```yaml
# GitHub Actions — ordered by speed, each stage gates the next
jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: pip install ruff mypy
      - run: ruff check . && mypy src/   # ~30 seconds

  unit-tests:
    needs: lint                           # doesn't start until lint passes
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: pytest tests/unit/ -n auto   # ~2 minutes

  build:
    needs: unit-tests
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t myapp:${{ github.sha }} .   # ~5 minutes

  deploy:
    needs: build
    environment: production               # requires manual approval if configured
    runs-on: ubuntu-24.04
    steps:
      - run: ./scripts/deploy.sh
```

**The `needs` key is your dependency graph.** Without it, all jobs run in parallel. With it, you create a directed acyclic graph where each node waits for its parents. The optimal pipeline is a DAG — not a linear sequence, and not a flat parallel list.

**Gotcha:** placing everything in `needs: [a, b, c]` makes the job wait for all three. If any one fails, the dependent job is skipped (not failed). Use `if: always()` only when you genuinely need a cleanup step to run regardless of upstream status.

### Caching Strategies

Caching trades disk space and cache management complexity for build speed. The key insight: **a cache key that changes too frequently is useless; one that changes too infrequently causes stale dependency bugs.** The sweet spot is hashing the dependency manifest file — the cache invalidates exactly when dependencies change.

| Ecosystem | What to cache | Key input |
|-----------|--------------|-----------|
| Python (pip) | `~/.cache/pip` | `requirements*.txt` |
| Node.js (npm) | `~/.npm` | `package-lock.json` |
| Node.js (yarn) | `.yarn/cache` | `yarn.lock` |
| Go | `~/go/pkg/mod` | `go.sum` |
| Gradle | `~/.gradle/caches` | `**/*.gradle*`, `gradle-wrapper.properties` |
| Docker layers | GitHub Actions cache or registry | `Dockerfile`, source files |
| Rust (cargo) | `~/.cargo/registry`, `target/` | `Cargo.lock` |

```yaml
# Python — manual cache with fallback restore key
- uses: actions/cache@v4
  with:
    path: ~/.cache/pip
    key: ${{ runner.os }}-pip-${{ hashFiles('requirements*.txt') }}
    restore-keys: |
      ${{ runner.os }}-pip-        # partial match: uses stale cache if exact key misses
                                   # better than no cache at all on first run after dep change

# Node.js — setup-node handles cache automatically
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'                   # caches ~/.npm; key derived from package-lock.json

# Go — setup-go handles cache automatically
- uses: actions/setup-go@v5
  with:
    go-version: '1.24'
    cache: true                    # caches $GOPATH/pkg/mod; key derived from go.sum

# Docker layer cache via BuildKit (most impactful for image-heavy pipelines)
- uses: docker/setup-buildx-action@v3

- uses: docker/build-push-action@v6
  with:
    context: .
    cache-from: type=gha                 # read cache from GitHub Actions cache
    cache-to: type=gha,mode=max          # mode=max caches all intermediate layers
    tags: myapp:${{ github.sha }}
    push: true
```

**Cache poisoning risk:** caches shared across branches can pull in artifacts from untrusted branches. GitHub Actions scopes cache reads to the current branch and the default branch — forks cannot read parent repo caches, which is the right security boundary.

**`restore-keys` behavior:** when the exact key misses, GitHub tries each restore-key prefix in order and uses the most recent matching entry. The job runs with a stale cache, which is usually better than no cache — pip will only download the delta. The new exact-key cache is saved at the end of the job.

### Parallelism and Matrix Builds

Parallelism reduces wall-clock time by running independent work simultaneously. There are two forms: **job-level parallelism** (separate VMs running different jobs) and **matrix builds** (same job running across a grid of parameters).

```yaml
jobs:
  # These three jobs run simultaneously — no `needs` relationship
  unit-tests:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: pytest tests/unit/

  integration-tests:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: pytest tests/integration/

  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: ruff check . && mypy src/

  # This job fans in — waits for all three
  build:
    needs: [unit-tests, integration-tests, lint]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: docker build .
```

**Matrix builds** let you test across versions, operating systems, or configurations without duplicating job definitions:

```yaml
jobs:
  test:
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']
        os: [ubuntu-24.04, windows-latest]
      fail-fast: false    # let all matrix combinations finish even if one fails
                          # critical when debugging: you want to see ALL failures, not just the first
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - run: pytest

  # Matrix exclusions: skip combinations that don't make sense
  test-with-exclusions:
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']
        os: [ubuntu-24.04, windows-latest]
        exclude:
          - os: windows-latest
            python-version: '3.10'   # don't test 3.10 on Windows
```

**`fail-fast: true` (the default):** cancels all in-progress matrix jobs as soon as one fails. Saves runner minutes in production pipelines. **`fail-fast: false`:** lets everything finish — use this in debug sessions when you need to see whether a failure is version-specific.

**Step-level parallelism** isn't natively supported in most CI systems — steps within a job are sequential by design (they share a filesystem). To parallelize at the step level, use background processes (`cmd &`) or tools like `pytest-xdist` that internally distribute work across CPUs.

```yaml
# pytest-xdist: parallel test execution within a single job
- run: pytest -n auto   # auto = number of available CPUs
                        # significant speedup on test suites with 100+ tests
```

### Secrets Hygiene

Secrets mismanagement is one of the most common causes of security incidents in CI/CD. The attack surface is wide: secrets can appear in logs, process lists, environment dumps, artifact files, and PR comments. The principle is **least privilege + minimum exposure surface**.

```yaml
# BAD: secret as CLI argument — visible in ps output and GitHub Actions logs
- run: deploy.sh --token=${{ secrets.API_TOKEN }}

# BAD: echoing a secret (GitHub Actions will mask known secrets in logs,
#      but this is fragile — partial strings may not be masked)
- run: echo "Token is ${{ secrets.API_TOKEN }}"

# GOOD: pass secrets via environment variables — not in command args
- name: Deploy
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }}   # available as $API_TOKEN inside the script
  run: ./scripts/deploy.sh               # script reads os.environ['API_TOKEN']
```

**Secret scoping hierarchy in GitHub Actions:**

| Scope | Where defined | Accessible from |
|-------|--------------|-----------------|
| Repository secret | Repo → Settings → Secrets | All workflows in that repo |
| Environment secret | Repo → Settings → Environments | Workflows that reference that environment |
| Organization secret | Org → Settings → Secrets | Selected repos (configurable) |

**Use environment-scoped secrets for production credentials.** A repository-wide `PROD_DB_PASSWORD` is accessible from any workflow in the repo, including ones triggered by PRs. An environment-scoped secret requires the workflow to explicitly target that environment — and environments can require manual approval.

**OIDC (OpenID Connect) — the right way to authenticate to cloud providers:**

Instead of storing long-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in secrets (which can be leaked and don't auto-expire), use OIDC to exchange a short-lived GitHub-issued token for cloud credentials.

```yaml
# The workflow requests permission to mint an OIDC token
permissions:
  id-token: write    # required for OIDC
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy
          aws-region: us-east-1
          # No stored credentials needed — GitHub presents OIDC token,
          # AWS validates it against the trust policy and issues temporary creds

      - run: aws s3 sync ./dist s3://my-bucket/
```

The corresponding AWS IAM trust policy restricts which repos and branches can assume the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:myorg/myrepo:ref:refs/heads/main"
      }
    }
  }]
}
```

**Additional secrets hygiene rules:**
- Never print `env` or `printenv` in CI without filtering
- Rotate secrets on a schedule, not just after suspected compromise
- Use `gitleaks` or `truffleHog` in CI to scan for accidentally committed secrets
- Audit `GITHUB_TOKEN` permissions — default `write-all` is too broad; use `permissions:` at the workflow level to narrow it

### Shift-Left Testing and Security

"Shift left" means moving testing and security validation earlier in the development lifecycle — into the developer's local workflow and the CI pipeline — rather than catching problems in staging or production. It reduces the cost of fixing issues (bugs found in CI are 10–100x cheaper to fix than bugs found in production) and builds quality into the process rather than bolting it on at the end.

```yaml
jobs:
  quality-gates:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      # 1. Dependency vulnerability scanning
      - name: Scan Python dependencies
        run: |
          pip install pip-audit
          pip-audit -r requirements.txt --fail-on-vuln   # non-zero exit on any CVE

      # 2. SAST — Static Application Security Testing
      - name: Run Bandit (Python SAST)
        run: |
          pip install bandit
          bandit -r src/ -ll -x tests/   # -ll = medium+ severity; -x = exclude tests dir

      # 3. Secret scanning — catch leaked credentials before they're pushed
      - name: Scan for secrets with Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      # 4. Container image scanning (run after build step)
      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: myapp:${{ github.sha }}
          exit-code: '1'              # fail the build
          severity: 'CRITICAL,HIGH'  # ignore LOW/MEDIUM in CI, report separately
          format: 'sarif'
          output: 'trivy-results.sarif'

      # Upload SARIF to GitHub Security tab for tracking
      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'
```

**Severity thresholds are a policy decision, not a technical one.** Failing on `CRITICAL` only means HIGH vulnerabilities accumulate silently. Failing on `LOW` means the pipeline is always red and teams learn to ignore it. Most teams start with `CRITICAL,HIGH` and tighten over time as the backlog is cleared.

**Where to put security scans in the pipeline order:**
- Secret scanning: before any other step (runs on source code)
- Dependency scanning: after dependency install, before build
- SAST: after checkout, can
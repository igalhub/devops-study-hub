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

**The `needs` key is your dependency graph.** Without it, all jobs run in parallel. With it, you create a directed acyclic graph (DAG) where each node waits for its parents. The optimal pipeline is a DAG — not a linear sequence, and not a flat parallel list.

**Gotcha:** listing multiple parents in `needs: [a, b, c]` makes the job wait for all three. If any one fails, the dependent job is skipped by default — it does not itself show as failed in the UI unless you explicitly check. Use `if: always()` only for cleanup jobs that must run regardless of upstream status, not as a general override.

**Gotcha:** avoid putting build and test in the same job to "save checkout time." When they share a job, a test failure blocks artifact creation feedback, and you can't re-run just the build step. Keep them separate — the visibility is worth the overhead.

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
    cache-to: type=gha,mode=max          # mode=max caches all intermediate layers,
                                         # not just the final stage — worth it for multi-stage builds
    tags: myapp:${{ github.sha }}
    push: true
```

**`restore-keys` behavior:** when the exact key misses, GitHub tries each restore-key prefix in order and uses the most recent matching entry. The job runs with a stale cache — pip will only download the delta. The new exact-key cache is saved at the end of the job, replacing the stale entry for future runs.

**Cache poisoning risk:** caches shared across branches can pull in artifacts from untrusted code. GitHub Actions scopes cache reads to the current branch and the default branch — forks cannot read parent repo caches, which is the right security boundary. For self-hosted runners with a shared cache backend, you must enforce this isolation yourself.

**Cache size limits:** GitHub Actions enforces a 10 GB per-repository cache limit. Entries unused for 7 days are evicted. For large monorepos, be selective — cache only what's expensive to rebuild (compiled dependencies, not source files). Bloated caches that exceed the limit evict your most useful entries first.

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

  # Fan-in: waits for all three before proceeding
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
                          # critical when debugging: you want ALL failure data, not just the first
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - run: pytest

  test-with-exclusions:
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']
        os: [ubuntu-24.04, windows-latest]
        exclude:
          - os: windows-latest
            python-version: '3.10'   # skip combinations that aren't supported or relevant
        include:
          - os: ubuntu-24.04
            python-version: '3.12'
            experimental: true       # custom variable accessible as ${{ matrix.experimental }}
```

**`fail-fast: true` (the default):** cancels all in-progress matrix jobs the moment one fails. Saves runner minutes in day-to-day pipelines. **`fail-fast: false`:** lets everything finish — use this when investigating whether a failure is version-specific or OS-specific. You want the full picture.

**Step-level parallelism** isn't natively supported in most CI systems — steps within a job are sequential by design because they share a filesystem. To parallelize at the step level, use background processes or tools designed for it:

```yaml
# pytest-xdist: parallel test execution within a single job
- run: pytest -n auto   # auto = number of available CPUs
                        # significant speedup for test suites with 100+ tests

# Background processes for independent setup steps
- name: Start services in parallel
  run: |
    ./scripts/seed-database.sh &   # runs in background
    ./scripts/warm-cache.sh &      # runs in background
    wait                           # block until both finish before continuing
```

**Cost awareness:** each matrix job consumes a separate runner. A 3×2 matrix = 6 runners running simultaneously. On paid plans this is billed per minute per runner. Profile your actual test suite time before reaching for matrix builds — sometimes a single fast runner with `pytest -n auto` is cheaper and faster than 6 separate VMs with startup overhead.

### Secrets Hygiene

Secrets mismanagement is one of the most common causes of security incidents in CI/CD. The attack surface is wide: secrets can appear in logs, process lists, environment dumps, artifact files, and PR comments. The principle is **least privilege + minimum exposure surface**.

```yaml
# BAD: secret as CLI argument — visible in `ps` output and CI logs
- run: deploy.sh --token=${{ secrets.API_TOKEN }}

# BAD: direct interpolation into shell string — masked in logs but
#      still dangerous; partial strings (e.g., base64 substrings) may not be masked
- run: echo "Deploying with token ${{ secrets.API_TOKEN }}"

# GOOD: pass secrets via environment variables — not embedded in command strings
- name: Deploy
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }}   # available as $API_TOKEN inside the script
  run: ./scripts/deploy.sh               # script reads os.environ['API_TOKEN'] or $API_TOKEN
```

**Secret scoping hierarchy in GitHub Actions:**

| Scope | Where defined | Accessible from |
|-------|--------------|-----------------|
| Repository secret | Repo → Settings → Secrets | All workflows in that repo |
| Environment secret | Repo → Settings → Environments | Workflows targeting that environment only |
| Organization secret | Org → Settings → Secrets | Selected repos (configurable) |

**Use environment-scoped secrets for production credentials.** A repository-wide `PROD_DB_PASSWORD` is accessible from any workflow in the repo, including ones triggered by PRs from forks. An environment-scoped secret requires the workflow to explicitly target that environment — and environments support required reviewers and wait timers as an additional gate.

**OIDC (OpenID Connect) — the right way to authenticate to cloud providers:**

Instead of storing long-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in secrets (which can be leaked, don't auto-expire, and require manual rotation), use OIDC to exchange a short-lived GitHub-issued JWT for cloud credentials that expire within the job's lifetime.

```yaml
permissions:
  id-token: write    # required to request an OIDC token from GitHub
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
          # GitHub presents an OIDC token; AWS validates it against the IAM
          # trust policy and issues temporary STS credentials (~1 hour TTL).
          # No stored long-lived credentials anywhere.

      - run: aws s3 sync ./dist s3://my-bucket/
```

The IAM trust policy locks down which repos and branches can assume the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    },
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

**The `sub` condition is critical.** Without it, any GitHub Actions workflow anywhere could potentially assume your role if the OIDC provider is configured. Lock it to `repo:org/repo:ref:refs/heads/main` for production roles, or `repo:org/repo:*` for dev roles.

**Additional secrets hygiene rules:**
- Never run `printenv` or `env` in CI without output filtering
- Default `GITHUB_TOKEN` permissions are `write-all` in many repos — override at workflow level with `permissions:` to grant only what the workflow needs
- Audit secrets usage with `gitleaks` or `truffleHog` in CI to catch accidentally committed credentials
- Rotate secrets on a schedule, not only after suspected compromise — treat rotation as routine maintenance

### Shift-Left Testing and Security

"Shift left" means moving testing and security validation earlier in the development lifecycle — into CI — rather than catching problems in staging or production. Bugs found in CI are 10–100x cheaper to fix than bugs found post-deployment because the context is fresh, the blast radius is zero, and the feedback loop is minutes rather than days.

```yaml
jobs:
  quality-gates:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # required for gitleaks to scan full commit history

      # 1. Secret scanning — must run first, before anything is executed
      - name: Scan for secrets with Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      # 2. Dependency vulnerability scanning
      - name: Audit Python dependencies
        run: |
          pip install pip-audit
          pip-audit -r requirements.txt --fail-on-vuln   # non-zero exit on any CVE

      # 3. SAST — Static Application Security Testing
      - name: Run Bandit (Python SAST)
        run: |
          pip install bandit
          bandit -r src/ -ll -x tests/   # -ll = medium+ severity; -x = exclude test dir
                                         # adjust severity threshold to match team policy

      # 4. Container image scanning — runs after build produces an image
      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: myapp:${{ github.sha }}
          exit-code: '1'              # fail the build on matching findings
          severity: 'CRITICAL,HIGH'  # LOW/MEDIUM go to the security dashboard, not CI block
          format: 'sarif'
          output: 'trivy-results.sarif'

      - name: Upload results to GitHub Security tab
        uses: github/codeql-action/upload-sarif@v3
        if: always()                  # upload even if Trivy failed the build — you want the data
        with:
          sarif_file: 'trivy-results.sarif'
```

**Severity thresholds are a policy decision, not a technical one.** Failing on `CRITICAL` only means HIGH vulnerabilities accumulate silently. Failing on `LOW` means the pipeline is always red and teams learn to ignore it — alert fatigue is a real security risk. Most teams start with `CRITICAL,HIGH` and tighten over time as the vulnerability backlog is cleared.

**Where to place security scans in pipeline order:**

| Scan type | Run after | Rationale |
|-----------|-----------|-----------|
| Secret scanning | Checkout | Source-code only; must run before secrets are used |
| Dependency audit | `pip install` / `npm ci` | Needs resolved lockfile |
| SAST | Checkout | Static analysis; no runtime needed |
| Container image scan | `docker build` | Needs the built image to exist |
| DAST (dynamic) | Deploy to staging | Needs a running application |

**Pre-commit hooks extend shift-left to the developer's machine:**

```bash
# Install pre-commit (Python tool that manages hooks)
pip install pre-commit

# .pre-commit-config.yaml — checked into the repo
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.4
    hooks:
      - id: gitleaks        # blocks commit if secrets detected

  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.4.4
    hooks:
      - id: ruff            # lint on commit
      - id: ruff-format     # format on commit

  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.10.0
    hooks:
      - id: mypy            # type check on commit
```

```bash
pre-commit install          # installs hooks into .git/hooks/pre-commit
pre-commit run --all-files  # run manually against all files (useful in CI too)
```

**Pre-commit in CI:** run `pre-commit run --all-files` as a CI step. This ensures developers who skipped hook installation are still caught. It also documents exactly what local checks are expected, making onboarding reproducible.

### Pipeline Idempotency and Artifact Management

A well-designed pipeline is **idempotent** — running it twice on the same commit produces the same result without side effects. This matters for re-runs after flaky failures, rollback scenarios, and debugging.

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      # Tag images with the Git SHA, not "latest"
      # "latest" is mutable — you can't reliably re-run a pipeline that used it
      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          tags: |
            myregistry/myapp:${{ github.sha }}
            myregistry/myapp:latest          # also tag latest for convenience,
                                             # but deploy by SHA, not by latest

      # Upload build artifacts for downstream jobs to consume
      # Avoids rebuilding the same binary in each job
      - name: Upload dist
        uses: actions/upload-artifact@v4
        with:
          name: dist-${{ github.sha }}
          path: dist/
          retention-days: 7   # don't keep artifacts forever; storage costs money

  deploy:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - name: Download dist
        uses: actions/download-artifact@v4
        with:
          name: dist-${{ github.sha }}
          path: dist/

      - name: Deploy
        run: ./scripts/deploy.sh dist/
```

**Artifact retention policy:** keep artifacts long enough to support incident investigation and rollback (7–30 days is typical). Indefinite retention creates storage costs and compliance surface area. For release artifacts that must be retained permanently, promote them to a proper artifact registry (ECR, Artifactory, GitHub Packages) rather than relying on CI artifact storage.

**Immutable artifact principle:** once an artifact is built from a specific commit SHA, never rebuild it for a different purpose. If you deploy the same SHA to staging and production, you're deploying the same binary — not a fresh build that might behave differently. This is the single most important property for safe rollbacks.

---

## Examples

### Example 1: Complete Python Web Service Pipeline

This pipeline covers the full lifecycle for a Python Flask application: lint, test, build, scan, and deploy to a staging environment on every PR, and to production on merge to `main`.

```yaml
# .github/workflows/ci-cd.yml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Narrow default permissions — grant only what each job needs
permissions:
  contents: read

env:
  IMAGE_NAME: myregistry/flask-app

jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Cache pip
        uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          key: ${{ runner.os }}-pip-${{ hashFiles('requirements*.txt') }}
          restore-keys: ${{ runner.os }}-pip-
      - run: pip install ruff mypy
      - run: ruff check . && mypy src/

  test:
    needs: lint
    runs-on: ubuntu-24.04
    strategy:
      matrix:
        python-version: ['3.11', '3.12']
      fail-fast: false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - name: Cache pip
        uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          key: ${{ runner.os }}-pip-${{ matrix.python-version }}-${{ hashFiles('requirements*.txt') }}
      - run: pip install -r requirements.txt -r requirements-dev.txt
      - run: pytest tests/ -n auto --cov=src --cov-report=xml
      - uses: actions/upload-artifact@v4
        with:
          name: coverage-${{ matrix.python-version }}
          path: coverage.xml

  build:
    needs: test
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write    # needed to push to GitHub Container Registry
    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=sha,format=long   # always tag by SHA for immutability
            type=ref,event=branch  # also tag by branch name for convenience
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  security-scan:
    needs: build
    runs-on: ubuntu-24.04
    permissions:
      security-events: write   # required to upload SARIF results
    steps:
      - uses: aquasecurity/trivy-action@master
        with:
          image-ref: ghcr.io/${{ github.repository }}:sha-${{ github.sha }}
          format: sarif
          output: trivy.sarif
          severity: CRITICAL,HIGH
          exit-code: '1'
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy.sarif

  deploy-staging:
    needs: security-scan
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-24.04
    environment: staging
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_STAGING_ROLE_ARN }}
          aws-region: us-east-1
      - run: |
          # Update the ECS task definition to use the new image SHA
          ./scripts/ecs-deploy.sh \
            --cluster staging \
            --service flask-app \
            --image ghcr.io/${{ github.repository }}:sha-${{ github.sha }}

  deploy-production:
    needs: security-scan
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-24.04
    environment: production    # requires manual approval from a reviewer
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}
          aws-region: us-east-1
      - run: |
          ./scripts/ecs-deploy.sh \
            --cluster production \
            --service flask-app \
            --image ghcr.io/${{ github.repository }}:sha-${{ github.sha }}
```

**Verify it worked:**
1. Open the Actions tab — you should see jobs fan out in DAG order: lint → test (matrix) → build → security-scan → deploy.
2. For PRs, verify the staging deploy ran but production deploy was skipped.
3. For merges to `main`, verify production deploy was gated by environment approval.
4. Check the Security tab for Trivy SARIF results uploaded under "Code scanning alerts."

---

### Example 2: Node.js Monorepo with Affected-Package Detection

In a monorepo, running all tests on every commit is wasteful. This pipeline detects which packages changed and only tests those.

```yaml
name: Monorepo CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  detect-changes:
    runs-on: ubuntu-24.04
    outputs:
      api-changed: ${{ steps.filter.outputs.api }}
      web-changed: ${{ steps.filter.outputs.web }}
      shared-changed: ${{ steps.filter.outputs.shared }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            api:
              - 'packages/api/**'
              - 'packages/shared/**'   # api depends on shared
            web:
              - 'packages/web/**'
              - 'packages/shared/**'   # web also depends on shared
            shared:
              - 'packages/shared/**'

  test-api:
    needs: detect-changes
    if: needs.detect-changes.outputs.api-changed == 'true'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test --workspace=packages/api

  test-web:
    needs: detect-changes
    if: needs.detect-changes.outputs.web-changed == 'true'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test --workspace=packages/web

  # This job is the required status check on branch protection.
  # It always passes if all relevant test jobs passed (or were skipped).
  ci-complete:
    needs: [test-api, test-web]
    if: always()
    runs-on: ubuntu-24.04
    steps:
      - name: Check all jobs passed
        run: |
          if [[ "${{ needs.test-api.result }}" == "failure" || \
                "${{ needs.test-web.result }}" == "failure" ]]; then
            echo "One or more test jobs failed"
            exit 1
          fi
          echo "All relevant tests passed or were skipped"
```

**Verify it worked:**
- Modify only `packages/api/` — confirm `test-web` is skipped, `test-api` runs.
- Modify `packages/shared/` — confirm both `test-api` and `test-web` run.
- Check that branch protection's required status check (`ci-complete`) is green in both cases.

---

### Example 3: Preventing Secret Leaks with Gitleaks and Pre-commit

This example sets up both a local pre-commit gate and a CI gate against secret leakage.

```bash
# 1. Install pre-commit locally
pip install pre-commit

# 2. Create .pre-commit-config.yaml at repo root
cat > .pre-commit-config.yaml << 'EOF'
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.4
    hooks:
      - id: gitleaks
        name: Detect hardcoded secrets

  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.4.4
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format
EOF

# 3. Install hooks into the local repo
pre-commit install

# 4. Verify by attempting to commit a fake secret
echo 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' > test-secret.txt
git add test-secret.txt
git commit -m "test"
# Expected: gitleaks hook blocks the commit and prints the finding

# 5. Clean up
rm test-secret.txt
git restore --staged test-secret.txt 2>/dev/null || true
```

```yaml
# .github/workflows/secrets-scan.yml — CI gate that catches what pre-commit missed
name: Secret Scan

on: [push, pull_request]

jobs:
  gitleaks:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # scan full history, not just the latest commit
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        # Exits non-zero and prints findings if any secrets are detected
        # Findings appear in the Actions log with file, line, and rule name
```

**Verify it worked:**
- Push a commit containing a dummy AWS key pattern — gitleaks should fail the CI job.
- Check the Actions log for the finding report showing file path and rule that matched.
- Add a `.gitleaks.toml` to allowlist known false positives (e.g., test fixture files) rather than disabling the scan globally.

---

## Exercises

### Exercise 1: Convert a Sequential Pipeline to a DAG

**Goal:** practice pipeline dependency modeling and measure the wall-clock improvement.

Take this fully sequential pipeline and restructure it as an optimal DAG. Then calculate the theoretical minimum wall-clock time before and after.

```yaml
# Starting point — everything sequential, total time: ~22 minutes
jobs:
  lint:        # 1 min
    steps: [...]
  unit-tests:  # 3 min
    needs: lint
    steps: [...]
  integration: # 5 min
    needs: unit-tests
    steps: [...]
  sast:        # 2 min
    needs: integration
    steps: [...]
  build:       # 4 min
    needs: sast
    steps: [...]
  deploy:      # 7 min
    needs: build
    steps: [...]
```

Tasks:
1. Identify which jobs have true dependencies (need output from a prior job) vs. which are just ordered for convention.
2. Redraw the pipeline as a DAG in your YAML. `lint`, `unit-tests`, `integration`, and `sast` can all be considered independent quality gates — only `deploy` strictly needs `build`, and `build` needs all gates to pass.
3. Calculate the minimum wall-clock time of your new DAG.
4. Add a `ci-complete` fan-in job (like Example 2) that a branch protection rule could target.

**Expected outcome:** wall-clock time drops from ~22 minutes to approximately 8 minutes (build after all parallel gates + deploy).

---

### Exercise 2: Implement and Measure Caching

**Goal:** quantify the impact of dependency caching on a real build.

```bash
# Setup: create a Python project with non-trivial dependencies
mkdir cache-lab && cd cache-lab
git init

cat > requirements.txt << 'EOF'
flask==3.0.3
sqlalchemy==2.0.30
boto3==1.34.114
pandas==2.2.2
pytest==8.2.0
EOF

cat > test_app.py << 'EOF'
def test_imports():
    import flask, sqlalchemy, boto3, pandas
    assert True
EOF
```

Tasks:
1. Create a GitHub Actions workflow that runs `pip install -r requirements.txt && pytest` **without** caching. Note the job duration in the Actions UI.
2. Add `actions/cache@v4` with a key based on `hashFiles('requirements.txt')`. Re-run the workflow. Note the duration on cache miss (first run) vs. cache hit (second run).
3. Modify `requirements.txt` by bumping one version. Confirm the cache misses (new key) and the packages are re-downloaded.
4. Add `restore-keys` so a cache miss still benefits from the most recent partial match. Verify in the "Cache" step log that it falls back to the stale entry on a key miss.

**Expected outcome:** cache hit should reduce `pip install` time from 60–90 seconds to under 5 seconds.

---

### Exercise 3: Scope Secrets to Environments

**Goal:** understand the difference between repository secrets and environment-scoped secrets by observing what a PR workflow can and cannot access.

Tasks:
1. In your repository's Settings, create a **repository secret** called `TEST_REPO_SECRET` with value `repo-level-value`.
2. Create an **environment** called `production`. Add an **environment secret** called `TEST_ENV_SECRET` with value `env-level-value`. Enable "Required reviewers" and add yourself.
3. Write a workflow with two jobs:
   - `test-repo-secret`: runs on `pull_request`, prints whether `TEST_REPO_SECRET` is set (use `echo "Secret is set: ${{ secrets.TEST_REPO_SECRET != '' }}"`)
   - `test-env-secret`: targets `environment: production`, prints whether `TEST_ENV_SECRET` is set
4. Open a PR and observe: `test-repo-secret` should succeed immediately. `test-env-secret` should be blocked waiting for your approval as a required reviewer.
5. Approve the environment deployment and observe the secret becomes accessible.

**Expected outcome:** you directly observe that environment secrets require explicit targeting and optional human approval — repository secrets do not.

---

### Exercise 4: Add Shift-Left Security Scanning to an Existing Workflow

**Goal:** integrate dependency scanning and image scanning into a pipeline and tune severity thresholds.

Tasks:
1. Take any existing workflow that builds a Docker image (or create one that runs `docker build`).
2. Add a `pip-audit` step that runs before the build. Introduce a known-vulnerable package temporarily (e.g., `flask==2.2.0` has known CVEs) and confirm the step fails. Then restore a clean version.
3. After the build step, add `aquasecurity/trivy-action` scanning the built image. Configure it to fail on `CRITICAL,HIGH` and output SARIF.
4. Add `github/codeql-action/upload-sarif` with `if: always()` to upload results even when Trivy fails the build.
5. Navigate to the Security tab → Code scanning alerts in your repository and confirm the Trivy findings appear there.
6. Add a `.trivyignore` file to suppress one specific CVE by ID (look up the CVE ID from the scan output). Verify the suppressed CVE no longer fails the build but still appears in the SARIF report.

**Expected outcome:** you have a working security gate, understand how to tune it without disabling it, and know where findings are tracked for remediation tracking.

---

### Quick Checks

7. Count secrets referenced in a workflow environment block. Run: `printf 'env:\n  DB_PASS: ${{ secrets.DB_PASSWORD }}\n  API_KEY: ${{ secrets.API_KEY }}\n  TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n' | grep -c 'secrets\.'`

```expected_output
3
```

8. Calculate percentage of build time saved by caching. Run: `python3 -c "print(int((120-15)/120*100))"`

```expected_output
87
```

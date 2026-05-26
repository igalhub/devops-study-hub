---
title: Pipeline Best Practices
module: cicd
duration_min: 20
difficulty: intermediate
tags: [cicd, pipelines, caching, secrets, parallelism, security, shift-left]
exercises: 4
---

## Overview
A well-designed pipeline gives fast feedback, protects secrets, and fails loudly on real problems — not false positives from flaky infrastructure. This lesson covers the patterns that make pipelines fast, secure, and trustworthy: caching, parallelism, secrets hygiene, shift-left testing, and notification design.

## Concepts

### Fail Fast
Put cheap, fast checks first. Don't wait 20 minutes for a build to fail on a linting error that takes 5 seconds to detect.

```yaml
# GitHub Actions — ordered by speed (fastest first)
jobs:
  lint:           # ~30 seconds — fail fast
    steps:
      - run: ruff check . && mypy src/

  test:           # ~2 minutes
    needs: lint
    steps:
      - run: pytest

  build:          # ~5 minutes
    needs: test
    steps:
      - run: docker build ...

  deploy:         # only after all the above
    needs: build
    environment: production
```

### Caching Strategies

**Python (pip)**
```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/pip
    key: ${{ runner.os }}-pip-${{ hashFiles('requirements*.txt') }}
    restore-keys: |
      ${{ runner.os }}-pip-
```

**Node.js (npm)**
```yaml
# actions/setup-node has built-in caching:
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'             # caches ~/.npm automatically
```

**Docker layer cache (GitHub Actions)**
```yaml
- uses: docker/setup-buildx-action@v3

- uses: docker/build-push-action@v6
  with:
    context: .
    cache-from: type=gha          # GitHub Actions cache
    cache-to: type=gha,mode=max
    tags: myapp:${{ github.sha }}
    push: true
```

**Go**
```yaml
- uses: actions/setup-go@v5
  with:
    go-version: '1.24'
    cache: true              # caches $GOPATH/pkg/mod
```

### Parallelism
Run independent jobs and steps concurrently to minimize wall-clock time:

```yaml
jobs:
  # These three run simultaneously:
  unit-tests:
    runs-on: ubuntu-24.04
    steps: [...]

  integration-tests:
    runs-on: ubuntu-24.04
    steps: [...]

  lint-and-typecheck:
    runs-on: ubuntu-24.04
    steps: [...]

  # This waits for all three:
  build:
    needs: [unit-tests, integration-tests, lint-and-typecheck]
    steps: [...]
```

Use `fail-fast: false` in matrix builds when you want all matrix combinations to complete even if one fails — useful when debugging cross-version failures.

### Secrets Hygiene
```yaml
# Never hardcode secrets. Never echo them. Never pass them as positional args.
# Bad:
run: deploy.sh --token=${{ secrets.TOKEN }}   # shows up in ps output

# Good:
env:
  API_TOKEN: ${{ secrets.TOKEN }}
run: deploy.sh   # script reads $API_TOKEN from environment
```

**Principles:**
- Scope secrets to the minimum: use environment-scoped secrets for prod credentials (not repo-wide)
- Use OIDC instead of long-lived credentials where supported (AWS, GCP, Azure)
- Rotate secrets on a schedule — not just on compromise
- Audit which workflows have access to which secrets

**OIDC for AWS (no stored credentials)**
```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789:role/github-actions-role
      aws-region: us-east-1
  # AWS credentials are now available without storing ACCESS_KEY/SECRET in secrets
```

### Shift-Left Testing
Run security and quality checks in CI, not as an afterthought:

```yaml
jobs:
  security:
    steps:
      # Dependency vulnerability scan
      - name: Audit Python packages
        run: pip-audit -r requirements.txt

      # Container image scan
      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'myapp:${{ github.sha }}'
          exit-code: '1'
          severity: 'CRITICAL,HIGH'

      # SAST (static analysis security testing)
      - name: Run Bandit
        run: bandit -r src/ -ll   # flag medium+ severity
```

### Pinning Action Versions
```yaml
# Bad — "latest" can introduce breaking changes silently
- uses: actions/checkout@main

# Good — pin to a specific SHA for security and reproducibility
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
```

Pinning to a commit SHA prevents a compromised or changed action from running different code. Use Dependabot to automate updates.

### Idempotent Deployments
Every deployment step should be safe to re-run:
```bash
# Idempotent: kubectl apply always works, even if resource exists
kubectl apply -f deployment.yaml

# Not idempotent: will fail if namespace already exists
kubectl create namespace production

# Fix: use --dry-run or check first
kubectl create namespace production --dry-run=client -o yaml | kubectl apply -f -
```

### Pipeline as Code Review
Treat Jenkinsfiles and workflow YAML with the same rigor as application code:
- Require PRs and code review for pipeline changes
- Don't allow untrusted code paths to access production secrets
- In GitHub Actions: `pull_request` event from forks does NOT have access to secrets — by design

### Notification Design
Alert on failures, not on every run:
```yaml
post {
  failure {
    slackSend(
      channel: '#deployments',
      color: 'danger',
      message: "Build ${env.JOB_NAME} #${env.BUILD_NUMBER} FAILED — ${env.BUILD_URL}"
    )
  }
  success {
    // Only notify on recovery (first success after failure)
    script {
      if (currentBuild.previousBuild?.result == 'FAILURE') {
        slackSend(channel: '#deployments', color: 'good', message: "Build recovered")
      }
    }
  }
}
```

## Examples

### Pipeline Performance Checklist
```bash
# Measure where time is actually spent:
# 1. Check job timings in GitHub Actions → workflow run → job summary
# 2. Look for:
#    - Cache misses (cache key too narrow or too broad)
#    - Sequential steps that could be parallel
#    - Large `git clone` (use --depth=1 via actions/checkout's fetch-depth: 1)
#    - Slow Docker builds (missing BuildKit cache)
#    - Test suite without parallelism (pytest-xdist: pytest -n auto)
```

```yaml
# Shallow clone (faster for large repos)
- uses: actions/checkout@v4
  with:
    fetch-depth: 1   # only latest commit, no full history

# Parallel pytest (install pytest-xdist)
- run: pytest -n auto   # uses all available CPUs
```

## Exercises

1. Audit an existing workflow for fail-fast order: move lint before tests, tests before build, build before deploy. Measure the time savings when lint fails by comparing run duration before and after.
2. Implement OIDC-based AWS credentials in a GitHub Actions workflow (no stored `AWS_ACCESS_KEY_ID`). Create the corresponding IAM role with a trust policy scoped to your repo and branch.
3. Add a container image security scan using `aquasecurity/trivy-action`. Configure it to fail the build on any CRITICAL vulnerability. Test by building an image with a known vulnerable base.
4. Add pipeline notifications: post to a Slack webhook on failure only, including the job name, run number, and a link to the run. Use `if: failure()` in GitHub Actions or `post { failure {} }` in Jenkins.

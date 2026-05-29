---
title: GitHub Actions
module: cicd
duration_min: 30
difficulty: intermediate
tags: [cicd, github-actions, workflows, runners, secrets, matrix, caching]
exercises: 4
---

## Overview
GitHub Actions is the CI/CD platform built into GitHub. Workflows live in `.github/workflows/` and run on push, pull request, schedule, or manual trigger. Every job gets a fresh runner; steps inside a job share the same filesystem and environment. Understanding the job/step model, caching, and secrets handling is enough to build production-grade pipelines.

## Concepts

### Workflow Structure
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'        # every Monday at 06:00 UTC
  workflow_dispatch:             # allow manual trigger from the UI

jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Run tests
        run: pytest --tb=short
```

### Runners
```yaml
# GitHub-hosted (free tier: 2000 min/month for public repos)
runs-on: ubuntu-24.04
runs-on: ubuntu-22.04
runs-on: macos-14
runs-on: windows-2022

# Self-hosted (your own machine registered as a runner)
runs-on: self-hosted
runs-on: [self-hosted, linux, x64, gpu]
```

Self-hosted runners give you control over hardware, software, and network access — useful for accessing private infrastructure or needing specific hardware.

### Secrets and Environment Variables
```yaml
jobs:
  deploy:
    runs-on: ubuntu-24.04
    env:
      APP_ENV: production         # workflow-level env var

    steps:
      - name: Deploy
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
        run: |
          aws s3 sync ./dist s3://my-bucket
```

Secrets are set in **Settings → Secrets and variables → Actions**. They're masked in logs and never passed to workflows triggered by forks (for security).

### Caching
```yaml
- name: Cache pip packages
  uses: actions/cache@v4
  with:
    path: ~/.cache/pip
    key: ${{ runner.os }}-pip-${{ hashFiles('requirements.txt') }}
    restore-keys: |
      ${{ runner.os }}-pip-

- name: Cache Node modules
  uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('package-lock.json') }}
```

Cache key includes a hash of the lockfile — cache busts automatically when dependencies change.

### Artifacts
```yaml
- name: Build
  run: npm run build

- name: Upload build artifact
  uses: actions/upload-artifact@v4
  with:
    name: dist
    path: dist/
    retention-days: 7

# In a later job: download it
- uses: actions/download-artifact@v4
  with:
    name: dist
    path: ./dist
```

### Matrix Builds
```yaml
jobs:
  test:
    runs-on: ubuntu-24.04
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']
        os: [ubuntu-24.04, macos-14]
      fail-fast: false   # don't cancel other matrix jobs on first failure
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
```

### Job Dependencies
```yaml
jobs:
  test:
    runs-on: ubuntu-24.04
    steps: [...]

  build:
    needs: test          # only runs if 'test' passes
    runs-on: ubuntu-24.04
    steps: [...]

  deploy:
    needs: [test, build]   # waits for both
    runs-on: ubuntu-24.04
    steps: [...]
```

### Environments and Approvals
```yaml
jobs:
  deploy-prod:
    runs-on: ubuntu-24.04
    environment:
      name: production
      url: https://myapp.com   # shown in the GitHub UI
    steps:
      - run: ./deploy.sh
```

Configure the `production` environment in **Settings → Environments** to require manual approval from specific reviewers before the job runs.

### Reusable Workflows
```yaml
# .github/workflows/reusable-test.yml
on:
  workflow_call:
    inputs:
      python-version:
        required: true
        type: string
    secrets:
      CODECOV_TOKEN:
        required: true

jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ inputs.python-version }}
```

```yaml
# Call it from another workflow:
jobs:
  run-tests:
    uses: ./.github/workflows/reusable-test.yml
    with:
      python-version: '3.12'
    secrets:
      CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}
```

### Conditional Steps
```yaml
- name: Deploy to prod
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  run: ./deploy.sh

- name: Notify on failure
  if: failure()
  run: ./notify-slack.sh "Pipeline failed"

- name: Always clean up
  if: always()
  run: docker compose down
```

## Examples

### Full CI/CD Pipeline
```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          key: ${{ runner.os }}-pip-${{ hashFiles('requirements*.txt') }}

      - run: pip install -r requirements.txt -r requirements-dev.txt
      - run: pytest --tb=short --cov=src --cov-report=xml
      - run: ruff check .

  build:
    needs: test
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker image
        run: |
          docker build -t myapp:${{ github.sha }} .

      - name: Push to ECR
        if: github.ref == 'refs/heads/main'
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          aws ecr get-login-password --region us-east-1 \
            | docker login --username AWS --password-stdin ${{ secrets.ECR_REGISTRY }}
          docker tag myapp:${{ github.sha }} ${{ secrets.ECR_REGISTRY }}/myapp:${{ github.sha }}
          docker push ${{ secrets.ECR_REGISTRY }}/myapp:${{ github.sha }}

  deploy:
    needs: build
    runs-on: ubuntu-24.04
    environment: production
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to EKS
        env:
          KUBECONFIG_DATA: ${{ secrets.KUBECONFIG_BASE64 }}
        run: |
          echo "$KUBECONFIG_DATA" | base64 -d > ~/.kube/config
          kubectl set image deployment/myapp app=${{ secrets.ECR_REGISTRY }}/myapp:${{ github.sha }}
          kubectl rollout status deployment/myapp
```

## Exercises

1. Write a workflow that triggers on push to `main` and on pull requests. It should run `pytest` with Python 3.11 and 3.12 in a matrix. Use `actions/cache` for pip packages keyed to the hash of `requirements.txt`.
2. Add a Docker build-and-push job that runs only on pushes to `main` (not PRs). Push the image to GitHub Container Registry (`ghcr.io`) using `GITHUB_TOKEN` for auth. Tag it with the commit SHA.
3. Create a deployment job with an `environment: production` gate requiring manual approval. The job should only run after successful test and build jobs, and only on the `main` branch.
4. Write a reusable workflow that accepts `python-version` as an input and runs linting + tests. Call it from a main workflow with two different Python versions.


---

### Quick Checks

5. Count jobs in a workflow stub. Run: `printf 'jobs:\n  build:\n    runs-on: ubuntu-latest\n  test:\n    runs-on: ubuntu-latest\n  deploy:\n    runs-on: ubuntu-latest\n' | awk '/^  [a-z]/ && !/^    /{c++} END{print c}'`

```expected_output
3
```

6. Count steps in a workflow job. Run: `printf 'steps:\n  - uses: actions/checkout@v4\n  - run: npm ci\n  - run: npm test\n  - run: npm run build\n' | grep -c '  - '`

```expected_output
4
```

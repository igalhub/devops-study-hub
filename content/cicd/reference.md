# CI/CD Pipelines — Quick Reference

## GitHub Actions CLI (gh)

| Command | Description |
|---------|-------------|
| `gh workflow list` | List workflows |
| `gh workflow run name.yml` | Trigger workflow manually |
| `gh run list` | List recent workflow runs |
| `gh run view ID` | View run details |
| `gh run watch ID` | Watch run in progress |
| `gh run download ID` | Download run artifacts |
| `gh secret list` | List repository secrets |
| `gh secret set NAME` | Set a secret (prompts) |
| `gh variable list` | List Actions variables |
| `gh cache list` | List runner cache entries |
| `gh cache delete KEY` | Delete cache entry |

## GitHub Actions — Key Workflow Patterns

```yaml
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:          # Manual trigger
  schedule:
    - cron: '0 2 * * *'      # Nightly at 2am UTC

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      APP_ENV: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: pip
      - run: pip install -r requirements.txt
      - run: pytest
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

## GitHub Actions — Common Patterns

| Pattern | Description |
|---------|-------------|
| `${{ secrets.MY_SECRET }}` | Reference secret |
| `${{ vars.MY_VAR }}` | Reference variable |
| `${{ github.ref_name }}` | Current branch/tag name |
| `${{ github.sha }}` | Current commit SHA |
| `needs: [job1, job2]` | Wait for other jobs |
| `if: github.ref == 'refs/heads/main'` | Condition on step/job |
| `continue-on-error: true` | Don't fail job on step failure |
| `timeout-minutes: 10` | Job timeout |
| `strategy.matrix` | Parallel matrix builds |
| `environment: production` | Require deployment approval |
| `concurrency: ci-${{ github.ref }}` | Cancel older runs |

## Jenkins — Pipeline (Declarative)

```groovy
pipeline {
  agent any
  environment { APP_ENV = 'prod' }
  stages {
    stage('Build') {
      steps { sh 'make build' }
    }
    stage('Test') {
      steps { sh 'make test' }
      post { always { junit 'reports/*.xml' } }
    }
    stage('Deploy') {
      when { branch 'main' }
      steps { sh 'make deploy' }
    }
  }
  post {
    failure { slackSend message: "Build failed: ${env.BUILD_URL}" }
  }
}
```

## Jenkins CLI

| Command | Description |
|---------|-------------|
| `java -jar jenkins-cli.jar -s URL build JOB` | Trigger build |
| `java -jar jenkins-cli.jar -s URL list-jobs` | List jobs |
| `java -jar jenkins-cli.jar -s URL console JOB` | View console output |
| `java -jar jenkins-cli.jar -s URL get-job JOB` | Export job XML |
| `jenkins-jobs update jobs/` | Apply JJB configs |

## ArgoCD CLI

| Command | Description |
|---------|-------------|
| `argocd login host` | Login to ArgoCD |
| `argocd app list` | List applications |
| `argocd app get name` | Application status |
| `argocd app sync name` | Sync app to git state |
| `argocd app diff name` | Show drift from desired state |
| `argocd app rollback name REVISION` | Roll back to revision |
| `argocd app history name` | Rollout history |

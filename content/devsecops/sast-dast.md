---
title: SAST and DAST
module: devsecops
duration_min: 20
difficulty: intermediate
tags: [devsecops, sast, dast, security-testing, bandit, semgrep, zap, owasp, ci]
exercises: 4
---

## Overview
SAST (Static Application Security Testing) analyzes source code without running it — it catches hardcoded secrets, SQL injection patterns, insecure function calls, and known-vulnerable code paths at commit time. DAST (Dynamic Application Security Testing) attacks a running application like an external attacker would — it finds issues that only appear at runtime: authentication bypasses, XSS, misconfigured headers, exposed endpoints. Both belong in CI/CD; neither replaces the other.

## Concepts

### SAST — Static Analysis

#### Bandit (Python)
```bash
pip install bandit

# Scan a Python project
bandit -r src/

# Only report medium and high severity
bandit -r src/ -l   # -l = low severity only
bandit -r src/ -ll  # medium and above

# Output formats
bandit -r src/ -f json -o bandit-report.json

# Skip specific checks (use sparingly)
bandit -r src/ --skip B105,B106   # skip hardcoded password checks

# Suppress a specific finding inline
password = get_from_vault()  # nosec B105
```

Common Bandit findings to know:
```
B101 — assert used (disabled in optimized mode, don't use for security checks)
B105 — hardcoded password string
B110 — try/except/pass (swallowing exceptions)
B201 — Flask debug=True
B301 — pickle.loads (unsafe deserialization)
B324 — md5/sha1 used for hashing (use sha256+)
B501 — SSL certificate verification disabled
B608 — SQL injection via string formatting
```

#### Semgrep
Semgrep is a cross-language static analysis tool with a large community rule set:

```bash
pip install semgrep

# Run with auto-detected language rules
semgrep --config=auto src/

# Run OWASP Top 10 rules
semgrep --config="p/owasp-top-ten" src/

# Run Python security rules
semgrep --config="p/python" src/

# Run secrets detection
semgrep --config="p/secrets" .

# Output as SARIF (uploads to GitHub Security tab)
semgrep --config=auto --sarif --output=semgrep.sarif src/

# Fail CI on any finding
semgrep --config=auto --error src/
```

Writing a custom Semgrep rule:
```yaml
# rules/no-raw-sql.yml
rules:
  - id: no-raw-sql-format
    patterns:
      - pattern: |
          cursor.execute("..." % ...)
      - pattern: |
          cursor.execute("..." + ...)
    message: "SQL injection risk: use parameterized queries instead"
    severity: ERROR
    languages: [python]
```

```bash
semgrep --config=rules/no-raw-sql.yml src/
```

#### Secret Scanning
```bash
# Gitleaks — scan git history for committed secrets
brew install gitleaks   # or download from GitHub releases

# Scan current repo
gitleaks detect --source .

# Scan a specific commit range
gitleaks detect --source . --log-opts "main..HEAD"

# Pre-commit hook integration
cat > .pre-commit-config.yaml <<'EOF'
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
EOF
```

#### SAST in GitHub Actions
```yaml
name: Security Scan

on: [push, pull_request]

jobs:
  sast:
    runs-on: ubuntu-24.04
    permissions:
      security-events: write   # required for uploading SARIF

    steps:
      - uses: actions/checkout@v4

      - name: Run Bandit
        run: |
          pip install bandit
          bandit -r src/ -f json -o bandit.json --exit-zero
          # exit-zero: don't fail here, upload results instead

      - name: Run Semgrep
        uses: semgrep/semgrep-action@v1
        with:
          config: p/owasp-top-ten p/secrets
        env:
          SEMGREP_APP_TOKEN: ${{ secrets.SEMGREP_APP_TOKEN }}
```

### DAST — Dynamic Analysis

#### OWASP ZAP
ZAP (Zed Attack Proxy) is the most widely used open-source DAST tool. It proxies HTTP traffic and actively tests for vulnerabilities:

```bash
# Run a baseline scan against a running app (passive scan only — safe for CI)
docker run --rm zaproxy/zap-stable zap-baseline.py \
  -t https://myapp.example.com \
  -J zap-report.json

# Run a full active scan (aggressive — don't run against production)
docker run --rm zaproxy/zap-stable zap-full-scan.py \
  -t https://staging.myapp.example.com \
  -J zap-report.json \
  -I   # ignore failures (don't exit non-zero)

# API scan (using an OpenAPI spec)
docker run --rm zaproxy/zap-stable zap-api-scan.py \
  -t https://staging.myapp.example.com/openapi.json \
  -f openapi \
  -J zap-report.json
```

**Scan types:**
- `zap-baseline.py` — passive scan, no attacks, safe against any environment
- `zap-full-scan.py` — active attack scan, may create/modify data, run against staging only
- `zap-api-scan.py` — targeted API testing using OpenAPI/Swagger/GraphQL definitions

#### ZAP in GitHub Actions
```yaml
jobs:
  dast:
    runs-on: ubuntu-24.04
    services:
      app:
        image: myapp:${{ github.sha }}
        ports:
          - 8000:8000

    steps:
      - name: Wait for app to start
        run: |
          until curl -sf http://localhost:8000/health; do sleep 2; done

      - name: ZAP Baseline Scan
        uses: zaproxy/action-baseline@v0.12.0
        with:
          target: 'http://localhost:8000'
          fail_action: false   # don't fail the build on findings (alert only)
          artifact_name: zap-report
```

### OWASP Top 10 (What You're Testing For)
```
A01 — Broken Access Control        (can user A access user B's data?)
A02 — Cryptographic Failures       (HTTP not HTTPS, weak ciphers, MD5 passwords)
A03 — Injection                    (SQL, command, LDAP injection via untrusted input)
A04 — Insecure Design              (missing rate limits, flawed business logic)
A05 — Security Misconfiguration    (default passwords, debug mode on, verbose errors)
A06 — Vulnerable Components        (outdated packages with known CVEs)
A07 — Authentication Failures      (weak passwords, no MFA, session fixation)
A08 — Software Integrity Failures  (unsigned dependencies, insecure CI pipelines)
A09 — Logging Failures             (no audit trail, logging sensitive data)
A10 — SSRF                         (server making requests to attacker-controlled URLs)
```

### Integrating into CI: Shift-Left
```yaml
# Prioritized security gates in CI:

# Gate 1 (on every commit — fast, <60s):
# - Gitleaks: detect committed secrets
# - Bandit: critical Python security issues
# - Semgrep: OWASP top 10 patterns

# Gate 2 (on PR — moderate speed):
# - Trivy: container image CVE scan
# - Dependency audit: pip-audit, npm audit

# Gate 3 (on staging deploy — slow, minutes):
# - ZAP baseline scan: passive web app scan
# - ZAP API scan: if OpenAPI spec exists

# Gate 4 (scheduled weekly):
# - ZAP full active scan: against staging
# - Gitleaks on full git history
```

## Examples

### SQL Injection — What SAST Catches
```python
# Vulnerable — Semgrep and Bandit both flag this (B608)
def get_user(username: str):
    query = f"SELECT * FROM users WHERE username = '{username}'"
    cursor.execute(query)

# Safe — parameterized query
def get_user(username: str):
    cursor.execute("SELECT * FROM users WHERE username = %s", (username,))
```

## Exercises

1. Run Bandit against a Python project (use the devops-study-hub backend or any Python codebase). Fix the top 3 findings. Add Bandit to a pre-commit hook so it runs before every commit.
2. Write a custom Semgrep rule that flags any use of `subprocess.run(..., shell=True)` with a user-controlled argument (shell injection risk). Test it against a file that has both safe and unsafe usages.
3. Set up ZAP baseline scan against a locally running web app. Review the report — categorize each finding by OWASP Top 10 category. Pick one finding and demonstrate the fix.
4. Add a security scanning job to a GitHub Actions workflow that: (a) runs Bandit and fails on any HIGH finding, (b) runs `pip-audit` for dependency CVEs, (c) uploads results as a SARIF artifact to GitHub Security tab.

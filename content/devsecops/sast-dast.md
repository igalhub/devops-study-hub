---
title: SAST and DAST
module: devsecops
duration_min: 20
difficulty: intermediate
tags: [devsecops, sast, dast, security-testing, bandit, semgrep, zap, owasp, ci]
exercises: 4
---

## Overview

SAST (Static Application Security Testing) analyzes source code, bytecode, or compiled artifacts without executing them. It catches hardcoded secrets, SQL injection patterns, insecure function calls, and dangerous API usage at commit time — before any code reaches a running environment. Because SAST operates on code, it gives developers precise file-and-line feedback and integrates naturally into editors, pre-commit hooks, and CI pipelines. The tradeoff is that SAST cannot see runtime behavior: it cannot know what HTTP headers your server actually returns, whether an auth check is bypassed by a specific request sequence, or how your app behaves under a real attacker's input.

DAST (Dynamic Application Security Testing) attacks a live application the way an external attacker would. It sends crafted HTTP requests, inspects responses, follows redirects, and probes for vulnerabilities that only surface at runtime: authentication bypasses, reflected and stored XSS, misconfigured security headers, open redirects, and server-side request forgery. DAST is language-agnostic — it does not care what framework your app uses — but it requires a running target, which means it belongs later in the pipeline, typically against a staging or ephemeral environment.

Together, SAST and DAST implement defense in depth for application security. SAST shifts security left to the developer's workstation and the PR stage; DAST validates the running system before promotion to production. Neither replaces the other, and neither replaces human code review or penetration testing. In a mature DevSecOps pipeline they are complementary layers: SAST is fast and cheap (run on every commit), DAST is slower and more realistic (run on every deploy to a test environment). Both feed findings into a unified place — GitHub Security tab, Defect Dojo, or similar — so teams can track, triage, and close vulnerabilities systematically.

---

## Concepts

### SAST vs DAST: Core Differences

| Property | SAST | DAST |
|---|---|---|
| What it analyzes | Source code / bytecode | Running application (HTTP) |
| When it runs | Pre-commit, PR, CI build | Post-deploy to test environment |
| Requires running app? | No | Yes |
| Language-aware? | Yes — rules are language-specific | No — targets HTTP surface |
| Finds runtime issues? | No | Yes |
| False-positive rate | Higher (no runtime context) | Lower (confirmed via real requests) |
| Speed | Seconds to minutes | Minutes to hours |
| Typical tools | Bandit, Semgrep, Gitleaks | OWASP ZAP, Nuclei, Burp Suite |

**Key interview point:** SAST false positives are common because the tool cannot trace data flow through all code paths. A variable that looks like user input to the tool might be a hardcoded constant at runtime. DAST false positives are less common because each finding is a real HTTP exchange — but DAST can miss vulnerabilities that require authenticated or multi-step flows if not configured with valid credentials and session handling.

**The coverage gap:** neither tool catches business logic flaws. An insecure direct object reference (IDOR) that returns another user's data by changing an ID in the URL requires human understanding of the intended access model. SAST sees no dangerous function call. DAST sees a 200 response and has no way to know the data belonged to a different user. This is why automated tools supplement but never replace manual testing and code review.

---

### SAST with Bandit (Python)

Bandit parses Python AST (Abstract Syntax Tree) and runs a set of plugin tests against it. Each test maps to a known insecure pattern. Severity (LOW/MEDIUM/HIGH) and confidence (LOW/MEDIUM/HIGH) are reported independently — a finding can be HIGH severity but LOW confidence if Bandit is unsure whether the code path is reachable. In a CI gate, use both dimensions: fail on HIGH severity + HIGH confidence to minimize noise while catching the most dangerous confirmed findings.

```bash
pip install bandit

# Recursive scan of a source directory
bandit -r src/

# Report only MEDIUM severity and above (skip LOW noise)
bandit -r src/ -ll

# Report only HIGH severity (strictest gate)
bandit -r src/ -lll

# JSON output for machine consumption (CI upload, dashboards)
bandit -r src/ -f json -o bandit-report.json

# SARIF output for GitHub Security tab
bandit -r src/ -f sarif -o bandit.sarif

# Skip specific checks — use sparingly, document why
bandit -r src/ --skip B101,B105

# Exit code 0 even if findings exist (collect results without failing)
bandit -r src/ -f json -o bandit.json --exit-zero
```

**Common Bandit rule IDs to know for interviews:**

| Rule | Issue | Why It Matters |
|---|---|---|
| B101 | `assert` used for security checks | Asserts are stripped with `-O` flag at runtime |
| B105/B106 | Hardcoded password in string/function arg | Credentials in source = credential leak via git |
| B110 | `try/except/pass` swallows exceptions | Silent failures hide security errors from logs |
| B201 | Flask `debug=True` | Exposes interactive debugger to network |
| B301 | `pickle.loads` | Arbitrary code execution on deserialization |
| B324 | MD5/SHA1 for hashing | Broken for passwords; use bcrypt/SHA-256+ |
| B501 | SSL cert verification disabled | Enables MITM attacks on outbound requests |
| B608 | SQL string formatting | SQL injection vector |

**Suppressing a finding inline:** use `# nosec <rule>` with a comment explaining why it is safe. Bare `# nosec` without a rule ID suppresses everything on that line — avoid it because it hides future findings if new rules are added.

```python
# Acceptable suppression — test-only code, not a real password
TEST_PASSWORD = "hunter2"  # nosec B105 — hardcoded only in test fixtures, never in production config

# Bad — suppresses all rules, provides no context
TEST_PASSWORD = "hunter2"  # nosec
```

**Bandit gotcha:** Bandit does not perform full inter-procedural taint analysis. It cannot follow data through function calls across files. A B608 finding might be a false positive if the string being formatted is not user-controlled — always read the surrounding code before suppressing. Conversely, Bandit can miss an injection vulnerability if the dangerous call is wrapped in a helper function in another module.

---

### SAST with Semgrep

Semgrep performs pattern-matching on syntax trees across 30+ languages. Unlike regex, Semgrep patterns are syntactically aware — `$X + $Y` matches any addition expression regardless of whitespace, parentheses, or variable names. The community registry at `semgrep.dev/r` contains thousands of rules maintained by Semgrep and the security community, organized into curated packs.

```bash
pip install semgrep

# Auto-detect language and apply default rules
semgrep --config=auto src/

# OWASP Top 10 ruleset
semgrep --config="p/owasp-top-ten" src/

# Secrets detection (API keys, tokens, credentials)
semgrep --config="p/secrets" .

# Multiple rulesets in one run
semgrep --config="p/owasp-top-ten" --config="p/secrets" src/

# SARIF for GitHub Advanced Security
semgrep --config=auto --sarif --output=semgrep.sarif src/

# Fail CI (exit code 1) on any finding
semgrep --config=auto --error src/

# Fail only on ERROR severity, not WARNING
semgrep --config=auto --severity=ERROR --error src/
```

**Writing custom Semgrep rules** is a key differentiator from Bandit. Rules are YAML and support `pattern`, `pattern-not`, `pattern-inside`, `metavariable-regex`, and `taint` mode for cross-function data-flow analysis. Custom rules enforce organization-specific standards that no off-the-shelf tool knows about.

```yaml
# rules/no-shell-injection.yml
rules:
  - id: subprocess-shell-true-with-variable
    patterns:
      - pattern: subprocess.run($CMD, ..., shell=True, ...)
      # pattern-not excludes the safe case: literal string + shell=True
      - pattern-not: subprocess.run("...", ..., shell=True, ...)
    message: >
      subprocess.run with shell=True and a non-literal command is a shell injection risk.
      Use a list of arguments instead: subprocess.run(['cmd', arg1, arg2]).
    severity: ERROR
    languages: [python]
    metadata:
      cwe: CWE-78
      owasp: A03:2021

  - id: no-raw-sql-format
    patterns:
      - pattern: cursor.execute($Q % ...)
      - pattern: cursor.execute($Q + ...)
      - pattern: cursor.execute(f"...")
    message: "SQL injection risk: use parameterized queries — cursor.execute(sql, (param,))"
    severity: ERROR
    languages: [python]
```

```bash
# Test your custom rules against the rules directory
semgrep --config=rules/ src/

# Test a rule against a specific file to validate it fires correctly
semgrep --config=rules/no-shell-injection.yml tests/fixtures/bad_subprocess.py
```

**Semgrep taint mode** tracks user-controlled data from a source (e.g., `request.args.get(...)`) to a sink (e.g., `cursor.execute(...)`). This catches injection vulnerabilities that span multiple lines and function call boundaries — something structural pattern-matching alone cannot do.

```yaml
rules:
  - id: flask-sql-taint
    mode: taint
    pattern-sources:
      # Any place user input enters the application
      - pattern: request.args.get(...)
      - pattern: request.form.get(...)
      - pattern: request.json.get(...)
    pattern-sinks:
      # Any place that executes SQL
      - pattern: cursor.execute(...)
      - pattern: db.session.execute(...)
    # pattern-sanitizers can exclude cases where input passes through an allowlist or ORM
    message: "Tainted user input flows into a SQL sink without sanitization"
    severity: ERROR
    languages: [python]
    metadata:
      cwe: CWE-89
```

**Semgrep gotcha:** taint mode follows data flow within a single file by default in the open-source version. Cross-file taint tracking requires Semgrep Pro. For most CI use cases, combine taint rules (intra-file) with structural rules (cross-file patterns) and code review for the gaps.

---

### Secret Scanning with Gitleaks

Secrets committed to git history persist even after deletion from HEAD — the object still exists in the pack file and is accessible via `git log --all` or a clone. Gitleaks scans commit history using entropy analysis and regular expression patterns to detect API keys, tokens, passwords, and certificates before or after they reach the remote.

```bash
# Install
brew install gitleaks    # macOS
# or via Docker:
docker run --rm -v "$(pwd)":/path zricethezav/gitleaks:latest detect --source /path

# Scan the working tree and full git history
gitleaks detect --source .

# Scan only commits introduced in this branch (fast — suitable for CI on PRs)
gitleaks detect --source . --log-opts "origin/main..HEAD"

# Output report as JSON for upload to a dashboard
gitleaks detect --source . --report-format json --report-path gitleaks-report.json

# Exit codes: 0 = no findings, 1 = findings found, 126 = error (connection, config)
```

**Pre-commit hook** — catches secrets before they ever reach the remote. The pre-commit framework runs hooks automatically on `git commit` and aborts the commit if any hook fails.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks

  - repo: https://github.com/PyCQA/bandit
    rev: 1.7.8
    hooks:
      - id: bandit
        args: ["-ll", "-r", "src/"]  # -ll = MEDIUM and above only
```

```bash
pre-commit install           # installs hooks into .git/hooks/ — run once per clone
pre-commit run --all-files   # run manually against all tracked files (useful in CI)
```

**Gitleaks gotcha:** if a real secret is found in history, deleting it from HEAD is not enough. You must rewrite history (`git filter-repo --path-glob '*.env' --invert-paths` or interactive rebase) and rotate the credential immediately. Treat any committed secret as fully compromised regardless of how quickly you removed it — assume it was scraped by an automated scanner the moment it hit the remote.

**Allowlist for false positives:** Gitleaks supports a `.gitleaks.toml` config file where you can allowlist specific findings by rule, file path, or commit hash.

```toml
# .gitleaks.toml
[allowlist]
  description = "test fixtures and known false positives"
  paths = [
    '''tests/fixtures/''',   # test data with fake credentials
  ]
  regexes = [
    '''EXAMPLE_KEY_DO_NOT_USE''',  # documentation placeholder
  ]
```

---

### DAST with OWASP ZAP

ZAP (Zed Attack Proxy) is an intercepting proxy that both passively observes and actively attacks HTTP applications. It is the most widely adopted open-source DAST tool and has first-class Docker and CI support via three wrapper scripts that map to different risk profiles.

**Three scan modes:**

| Mode | Script | Behavior | Safe for production? |
|---|---|---|---|
| Baseline | `zap-baseline.py` | Passive only — spiders the app, no attacks | Yes |
| Full | `zap-full-scan.py` | Active attacks — fuzzes inputs, probes vulnerabilities | No — staging only |
| API | `zap-api-scan.py` | Active scan driven by OpenAPI/Swagger/GraphQL spec | No — staging only |

```bash
# Baseline scan — passive only, safe against any environment including production
docker run --rm zaproxy/zap-stable zap-baseline.py \
  -t https://myapp.example.com \
  -J zap-baseline-report.json \
  -r zap-baseline-report.html   # HTML report for human review

# Full active scan — staging/ephemeral environments ONLY
docker run --rm zaproxy/zap-stable zap-full-scan.py \
  -t https://staging.myapp.example.com \
  -J zap-full-report.json \
  -l WARN            # only report WARN and above, suppress INFO noise

# API scan using OpenAPI spec — reaches endpoints the spider might miss
# (spider crawls links; API spec lists all routes including undocumented ones)
docker run --rm zaproxy/zap-stable zap-api-scan.py \
  -t https://staging.myapp.example.com/openapi.json \
  -f openapi \
  -J zap-api-report.json \
  -z "-config scanner.attackStrength=HIGH"   # pass ZAP config options via -z
```

**ZAP exit codes:**
- `0` — no alerts at or above the configured threshold
- `1` — one or more alerts found at or above threshold (use this to fail CI)
- `2` — scan failed to run (connection refused, bad URL, config error)

**ZAP gotcha:** the full scan and API scan actively submit forms, trigger actions, and may create, modify, or delete data in your application. Never run `zap-full-scan.py` against a production database or any environment with real user data. Always target an ephemeral environment with a seeded test dataset that can be discarded after the scan. Some applications have irreversible actions (send email, charge payment) that an active scan will trigger — configure ZAP to skip those endpoints using a context exclusion list.

---

### DAST Authentication

ZAP cannot test authenticated endpoints without valid credentials — it will scan only the public surface and miss everything behind a login wall. There are three approaches depending on application complexity.

**Simple: inject a pre-obtained token via request header replacement**

```bash
# Obtain a token from your staging environment first (e.g., via login API)
TOKEN=$(curl -s -X POST https://staging.myapp.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"stagingpass"}' | jq -r '.token')

# Pass token to all ZAP requests via the replacer plugin
docker run --rm zaproxy/zap-stable zap-baseline.py \
  -t https://staging.myapp.example.com \
  -J report.json \
  -z "-config replacer.full_list(0).description=auth \
      -config replacer.full_list(0).enabled=true \
      -config replacer.full_list(0).matchtype=REQ_HEADER \
      -config replacer.full_list(0).matchstr=Authorization \
      -config replacer.full_list(0).replacement='Bearer ${TOKEN}'"
```

**Complex: ZAP Automation Framework for login form + session handling**

For applications with login forms, MFA, or OAuth flows, the Automation Framework (`af.yaml`) replaces ad-hoc `-z` config flags with a structured, versionable scan plan.

```yaml
# zap-af.yaml — ZAP Automation Framework scan plan
env:
  contexts:
    - name: myapp
      urls:
        - https://staging.myapp.example.com
      authentication:
        method: form
        parameters:
          loginPageUrl: https://staging.myapp.example.com/login
          loginRequestUrl: https://staging.myapp.example.com/login
          loginRequestBody: "username={%username%}&password={%password%}"
        verification:
          method: response
          loggedInRegex: "Welcome, testuser"   # regex that confirms auth succeeded
          loggedOutRegex: "Sign in"
      users:
        - name: testuser
          credentials:
            username: testuser
            password: stagingpass
jobs:
  - type: spider
    parameters:
      context: myapp
      user: testuser
      maxDuration: 5
  - type: activeScan
    parameters:
      context: myapp
      user: testuser
      policy: Default Policy
  - type: report
    parameters:
      reportFile: /zap/wrk/zap-af-report.json
      reportType: json
```

```bash
docker run --rm -v $(pwd):/zap/wrk zaproxy/zap-stable \
  zap.sh -cmd -autorun /zap/wrk/zap-af.yaml
```

---

### OWASP Top 10 — What Each Tool Covers

Understanding which tool catches which OWASP category is a common interview question and a prerequisite for designing a pipeline that provides real coverage rather than checkbox compliance.

| OWASP Category | SAST (Semgrep/Bandit) | DAST (ZAP) | Gap |
|---|---|---|---|
| A01 Broken Access Control | Partial — finds missing auth decorators | Yes — probes endpoints without credentials | Business logic IDOR requires manual testing |
| A02 Cryptographic Failures | Yes — weak ciphers, HTTP URLs, MD5 | Yes — checks TLS version, security headers | Key management practices invisible to both |
| A03 Injection (SQL, cmd, LDAP) | Yes — pattern + taint analysis | Yes — fuzzes inputs with payloads | Complex multi-step injections may need manual |
| A04 Insecure Design | No — requires business logic context | Partial — missing rate limits, predictable tokens | Requires threat modeling + manual review |
| A05 Security Misconfiguration | Partial — debug=True, CORS wildcard | Yes — checks headers, error pages, default creds | Infrastructure config requires IaC scanning |
| A06 Vulnerable Components | Via SCA (pip-audit, Trivy) | No | Neither SAST nor DAST; needs dedicated SCA |
| A07 Authentication Failures | Partial — weak password hashing | Yes — brute force detection, session fixation | MFA bypass requires manual testing |
| A08 Software Integrity Failures | Via Gitleaks, supply chain tools | No | Requires SBOM + signing verification |
| A09 Security Logging Failures | Partial — missing log statements | No | Log review requires runtime log inspection |
| A10 SSRF | Yes — taint to outbound URL sinks | Yes — probes with internal IP payloads | Cloud metadata endpoint requires env-specific rules |

**Interview point:** No single tool covers the full OWASP Top 10. A complete DevSecOps pipeline layers SAST + DAST + SCA (Software Composition Analysis) + secret scanning + IaC scanning. When an interviewer asks "how do you secure your pipeline?", name all five layers and explain what each one catches.

---

### Shift-Left: CI Pipeline Integration Strategy

"Shift left" means moving security checks earlier in the development lifecycle to reduce the cost of fixing findings. Research consistently shows that a finding caught at commit time costs minutes to fix; the same finding found in production costs days of incident response plus potential data breach notification obligations.

The practical implication is tiered tooling: fast, low-noise checks block the developer locally; slightly slower, broader checks gate the PR; full scans run post-merge against staging where a longer runtime is acceptable.

```
Developer Workstation (runs on every git commit — must be <10 seconds)
  └── pre-commit: Gitleaks (scan staged diff only)
  └── pre-commit: Bandit -ll (MEDIUM+ severity, fast)
  └── pre-commit: Semgrep custom org rules only (small ruleset = fast)

Pull Request CI (target <2 minutes — blocks merge)
  └── Bandit: HIGH severity + HIGH confidence only
  └── Semgrep: p/owasp-top-ten, p/secrets (broader but curated)
  └── pip-audit / npm audit: known CVEs in declared dependencies
  └── Gitleaks: scan only commits in this PR (--log-opts origin/main..HEAD)
  └── Upload SARIF to GitHub Security tab (non-blocking, for visibility)

Merge to main / deploy to staging (5-15 minutes — blocks promotion)
  └── Full Bandit + Semgrep with SARIF upload (complete scan, all severities)
  └── Trivy: container image CVE scan (OS packages + language deps)
  └── ZAP baseline scan: passive, against ephemeral staging environment

Scheduled (nightly or weekly — against long-lived staging)
  └── ZAP full active scan or API scan
  └── Gitleaks on full git history (catches secrets in old commits)
  └── pip-audit / Trivy on all images in registry (catches newly published CVEs)
```

**Gate design principle:** a CI gate should fail builds on confirmed, high-severity findings only. Failing on every LOW-confidence finding trains developers to ignore or suppress warnings indiscriminately. Start permissive (collect results without failing), establish a baseline, then tighten thresholds incrementally. Never introduce a gate that produces more than a handful of new findings per week — developer trust in the tool collapses if every PR is blocked by noise.

---

## Examples

### Example 1: Python Flask App — SAST in GitHub Actions

This example shows a complete GitHub Actions workflow that runs Bandit and Semgrep on pull requests, uploads SARIF results to the GitHub Security tab, and fails the build only on confirmed high-severity findings.

```yaml
# .github/workflows/sast.yml
name: SAST

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  bandit:
    name: Bandit (Python SAST)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Bandit
        run: pip install bandit[sarif]   # sarif extra enables SARIF output format

      - name: Run Bandit
        # -lll = HIGH severity only; --exit-zero so we always produce the SARIF file
        # even when findings exist — we control the gate separately via the SARIF upload
        run: |
          bandit -r src/ -lll -f sarif -o bandit.sarif --exit-zero
          # Also produce JSON for artifact upload
          bandit -r src/ -f json -o bandit.json --exit-zero

      - name: Upload SARIF to GitHub Security tab
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: bandit.sarif
        # This makes findings visible in the Security tab without blocking the build

      - name: Fail on HIGH+HIGH findings
        # Re-run without --exit-zero to actually fail the job if high-severity findings exist
        # -lll = severity HIGH, -iii = confidence HIGH
        run: bandit -r src/ -lll -iii

  semgrep:
    name: Semgrep
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep   # official image has semgrep pre-installed
    steps:
      - uses: actions/checkout@v4

      - name: Run Semgrep (OWASP Top 10 + secrets)
        env:
          SEMGREP_APP_TOKEN: ${{ secrets.SEMGREP_APP_TOKEN }}  # optional: enables cloud dashboard
        run: |
          semgrep \
            --config="p/owasp-top-ten" \
            --config="p/secrets" \
            --config=rules/ \           # org-specific custom rules in the repo
            --sarif \
            --output=semgrep.sarif \
            --severity=ERROR \          # only ERROR level triggers --error exit code
            --error \
            src/

      - name: Upload Semgrep SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: semgrep.sarif
        if: always()   # upload even if semgrep step failed so findings are visible
```

**Verify it works:** open a PR that introduces a SQL injection: `cursor.execute("SELECT * FROM users WHERE id=" + user_id)`. The Semgrep job should fail with a `no-raw-sql-format` finding, and the GitHub Security tab should show the finding linked to the specific diff line.

---

### Example 2: ZAP Baseline Scan in CI Against an Ephemeral Environment

This workflow spins up a Docker Compose stack (app + database), runs a ZAP baseline scan against it, and tears it down. The baseline scan is passive — safe to run on every merge to main.

```yaml
# .github/workflows/dast-baseline.yml
name: DAST Baseline

on:
  push:
    branches: [main]

jobs:
  zap-baseline:
    name: ZAP Baseline Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Start application stack
        run: |
          docker compose -f docker-compose.test.yml up -d
          # Wait for the app to be healthy before scanning
          timeout 60 bash -c 'until curl -sf http://localhost:8080/health; do sleep 2; done'

      - name: Run ZAP Baseline Scan
        # Use the official ZAP GitHub Action — handles Docker networking automatically
        uses: zaproxy/action-baseline@v0.12.0
        with:
          target: "http://localhost:8080"
          rules_file_name: ".zap/rules.tsv"   # per-rule alert thresholds (see below)
          cmd_options: "-J zap-report.json"

      - name: Upload ZAP report
        uses: actions/upload-artifact@v4
        with:
          name: zap-baseline-report
          path: zap-report.json
        if: always()

      - name: Tear down application stack
        run: docker compose -f docker-compose.test.yml down -v
        if: always()   # always clean up even if scan failed
```

**ZAP rules file — per-rule alert thresholds:**

```tsv
# .zap/rules.tsv
# Format: rule_id   IGNORE|WARN|FAIL   # comment
10020   WARN    # Missing Anti-clickjacking header — warn but don't fail
10038   IGNORE  # Content Security Policy not set — known gap, tracked separately
10036   FAIL    # Server leaks version info — must fix before production
10202   FAIL    # Absence of Anti-CSRF tokens on forms
```

**Verify it works:** check the GitHub Actions run. The `zaproxy/action-baseline` action posts a summary table of findings directly to the PR as a comment. A FAIL-threshold finding causes the job to exit with code 1, blocking promotion. A WARN-threshold finding is visible in the comment but does not block.

---

### Example 3: Gitleaks in a Pre-commit Hook + CI Verification

**Setup: local pre-commit hook**

```bash
# Install pre-commit (once per machine)
pip install pre-commit

# In the project root, add .pre-commit-config.yaml (see Concepts section)
# Then install the hooks:
pre-commit install

# Verify hooks are installed
ls .git/hooks/pre-commit   # should exist after install
```

**Test that the hook fires:**

```bash
# Create a file with a fake AWS key pattern
echo 'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' > test_secret.py

git add test_secret.py
git commit -m "test"
# Expected: commit is aborted, gitleaks prints the finding with rule ID and file:line
```

**CI verification — scan PR commits only (fast path):**

```yaml
# Snippet for .github/workflows/secrets.yml
- name: Gitleaks scan (PR commits only)
  uses: gitleaks/gitleaks-action@v2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}  # required for v2 org scans
  with:
    args: --log-opts="origin/main..HEAD"   # only scan commits in this PR
```

**Verify it works:** the action fails with exit code 1 and prints a table listing the secret type, file, line, and commit hash. Remove the file, amend the commit (`git commit --amend`), and the scan passes.

---

### Example 4: Custom Semgrep Rule — Finding a Company-Specific Anti-Pattern

Your organization has standardized on a wrapper function `db.safe_query()` instead of raw `cursor.execute()`. You want to enforce this in CI. This is something no off-the-shelf ruleset covers — it requires a custom rule.

```yaml
# rules/org-standards.yml
rules:
  - id: use-safe-query-wrapper
    pattern: cursor.execute(...)
    message: >
      Direct cursor.execute() is not allowed. Use db.safe_query() which enforces
      parameterization and query logging. See: internal/db/README.md.
    severity: ERROR
    languages: [python]
    metadata:
      category: best-practice
      team: platform-security

  - id: no-debug-logging-in-auth
    patterns:
      - pattern: logging.debug(...)
      - pattern-inside: |
          def $FUNC(...):
            ...
        # Only flag debug logging inside functions with 'auth' or 'login' in the name
      - metavariable-regex:
          metavariable: $FUNC
          regex: ".*(auth|login|token|password).*"
    message: >
      Debug logging inside authentication functions may log sensitive values.
      Use logging.info() with sanitized messages or structured logging with explicit field control.
    severity: WARNING
    languages: [python]
```

```bash
# Test the rule — should fire on the bad file, not the good file
cat > /tmp/bad.py << 'EOF'
import sqlite3
conn = sqlite3.connect("app.db")
cursor = conn.cursor()
cursor.execute("SELECT * FROM users WHERE id=" + user_id)  # should fire
EOF

cat > /tmp/good.py << 'EOF'
from internal.db import db
results = db.safe_query("SELECT * FROM users WHERE id=?", (user_id,))  # should not fire
EOF

semgrep --config=rules/org-standards.yml /tmp/bad.py /tmp/good.py
# Expected: 1 finding in bad.py, 0 findings in good.py
```

**Verify it works:** `semgrep` exits with code 1 for `bad.py` and prints the rule ID, message, and file:line. For `good.py` it exits with code 0 and prints "No findings."

---

## Exercises

### Exercise 1: Run Bandit Against a Vulnerable Python App and Triage Findings

1. Clone a deliberately vulnerable Python app — [pygoat](https://github.com/adeyosemanputra/pygoat) or create a file with known-bad patterns:

```python
# vuln_app.py
import pickle, subprocess, hashlib, sqlite3

def get_user(user_id):
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id=" + user_id)   # B608
    return cursor.fetchone()

def hash_password(pwd):
    return hashlib.md5(pwd.encode()).hexdigest()   # B324

def run_command(cmd):
    subprocess.run(cmd, shell=True)   # B602

def load_data(data):
    return pickle.loads(data)   # B301
```

2. Run Bandit at all severity levels and observe the difference in output volume:
   ```bash
   bandit vuln_app.py          # all severities
   bandit vuln_app.py -ll      # MEDIUM+
   bandit vuln_app.py -lll     # HIGH only
   ```
3. For each HIGH finding, look up the CWE number from the Bandit documentation and write a one-sentence description of the actual attack scenario it enables.
4. Add a suppression comment to the `get_user` function — but only if you can justify why it would be a false positive. If you cannot justify it, fix the code instead.

**Goal:** understand the difference between noise-level LOW findings and genuinely dangerous HIGH findings, and practice suppression discipline.

---

### Exercise 2: Write a Semgrep Rule for a Custom Anti-Pattern

Your team uses `requests.get()` throughout the codebase. Your security team has flagged that several calls disable SSL verification with `verify=False`. Write a Semgrep rule that catches this.

1. Write the rule in `rules/no-ssl-verify-false.yml` that matches any `requests.get(...)`, `requests.post(...)`, or `requests.request(...)` call where `verify=False` is passed as a keyword argument.
2. Test it against these two cases — your rule should fire on `bad.py` and not on `good.py`:
   ```python
   # bad.py
   import requests
   resp = requests.get("https://example.com", verify=False)

   # good.py
   import requests
   resp = requests.get("https://example.com")
   resp2 = requests.get("https://example.com", verify="/etc/ssl/certs/ca-bundle.crt")
   ```
3. Add a `metadata` block to your rule that includes `cwe: CWE-295` and `fix` text explaining the correct alternative.
4. Run the rule with `--verbose` to see how Semgrep matched the pattern, and use `--test` mode if you add inline test annotations.

**Goal:** practice the Semgrep rule authoring workflow, understand `pattern-not`, and produce something you could actually commit to a real project.

---

### Exercise 3: Run a ZAP Baseline Scan and Interpret the Report

1. Start a local vulnerable web application — [DVWA](https://github.com/digininja/DVWA) or [Juice Shop](https://github.com/juice-shop/juice-shop):
   ```bash
   docker run -d -p 3000:3000 bkimminich/juice-shop
   # Wait ~15 seconds for startup
   curl -s http://localhost:3000 | grep -o "<title>.*</title>"
   ```
2. Run a ZAP baseline scan against it:
   ```bash
   docker run --rm --network host zaproxy/zap-stable zap-baseline.py \
     -t http://localhost:3000 \
     -J juice-shop-baseline.json \
     -r juice-shop-baseline.html \
     -l WARN
   ```
3. Open `juice-shop-baseline.html` in a browser and answer these questions from the report:
   - How many WARN-level alerts were found?
   - Which alert has the highest risk score?
   - Are any alerts marked as false positives by ZAP itself?
4. Pick one WARN-level finding, look up the corresponding OWASP category it maps to, and describe what a real attacker could do with that vulnerability.

**Goal:** read an actual ZAP report, understand risk levels and alert metadata, and connect a finding to a real attack scenario — the skill you need to triage DAST results in a real job.

---

### Exercise 4: Build a Complete Shift-Left Pipeline with Pre-commit + CI Simulation

1. Create a new git repository and add a Python file with at least two intentional vulnerabilities (SQL injection + hardcoded credential).
2. Set up a `.pre-commit-config.yaml` that runs both Gitleaks and Bandit on every commit.
3. Attempt to commit the vulnerable file — observe the pre-commit hook block the commit.
4. Simulate CI gating by writing a shell script that runs Semgrep and exits with a non-zero code if any ERROR-severity findings exist:
   ```bash
   #!/usr/bin/env bash
   # ci-sast-gate.sh
   semgrep --config="p/owasp-top-ten" --severity=ERROR --error src/
   EXIT=$?
   if [ $EXIT -ne 0 ]; then
     echo "SAST gate FAILED — fix ERROR-severity findings before merging"
     exit 1
   fi
   echo "SAST gate PASSED"
   ```
5. Fix one of the two vulnerabilities so that only one finding remains. Verify that the pre-commit hook passes for the fixed code and that the CI script still fails for the unfixed vulnerability.
6. Suppress the remaining finding with an inline `# nosec` comment (Bandit) and a Semgrep `# nosemgrep` comment, then explain in a code comment why the suppression is justified.

**Goal:** experience the full developer workflow — local hook, CI gate, suppression — and understand when suppression is appropriate versus when you must fix the code.

---

### Quick Checks

7. This code string passes user input to `subprocess` with `shell=True` — a high-severity SAST finding. Print `HIGH` if the pattern is detected, `LOW` otherwise.

```python
code = "subprocess.call(user_input, shell=True)"; print("HIGH" if "shell=True" in code else "LOW")
```

```expected_output
HIGH
```

hint: Look for how to detect dangerous patterns in Python code that combine user-controlled input with shell execution.
hint: Check whether the subprocess call uses shell=True alongside a variable or concatenated string rather than a hardcoded command, and use that combination as your detection condition.

8. Detect SQL injection by string concatenation in this code line. Print `injection risk` if the pattern matches, `clean` if not.

```bash
echo "query = 'SELECT * FROM users WHERE id = ' + user_id" | grep -qE 'SELECT.*\+' && echo "injection risk" || echo "clean"
```

```expected_output
injection risk
```
hint: Think about how SQL injection via string concatenation looks as a pattern — focus on detecting quote characters or concatenation operators joining user input to a query string.
hint: Use grep with a regex pattern like '[\'"\+].*SELECT\|SELECT.*[\+\'"\+]' or look for signs like single quotes and plus signs near SQL keywords, then pipe the result through a conditional to echo the appropriate message.

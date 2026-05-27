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

**Key interview point:** SAST false positives are common because the tool cannot trace data flow through all code paths. DAST false positives are less common but DAST can miss vulnerabilities that require authenticated or multi-step flows if it isn't configured correctly.

---

### SAST with Bandit (Python)

Bandit parses Python AST (Abstract Syntax Tree) and runs a set of tests against it. Each test maps to a known insecure pattern. Severity (LOW/MEDIUM/HIGH) and confidence (LOW/MEDIUM/HIGH) are reported separately — a finding can be HIGH severity but LOW confidence if Bandit is unsure whether the code path is reachable.

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
| B101 | `assert` used for security checks | Asserts are stripped with `-O` flag |
| B105/B106 | Hardcoded password in string/function arg | Credentials in source = credential leak |
| B110 | `try/except/pass` swallows exceptions | Silent failures hide security errors |
| B201 | Flask `debug=True` | Exposes interactive debugger to network |
| B301 | `pickle.loads` | Arbitrary code execution on deserialization |
| B324 | MD5/SHA1 for hashing | Broken for passwords; use bcrypt/SHA-256+ |
| B501 | SSL cert verification disabled | Enables MITM attacks |
| B608 | SQL string formatting | SQL injection vector |

**Suppressing a finding inline:** use `# nosec <rule>` with a comment explaining why it is safe. Bare `# nosec` without a rule ID suppresses everything on that line — avoid it.

```python
# Acceptable suppression — test-only code, not a real password
TEST_PASSWORD = "hunter2"  # nosec B105 — hardcoded only in test fixtures
```

**Bandit gotcha:** Bandit reports issues in code it can parse but does not perform full taint analysis. It cannot follow data through function calls across files. A finding like B608 might be a false positive if the string being formatted is not user-controlled — always read the surrounding code before dismissing or suppressing.

---

### SAST with Semgrep

Semgrep performs pattern-matching on syntax trees across 30+ languages. Unlike regex, Semgrep patterns are syntactically aware — `$X + $Y` matches any addition regardless of whitespace or variable names. The community registry (`semgrep.dev/r`) contains thousands of rules maintained by r2c and the security community.

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

**Writing custom Semgrep rules** is a key differentiator from Bandit. Rules are YAML and can use `pattern`, `pattern-not`, `pattern-inside`, `metavariable-regex`, and `taint` mode for data-flow analysis.

```yaml
# rules/no-shell-injection.yml
rules:
  - id: subprocess-shell-true-with-variable
    patterns:
      - pattern: subprocess.run($CMD, ..., shell=True, ...)
      - pattern-not: subprocess.run("...", ..., shell=True, ...)  # string literal is safe
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
    message: "SQL injection risk: use parameterized queries (cursor.execute(sql, params))"
    severity: ERROR
    languages: [python]
```

```bash
semgrep --config=rules/ src/
```

**Semgrep taint mode** tracks user-controlled data from a source (e.g., `request.args.get(...)`) to a sink (e.g., `cursor.execute(...)`). This catches injection vulnerabilities that span multiple lines and functions — something pattern-matching alone cannot do.

```yaml
rules:
  - id: flask-sql-taint
    mode: taint
    pattern-sources:
      - pattern: request.args.get(...)
      - pattern: request.form.get(...)
    pattern-sinks:
      - pattern: cursor.execute(...)
    message: "Tainted user input reaches SQL sink"
    severity: ERROR
    languages: [python]
```

---

### Secret Scanning with Gitleaks

Secrets committed to git history persist even after deletion from HEAD. Gitleaks scans commit history using entropy analysis and pattern matching for API keys, tokens, passwords, and certificates.

```bash
# Install
brew install gitleaks    # macOS
# or: docker run zricethezav/gitleaks:latest

# Scan the working tree and git history
gitleaks detect --source .

# Scan only recent commits (e.g., since branching from main)
gitleaks detect --source . --log-opts "main..HEAD"

# Output report as JSON
gitleaks detect --source . --report-format json --report-path gitleaks-report.json

# Exit code: 0 = no findings, 1 = findings found, 126 = error
```

**Pre-commit hook** — catches secrets before they ever hit the remote:

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
        args: ["-ll", "-r", "src/"]
```

```bash
pre-commit install       # installs hooks into .git/hooks/
pre-commit run --all-files   # run manually against all files
```

**Gitleaks gotcha:** if a real secret is found in history, deleting it from HEAD is not enough. You must rewrite history (`git filter-repo`) and rotate the credential immediately. Treat any committed secret as compromised regardless of how quickly you removed it.

---

### DAST with OWASP ZAP

ZAP (Zed Attack Proxy) is an intercepting proxy that both passively observes and actively attacks HTTP applications. It is the most widely adopted open-source DAST tool and has first-class Docker and CI support.

**Three scan modes:**

| Mode | Script | Behavior | Safe for production? |
|---|---|---|---|
| Baseline | `zap-baseline.py` | Passive only — spiders the app, no attacks | Yes |
| Full | `zap-full-scan.py` | Active attacks — fuzzes inputs, probes vulnerabilities | No — staging only |
| API | `zap-api-scan.py` | Active scan driven by OpenAPI/Swagger/GraphQL spec | No — staging only |

```bash
# Baseline scan — passive, safe against any environment
docker run --rm zaproxy/zap-stable zap-baseline.py \
  -t https://myapp.example.com \
  -J zap-baseline-report.json \
  -r zap-baseline-report.html

# Full active scan — run only against staging/ephemeral environments
docker run --rm zaproxy/zap-stable zap-full-scan.py \
  -t https://staging.myapp.example.com \
  -J zap-full-report.json \
  -l WARN           # only report WARN and above

# API scan using OpenAPI spec — covers endpoints the spider might miss
docker run --rm zaproxy/zap-stable zap-api-scan.py \
  -t https://staging.myapp.example.com/openapi.json \
  -f openapi \
  -J zap-api-report.json \
  -z "-config scanner.attackStrength=HIGH"   # ZAP config options via -z
```

**ZAP exit codes:**
- `0` — no alerts at or above the threshold
- `1` — alerts found at or above the threshold
- `2` — scan failed (connection refused, etc.)

**ZAP gotcha:** the full scan can create or modify data in your application (it submits forms, triggers actions). Never run `zap-full-scan.py` against a production database or any environment with real user data. Always use an ephemeral or staging environment with a seeded test dataset.

---

### DAST Authentication

ZAP cannot test authenticated endpoints without credentials. For simple apps, pass a session cookie or bearer token:

```bash
# Pass an Authorization header to all requests
docker run --rm zaproxy/zap-stable zap-baseline.py \
  -t https://staging.myapp.example.com \
  -J report.json \
  -z "-config replacer.full_list(0).description=auth \
      -config replacer.full_list(0).enabled=true \
      -config replacer.full_list(0).matchtype=REQ_HEADER \
      -config replacer.full_list(0).matchstr=Authorization \
      -config replacer.full_list(0).replacement='Bearer eyJ...'"
```

For complex authentication flows (login form, MFA, OAuth), ZAP supports automation scripts (Python/JavaScript) that perform the login sequence and hand the session to the scanner. This is covered in ZAP's Automation Framework (`af.yaml`), which replaces legacy `-z` config for complex scenarios.

---

### OWASP Top 10 — What Each Tool Covers

Understanding which tool catches which OWASP category is a common interview question.

| OWASP Category | SAST (Semgrep/Bandit) | DAST (ZAP) |
|---|---|---|
| A01 Broken Access Control | Partial — finds missing auth decorators | Yes — probes endpoints without auth |
| A02 Cryptographic Failures | Yes — weak ciphers, HTTP URLs, MD5 | Yes — checks TLS config, headers |
| A03 Injection (SQL, cmd) | Yes — pattern + taint analysis | Yes — fuzzes inputs with payloads |
| A04 Insecure Design | No — requires business logic context | Partial — missing rate limits |
| A05 Security Misconfiguration | Partial — debug=True, CORS * | Yes — checks headers, error pages |
| A06 Vulnerable Components | Via SCA (pip-audit, Trivy) | No |
| A07 Authentication Failures | Partial — weak password checks | Yes — brute force, session fixation |
| A08 Software Integrity | Via Gitleaks, supply chain tools | No |
| A09 Logging Failures | Partial — missing log statements | No |
| A10 SSRF | Yes — taint to URL sinks | Yes — probes with SSRF payloads |

**Interview point:** No single tool covers everything. A complete DevSecOps pipeline layers SAST + DAST + SCA (Software Composition Analysis for dependencies) + secret scanning + IaC scanning.

---

### Shift-Left: CI Pipeline Integration Strategy

"Shift left" means moving security checks earlier in the development lifecycle to reduce the cost of fixing findings. A finding caught at commit time costs minutes to fix; the same finding found in production costs weeks plus incident response.

```
Developer Workstation
  └── pre-commit hooks: Gitleaks, Bandit (-ll), Semgrep custom rules

Pull Request (fast — target <2 minutes)
  └── Bandit: HIGH severity only (--exit-zero for MEDIUM, fail on HIGH)
  └── Semgrep: p/owasp-top-ten, p/secrets
  └── pip-audit / npm audit: known CVEs in dependencies
  └── Gitleaks: scan PR commits only

Merge to main / deploy to staging (moderate — 5-10 minutes)
  └── Full Bandit + Semgrep with SARIF upload
  └── Trivy: container image CVE scan
  └── ZAP baseline scan: passive, against ephemeral staging

Scheduled (weekly, against long-lived staging)
  └── ZAP full active scan
  └── Gitleaks on full git
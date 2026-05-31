# DevSecOps — Quick Reference

## Secret Scanning

| Tool / Command | Description |
|----------------|-------------|
| `gitleaks detect --source .` | Scan repo for secrets |
| `gitleaks detect --no-git -s dir/` | Scan directory (non-git) |
| `git log --all --full-history -- '*.env'` | Find deleted env files |
| `trufflehog git file://./repo` | Scan git history for secrets |
| `detect-secrets scan > .secrets.baseline` | Create secrets baseline |
| `detect-secrets audit .secrets.baseline` | Review baseline |

## SAST (Static Analysis)

| Tool / Command | Description |
|----------------|-------------|
| `bandit -r src/` | Python SAST scan |
| `bandit -r src/ -f json -o report.json` | JSON output |
| `semgrep --config auto src/` | Multi-language SAST |
| `semgrep --config p/owasp-top-ten src/` | OWASP ruleset |
| `eslint --ext .js,.jsx src/` | JS/JSX linting |
| `hadolint Dockerfile` | Dockerfile linting |
| `checkov -d .` | IaC security scan (TF, K8s, Docker) |
| `tfsec .` | Terraform-specific security scan |

## Container Security

| Command | Description |
|---------|-------------|
| `docker scout cves image:tag` | CVE scan with Docker Scout |
| `trivy image image:tag` | Scan image for CVEs |
| `trivy fs .` | Scan filesystem / repo |
| `grype image:tag` | Another image CVE scanner |
| `docker run --read-only image` | Read-only root filesystem |
| `docker run --cap-drop ALL image` | Drop all capabilities |
| `docker run --no-new-privileges image` | Prevent privilege escalation |
| `docker run -u 1000:1000 image` | Run as non-root user |

## TLS / Certificates

| Command | Description |
|---------|-------------|
| `openssl req -x509 -nodes -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365` | Self-signed cert |
| `openssl x509 -in cert.pem -text -noout` | Inspect certificate |
| `openssl s_client -connect host:443` | Test TLS handshake |
| `openssl verify -CAfile ca.pem cert.pem` | Verify cert against CA |
| `certbot certonly --standalone -d example.com` | Let's Encrypt cert |
| `certbot renew` | Renew Let's Encrypt certs |

## Secrets Management

| Tool / Command | Description |
|----------------|-------------|
| `vault login -method=aws` | Authenticate to Vault |
| `vault kv get secret/myapp` | Read a secret |
| `vault kv put secret/myapp key=val` | Write a secret |
| `vault kv list secret/` | List secrets |
| `vault token lookup` | Inspect current token |
| `aws secretsmanager get-secret-value --secret-id name` | AWS Secrets Manager |
| `aws ssm get-parameter --name /path/key --with-decryption` | AWS SSM Parameter Store |

## OWASP / Dependency Scanning

| Command | Description |
|---------|-------------|
| `dependency-check --project name --scan dir/` | CVE scan for dependencies |
| `npm audit` | Node.js dependency audit |
| `npm audit fix` | Auto-fix low-risk issues |
| `pip-audit` | Python dependency audit |
| `safety check -r requirements.txt` | Python safety check |
| `snyk test` | Snyk dependency scan |
| `snyk container test image:tag` | Snyk container scan |

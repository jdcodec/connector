# Security Policy

## Reporting a vulnerability

Email **`hello@jdcodec.com`** with details. **Do not file public GitHub issues for security bugs** — this includes the connector and the cloud API surface.

We aim to acknowledge within 48 hours and will keep you informed about the remediation timeline. We don't currently run a paid bug bounty.

## Scope

### In scope

- **The local connector binary** (this repo):
  - Privacy Shield bypass — any way to make PII pass through unredacted.
  - Code execution via crafted MCP input.
  - Dependency vulnerabilities affecting the published npm artefact.
  - Subprocess / spawn vulnerabilities (Playwright MCP wrapper).
- **The cloud API surface at `api.jdcodec.com`**:
  - Auth bypass (cross-tenant access, unauth'd endpoints that should require auth).
  - Response leaks (one customer's data appearing in another's response).
  - Rate-limit / DoS issues.

### Out of scope

- **The cloud codec service implementation.** The codec running server-side is proprietary and isn't open for inspection. Reports about its observable behaviour (latency, output, error responses) are welcome; reverse-engineering attempts to extract its logic are not in scope.
- **Issues already documented on our public roadmap.**
- **Theoretical attacks** without a concrete reproduction (e.g., "you might be vulnerable to X if Y" — please demonstrate Y).

## Privacy disclosures

The connector is built around a privacy guarantee: **PII is redacted on-device before bytes leave your machine**. If you find a way to make PII bypass the on-device shield — even if the bypass requires unusual or adversarial input — treat it as a security report, not a regular bug. We take privacy bypasses seriously.

A few examples of what counts:

- Crafting a Playwright snapshot whose contents match a regex our shield's regex doesn't catch, where the contents are clearly PII.
- A timing or side-channel attack that reveals redacted content via cloud API behaviour.
- A configuration that disables the privacy shield without an obvious warning to the user.

## Coordinated disclosure

We follow standard coordinated disclosure: 90 days from initial report to public disclosure, extendable if remediation is in progress. Credit in our security disclosures (with your permission).

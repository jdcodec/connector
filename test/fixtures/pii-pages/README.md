# PII page fixtures

Captured snapshots of real public web pages plus a small synthetic shell
script. Each `.snapshot.txt` file is the verbatim text the connector
receives from `@playwright/mcp` for the page — the exact input that
`redact()` scans.

The accompanying `pii-pages.test.ts` asserts a per-page redaction cap and
the false-positive-rate threshold (under 0.05 redactions per KB body
text). If a ruleset edit pushes a fixture above its cap, CI fails and
the editor either tightens the rule or, if the new redaction is
legitimate, updates the cap with a note in the same commit.

## Capture procedure

For the public-page archetypes (everything except `shell-script-passwords`):

```bash
node scripts/pii-corpus/snapshot-page.mjs <url> [<slug>]
```

The script writes the fixture to this directory.

The synthetic `shell-script-passwords.snapshot.txt` is hand-written —
re-edit in place if its coverage shape needs to change.

## Re-capture cadence

Public-page fixtures are pinned for deterministic regression testing —
re-running the test suite must not depend on the live page being
reachable or unchanged. Refresh in place when:

- a captured page changes shape in a way that materially affects what
  redacts;
- the ruleset is tightened in a way that should reduce existing FP
  counts on pinned fixtures (re-capture confirms the production code
  path mirrors the unit-test improvement).

## Archetypes covered

| Slug | URL | Archetype | Probes |
|---|---|---|---|
| `hn-front` | news.ycombinator.com | social/aggregator | Numeric ID rules (NHS shape) |
| `wiki-pdf` | en.wikipedia.org/wiki/Portable_Document_Format | long-form reference | Numeric tables, archive.org URLs |
| `github-readme` | github.com/anthropics/claude-code | code/dev | Auth/Secret, all-caps tokens |
| `bbc-news-front` | bbc.com/news | news front | Date, story IDs |
| `rfc9293-tcp` | datatracker.ietf.org/doc/html/rfc9293 | technical spec | IPv4, section refs, author emails |
| `gov-uk-statistics` | gov.uk/government/statistics | government index | SSN/Identity, dates |
| `mdn-http` | developer.mozilla.org/en-US/docs/Web/HTTP | numeric reference | Status codes, version refs |
| `shell-script-passwords` | _synthetic_ | shell script | `PASSWORD_ATTR` against `password_*` config keys + mysql `-p<password>` CLI flags |

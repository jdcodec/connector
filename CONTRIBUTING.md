# Contributing to the JD Codec Connector

Thanks for your interest. This is an alpha-stage privacy-positioned project; contributions are welcome with a few caveats below.

## How development works

The canonical source for the connector lives in JD Codec's internal repository, and **this public repo is a one-way mirror** of that source. Updates flow from internal → here via a controlled sync workflow that runs through review on both sides.

So the contribution flow is a little different from typical GitHub projects:

1. **You open a PR against `main` here.** CI runs the full test suite + grep-gate on your branch.
2. **If we accept**, we apply the change internally and re-sync. Your commit lands on this repo through the sync workflow rather than being merged directly. This keeps the source of truth canonical.
3. **Authorship is preserved** in the resulting commit.

If your contribution doesn't fit that flow (e.g., you want to refactor across multiple files or add a major feature), email **`hello@jdcodec.com`** first to talk it through.

## Filing issues

- **Bugs**: GitHub issue here, ideally with a minimal reproduction (snapshot input + expected vs. observed redaction / proxy behaviour).
- **Security vulnerabilities**: see [SECURITY.md](SECURITY.md). **Don't file public issues for security bugs.**
- **Feature requests**: GitHub issue with a brief description of the use case. We're especially interested in:
  - New PII categories the redaction shield should cover.
  - MCP-client integrations beyond Claude Code / Cursor / generic Playwright MCP.
  - Edge cases where compression behaves unexpectedly.

## Development setup

```bash
git clone https://github.com/jdcodec/connector.git
cd connector
npm install
npm run build       # tsc strict
npm test            # grep-gate + vitest (235 tests)
```

Node.js 22 or newer required. The grep-gate enforces the Hollow Connector invariant (no codec internals, no imports escaping `src/`); see `scripts/grep-gate.sh`.

## Code conventions

- **TypeScript strict mode** (`tsconfig.json`). All new code passes `npm run build` clean.
- **Privacy Shield rules** are declarative — they live in `src/resources/pii-ruleset.json`. Engine logic in `src/privacy/engine.ts` should rarely need changes.
- **New PII rules** require a corpus entry in `src/resources/pii-test-corpus.json` covering at least one positive case (and ideally a near-miss negative case to catch over-redaction).
- **The grep-gate is non-negotiable**. If your PR fails the grep-gate, fix the source — don't disable the gate. Codec-internal terminology and imports outside `src/` are forbidden by design.

## License

All contributions are accepted under [Apache 2.0](LICENSE), the project's license. By submitting a PR you agree your contribution may be redistributed under those terms.

## Code of conduct

Be respectful. We'll add a formal CoC if/when we hit the scale that requires one; until then, treat this like any small OSS project — engage in good faith, no harassment, focus on the work.

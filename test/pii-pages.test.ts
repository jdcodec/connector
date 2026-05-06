import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../src/privacy/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "..", "..", "..", "tests", "fixtures", "pii-pages");

interface Expectation {
  /** Slug = filename without `.snapshot.txt`. */
  slug: string;
  /** Hard upper bound on total redactions for this fixture. Set per page based on the survey. */
  maxRedactions: number;
  /** Per-rule cap. No single category should exceed this on a page that contains ~zero real PII. */
  perCategoryCap: number;
  /** Categories we know are LEGITIMATELY present on this fixture (e.g. published author emails on RFC 9293). Allowed to exceed perCategoryCap. */
  allowedLegitimateCategories?: string[];
}

/**
 * Per-fixture expectations from the v2.3.0 false-positive survey (2026-05-05).
 * The numbers are calibrated against the post-fix run (782 → 15 total).
 *
 * The point of this test is to lock in the post-fix behaviour as a
 * regression boundary. If the ruleset gets edited and one of these
 * fixtures starts redacting noticeably more, CI fails and the editor
 * has to either (a) confirm the new redactions are legit and update
 * the cap, or (b) tighten the rule.
 */
const EXPECTATIONS: Expectation[] = [
  // HN: 1 legitimate redaction (hn@ycombinator.com).
  { slug: "hn-front", maxRedactions: 3, perCategoryCap: 2, allowedLegitimateCategories: ["EMAIL"] },
  // Wikipedia PDF: zero PII content — fully clean post-fix.
  { slug: "wiki-pdf", maxRedactions: 1, perCategoryCap: 1 },
  // GitHub README: 1 PHONE_US one-off (10-digit page ID matched). Marginal FP, single instance — left out of retag scope.
  { slug: "github-readme", maxRedactions: 3, perCategoryCap: 2 },
  // BBC news front: clean post-fix.
  { slug: "bbc-news-front", maxRedactions: 2, perCategoryCap: 1 },
  // RFC 9293: 7 legitimate author emails + a handful of irreducible IPv4 / address ambiguity in a TCP RFC.
  // EMAIL allowed to exceed cap because RFC author emails ARE PII (gray area but redacting is the safe direction).
  // IP allowed up to 10 because the RFC genuinely contains both example IPs and section refs that share shape.
  {
    slug: "rfc9293-tcp",
    maxRedactions: 25,
    perCategoryCap: 12,
    allowedLegitimateCategories: ["EMAIL", "IP"],
  },
  // gov.uk statistics: clean post-fix.
  { slug: "gov-uk-statistics", maxRedactions: 1, perCategoryCap: 1 },
  // MDN HTTP overview: clean post-fix.
  { slug: "mdn-http", maxRedactions: 1, perCategoryCap: 1 },
  // Shell/infra script archetype — a Magento reset script with password_*
  // config keys and a CLI mysql -p flag. Confirms PASSWORD_ATTR rule does
  // not over-redact these patterns. Surfaced 2026-05-05 by an external
  // reviewer's report of a [REDACTED:password] artifact in someone's
  // working-tree copy of the same file (not reproducible in committed
  // history). Pinning as a fixture locks the clean result.
  { slug: "infra-shell-script", maxRedactions: 0, perCategoryCap: 0 },
];

describe("pii-pages — regression boundary on real-world fixtures", () => {
  for (const exp of EXPECTATIONS) {
    describe(exp.slug, () => {
      const text = readFileSync(join(FIXTURES_ROOT, `${exp.slug}.snapshot.txt`), "utf8");
      const result = redact(text);
      const stats = result.redactionStats;
      const total = Object.values(stats).reduce((a, b) => a + b, 0);

      it(`total redactions ≤ ${exp.maxRedactions} (got ${total}, stats=${JSON.stringify(stats)})`, () => {
        expect(total, `pinned fixture ${exp.slug} exceeded redaction cap`).toBeLessThanOrEqual(
          exp.maxRedactions,
        );
      });

      it(`per-category cap ≤ ${exp.perCategoryCap} except allowed legit categories`, () => {
        const allowed = new Set(exp.allowedLegitimateCategories ?? []);
        for (const [cat, count] of Object.entries(stats)) {
          if (allowed.has(cat)) continue;
          expect(
            count,
            `${exp.slug}: category ${cat} fired ${count} times (cap ${exp.perCategoryCap}). Either it is legitimately present and should be added to allowedLegitimateCategories, or a rule needs tightening.`,
          ).toBeLessThanOrEqual(exp.perCategoryCap);
        }
      });

      it("FP rate stays below policy threshold (<0.05 redactions per KB body)", () => {
        const kb = text.length / 1024;
        const rate = total / kb;
        expect(
          rate,
          `${exp.slug}: ${total} redactions on ${kb.toFixed(1)}KB = ${rate.toFixed(4)}/KB. Policy threshold is 0.05/KB.`,
        ).toBeLessThan(0.05);
      });
    });
  }
});

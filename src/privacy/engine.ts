import type {
  CompiledRule,
  CompiledRuleset,
  Range,
  RedactionStats,
} from "./types.js";
import { hasKnownValidator, runValidator } from "./validators.js";

export interface EngineMatch {
  start: number;
  end: number;
  priority: number;
  token: string;
  category: string;
  ruleIndex: number;
}

const GLOBAL_SUPPRESSOR_KEYS = [
  "suppress_if_inside_iso8601",
  "suppress_if_iso8601",
  "suppress_if_timestamp",
  "suppress_if_ref_attribute",
  "suppress_if_uuid",
  "suppress_if_hex_color",
];

const ADDRESS_CONTEXT_RE = /\b(?:post[\s-]?code|postal|zip(?:\s*code)?|address)\b/i;
const ADDRESS_RULE_NAMES = new Set(["POSTCODE_AU", "POSTCODE_UK", "ZIP_US"]);

const PHONE_FALLBACK_CONTEXT_RE = /(?:\+|\b(?:phone|tel|mobile|cell|contact|call|dial|fax)\b|\(\d)/i;
const PHONE_FALLBACK_RULE_NAMES = new Set(["PHONE_INTL_FALLBACK", "PHONE_US"]);

// DOB_ISO and DOB_LONG are shape-only (ISO 1990-03-15 / long-form "March 15, 1990")
// — without context they'd match every ordinary date. DOB_SLASH is NOT in this set
// to preserve v2.0 corpus behaviour (POS-DOB-0002 "01-12-2005" alone still redacts).
const DOB_CONTEXT_RE = /\b(?:dob|d\.?o\.?b\.?|date\s*of\s*birth|birth(?:day|date)?|born)\b/i;
const DOB_RULE_NAMES = new Set(["DOB_ISO", "DOB_LONG"]);

const PREFIX_TRIM: Record<string, RegExp> = {
  EMAIL_MAILTO: /^mailto:/i,
  BEARER_JWT: /^bearer\s+/i,
  BASIC_AUTH: /^basic\s+/i,
  PASSWORD_ATTR: /^(?:password|passwd|pwd)\s*[:=]\s*"?/i,
  API_KEY_AWS_SECRET: /^aws.*?(?:secret|sk).*?[:=]\s*/i,
  DOB_BORN: /^born(?:\s+in)?\s+/i,
};

const BOOSTER_KEYWORDS: Record<string, RegExp> = {
  SIN: /\b(?:sin|social\s*insurance)\b/i,
  TFN: /\b(?:tfn|tax\s*file)\b/i,
  IBAN: /\b(?:iban|routing|bank\s*account|aba|wire)\b/i,
  CC: /\b(?:card|credit|debit|cc|cardnum|pan)\b/i,
  SSN: /\b(?:ssn|social\s*security)\b/i,
  NHS: /\bnhs\b/i,
  NINO: /\b(?:nino|national\s*insurance|ni\s*number)\b/i,
  ABN: /\babn\b/i,
  ACN: /\b(?:acn|company\s*number)\b/i,
  MEDICARE: /\bmedicare\b/i,
  VAT: /\b(?:vat|tax\s*id)\b/i,
  // PASSPORT keywords. Real passport-bearing content reliably contains one
  // of these within ±48 chars; URL hex fragments / ISO committee codes /
  // git SHAs / hex colours do not. This is the cleanest discriminator.
  PASSPORT: /\bpassport(?:\s*(?:no\.?|number|#))?\b|\bMRZ\b|\bnationality\b|\bplace\s*of\s*birth\b|\bdate\s*of\s*(?:issue|expiry)\b|\btravel\s*document\b|\bdocument\s*number\b/i,
  EMAIL: /\be[-\s]?mail\b/i,
  PHONE: /\b(?:phone|mobile|cell|tel)\b/i,
  DOB: /\b(?:dob|birth|birthday|born)\b/i,
  ADDRESS: /\b(?:address|postcode|postal|zip)\b/i,
  // NETWORK booster gates IPV4. RFCs/specs use dotted-decimal as section
  // refs ('§3.10.7.4') indistinguishable from real IPs by shape; only
  // surrounding network vocabulary disambiguates. Uses an alpha-only
  // boundary (negative-class around the keyword) instead of \b so 'ip'
  // matches inside 'server_ip' / 'client_ip' attribute names — \b would
  // miss those because '_' is a word char.
  NETWORK: /(?:^|[^a-zA-Z])(?:ipv?[46]?|address|addr|host(?:name)?|inet|tcp|udp|dns|subnet|netmask|gateway|peer|listen|bind|connect(?:ion)?|socket|proxy|firewall|router|switch|server|client|src|dst)(?=[^a-zA-Z]|$)/i,
  // AUTH booster gates BASIC_AUTH against plain English ('basic education',
  // 'basic features' on a GitHub README). Real HTTP Basic auth headers
  // appear after 'Authorization:' or 'Bearer' / 'credentials' tokens. Note
  // 'basic auth' itself is included so the rule fires on documentation
  // that says e.g. "Use basic auth: Basic dXNlcjpwYXNz" without a literal
  // Authorization header.
  AUTH: /\b(?:authorization|authentication|bearer|credentials?|http\s*auth|basic\s*auth)\b/i,
};
const BOOSTER_WINDOW = 48;
const BOOSTER_PRIORITY_BUMP = 10;

export interface ScanSpan {
  ruleName: string;
  category: string;
  start: number;
  end: number;
  value: string;
}

export function scanString(
  input: string,
  rs: CompiledRuleset,
  options: { captureSpans?: boolean } = {},
): {
  redacted: string;
  stats: RedactionStats;
  spans?: ScanSpan[];
} {
  if (input === "") return { redacted: "", stats: {}, ...(options.captureSpans ? { spans: [] } : {}) };

  const DEBUG = process.env.JDC_PRIVACY_PROFILE === "1";
  const t0 = DEBUG ? performance.now() : 0;
  const suppressorRanges = collectSuppressorRanges(input, rs);
  const t1 = DEBUG ? performance.now() : 0;
  const precededByAp = rs.antiPatterns.get("suppress_if_preceded_by") ?? null;
  const precededByWindow = precededByAp?.windowChars ?? 24;

  const candidates: EngineMatch[] = [];

  for (let i = 0; i < rs.rules.length; i++) {
    const rule = rs.rules[i];
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(input)) !== null) {
      const start = m.index;
      const value = m[0];
      const end = start + value.length;
      if (value.length === 0) rule.regex.lastIndex++;

      if (rangeInsideAny(start, end, suppressorRanges)) continue;

      if (rule.antiPatterns.includes("suppress_if_preceded_by") && precededByAp) {
        const windowStart = Math.max(0, start - precededByWindow);
        const window = input.slice(windowStart, start);
        if (precededByAp.regex.test(window)) {
          precededByAp.regex.lastIndex = 0;
          continue;
        }
        precededByAp.regex.lastIndex = 0;
      }

      if (isSafeListed(rule, value, input, start, rs)) continue;

      if (ADDRESS_RULE_NAMES.has(rule.name) && !hasContextMatch(input, start, end, ADDRESS_CONTEXT_RE)) {
        continue;
      }

      if (PHONE_FALLBACK_RULE_NAMES.has(rule.name) && !hasContextMatch(input, start, end, PHONE_FALLBACK_CONTEXT_RE)) {
        continue;
      }

      if (DOB_RULE_NAMES.has(rule.name) && !hasContextMatch(input, start, end, DOB_CONTEXT_RE)) {
        continue;
      }

      // Tier policy: low-confidence rules require at least one of their
      // declared context boosters to match within the BOOSTER_WINDOW. This
      // generalises the hardcoded context-gates above (ADDRESS,
      // PHONE_FALLBACK, DOB) so any rule can be gated by tagging
      // confidence: low + context_boosters in the ruleset JSON. Rules with
      // confidence: low and zero context boosters retain shape-only
      // behaviour (shape match + optional validator) — opt those into the
      // tier policy via a ruleset edit, not an engine change.
      if (
        rule.confidence === "low" &&
        rule.contextBoosters.length > 0 &&
        !hasAnyBoosterContext(rule.contextBoosters, input, start, end)
      ) {
        continue;
      }

      if (rule.confidence === "low" && rule.validator) {
        if (!runValidator(rule.validator, value)) continue;
      }

      const validatorBoost =
        rule.confidence !== "low" &&
        rule.validator &&
        hasKnownValidator(rule.validator) &&
        runValidator(rule.validator, value)
          ? 3
          : 0;

      let trimmedStart = start;
      const trim = PREFIX_TRIM[rule.name];
      if (trim) {
        const pfx = trim.exec(value);
        if (pfx) trimmedStart = start + pfx[0].length;
      }
      if (trimmedStart >= end) continue;

      const boost = computeContextBoost(rule, input, start, end);

      candidates.push({
        start: trimmedStart,
        end,
        priority: rule.priority + boost + validatorBoost,
        token: rule.replacementToken,
        category: rule.replacementTokenKey,
        ruleIndex: i,
      });
    }
  }

  const t2 = DEBUG ? performance.now() : 0;
  const accepted = resolveOverlaps(candidates, input.length);
  accepted.sort((a, b) => a.start - b.start);
  const t3 = DEBUG ? performance.now() : 0;

  const stats: RedactionStats = {};
  const spans: ScanSpan[] | undefined = options.captureSpans ? [] : undefined;
  let out = "";
  let cursor = 0;
  for (const c of accepted) {
    if (c.start < cursor) continue;
    out += input.slice(cursor, c.start);
    out += c.token;
    stats[c.category] = (stats[c.category] ?? 0) + 1;
    if (spans) {
      spans.push({
        ruleName: rs.rules[c.ruleIndex].name,
        category: c.category,
        start: c.start,
        end: c.end,
        value: input.slice(c.start, c.end),
      });
    }
    cursor = c.end;
  }
  out += input.slice(cursor);
  const t4 = DEBUG ? performance.now() : 0;
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.info(
      `[privacy] suppressors ${(t1 - t0).toFixed(1)}ms, rules+cands ${(t2 - t1).toFixed(1)}ms (${candidates.length}), overlap ${(t3 - t2).toFixed(1)}ms, build ${(t4 - t3).toFixed(1)}ms`,
    );
  }
  return { redacted: out, stats, ...(spans ? { spans } : {}) };
}

function collectSuppressorRanges(input: string, rs: CompiledRuleset): Range[] {
  const ranges: Range[] = [];
  for (const key of GLOBAL_SUPPRESSOR_KEYS) {
    const ap = rs.antiPatterns.get(key);
    if (!ap || ap.windowChars !== null) continue;
    ap.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ap.regex.exec(input)) !== null) {
      const len = m[0].length;
      ranges.push({ start: m.index, end: m.index + len });
      if (len === 0) ap.regex.lastIndex++;
    }
  }
  let sorted = true;
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i - 1].start > ranges[i].start) {
      sorted = false;
      break;
    }
  }
  if (!sorted) ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function rangeInsideAny(start: number, end: number, ranges: Range[]): boolean {
  if (ranges.length === 0) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (r.start <= start && r.end >= end) return true;
    if (r.start > start) hi = mid - 1;
    else lo = mid + 1;
  }
  return false;
}

function isSafeListed(
  rule: CompiledRule,
  value: string,
  input: string,
  start: number,
  rs: CompiledRuleset,
): boolean {
  if (rule.category === "Email") {
    const lower = value.toLowerCase();
    if (rs.safeList.emailsExactLower.has(lower)) return true;
    const mailtoMatch = /^mailto:(.+)$/i.exec(lower);
    if (mailtoMatch && rs.safeList.emailsExactLower.has(mailtoMatch[1])) return true;
    return false;
  }

  if (rule.category === "Network") {
    if (rs.safeList.hostsExact.has(value)) return true;
    return false;
  }

  if (rule.category === "Credit Card") {
    const digits = value.replace(/\D/g, "");
    if (!rs.safeList.ccTestPansDigits.has(digits)) return false;
    const windowStart = Math.max(0, start - 24);
    const window = input.slice(windowStart, start).toLowerCase();
    return /\b(?:test|sample|demo|example|sandbox)\b/.test(window);
  }

  return false;
}

/**
 * Returns true if any of the rule's declared context-booster regexes matches
 * within ±BOOSTER_WINDOW chars of [start, end]. Used as the prerequisite gate
 * for confidence: low rules under the tier policy. Mirrors the window sizing
 * and lookup pattern already used by computeContextBoost so the policy gate
 * and the priority bump see the same context window.
 */
function hasAnyBoosterContext(
  boosterKeys: string[],
  input: string,
  start: number,
  end: number,
): boolean {
  if (boosterKeys.length === 0) return false;
  const windowStart = Math.max(0, start - BOOSTER_WINDOW);
  const windowEnd = Math.min(input.length, end + BOOSTER_WINDOW);
  const window = input.slice(windowStart, windowEnd);
  for (const key of boosterKeys) {
    const re = BOOSTER_KEYWORDS[key];
    if (re && re.test(window)) {
      re.lastIndex = 0;
      return true;
    }
    if (re) re.lastIndex = 0;
  }
  return false;
}

function computeContextBoost(
  rule: { contextBoosters: string[] },
  input: string,
  start: number,
  end: number,
): number {
  if (rule.contextBoosters.length === 0) return 0;
  const windowStart = Math.max(0, start - BOOSTER_WINDOW);
  const windowEnd = Math.min(input.length, end + BOOSTER_WINDOW);
  const window = input.slice(windowStart, windowEnd);
  for (const boosterKey of rule.contextBoosters) {
    const re = BOOSTER_KEYWORDS[boosterKey];
    if (re && re.test(window)) {
      re.lastIndex = 0;
      return BOOSTER_PRIORITY_BUMP;
    }
    if (re) re.lastIndex = 0;
  }
  return 0;
}

function hasContextMatch(input: string, start: number, end: number, re: RegExp): boolean {
  const windowStart = Math.max(0, start - 32);
  const windowEnd = Math.min(input.length, end + 32);
  const window = input.slice(windowStart, windowEnd);
  const result = re.test(window);
  re.lastIndex = 0;
  return result;
}

function resolveOverlaps(candidates: EngineMatch[], inputLength: number): EngineMatch[] {
  candidates.sort((a, b) => {
    const alen = a.end - a.start;
    const blen = b.end - b.start;
    if (blen !== alen) return blen - alen;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.start - b.start;
  });

  const occupied = new Uint8Array(inputLength);
  const accepted: EngineMatch[] = [];
  for (const c of candidates) {
    let clash = false;
    for (let i = c.start; i < c.end; i++) {
      if (occupied[i]) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    for (let i = c.start; i < c.end; i++) occupied[i] = 1;
    accepted.push(c);
  }
  return accepted;
}

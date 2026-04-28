import type {
  CompiledAntiPattern,
  CompiledRule,
  CompiledRuleset,
  RawRuleset,
} from "./types.js";
import rawRuleset from "../resources/pii-ruleset.json";

let cached: CompiledRuleset | null = null;

export function loadRuleset(): CompiledRuleset {
  if (cached) return cached;
  cached = compileRuleset(rawRuleset as unknown as RawRuleset);
  return cached;
}

export function resetRulesetCacheForTests(): void {
  cached = null;
}

export function compileRuleset(raw: RawRuleset): CompiledRuleset {
  const rules: CompiledRule[] = raw.pii_patterns.map((r) => {
    const { pattern, flags } = normalizePattern(r.regex, r.flags ?? "");
    const regex = new RegExp(pattern, ensureGlobal(flags));
    const replacementToken = raw.replacement_tokens[r.replacement_token];
    if (replacementToken === undefined) {
      throw new Error("ruleset_compile_error");
    }
    return {
      name: r.name,
      category: r.category,
      priority: r.priority,
      confidence: r.confidence,
      regex,
      replacementTokenKey: r.replacement_token,
      replacementToken,
      validator: r.validator ?? null,
      antiPatterns: r.anti_patterns ?? [],
      contextBoosters: r.context_boosters ?? [],
    };
  });
  rules.sort((a, b) => b.priority - a.priority);

  const antiPatterns = new Map<string, CompiledAntiPattern>();
  for (const [key, value] of Object.entries(raw.ambiguity_rules)) {
    const { pattern, flags } = normalizePattern(value.regex, "");
    antiPatterns.set(key, {
      key,
      regex: new RegExp(pattern, ensureGlobal(flags)),
      windowChars: typeof value.window_chars === "number" ? value.window_chars : null,
    });
  }
  // Alias: rules reference suppress_if_iso8601 but ambiguity_rules defines suppress_if_inside_iso8601.
  if (antiPatterns.has("suppress_if_inside_iso8601") && !antiPatterns.has("suppress_if_iso8601")) {
    antiPatterns.set("suppress_if_iso8601", antiPatterns.get("suppress_if_inside_iso8601")!);
  }

  const safeList = {
    hostsExact: new Set<string>(raw.safe_list?.hosts ?? []),
    emailsExactLower: new Set<string>((raw.safe_list?.emails ?? []).map((e) => e.toLowerCase())),
    ccTestPansDigits: new Set<string>(
      (raw.safe_list?.cc_test_pans ?? []).map((p) => p.replace(/\D/g, "")),
    ),
  };

  return {
    version: raw.ruleset_version,
    rules,
    antiPatterns,
    safeList,
  };
}

function ensureGlobal(flags: string): string {
  if (!flags.includes("g")) {
    return flags + "g";
  }
  return flags;
}

function normalizePattern(
  pattern: string,
  existingFlags: string,
): { pattern: string; flags: string } {
  let p = pattern;
  let f = existingFlags;
  const inlineFlagMatch = /^\(\?([a-z]+)\)/.exec(p);
  if (inlineFlagMatch) {
    const inlineFlags = inlineFlagMatch[1];
    p = p.slice(inlineFlagMatch[0].length);
    for (const ch of inlineFlags) {
      if (!f.includes(ch)) f += ch;
    }
  }
  return { pattern: p, flags: f };
}

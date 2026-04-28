export type RedactionStats = Record<string, number>;

export interface RedactInput {
  snapshotYaml: string;
  url?: string;
}

export interface RedactResult {
  snapshotYaml: string;
  url?: string;
  redactionStats: RedactionStats;
}

export type RedactScope = "body" | "url" | "both";

export interface RedactOptions {
  scope?: RedactScope;
}

export interface RawRule {
  category: string;
  name: string;
  region: string;
  priority: number;
  confidence: "high" | "medium" | "low";
  regex: string;
  flags?: string;
  replacement_token: string;
  validator?: string;
  anti_patterns?: string[];
  context_boosters?: string[];
  notes?: string;
}

export interface RawAmbiguityRule {
  regex: string;
  window_chars?: number;
  type?: string;
  description?: string;
}

export interface RawRuleset {
  ruleset_version: string;
  replacement_tokens: Record<string, string>;
  ambiguity_rules: Record<string, RawAmbiguityRule>;
  pii_patterns: RawRule[];
  safe_list?: {
    hosts?: string[];
    emails?: string[];
    dom_tokens?: string[];
    cc_test_pans?: string[];
  };
}

export interface CompiledRule {
  name: string;
  category: string;
  priority: number;
  confidence: "high" | "medium" | "low";
  regex: RegExp;
  replacementTokenKey: string;
  replacementToken: string;
  validator: string | null;
  antiPatterns: string[];
  contextBoosters: string[];
}

export interface CompiledAntiPattern {
  key: string;
  regex: RegExp;
  windowChars: number | null;
}

export interface CompiledRuleset {
  version: string;
  rules: CompiledRule[];
  antiPatterns: Map<string, CompiledAntiPattern>;
  safeList: {
    hostsExact: Set<string>;
    emailsExactLower: Set<string>;
    ccTestPansDigits: Set<string>;
  };
}

export interface Range {
  start: number;
  end: number;
}

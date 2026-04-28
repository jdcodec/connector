/**
 * Text helpers for extracting structured fields from Playwright MCP tool responses.
 * Commoditized parsing only — no codec logic here, just regex over the MCP text protocol.
 */

/** Extract page URL from a Playwright MCP response text. */
export function extractUrlFromResponse(text: string): string | null {
  const m = /Page URL:\s*(\S+)/i.exec(text);
  if (m) return m[1];
  const m2 = /Page url:\s*(\S+)/i.exec(text);
  if (m2) return m2[1];
  return null;
}

export interface SnapshotSplit {
  yamlText: string;
  prefix: string;
  suffix: string;
}

/**
 * Splits a Playwright MCP response around its ```yaml fenced code block. Returns
 * `null` when no YAML block is found (e.g. an error response).
 *
 *   <prefix> ```yaml
 *   ...yamlText...
 *   ``` <suffix>
 *
 * `prefix` ends with ``` ```yaml\n ``` and `suffix` starts with ```` ``` ````.
 */
export function splitSnapshotYaml(text: string): SnapshotSplit | null {
  const re = /(```yaml\n)([\s\S]*?)(```)/;
  const m = re.exec(text);
  if (!m) return null;
  const fenceStart = m.index;
  const fenceEnd = fenceStart + m[0].length;
  return {
    yamlText: m[2].trim(),
    prefix: text.slice(0, fenceStart) + m[1],
    suffix: m[3] + text.slice(fenceEnd),
  };
}

/** Reassemble a response text after replacing the YAML block with compressed output. */
export function joinSnapshotYaml(split: SnapshotSplit, replacement: string): string {
  return split.prefix + replacement + "\n" + split.suffix;
}

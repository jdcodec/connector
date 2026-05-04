import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Single source of truth for the connector version, read from the
 * shipped `package.json` at module load. Avoids hardcoding a version
 * literal in banner output, where it would inevitably drift from the
 * real version on the next bump.
 *
 * The compiled file lives at `dist/onboarding/version.js`, so
 * `../../package.json` resolves to the package root in both source
 * and built form. We use `__dirname` because the package compiles to
 * CommonJS (NodeNext + no `"type": "module"` in package.json), where
 * `import.meta.url` isn't available.
 */
function readVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to "unknown" — keeps the banner working in odd
    // package-relocation scenarios without crashing the CLI.
  }
  return "unknown";
}

export const VERSION = readVersion();

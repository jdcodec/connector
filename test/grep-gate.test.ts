import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(__dirname, "..");
const SCRIPT = join(PKG_ROOT, "scripts", "grep-gate.sh");

describe("grep-gate", () => {
  it("passes on clean tree", () => {
    const out = execFileSync("bash", [SCRIPT], {
      cwd: PKG_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("OK");
  });

  it("fails when a file uses an import that escapes the package (2+ levels of '..')", () => {
    const violatingDir = join(PKG_ROOT, "src", "_grep_gate_test_violation");
    const violatingFile = join(violatingDir, "violation.ts");
    mkdirSync(violatingDir, { recursive: true });
    writeFileSync(
      violatingFile,
      "import { doNotUse } from \"../../../external/module\";\nvoid doNotUse;\n",
      "utf8",
    );
    try {
      let code = 0;
      try {
        execFileSync("bash", [SCRIPT], { cwd: PKG_ROOT, encoding: "utf8" });
      } catch (e) {
        code = (e as { status?: number }).status ?? -1;
      }
      expect(code, "grep-gate must exit non-zero on violation").not.toBe(0);
    } finally {
      try {
        unlinkSync(violatingFile);
        rmSync(violatingDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("fails when a file references codec-internal terminology", () => {
    const violatingDir = join(PKG_ROOT, "src", "_grep_gate_test_violation");
    const violatingFile = join(violatingDir, "codec-term.ts");
    mkdirSync(violatingDir, { recursive: true });
    // Single banned term in a comment is enough — check 2 scans content,
    // not just imports.
    writeFileSync(
      violatingFile,
      "// would-be helper for compactIframe handoff\nexport const placeholder = 1;\n",
      "utf8",
    );
    try {
      let code = 0;
      let stderr = "";
      try {
        execFileSync("bash", [SCRIPT], { cwd: PKG_ROOT, encoding: "utf8" });
      } catch (e) {
        const err = e as { status?: number; stderr?: string | Buffer };
        code = err.status ?? -1;
        stderr = err.stderr?.toString() ?? "";
      }
      expect(code, "grep-gate must exit non-zero on codec-term violation").not.toBe(0);
      expect(stderr, "error output should call out codec terminology").toContain(
        "codec-internal terminology",
      );
    } finally {
      try {
        unlinkSync(violatingFile);
        rmSync(violatingDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});

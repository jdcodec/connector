import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/env.js";

function makeEnv(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("applies defaults with minimal env", () => {
    const cfg = loadConfig({ env: makeEnv({}), readFile: () => null });
    expect(cfg.apiKey).toBeNull();
    expect(cfg.cloudUrl).toBe("https://api.jdcodec.com");
    expect(cfg.bypass).toBe(false);
    expect(cfg.region).toBeUndefined();
    expect(cfg.playwrightCmd).toBe("npx");
    expect(cfg.playwrightArgs).toEqual(["@playwright/mcp", "--no-sandbox"]);
    expect(cfg.traceEnabled).toBe(false);
    expect(cfg.failOpen).toBe(false);
  });

  it("reads api key from JDC_API_KEY env", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_API_KEY: "jdck_env.secret" }),
      readFile: () => null,
    });
    expect(cfg.apiKey).toBe("jdck_env.secret");
  });

  it("falls back to ~/.jdcodec/config.json when env is absent", () => {
    const cfg = loadConfig({
      env: makeEnv({}),
      readFile: (p) => {
        expect(p).toContain(".jdcodec");
        return JSON.stringify({ api_key: "jdck_file.secret" });
      },
    });
    expect(cfg.apiKey).toBe("jdck_file.secret");
  });

  it("env wins over config file", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_API_KEY: "jdck_env.secret" }),
      readFile: () => JSON.stringify({ api_key: "jdck_file.secret" }),
    });
    expect(cfg.apiKey).toBe("jdck_env.secret");
  });

  it("ignores malformed config file without throwing", () => {
    const cfg = loadConfig({ env: makeEnv({}), readFile: () => "not-json{" });
    expect(cfg.apiKey).toBeNull();
  });

  it("parses JDC_BYPASS", () => {
    expect(
      loadConfig({ env: makeEnv({ JDC_BYPASS: "1" }), readFile: () => null }).bypass,
    ).toBe(true);
    expect(
      loadConfig({ env: makeEnv({ JDC_BYPASS: "true" }), readFile: () => null }).bypass,
    ).toBe(true);
    expect(
      loadConfig({ env: makeEnv({ JDC_BYPASS: "no" }), readFile: () => null }).bypass,
    ).toBe(false);
  });

  it("splits JDC_PLAYWRIGHT_ARGS on whitespace", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_PLAYWRIGHT_ARGS: "@playwright/mcp --foo bar" }),
      readFile: () => null,
    });
    expect(cfg.playwrightArgs).toEqual(["@playwright/mcp", "--foo", "bar"]);
  });

  it("strips trailing slash from JDC_CLOUD_URL", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_CLOUD_URL: "https://api.example.test//" }),
      readFile: () => null,
    });
    expect(cfg.cloudUrl).toBe("https://api.example.test");
  });

  it("passes JDC_REGION through", () => {
    const cfg = loadConfig({ env: makeEnv({ JDC_REGION: "oc" }), readFile: () => null });
    expect(cfg.region).toBe("oc");
  });

  it("surfaces JDC_PRIVACY_FAIL_OPEN", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_PRIVACY_FAIL_OPEN: "1" }),
      readFile: () => null,
    });
    expect(cfg.failOpen).toBe(true);
  });
});

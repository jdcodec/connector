import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/env.js";

function makeEnv(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("loadConfig — Privacy Shield bypass two-step gate", () => {
  it("defaults: shield on, ack false, bypass not engaged", () => {
    const cfg = loadConfig({ env: makeEnv({}), readFile: () => null });
    expect(cfg.privacyShield).toBe("on");
    expect(cfg.privacyShieldBypassAck).toBe(false);
    expect(cfg.privacyShieldBypassEngaged).toBe(false);
  });

  it("off-switch + ack engages bypass", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_PRIVACY_SHIELD: "off", JDC_PRIVACY_SHIELD_BYPASS_ACK: "1" }),
      readFile: () => null,
    });
    expect(cfg.privacyShield).toBe("off");
    expect(cfg.privacyShieldBypassAck).toBe(true);
    expect(cfg.privacyShieldBypassEngaged).toBe(true);
  });

  it("off-switch alone does NOT engage bypass", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_PRIVACY_SHIELD: "off" }),
      readFile: () => null,
    });
    expect(cfg.privacyShield).toBe("off");
    expect(cfg.privacyShieldBypassAck).toBe(false);
    expect(cfg.privacyShieldBypassEngaged).toBe(false);
  });

  it("ack alone (shield on) does NOT engage bypass", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_PRIVACY_SHIELD_BYPASS_ACK: "1" }),
      readFile: () => null,
    });
    expect(cfg.privacyShield).toBe("on");
    expect(cfg.privacyShieldBypassAck).toBe(true);
    expect(cfg.privacyShieldBypassEngaged).toBe(false);
  });

  it("off is case-insensitive and trims whitespace", () => {
    expect(
      loadConfig({ env: makeEnv({ JDC_PRIVACY_SHIELD: "OFF" }), readFile: () => null })
        .privacyShield,
    ).toBe("off");
    expect(
      loadConfig({ env: makeEnv({ JDC_PRIVACY_SHIELD: "  Off  " }), readFile: () => null })
        .privacyShield,
    ).toBe("off");
  });

  it("fail-safe: unset, 'on', or any unknown value keeps the Shield on", () => {
    for (const value of [undefined, "on", "true", "1", "disabled", "garbage"]) {
      const cfg = loadConfig({
        env: makeEnv(value === undefined ? {} : { JDC_PRIVACY_SHIELD: value }),
        readFile: () => null,
      });
      expect(cfg.privacyShield).toBe("on");
    }
  });

  it("a non-off env value does not fall through to the config file", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_PRIVACY_SHIELD: "on" }),
      readFile: () => JSON.stringify({ privacy_shield: "off" }),
    });
    expect(cfg.privacyShield).toBe("on");
  });

  it("config-file privacy_shield + privacy_shield_bypass_ack engage bypass when env is unset", () => {
    const cfg = loadConfig({
      env: makeEnv({}),
      readFile: () =>
        JSON.stringify({ privacy_shield: "off", privacy_shield_bypass_ack: true }),
    });
    expect(cfg.privacyShield).toBe("off");
    expect(cfg.privacyShieldBypassAck).toBe(true);
    expect(cfg.privacyShieldBypassEngaged).toBe(true);
  });

  it("config-file ack must be boolean true, not the string \"true\"", () => {
    const cfg = loadConfig({
      env: makeEnv({}),
      readFile: () =>
        JSON.stringify({ privacy_shield: "off", privacy_shield_bypass_ack: "true" }),
    });
    expect(cfg.privacyShieldBypassAck).toBe(false);
    expect(cfg.privacyShieldBypassEngaged).toBe(false);
  });

  it("env ack (truthy) is honoured alongside the off-switch", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_PRIVACY_SHIELD: "off", JDC_PRIVACY_SHIELD_BYPASS_ACK: "yes" }),
      readFile: () => null,
    });
    expect(cfg.privacyShieldBypassEngaged).toBe(true);
  });

  it("malformed config file does not throw and keeps the safe defaults", () => {
    const cfg = loadConfig({ env: makeEnv({}), readFile: () => "not-json{" });
    expect(cfg.privacyShield).toBe("on");
    expect(cfg.privacyShieldBypassAck).toBe(false);
    expect(cfg.privacyShieldBypassEngaged).toBe(false);
  });

  it("stays distinct from the codec bypass (JDC_BYPASS)", () => {
    const cfg = loadConfig({
      env: makeEnv({ JDC_BYPASS: "1" }),
      readFile: () => null,
    });
    expect(cfg.bypass).toBe(true);
    expect(cfg.privacyShield).toBe("on");
    expect(cfg.privacyShieldBypassEngaged).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { handleSnapshot } from "../src/proxy/snapshot.js";
import { CloudClient } from "../src/cloud/client.js";
import { SessionState } from "../src/session/state.js";

const RESPONSE = [
  "Page URL: https://example.com/users/jane@example.org",
  "",
  "- Page Snapshot",
  "```yaml",
  "- heading \"Hello jane@example.org\" [ref=e1]",
  "- textbox \"card\" [ref=e2]: 4111-1111-1111-1111",
  "```",
  "",
  "Tabs: 0",
].join("\n");

function compressedResponse(): Response {
  return new Response(
    JSON.stringify({
      frame_type: "I",
      compressed_output: "COMPRESSED_PAYLOAD",
      compression_stats: { input_chars: 100, output_chars: 20, codec_ms: 5 },
    }),
    { status: 200, headers: { "x-request-id": "req-1" } },
  );
}

function stubCloud(handler: (req: unknown) => Response | Promise<Response>): CloudClient {
  return new CloudClient({
    apiKey: "jdck_id.secret",
    fetchImpl: async (_input, init) => {
      const parsed = JSON.parse((init as RequestInit).body as string);
      return handler(parsed);
    },
    sleep: async () => {},
  });
}

function makeLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  return {
    events,
    logger: {
      info: (event: string, fields?: Record<string, unknown>) => {
        events.push({ level: "info", event, fields });
      },
      warn: (event: string, fields?: Record<string, unknown>) => {
        events.push({ level: "warn", event, fields });
      },
      error: (event: string, fields?: Record<string, unknown>) => {
        events.push({ level: "error", event, fields });
      },
    },
  };
}

describe("handleSnapshot — Privacy Shield bypass engaged", () => {
  it("sends client_redacted:false + privacy_shield_bypass:true + empty redaction_stats with the raw url + yaml", async () => {
    let captured: Record<string, unknown> | undefined;
    const cloud = stubCloud(async (req) => {
      captured = req as Record<string, unknown>;
      return compressedResponse();
    });

    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      privacyShieldBypass: true,
    });

    expect(result.outcome).toBe("compressed");
    const body = captured as {
      client_redacted: boolean;
      privacy_shield_bypass?: boolean;
      redaction_stats: Record<string, number>;
      url: string;
      snapshot_yaml: string;
    };
    expect(body.client_redacted).toBe(false);
    expect(body.privacy_shield_bypass).toBe(true);
    expect(body.redaction_stats).toEqual({});
    // The Shield did not run: the raw url + yaml reach the cloud verbatim.
    expect(body.url).toContain("jane@example.org");
    expect(body.snapshot_yaml).toContain("jane@example.org");
    expect(body.snapshot_yaml).toContain("4111-1111-1111-1111");
    expect(body.snapshot_yaml).not.toContain("{{REDACTED_EMAIL}}");
  });

  it("emits a per-snapshot WARN carrying counts/ids only — never snapshot content", async () => {
    const cloud = stubCloud(async () => compressedResponse());
    const { events, logger } = makeLogger();

    await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      privacyShieldBypass: true,
      log: logger,
    });

    const warn = events.find((e) => e.event === "privacy.bypass.engaged");
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warn");
    expect(Object.keys(warn!.fields ?? {}).sort()).toEqual([
      "input_chars",
      "session_id",
      "step",
    ]);
    expect(typeof warn!.fields!.input_chars).toBe("number");
    const serialized = JSON.stringify(warn!.fields);
    expect(serialized).not.toContain("jane@example.org");
    expect(serialized).not.toContain("4111-1111-1111-1111");
  });

  it("does not emit the engaged WARN on the default (non-bypass) path", async () => {
    const cloud = stubCloud(async () => compressedResponse());
    const { events, logger } = makeLogger();
    await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      log: logger,
    });
    expect(events.find((e) => e.event === "privacy.bypass.engaged")).toBeUndefined();
  });
});

describe("handleSnapshot — codec bypass short-circuits the privacy bypass", () => {
  it("JDC_BYPASS set: no cloud POST happens even when the privacy bypass is engaged", async () => {
    const cloud = stubCloud(async () => {
      throw new Error("postSnapshot should not be called when codec bypass is set");
    });
    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: true,
      privacyShieldBypass: true,
    });
    expect(result.outcome).toBe("bypass");
  });
});

describe("handleSnapshot — off-switch without ack (incomplete)", () => {
  it("runs the Shield normally and warns once across multiple snapshots", async () => {
    let captured: Record<string, unknown> | undefined;
    const cloud = stubCloud(async (req) => {
      captured = req as Record<string, unknown>;
      return compressedResponse();
    });
    const { events, logger } = makeLogger();

    await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      privacyShieldBypassIncomplete: true,
      log: logger,
    });
    await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      privacyShieldBypassIncomplete: true,
      log: logger,
    });

    // The Shield ran: redacted body, client_redacted true, no bypass flag.
    const body = captured as {
      client_redacted: boolean;
      privacy_shield_bypass?: boolean;
      snapshot_yaml: string;
    };
    expect(body.client_redacted).toBe(true);
    expect(body.privacy_shield_bypass).toBeUndefined();
    expect(body.snapshot_yaml).toContain("{{REDACTED_EMAIL}}");

    // One-time WARN across both snapshots.
    const incompletes = events.filter((e) => e.event === "privacy.bypass.incomplete");
    expect(incompletes.length).toBe(1);
    expect(incompletes[0].level).toBe("warn");
  });
});

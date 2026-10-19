import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SttServiceSchema } from "../../../config/schemas/stt.js";
import { sttGatewayProviderMigration as MIG } from "../165-stt-gateway-provider.js";

let workspaceDir: string;
let configPath: string;

function write(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}

function read(): Record<string, any> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function stt(): Record<string, any> {
  return read().services.stt;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "stt-gateway-provider-"));
  configPath = join(workspaceDir, "config.json");
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("165-stt-gateway-provider", () => {
  test("has the expected id", () => {
    expect(MIG.id).toBe("165-stt-gateway-provider");
  });

  test("points batch transcription at the gateway and pins streaming roles", () => {
    write({
      services: {
        stt: {
          provider: "vellum",
          language: "multi",
          providers: {},
          roles: {},
        },
      },
    });

    MIG.run(workspaceDir);

    expect(stt().provider).toBe("gateway");
    expect(stt().providers.gateway).toEqual({ model: "stt" });
    expect(stt().roles).toEqual({
      liveVoice: { provider: "vellum" },
      telephony: { provider: "vellum" },
      dictation: { provider: "vellum" },
      watch: { provider: "vellum" },
    });
    expect(stt().language).toBe("multi");
  });

  test("keeps an explicit streaming role selection", () => {
    write({
      services: {
        stt: {
          provider: "vellum",
          language: "en",
          providers: {},
          roles: { liveVoice: { provider: "deepgram", model: "flux" } },
        },
      },
    });

    MIG.run(workspaceDir);

    expect(stt().roles.liveVoice).toEqual({
      provider: "deepgram",
      model: "flux",
    });
    expect(stt().roles.dictation).toEqual({ provider: "vellum" });
  });

  test("creates services.stt when missing", () => {
    write({});

    MIG.run(workspaceDir);

    expect(stt().provider).toBe("gateway");
    expect(stt().providers.gateway).toEqual({ model: "stt" });
    expect(stt().roles.batch).toBeUndefined();
  });

  test("leaves the migrated block schema-valid", () => {
    write({ services: { stt: { provider: "vellum", providers: {} } } });

    MIG.run(workspaceDir);

    const parsed = SttServiceSchema.parse(stt());
    expect(parsed.provider).toBe("gateway");
    expect(parsed.providers.gateway?.model).toBe("stt");
    expect(parsed.roles.liveVoice?.provider).toBe("vellum");
  });

  test("is idempotent", () => {
    write({ services: { stt: { provider: "vellum", providers: {} } } });
    MIG.run(workspaceDir);
    const before = readFileSync(configPath, "utf-8");

    MIG.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("no-ops when config.json is absent", () => {
    expect(() => MIG.run(workspaceDir)).not.toThrow();
  });

  test("down restores the managed provider and drops the gateway entry", () => {
    write({
      services: {
        stt: { provider: "gateway", providers: { gateway: { model: "stt" } } },
      },
    });

    MIG.down(workspaceDir);

    expect(stt().provider).toBe("vellum");
    expect(stt().providers.gateway).toBeUndefined();
  });
});

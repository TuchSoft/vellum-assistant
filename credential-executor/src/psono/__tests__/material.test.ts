import { describe, expect, test } from "bun:test";

import { parseMaterial } from "../material.js";

const PRIVATE = "11".repeat(32);
const SECRET = "22".repeat(32);

describe("parseMaterial", () => {
  test("parses NAME=value lines", () => {
    const material = parseMaterial(
      [
        "API_KEY_ID=key-1",
        `API_KEY_PRIVATE_KEY=${PRIVATE}`,
        `API_KEY_SECRET_KEY=${SECRET}`,
        "SERVER_URL=https://psono.example/server/",
      ].join("\n"),
    );
    expect(material).toEqual({
      apiKeyId: "key-1",
      apiKeyPrivateKeyHex: PRIVATE,
      apiKeySecretKeyHex: SECRET,
      serverUrl: "https://psono.example/server",
    });
  });

  test("parses the value/name pair layout", () => {
    const material = parseMaterial(
      [
        "key-1",
        "API_KEY_ID",
        "",
        PRIVATE,
        "API_KEY_PRIVATE_KEY",
        "",
        SECRET,
        "API_KEY_SECRET_KEY",
        "",
        "https://psono.example/server",
        "SERVER_URL",
      ].join("\n"),
    );
    expect(material.apiKeyId).toBe("key-1");
    expect(material.serverUrl).toBe("https://psono.example/server");
  });

  test("rejects a missing field without echoing a value", () => {
    expect(() =>
      parseMaterial(`API_KEY_ID=key-1\nSERVER_URL=https://x.example`),
    ).toThrow("API_KEY_PRIVATE_KEY");
  });

  test("rejects a non-hex private key", () => {
    expect(() =>
      parseMaterial(
        [
          "API_KEY_ID=key-1",
          "API_KEY_PRIVATE_KEY=not-hex",
          `API_KEY_SECRET_KEY=${SECRET}`,
          "SERVER_URL=https://x.example",
        ].join("\n"),
      ),
    ).toThrow("API_KEY_PRIVATE_KEY");
  });
});

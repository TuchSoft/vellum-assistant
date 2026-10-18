import { afterEach, describe, expect, test } from "bun:test";

import { checkUnrecognizedEnvVars } from "../env-registry.js";

const KEY = "VELLUM_DATABASE_URL";

describe("checkUnrecognizedEnvVars", () => {
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  test("recognizes VELLUM_DATABASE_URL", () => {
    process.env[KEY] = "postgres://user@example.test/vellum";
    expect(checkUnrecognizedEnvVars()).not.toContain(
      `Unrecognized environment variable: ${KEY}`,
    );
  });
});

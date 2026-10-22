/**
 * Psono API key material: loading and validation.
 *
 * The material file holds four values and lives outside the repository. The
 * loader accepts both `NAME=value` lines (the documented brief format) and the
 * value/name pair layout produced by the test material. Values stay in RAM and
 * are never logged.
 */

import { readFileSync } from "node:fs";

export interface PsonoMaterial {
  apiKeyId: string;
  apiKeyPrivateKeyHex: string;
  apiKeySecretKeyHex: string;
  serverUrl: string;
}

const REQUIRED_FIELDS = [
  "API_KEY_ID",
  "API_KEY_PRIVATE_KEY",
  "API_KEY_SECRET_KEY",
  "SERVER_URL",
] as const;

const NAME_LINE = /^[A-Z][A-Z0-9_]*$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Parse material text into a validated `PsonoMaterial`.
 *
 * Throws an Error naming the offending field (never the value).
 */
export function parseMaterial(text: string): PsonoMaterial {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const raw: Record<string, string> = {};

  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0 && NAME_LINE.test(line.slice(0, eq))) {
      raw[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
  }

  if (!REQUIRED_FIELDS.every((name) => raw[name])) {
    // Fall back to the value/name pair layout.
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const value = lines[i]!;
      const name = lines[i + 1]!;
      if (NAME_LINE.test(name) && !value.includes("=")) {
        raw[name] = value;
      } else {
        break;
      }
    }
  }

  for (const name of REQUIRED_FIELDS) {
    if (!raw[name]) {
      throw new Error(`Psono material is missing ${name}`);
    }
  }

  const apiKeyPrivateKeyHex = raw["API_KEY_PRIVATE_KEY"]!;
  const apiKeySecretKeyHex = raw["API_KEY_SECRET_KEY"]!;
  if (!HEX_32_BYTES.test(apiKeyPrivateKeyHex)) {
    throw new Error("Psono material API_KEY_PRIVATE_KEY is not 32 bytes of hex");
  }
  if (!HEX_32_BYTES.test(apiKeySecretKeyHex)) {
    throw new Error("Psono material API_KEY_SECRET_KEY is not 32 bytes of hex");
  }

  const serverUrl = stripTrailingSlash(raw["SERVER_URL"]!);
  if (!/^https?:\/\//i.test(serverUrl)) {
    throw new Error("Psono material SERVER_URL must be an http(s) URL");
  }

  return {
    apiKeyId: raw["API_KEY_ID"]!,
    apiKeyPrivateKeyHex,
    apiKeySecretKeyHex,
    serverUrl,
  };
}

/** Read and validate the material file at `path`. */
export function loadMaterialFile(path: string): PsonoMaterial {
  return parseMaterial(readFileSync(path, "utf-8"));
}

/**
 * Load material from `PSONO_MATERIAL_FILE`.
 *
 * Returns `undefined` when the variable is unset or empty: the read path is
 * optional and its endpoints report `unavailable` in that case.
 */
export function loadMaterialFromEnv(): PsonoMaterial | undefined {
  const path = process.env["PSONO_MATERIAL_FILE"]?.trim();
  if (!path) {
    return undefined;
  }
  return loadMaterialFile(path);
}

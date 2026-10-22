import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

import {
  PsonoCredentialBackend,
  type RecordSource,
} from "../backend.js";
import { PsonoClient } from "../client.js";
import { loadMaterialFile } from "../material.js";
import { PsonoTree, type PsonoEntry } from "../tree.js";
import type { PsonoShareContent, SecretPayload } from "../types.js";

const MATERIAL_PATH =
  process.env["PSONO_MATERIAL_FILE"] ??
  "/Users/mattiabonzi/Progetti/assistant/docs/psono/CRED.txt";

const FOLDER = "_ces-write-test";
const ENTRY_ONE = `${FOLDER}/entry-one`;
const ENTRY_TWO = `${FOLDER}/entry-two`;

const noRecords: RecordSource = {
  getByAccount: () => undefined,
  list: () => [],
};

function randomValue(): string {
  return randomBytes(18).toString("base64url");
}

const live = existsSync(MATERIAL_PATH) ? describe : describe.skip;

live("Psono write integration", () => {
  const material = existsSync(MATERIAL_PATH)
    ? loadMaterialFile(MATERIAL_PATH)
    : undefined;
  const client = material
    ? new PsonoClient({
        material,
        serverPublicKeyHex: material.serverPublicKeyHex,
      })
    : undefined;
  const tree = client ? new PsonoTree(client) : undefined;
  const backend =
    client && tree
      ? new PsonoCredentialBackend({ client, tree, records: noRecords })
      : undefined;

  async function readEntry(ref: string): Promise<SecretPayload> {
    tree!.invalidate();
    const entry: PsonoEntry = await tree!.find(ref);
    return tree!.readPayload(entry);
  }

  async function itemNames(): Promise<string[]> {
    const handle = await tree!.openWritableShare();
    const content = await handle.read();
    const folder = (content.folders ?? []).find(
      (candidate) => candidate.name === FOLDER,
    );
    return (folder?.items ?? [])
      .map((item) => item.name)
      .filter((name): name is string => typeof name === "string");
  }

  async function cleanupFolder(): Promise<void> {
    const handle = await tree!.openWritableShare();
    const content = await handle.read();
    const folder = (content.folders ?? []).find(
      (candidate) => candidate.name === FOLDER,
    );
    if (!folder) {
      tree!.invalidate();
      return;
    }
    const items = [...(folder.items ?? [])];

    // Drop the folder from the share first: the entries stop being visible even
    // if deleting one of the backing secrets fails.
    await handle.update((next: PsonoShareContent) => {
      if (!Array.isArray(next.folders)) {
        return;
      }
      next.folders = next.folders.filter(
        (candidate) => candidate.name !== FOLDER,
      );
    });

    for (const item of items) {
      if (typeof item.id === "string") {
        try {
          await client!.deleteSecretLink(item.id);
        } catch {
          // Best effort: the visible state is already clean.
        }
      }
    }
    tree!.invalidate();
  }

  beforeAll(async () => {
    await client!.login();
    await cleanupFolder();
  }, 60_000);

  afterAll(async () => {
    await cleanupFolder();
  }, 60_000);

  test(
    "creates an entry and reads it back",
    async () => {
      const value = randomValue();
      const result = await backend!.createEntry(
        ENTRY_ONE,
        { title: "entry-one", password: value },
        "value",
      );
      expect(result.created).toBe(true);

      const payload = await readEntry(ENTRY_ONE);
      expect(typeof payload["password"]).toBe("string");
      expect(payload["password"] === value).toBe(true);
    },
    60_000,
  );

  test(
    "updates the value in place",
    async () => {
      const value = randomValue();
      const result = await backend!.updateEntry(ENTRY_ONE, {
        password: value,
      });
      expect(result.created).toBe(false);

      const payload = await readEntry(ENTRY_ONE);
      expect(payload["password"] === value).toBe(true);
    },
    60_000,
  );

  test(
    "a second entry does not lose the first",
    async () => {
      const first = await readEntry(ENTRY_ONE);
      const secondValue = randomValue();
      await backend!.createEntry(
        ENTRY_TWO,
        { title: "entry-two", password: secondValue },
        "value",
      );

      const names = await itemNames();
      expect(names.includes("entry-one")).toBe(true);
      expect(names.includes("entry-two")).toBe(true);

      const firstAfter = await readEntry(ENTRY_ONE);
      expect(firstAfter["password"] === first["password"]).toBe(true);
      const second = await readEntry(ENTRY_TWO);
      expect(second["password"] === secondValue).toBe(true);
    },
    60_000,
  );

  test(
    "creating the same ref twice keeps a single entry",
    async () => {
      const value = randomValue();
      await backend!.createEntry(ENTRY_TWO, { password: value });
      const names = await itemNames();
      expect(names.filter((name) => name === "entry-two")).toHaveLength(1);

      const payload = await readEntry(ENTRY_TWO);
      expect(payload["password"] === value).toBe(true);
    },
    60_000,
  );

  test(
    "deletes both entries and the test folder",
    async () => {
      const one = await backend!.deleteEntry(ENTRY_ONE);
      const two = await backend!.deleteEntry(ENTRY_TWO);
      expect(one.deleted).toBe(true);
      expect(two.deleted).toBe(true);
      expect(await itemNames()).toEqual([]);

      await cleanupFolder();
      const handle = await tree!.openWritableShare();
      const content = await handle.read();
      const stillThere = (content.folders ?? []).some(
        (candidate) => candidate.name === FOLDER,
      );
      expect(stillThere).toBe(false);
    },
    90_000,
  );
});

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import {
  createConnection,
  getConnection,
  listConnections,
  seedCanonicalConnections,
  updateConnection,
} from "../connections.js";

describePg("connection CRUD label defaults", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.orm.delete(db.schema.providerConnections);
  });

  test("new connection without label gets label=null", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "my-conn",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.label).toBeNull();
    }
  });

  test("createConnection passes explicit label", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "labeled-conn",
      provider: "openai",
      auth: { type: "platform" },
      label: "My OpenAI",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.label).toBe("My OpenAI");
    }
  });

  test("getConnection returns label from DB", async () => {
    await createConnection(requireMainDb(), {
      name: "get-me",
      provider: "gemini",
      auth: { type: "platform" },
      label: "Gemini Pro",
    });

    const conn = await getConnection(requireMainDb(), "get-me");
    expect(conn).not.toBeNull();
    expect(conn!.label).toBe("Gemini Pro");
  });

  test("updateConnection clears label when set to null", async () => {
    await createConnection(requireMainDb(), {
      name: "clear-label",
      provider: "openai",
      auth: { type: "platform" },
      label: "Old Label",
    });

    const result = await updateConnection(requireMainDb(), "clear-label", {
      auth: { type: "platform" },
      label: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.label).toBeNull();
    }
  });
});

describePg("seedCanonicalConnections labels", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.orm.delete(db.schema.providerConnections);
  });

  test("first boot seeds the default label on the vellum connection", async () => {
    await seedCanonicalConnections(requireMainDb());

    const conns = await listConnections(requireMainDb());
    const byName = Object.fromEntries(conns.map((c) => [c.name, c]));

    expect(byName["vellum"]?.label).toBe("Vellum");
  });

  test("second boot preserves user-customized label", async () => {
    await seedCanonicalConnections(requireMainDb());

    // User customizes the label.
    await updateConnection(requireMainDb(), "vellum", {
      auth: { type: "platform" },
      label: "Work Vellum",
    });

    // Reboot.
    await seedCanonicalConnections(requireMainDb());

    const conn = await getConnection(requireMainDb(), "vellum");
    expect(conn?.label).toBe("Work Vellum");
  });

  test("backfill fills null label on subsequent boot", async () => {
    await seedCanonicalConnections(requireMainDb());

    // User clears the label (PATCH label: null).
    await updateConnection(requireMainDb(), "vellum", {
      auth: { type: "platform" },
      label: null,
    });

    // Subsequent boots refill it, there's no distinction between "user
    // explicitly cleared" and "pre-seed row that never had one". Treating
    // both as "fill with default" is intentional; users who want a blank
    // label aren't a real cohort and we'd rather guarantee the default is
    // present for everyone.
    await seedCanonicalConnections(requireMainDb());

    const conn = await getConnection(requireMainDb(), "vellum");
    expect(conn?.label).toBe("Vellum");
  });
});

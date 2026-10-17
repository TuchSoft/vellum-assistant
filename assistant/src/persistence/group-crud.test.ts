import { describe, expect, test } from "bun:test";

import { initializeDb } from "./db-init.js";
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  updateGroup,
} from "./group-crud.js";

await initializeDb();

describe("group-crud icon field", () => {
  test("createGroup persists an icon and getGroup returns it", async () => {
    const group = await createGroup("With icon", "rocket");
    try {
      expect(group.icon).toBe("rocket");
      expect((await getGroup(group.id))?.icon).toBe("rocket");
    } finally {
      await deleteGroup(group.id);
    }
  });

  test("createGroup without an icon stores null", async () => {
    const group = await createGroup("No icon");
    try {
      expect(group.icon).toBeNull();
      expect((await getGroup(group.id))?.icon).toBeNull();
    } finally {
      await deleteGroup(group.id);
    }
  });

  test("updateGroup sets, preserves, and clears the icon", async () => {
    const group = await createGroup("Mutable");
    try {
      expect((await updateGroup(group.id, { icon: "star" }))?.icon).toBe(
        "star",
      );
      // A name-only update leaves the icon untouched.
      const renamed = await updateGroup(group.id, { name: "Renamed" });
      expect(renamed?.name).toBe("Renamed");
      expect(renamed?.icon).toBe("star");
      // Explicit null clears it.
      expect((await updateGroup(group.id, { icon: null }))?.icon).toBeNull();
    } finally {
      await deleteGroup(group.id);
    }
  });

  test("listGroups carries the icon column", async () => {
    const group = await createGroup("Listed", "heart");
    try {
      const listed = (await listGroups()).find((g) => g.id === group.id);
      expect(listed?.icon).toBe("heart");
    } finally {
      await deleteGroup(group.id);
    }
  });
});

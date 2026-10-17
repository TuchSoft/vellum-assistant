import { beforeEach, expect, test } from "bun:test";

import {
  listAppPins,
  removeAppPin,
  updateAppPin,
} from "../apps/app-pin-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { describePg } from "./pg-test-db.js";

await initializeDb();

async function clearAppPins(): Promise<void> {
  await requireMainDb().run("DELETE FROM app_pins");
}

async function pin(appId: string): Promise<void> {
  await updateAppPin(appId, { pinned: true });
}

async function order(): Promise<string[]> {
  return (await listAppPins()).map((entry) => entry.appId);
}

async function positionOf(appId: string): Promise<number | undefined> {
  return (await listAppPins()).find((entry) => entry.appId === appId)
    ?.sortPosition;
}

beforeEach(async () => {
  await clearAppPins();
});

describePg("pinning", () => {
  test("appends each new pin after the last", async () => {
    await pin("a");
    await pin("b");
    await pin("c");

    expect(await order()).toEqual(["a", "b", "c"]);
  });

  test("pinning an already-pinned app leaves its position alone", async () => {
    await pin("a");
    await pin("b");
    const before = await positionOf("a");

    await pin("a");

    expect(await positionOf("a")).toBe(before!);
    expect(await order()).toEqual(["a", "b"]);
  });

  test("reports the resulting pin, and null once unpinned", async () => {
    expect(await updateAppPin("a", { pinned: true })).toMatchObject({
      appId: "a",
    });
    expect(await updateAppPin("a", { pinned: false })).toBeNull();
  });

  test("an unpin with nothing pinned is a no-op, not a throw", async () => {
    expect(await updateAppPin("ghost", { pinned: false })).toBeNull();
    expect(await listAppPins()).toEqual([]);
  });
});

/*
 * Positions are a fractional index, so removing one leaves the others exactly
 * where they were. Asserted by value rather than by relative order, which would
 * hold either way and would not catch a rewrite that renumbers the survivors.
 */
describePg("unpinning", () => {
  test("leaves the surviving positions untouched", async () => {
    await pin("a");
    await pin("b");
    await pin("c");
    const positions = { a: await positionOf("a"), c: await positionOf("c") };

    await updateAppPin("b", { pinned: false });

    expect(await order()).toEqual(["a", "c"]);
    expect(await positionOf("a")).toBe(positions.a!);
    expect(await positionOf("c")).toBe(positions.c!);
  });

  test("a pin taken after an unpin lands last, not on a survivor", async () => {
    await pin("a");
    await pin("b");
    await updateAppPin("a", { pinned: false });

    await pin("c");

    expect(await order()).toEqual(["b", "c"]);
    expect(await positionOf("c")).toBeGreaterThan((await positionOf("b"))!);
  });

  test("removeAppPin drops the pin", async () => {
    await pin("a");
    await pin("b");

    await removeAppPin("a");

    expect(await order()).toEqual(["b"]);
  });

  test("removeAppPin for an unpinned app changes nothing", async () => {
    await pin("a");

    await removeAppPin("ghost");

    expect(await order()).toEqual(["a"]);
  });
});

describePg("colour", () => {
  test("sets and clears without disturbing the position", async () => {
    await pin("a");
    await pin("b");
    const before = await positionOf("b");

    await updateAppPin("b", { color: "teal" });
    expect((await listAppPins())[1]?.color).toBe("teal");
    expect(await positionOf("b")).toBe(before!);

    await updateAppPin("b", { color: null });
    expect((await listAppPins())[1]?.color).toBeUndefined();
    expect(await positionOf("b")).toBe(before!);
  });

  test("survives a later pin call that says nothing about colour", async () => {
    await pin("a");
    await updateAppPin("a", { color: "teal" });

    await updateAppPin("a", { pinned: true });

    expect((await listAppPins())[0]?.color).toBe("teal");
  });

  /* Otherwise a colour set on an app the user just unpinned would put the pin
     back, and the sidebar would grow a row nobody asked for. */
  test("a colour for an unpinned app creates no pin", async () => {
    expect(await updateAppPin("ghost", { color: "teal" })).toBeNull();
    expect(await listAppPins()).toEqual([]);
  });

  test("unpinning takes the colour with it", async () => {
    await pin("a");
    await updateAppPin("a", { color: "teal" });

    await updateAppPin("a", { pinned: false });
    await pin("a");

    expect((await listAppPins())[0]?.color).toBeUndefined();
  });
});

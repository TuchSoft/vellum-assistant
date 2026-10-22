import { describe, expect, test } from "bun:test";

import { TtlCache } from "../cache.js";

describe("TtlCache", () => {
  test("returns a value inside the TTL and drops it after expiry", () => {
    let now = 1_000;
    const cache = new TtlCache<string>(60_000, () => now);

    cache.set("a", "value");
    expect(cache.get("a")).toBe("value");

    now += 59_999;
    expect(cache.get("a")).toBe("value");

    now += 2;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("supports per-entry TTL and explicit invalidation", () => {
    let now = 0;
    const cache = new TtlCache<string>(60_000, () => now);

    cache.set("short", "x", 10);
    cache.set("long", "y");
    now = 11;

    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("y");

    cache.delete("long");
    expect(cache.get("long")).toBeUndefined();
  });
});

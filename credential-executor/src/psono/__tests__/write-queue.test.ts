import { describe, expect, test } from "bun:test";

import { ShareWriteQueue } from "../write-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ShareWriteQueue", () => {
  test("serializes tasks for the same share", async () => {
    const queue = new ShareWriteQueue();
    const order: string[] = [];
    const gate = deferred();

    const first = queue.run("share-1", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = queue.run("share-1", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("runs tasks for different shares concurrently", async () => {
    const queue = new ShareWriteQueue();
    const order: string[] = [];
    const gate = deferred();

    const first = queue.run("share-1", async () => {
      order.push("one:start");
      await gate.promise;
      order.push("one:end");
    });
    const second = queue.run("share-2", async () => {
      order.push("two:start");
      order.push("two:end");
    });

    await second;
    expect(order).toEqual(["one:start", "two:start", "two:end"]);

    gate.resolve();
    await first;
  });

  test("a failed task does not block the next one", async () => {
    const queue = new ShareWriteQueue();
    const order: string[] = [];

    const first = queue.run("share-1", async () => {
      order.push("first");
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    await queue.run("share-1", async () => {
      order.push("second");
    });
    expect(order).toEqual(["first", "second"]);
  });

  test("drains the tail map when idle", async () => {
    const queue = new ShareWriteQueue();
    await queue.run("share-1", async () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });
});

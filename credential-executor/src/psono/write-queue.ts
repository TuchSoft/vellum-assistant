/**
 * Per-share serialization for read-modify-write updates.
 *
 * Two writers that both read a share, add an item, and write it back would
 * otherwise persist only the last snapshot. Every mutation for a given share
 * runs after the previous one settles (success or failure), so each writer
 * re-reads the content the previous writer persisted.
 */

export class ShareWriteQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Run `task` after every previously queued task for `key` has settled.
   *
   * A rejected task does not block the queue: the next task still runs.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return run;
  }

  /** Number of shares with a queued tail (0 when fully drained). */
  get size(): number {
    return this.tails.size;
  }
}

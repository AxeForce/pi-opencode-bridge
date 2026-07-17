/**
 * Simple per-key async mutex / queue.
 * Ensures only one prompt runs per session at a time.
 */
export class AsyncQueue {
  private chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) || Promise.resolve();
    const task = prev.then(fn, fn);
    const tail = task.catch(() => {});
    this.chains.set(key, tail);

    // Remove the key only when this task is still the queue tail.
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });

    return task;
  }

  isBusy(key: string): boolean {
    return this.chains.has(key);
  }
}

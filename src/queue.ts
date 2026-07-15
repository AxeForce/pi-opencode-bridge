/**
 * Simple per-key async mutex / queue.
 * Ensures only one prompt runs per session at a time.
 */
export class AsyncQueue {
  private chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const next = prev.then(() => gate);
    this.chains.set(key, next.catch(() => {}));

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Prune if we're still the tail
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    }
  }

  isBusy(key: string): boolean {
    return this.chains.has(key);
  }
}

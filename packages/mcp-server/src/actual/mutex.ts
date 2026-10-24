export type Mutex = {
  /** Runs `fn` once every previously queued call has settled. */
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
};

// `@actual-app/api` is a process-wide singleton, so calls into it must never
// interleave. Queued calls run in FIFO order and a failure never blocks the
// calls queued behind it.
export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();

  return {
    runExclusive(fn) {
      const result = tail.then(() => fn());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

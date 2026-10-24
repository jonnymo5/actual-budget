import { createMutex } from './mutex';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createMutex', () => {
  it('never runs two calls at once and keeps first-in-first-out order', async () => {
    const mutex = createMutex();
    const events: string[] = [];
    const gate = deferred();

    const first = mutex.runExclusive(async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = mutex.runExclusive(async () => {
      events.push('second:start');
    });

    // Give the second call every chance to jump the queue.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('returns the value of the call', async () => {
    const mutex = createMutex();
    await expect(mutex.runExclusive(async () => 42)).resolves.toBe(42);
  });

  it('keeps working after a call fails, and still reports that failure', async () => {
    const mutex = createMutex();

    const failing = mutex.runExclusive(async () => {
      throw new Error('boom');
    });
    const next = mutex.runExclusive(async () => 'still running');

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('still running');
  });
});

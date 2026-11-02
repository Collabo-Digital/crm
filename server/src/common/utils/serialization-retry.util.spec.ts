import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { retryOnNumberingConflict } from './serialization-retry.util';

const conflict = () =>
  new PrismaClientKnownRequestError('could not serialize access', {
    code: 'P2034',
    clientVersion: 'test',
  });

const uniqueOn = (target: string) =>
  new PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });

describe('retryOnNumberingConflict', () => {
  it('outlasts a burst: one of several concurrent numberers wins per round', async () => {
    // Seven rounds lost to other transactions, then this one commits.
    let calls = 0;
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls < 8) throw conflict();
      return 'INV-26-27/000008';
    });

    await expect(
      retryOnNumberingConflict(fn, { baseDelayMs: 0, isRetriableUniqueViolation: () => false }),
    ).resolves.toBe('INV-26-27/000008');
    expect(fn).toHaveBeenCalledTimes(8);
  });

  it('waits a random, growing time between attempts instead of retrying in lockstep', async () => {
    jest.useFakeTimers();
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      let calls = 0;
      const fn = jest.fn(async () => {
        calls += 1;
        if (calls < 3) throw conflict();
        return 'ok';
      });
      const done = retryOnNumberingConflict(fn, { isRetriableUniqueViolation: () => false });

      // First wait is up to 25ms: half of it with this random draw.
      await jest.advanceTimersByTimeAsync(10);
      expect(fn).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5);
      expect(fn).toHaveBeenCalledTimes(2);
      // Second wait is up to 50ms.
      await jest.advanceTimersByTimeAsync(20);
      expect(fn).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(10);
      await expect(done).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      random.mockRestore();
      jest.useRealTimers();
    }
  });

  it('gives up after the last attempt with the original error', async () => {
    const fn = jest.fn(async () => {
      throw conflict();
    });

    await expect(
      retryOnNumberingConflict(fn, {
        maxAttempts: 3,
        baseDelayMs: 0,
        isRetriableUniqueViolation: () => false,
      }),
    ).rejects.toMatchObject({ code: 'P2034' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast on an unrelated unique violation', async () => {
    const fn = jest.fn(async () => {
      throw uniqueOn('email');
    });

    await expect(
      retryOnNumberingConflict(fn, {
        baseDelayMs: 0,
        isRetriableUniqueViolation: (e) => String(e.meta?.target).includes('invoice_number'),
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

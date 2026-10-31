/**
 * Rejects when the work takes longer than `ms`; the work itself is not cancelled, only no longer waited for. The timer is always
 * cleared, so a call that answers in time leaves nothing behind that keeps the process or the test run waiting.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took more than ${ms} ms`)), ms);
  });

  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

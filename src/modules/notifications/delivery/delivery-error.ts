/**
 * A message could not be delivered. `retryable` tells the outbox whether trying
 * again later can help (network down, provider overloaded) or not (invalid
 * number, rejected address, provider not configured).
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/**
 * An error described without its message. Database and library errors often
 * repeat the data of the failing call (a message body, a phone number), so
 * anything near a message is logged and stored as "Name CODE" only.
 */
export function describeError(error: any): string {
  const name = error?.name ?? 'Error';
  const code = error?.code ? ` ${String(error.code)}` : '';

  return `${name}${code}`;
}

/** HTTP status of a provider answer -> can a retry help? */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

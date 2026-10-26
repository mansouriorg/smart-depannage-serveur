import { DeliveryError } from '../delivery-error';

/** The little part of fetch() the providers use, so tests can pass a fake. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: any;
    /** 'error': a redirect is an error, it is not followed (the headers of the request, a key among them, would go with it). */
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function defaultFetch(): FetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

/**
 * One HTTP call with a timeout. A network error or a timeout is retryable; the
 * caller decides what a status code means.
 */
export async function callHttp(
  fetchFn: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs = 10000,
): Promise<{ status: number; body: string }> {
  const AbortControllerClass = (globalThis as any).AbortController;
  const controller = AbortControllerClass ? new AbortControllerClass() : undefined;
  const timer: any = setTimeout(() => controller?.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, { ...init, signal: controller?.signal });
    const body = await response.text();

    return { status: response.status, body };
  } catch (error: any) {
    // Never put the URL or the message in the error: they can carry credentials or numbers.
    throw new DeliveryError(
      `network error (${error?.name === 'AbortError' ? 'timeout' : error?.code ?? 'failed'})`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function parseJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

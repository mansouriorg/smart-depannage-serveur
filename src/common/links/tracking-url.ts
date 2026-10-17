import { getFrontendUrl } from '../../config/env';

/**
 * The page of the website that shows a request to somebody who has no account.
 * This is the ONLY place that knows where it lives: every message and every
 * answer that carries a tracking link is built by buildTrackingUrl(), so moving
 * the page (P1-16 replaces it) is a one-line change here.
 *
 * It is the page the website serves today (app/demande/status/page.tsx). The
 * link used to point at /guest/tracking/:id, which no page of the website serves.
 */
export const TRACKING_PATH = '/demande/status';

/**
 * Absolute link to follow one request: the website address (FRONTEND_URL, the
 * website's port, not the API's), the request number and the secret token.
 *
 * `rawToken` is the secret itself: the link must only be put in the message
 * that goes to the customer and in the answer to the request that made it,
 * never in a log line.
 */
export function buildTrackingUrl(
  interventionId: number,
  rawToken: string,
  baseUrl: string = getFrontendUrl(),
): string {
  if (!Number.isInteger(interventionId) || interventionId <= 0) {
    throw new Error('buildTrackingUrl: the request number must be a positive integer.');
  }

  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new Error('buildTrackingUrl: the tracking token is missing.');
  }

  const query = new URLSearchParams({ id: String(interventionId), token: rawToken });

  return `${baseUrl.replace(/\/+$/, '')}${TRACKING_PATH}?${query.toString()}`;
}

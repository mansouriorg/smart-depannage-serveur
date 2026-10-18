import { DeliveryConfig } from '../../../../config/delivery';
import { DeliveryError, isRetryableStatus } from '../delivery-error';
import { callHttp, defaultFetch, FetchLike, parseJson } from './http';

export type PushMessage = { title: string; body: string; data?: unknown };

export type PushResult = {
  token: string;
  ok: boolean;
  ticketId?: string;
  /** The device unregistered: the token must not be used again. */
  gone?: boolean;
  /** Failed for a reason that can pass (rate limit), so worth another try. */
  retryable?: boolean;
  error?: string;
};

export interface PushProvider {
  readonly name: string;
  isConfigured(): boolean;
  send(tokens: string[], message: PushMessage): Promise<PushResult[]>;
}

export class NoPushProvider implements PushProvider {
  readonly name = 'NONE';

  isConfigured() {
    return false;
  }

  async send(): Promise<PushResult[]> {
    throw new DeliveryError('Push provider not configured (PUSH_PROVIDER)', false);
  }
}

const EXPO_TOKEN = /^(Exponent|Expo)PushToken\[[^\]]+\]$/;
const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

/** The Android notification channel of the phone app (services/push.ts of the app: CHANNEL). */
export const ANDROID_CHANNEL = 'default';
const EXPO_CHUNK = 100;

/** Expo push service: https://docs.expo.dev/push-notifications/sending-notifications/ */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'EXPO';

  constructor(
    private readonly config: DeliveryConfig['push'],
    private readonly fetchFn: FetchLike = defaultFetch(),
  ) {}

  isConfigured() {
    return true;
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    const results: PushResult[] = [];

    // Anything that is not an Expo token (a leftover test value, a native FCM
    // or APNs token) cannot go through the Expo service. It is reported, not
    // switched off: the token may be good for another sender, and only the
    // service that really answers "DeviceNotRegistered" may retire a device.
    const valid = tokens.filter((token) => EXPO_TOKEN.test(token));

    for (const token of tokens) {
      if (!EXPO_TOKEN.test(token)) {
        results.push({ token, ok: false, retryable: false, error: 'not an Expo push token' });
      }
    }

    for (let i = 0; i < valid.length; i += EXPO_CHUNK) {
      const chunk = valid.slice(i, i + EXPO_CHUNK);

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };

      if (this.config.accessToken) {
        headers.Authorization = `Bearer ${this.config.accessToken}`;
      }

      const { status, body } = await callHttp(this.fetchFn, EXPO_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          chunk.map((to) => ({
            to,
            title: message.title,
            body: message.body,
            data: message.data ?? undefined,
            sound: 'default',
            priority: 'high',
            // The channel the phone app creates at start-up (services/push.ts): on Android 8 and later a push
            // without a channel falls on a fallback one with the system's default importance (P1-15).
            channelId: ANDROID_CHANNEL,
          })),
        ),
      });

      if (status < 200 || status >= 300) {
        throw new DeliveryError(`Expo push service refused the request (HTTP ${status})`, isRetryableStatus(status));
      }

      const tickets: any[] = parseJson(body)?.data ?? [];

      chunk.forEach((token, index) => {
        const ticket = tickets[index];

        if (ticket?.status === 'ok') {
          results.push({ token, ok: true, ticketId: ticket.id });
          return;
        }

        const reason = ticket?.details?.error ?? 'no ticket';

        results.push({
          token,
          ok: false,
          gone: reason === 'DeviceNotRegistered',
          retryable: reason === 'MessageRateExceeded' || !ticket,
          error: String(reason),
        });
      });
    }

    return results;
  }
}

export function createPushProvider(
  config: DeliveryConfig,
  fetchFn: FetchLike = defaultFetch(),
): PushProvider {
  return config.push.provider === 'expo' ? new ExpoPushProvider(config.push, fetchFn) : new NoPushProvider();
}

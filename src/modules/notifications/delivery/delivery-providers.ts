import { DeliveryConfig } from '../../../config/delivery';
import { createEmailProvider, EmailProvider, MailTransport } from './providers/email.provider';
import { FetchLike, defaultFetch } from './providers/http';
import { createPushProvider, PushProvider } from './providers/push.provider';
import { createSmsProvider, SmsProvider } from './providers/sms.provider';

/** The three ways out. A class so it can be injected; build it with createDeliveryProviders(). */
export class DeliveryProviders {
  constructor(
    public readonly sms: SmsProvider,
    public readonly email: EmailProvider,
    public readonly push: PushProvider,
  ) {}
}

/** Injection token for the DeliveryConfig. */
export const DELIVERY_CONFIG = 'DELIVERY_CONFIG';

export function createDeliveryProviders(
  config: DeliveryConfig,
  deps: { fetch?: FetchLike; makeTransport?: (options: Record<string, unknown>) => MailTransport } = {},
): DeliveryProviders {
  const fetchFn = deps.fetch ?? defaultFetch();

  return new DeliveryProviders(
    createSmsProvider(config, fetchFn),
    createEmailProvider(config, deps.makeTransport),
    createPushProvider(config, fetchFn),
  );
}

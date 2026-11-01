/**
 * The texts the server sends to a customer, a visitor or a technician, in French and in Arabic (P3-04).
 *
 * Messages to the back office (the staff notices, the internal notes, the alert SMS) are not here: they stay French.
 * The areas follow the product: sign-in and account (auth), the visitor's link (guest), the life of a job (mission), quotes, payments,
 * invoices, visits and their reminders (appointment), complaints, chat, a technician's application, and a job offered to a technician (offer).
 */
import type { MessageDef } from './message';
import { appointment } from './appointment';
import { application } from './application';
import { auth } from './auth';
import { chat } from './chat';
import { complaint } from './complaint';
import { guest } from './guest';
import { invoice } from './invoice';
import { mission } from './mission';
import { offer } from './offer';
import { payment } from './payment';
import { quote } from './quote';

export type { MessageDef, NoticeTexts } from './message';
export { message, notice, reference, say } from './message';
export { declaredLocale, localeOfUser, recipientLocale } from './locale';
export { moneyIn, whenIn } from './format';

export const MESSAGES = { appointment, application, auth, chat, complaint, guest, invoice, mission, offer, payment, quote };

export type MessageEntry = { area: string; key: string; definition: MessageDef<any> };

function isDefinition(value: unknown): value is MessageDef<any> {
  return typeof value === 'object' && value !== null && typeof (value as MessageDef).fr === 'string' && typeof (value as MessageDef).ar === 'string';
}

/** Every message, flat: `{ area: 'auth', key: 'auth.phoneCode.sms', definition }`. For the tests and for anybody who wants to list them. */
export function allMessages(): MessageEntry[] {
  const found: MessageEntry[] = [];

  const walk = (area: string, path: string, node: unknown) => {
    if (isDefinition(node)) {
      found.push({ area, key: path, definition: node });
      return;
    }

    if (typeof node === 'object' && node !== null) {
      for (const [name, child] of Object.entries(node)) walk(area, `${path}.${name}`, child);
    }
  };

  for (const [area, group] of Object.entries(MESSAGES)) walk(area, area, group);

  return found;
}

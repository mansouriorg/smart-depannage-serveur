import { message } from './message';

/** The invoice: the notice that it is ready, and the e-mail the back office sends with it. */
export const invoice = {
  ready: {
    title: message({ fr: 'Facture disponible', ar: 'الفاتورة متاحة' }),
    message: message<{ number: string }>({
      fr: 'Votre facture {number} est disponible.',
      ar: 'فاتورتك {number} متاحة.',
      isolate: ['number'],
    }),
  },

  email: {
    subject: message<{ number: string }>({ fr: 'Votre facture {number}', ar: 'فاتورتك {number}', isolate: ['number'] }),
    // The text proposed when the back office does not write its own. `amount` is written by `moneyIn`.
    body: message<{ number: string; amount: string }>({
      fr: 'Bonjour,\n\nVotre facture {number} d’un montant de {amount} TTC est disponible.\n\nVous pouvez la télécharger en PDF depuis votre page de suivi.\n\nCordialement.',
      ar: 'مرحبًا،\n\nفاتورتك {number} متاحة بمبلغ {amount} شامل للأداء.\n\nيمكنك تنزيلها بصيغة PDF من صفحة التتبّع.\n\nمع خالص التحية.',
      isolate: ['number'],
    }),
    bodyWithStamp: message<{ number: string; amount: string }>({
      fr: 'Bonjour,\n\nVotre facture {number} d’un montant de {amount} TTC (timbre fiscal compris) est disponible.\n\nVous pouvez la télécharger en PDF depuis votre page de suivi.\n\nCordialement.',
      ar: 'مرحبًا،\n\nفاتورتك {number} متاحة بمبلغ {amount} شامل للأداء (مع الطابع الجبائي).\n\nيمكنك تنزيلها بصيغة PDF من صفحة التتبّع.\n\nمع خالص التحية.',
      isolate: ['number'],
    }),
  },
};

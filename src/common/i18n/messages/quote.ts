import { message } from './message';

/** Quotes. `amount` is written by `moneyIn`, already set apart in Arabic. */
export const quote = {
  sent: {
    title: message({ fr: 'Devis reçu', ar: 'وصلك عرض سعر' }),
    message: message<{ amount: string }>({
      fr: 'Un devis de {amount} TTC vous a été envoyé.',
      ar: 'تم إرسال عرض سعر إليك بمبلغ {amount} شامل للأداء.',
    }),
    sms: message<{ amount: string }>({
      fr: 'Smart Dépannage: vous avez reçu un devis de {amount} TTC.',
      ar: 'وصلك عرض سعر بمبلغ {amount} شامل للأداء. Smart-Dépannage',
    }),
    emailSubject: message({ fr: 'Votre devis Smart Dépannage', ar: 'عرض السعر الخاص بك من Smart-Dépannage' }),
    emailBody: message<{ amount: string }>({
      fr: 'Vous avez reçu un devis de {amount} TTC.',
      ar: 'وصلك عرض سعر بمبلغ {amount} شامل للأداء.',
    }),
  },

  accepted: {
    title: message({ fr: 'Devis accepté', ar: 'تم قبول عرض السعر' }),
    message: message<{ ref: string }>({
      fr: 'Le client a accepté le devis {ref}.',
      ar: 'قبل العميل عرض السعر {ref}.',
      isolate: ['ref'],
    }),
  },
};

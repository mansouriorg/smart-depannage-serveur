import { message } from './message';

/** What the customer is told about their payments and refunds. `amount` and `sum` are written by `moneyIn`. */
export const payment = {
  received: {
    title: message({ fr: 'Paiement confirmé', ar: 'تم تأكيد الدفع' }),
    message: message<{ amount: string }>({
      fr: 'Votre paiement de {amount} a été confirmé.',
      ar: 'تم تأكيد دفعتك بمبلغ {amount}.',
    }),
  },

  refunded: {
    title: message({ fr: 'Remboursement effectué', ar: 'تم استرداد المبلغ' }),
    message: message<{ sum: string }>({
      fr: 'Un remboursement de {sum} a été effectué sur votre paiement.',
      ar: 'تم استرداد مبلغ {sum} من دفعتك.',
    }),
    // A refund of a card payment is made at the payment provider by the team: it is recorded, not yet back on the card.
    byCardTitle: message({ fr: 'Remboursement enregistré', ar: 'تم تسجيل استرداد المبلغ' }),
    byCardMessage: message<{ sum: string }>({
      fr: 'Un remboursement de {sum} a été enregistré sur votre paiement par carte. Il sera versé sur votre carte par notre prestataire de paiement.',
      ar: 'تم تسجيل استرداد مبلغ {sum} لدفعتك بالبطاقة المصرفية. سيُودعه مزوّد الدفع لدينا في بطاقتك.',
    }),
  },
};

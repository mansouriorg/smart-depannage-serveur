/**
 * Codes that the server puts into a sentence as a value (the `{}` of a pattern in `errors.ar.ts`) and that a person reads: the status
 * of a job, of a quote or of a payment, and the day of a week. In Arabic they are words, never the code (P3-04).
 *
 * They are not sentences of the source, so they are kept apart from the dictionary (whose every key must be written by the source).
 * A status that is spelled the same in two enums (PAID, CANCELLED, PENDING) is the same word in both. The words of a job's status
 * are the ones the apps show, so the person reads the same word in the sentence and on the screen.
 */
export const VALUE_WORDS_AR: Readonly<Record<string, string>> = {
  // a job (enum Status), the legacy names included
  CREATED: 'قيد الانتظار',
  WAITING_ADMIN_REVIEW: 'قيد المراجعة',
  QUOTE_SENT: 'تم إرسال عرض السعر',
  QUOTE_ACCEPTED: 'تم قبول عرض السعر',
  ASSIGNED: 'تم التعيين',
  ARTISAN_ACCEPTED: 'مقبول',
  ARTISAN_ON_THE_WAY: 'في الطريق',
  ARTISAN_ARRIVED: 'وصل',
  IN_PROGRESS: 'قيد التنفيذ',
  WAITING_CLIENT_VALIDATION: 'في انتظار التأكيد',
  COMPLETED: 'تم الإنجاز',
  PAYMENT_PENDING: 'الدفع قيد الانتظار',
  PAID: 'مدفوع',
  INVOICE_SENT: 'تم إرسال الفاتورة',
  CANCELLED: 'ملغى',
  DISPUTED: 'نزاع',
  PENDING: 'قيد الانتظار',
  ADMIN_REVIEW: 'قيد المراجعة',
  ACCEPTED: 'مقبول',
  ON_THE_WAY: 'في الطريق',
  ARRIVED: 'وصل',
  INVOICE_READY: 'تم إرسال الفاتورة',

  // a quote (enum QuoteStatus)
  DRAFT: 'مسودة',
  SENT: 'تم الإرسال',
  REJECTED: 'مرفوض',
  MODIFICATION_REQUESTED: 'تعديل مطلوب',
  EXPIRED: 'منتهي الصلاحية',

  // a payment (enum PaymentStatus)
  AWAITING_CONFIRMATION: 'في انتظار التأكيد',
  FAILED: 'فشل الدفع',
  REFUNDED: 'مسترد',
  PARTIALLY_REFUNDED: 'مسترد جزئيًا',

  // the days of the week (enum DayOfWeek)
  MONDAY: 'الاثنين',
  TUESDAY: 'الثلاثاء',
  WEDNESDAY: 'الأربعاء',
  THURSDAY: 'الخميس',
  FRIDAY: 'الجمعة',
  SATURDAY: 'السبت',
  SUNDAY: 'الأحد',
};

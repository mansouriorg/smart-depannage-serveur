import { message } from './message';

/**
 * The life of a job as the customer and the technician are told it: assigned, accepted, on the way, arrived, started, done, cancelled,
 * given to somebody else. (The same events are told to the back office in French and are not here.)
 */
export const mission = {
  assigned: {
    artisanTitle: message({ fr: 'Nouvelle mission assignée', ar: 'تم تعيين مهمّة جديدة لك' }),
    artisanMessage: message<{ address: string }>({
      fr: 'Une mission vous a été assignée: {address}.',
      ar: 'تم تعيين مهمّة لك: {address}.',
      isolate: ['address'],
    }),
    clientTitle: message({ fr: 'Artisan assigné', ar: 'تم تعيين فنّي' }),
    clientMessage: message({ fr: 'Un artisan a été assigné à votre intervention.', ar: 'تم تعيين فنّي لطلبك.' }),
    // Added after the sentence above when the visit has a time; `when` is already written by `whenIn`.
    schedule: message<{ when: string }>({ fr: 'Rendez-vous le {when}.', ar: 'الموعد: {when}.' }),
  },

  accepted: {
    title: message({ fr: 'Mission acceptée', ar: 'تم قبول المهمّة' }),
    clientNamed: message<{ name: string }>({ fr: '{name} a accepté votre intervention.', ar: 'قبل الفنّي {name} طلبك.', isolate: ['name'] }),
    client: message({ fr: 'L’artisan a accepté votre intervention.', ar: 'قبل الفنّي طلبك.' }),
    planned: message({ fr: 'L’artisan a accepté la mission planifiée.', ar: 'قبل الفنّي المهمّة المجدولة.' }),
    smsNamed: message<{ name: string }>({
      fr: 'Smart Dépannage: Votre demande a été acceptée ! {name} prend en charge votre dossier.',
      ar: 'تم قبول طلبك! يتولّاه {name}. Smart-Dépannage',
      isolate: ['name'],
    }),
    sms: message({
      fr: 'Smart Dépannage: Votre demande a été acceptée ! Un artisan prend en charge votre dossier.',
      ar: 'تم قبول طلبك! أحد الفنّيين يتولّى طلبك. Smart-Dépannage',
    }),
  },

  onTheWay: {
    title: message({ fr: 'Artisan en route', ar: 'الفنّي في الطريق' }),
    clientNamed: message<{ name: string }>({ fr: 'Votre artisan {name} est en route.', ar: 'الفنّي {name} في الطريق إليك.', isolate: ['name'] }),
    client: message({ fr: 'Votre artisan est en route.', ar: 'الفنّي في الطريق إليك.' }),
  },

  arrived: {
    title: message({ fr: 'Artisan arrivé', ar: 'وصل الفنّي' }),
    clientNamed: message<{ name: string }>({ fr: 'Votre artisan {name} est arrivé sur place.', ar: 'وصل الفنّي {name} إلى المكان.', isolate: ['name'] }),
    client: message({ fr: 'Votre artisan est arrivé sur place.', ar: 'وصل الفنّي إلى المكان.' }),
  },

  declined: {
    clientTitle: message({ fr: 'Nouvel artisan en recherche', ar: 'جارٍ البحث عن فنّي آخر' }),
    clientMessage: message({
      fr: 'Votre artisan n’est plus disponible pour cette intervention. Nous en cherchons un autre et revenons vers vous.',
      ar: 'فنّيك لم يعد متاحًا لهذا التدخّل. نبحث عن فنّي آخر وسنعود إليك.',
    }),
  },

  started: {
    title: message({ fr: 'Travaux commencés', ar: 'بدأت الأشغال' }),
    message: message({ fr: 'L’intervention a commencé.', ar: 'بدأ التدخّل.' }),
  },

  completed: {
    clientTitle: message({ fr: 'Intervention terminée', ar: 'تم إنجاز التدخّل' }),
    clientMessage: message({
      fr: 'L’artisan a terminé l’intervention. Vous pouvez la valider.',
      ar: 'أنهى الفنّي التدخّل. يمكنك تأكيده.',
    }),
    // The texts the customer gets from the three ways a job is closed (the back office, the technician's proof, the technician's button).
    smsAfterStatusChange: message({ fr: 'Intervention terminée. Merci de votre confiance !', ar: 'تم إنجاز التدخّل. شكرًا لثقتك بنا!' }),
    smsAfterProof: message({
      fr: 'Smart Dépannage: Votre intervention est terminée ! Une preuve sécurisée a été enregistrée sur votre dossier.',
      ar: 'تم إنجاز التدخّل! حُفظ إثبات الإنجاز بأمان في طلبك. Smart-Dépannage',
    }),
    sms: message({ fr: 'Smart Dépannage: votre intervention est terminée.', ar: 'تم إنجاز تدخّلك. Smart-Dépannage' }),
  },

  cancelled: {
    title: message({ fr: 'Mission annulée', ar: 'تم إلغاء المهمّة' }),
    message: message<{ ref: string; reason: string }>({
      fr: 'La mission {ref} a été annulée: {reason}',
      ar: 'تم إلغاء المهمّة {ref}: {reason}',
      isolate: ['ref', 'reason'],
    }),
  },

  rescheduled: {
    title: message({ fr: 'Rendez-vous modifié', ar: 'تم تغيير الموعد' }),
    message: message<{ ref: string; when: string }>({
      fr: 'Le rendez-vous de l’intervention {ref} est fixé le {when}.',
      ar: 'تم تحديد موعد التدخّل {ref}: {when}.',
      isolate: ['ref'],
    }),
    messageWithoutDate: message<{ ref: string }>({
      fr: 'Le rendez-vous de l’intervention {ref} est fixé.',
      ar: 'تم تحديد موعد التدخّل {ref}.',
      isolate: ['ref'],
    }),
  },

  withdrawn: {
    title: message({ fr: 'Mission retirée', ar: 'تم سحب المهمّة' }),
    message: message<{ ref: string }>({
      fr: 'La mission {ref} a été confiée à un autre artisan.',
      ar: 'تم إسناد المهمّة {ref} إلى فنّي آخر.',
      isolate: ['ref'],
    }),
  },

  proofRefused: {
    title: message({ fr: 'Photo refusée', ar: 'تم رفض الصورة' }),
    message: message<{ what: string; ref: string; next: string }>({
      fr: 'La photo {what} intervention de la mission {ref} a été refusée par l’équipe. {next}',
      ar: 'رفض الفريق صورة {what} للمهمّة {ref}. {next}',
      isolate: ['ref'],
    }),
    before: message({ fr: 'avant', ar: 'قبل التدخّل' }),
    after: message({ fr: 'après', ar: 'بعد التدخّل' }),
    retake: message({ fr: 'Reprenez-la sur place.', ar: 'أعد التقاطها في المكان.' }),
    contact: message({ fr: 'L’équipe vous contactera.', ar: 'سيتواصل معك الفريق.' }),
  },
};

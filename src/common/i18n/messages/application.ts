import { message } from './message';

/** A technician's application: the receipt, the decision, and the invitation to choose a password once it is accepted. */
export const application = {
  received: {
    subject: message({ fr: 'Candidature artisan reçue', ar: 'تم استلام طلب الانضمام' }),
    body: message({
      fr: 'Votre candidature artisan a bien été reçue. Notre équipe va l’examiner.',
      ar: 'تم استلام طلب انضمامك كفنّي. سيراجعه فريقنا.',
    }),
    sms: message({ fr: 'Smart Dépannage: votre candidature artisan a bien été reçue.', ar: 'تم استلام طلب انضمامك كفنّي. Smart-Dépannage' }),
  },

  approved: {
    title: message({ fr: 'Candidature artisan approuvée', ar: 'تمت الموافقة على طلب الانضمام' }),
    message: message({ fr: 'Votre candidature artisan a été approuvée.', ar: 'تمت الموافقة على طلب انضمامك كفنّي.' }),
    inviteSubject: message({ fr: 'Votre candidature est acceptée', ar: 'تم قبول طلب انضمامك' }),
    inviteBody: message<{ link: string }>({
      fr: 'Bonne nouvelle: votre candidature artisan est acceptée. Choisissez votre mot de passe (lien valable 24 heures, usage unique) : {link}',
      ar: 'خبر سار: تم قبول طلب انضمامك كفنّي. اختر كلمة المرور (الرابط صالح لمدة 24 ساعة ولمرة واحدة): {link}',
    }),
    inviteSms: message<{ link: string }>({
      fr: 'Smart Dépannage: votre candidature est acceptée. Créez votre mot de passe ici: {link}',
      ar: 'تم قبول طلب انضمامك إلى Smart-Dépannage. أنشئ كلمة المرور من هنا: {link}',
    }),
  },

  rejected: {
    title: message({ fr: 'Candidature artisan refusée', ar: 'تم رفض طلب الانضمام' }),
    // Shown when the back office gave no reason of its own.
    message: message({
      fr: 'Votre candidature artisan a été refusée. Vous pouvez contacter le support pour plus d’informations.',
      ar: 'تم رفض طلب انضمامك كفنّي. يمكنك الاتصال بالدعم لمزيد من المعلومات.',
    }),
    emailBody: message<{ reason: string }>({
      fr: 'Votre candidature artisan n’a pas été retenue.\n\nMotif: {reason}',
      ar: 'لم يتم قبول طلب انضمامك كفنّي.\n\nالسبب: {reason}',
      isolate: ['reason'],
    }),
  },
};

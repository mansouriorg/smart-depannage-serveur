import { message } from './message';

/**
 * Sign-in, passwords, codes and the notices about a change of e-mail or phone: sent to whoever owns the account (staff accounts
 * get them in French, see `recipientLocale`). The keys of the editable templates are the ones in `MessageTemplatesService`.
 */
export const auth = {
  passwordReset: {
    subject: message({ fr: 'Réinitialisation de votre mot de passe', ar: 'إعادة تعيين كلمة المرور' }),
    body: message<{ link: string }>({
      fr: 'Cliquez sur ce lien pour réinitialiser votre mot de passe: {link}',
      ar: 'اضغط على هذا الرابط لإعادة تعيين كلمة المرور: {link}',
    }),
  },

  emailVerification: {
    subject: message({ fr: 'Vérification de votre email', ar: 'التحقّق من بريدك الإلكتروني' }),
    body: message<{ link: string }>({
      fr: 'Cliquez sur ce lien pour vérifier votre email: {link}',
      ar: 'اضغط على هذا الرابط للتحقّق من بريدك الإلكتروني: {link}',
    }),
  },

  phoneCode: {
    sms: message<{ code: string }>({
      fr: 'Votre code de vérification est: {code}',
      ar: 'رمز التحقّق الخاص بك هو: {code}',
    }),
  },

  // The link a staff member's account or a technician's invitation carries has two wordings: the short one of the reset flow
  // (`body`) and the one that says how long the link lives (`bodyWithLifetime`, used when an account is created for somebody).
  passwordSetup: {
    subject: message({ fr: 'Création de votre mot de passe', ar: 'إنشاء كلمة المرور' }),
    body: message<{ link: string }>({
      fr: 'Votre compte a été créé. Cliquez ici pour créer votre mot de passe: {link}',
      ar: 'تم إنشاء حسابك. اضغط هنا لإنشاء كلمة المرور: {link}',
    }),
    bodyWithLifetime: message<{ link: string }>({
      fr: 'Votre compte Smart Dépannage a été créé. Choisissez votre mot de passe (lien valable 24 heures, usage unique) : {link}',
      ar: 'تم إنشاء حسابك في Smart-Dépannage. اختر كلمة المرور (الرابط صالح لمدة 24 ساعة ولمرة واحدة): {link}',
    }),
    sms: message<{ link: string }>({
      fr: 'Smart Dépannage: créez votre mot de passe ici: {link}',
      ar: 'أنشئ كلمة المرور لحسابك في Smart-Dépannage من هنا: {link}',
    }),
  },

  emailChange: {
    subject: message({ fr: 'Confirmez votre nouvelle adresse e-mail', ar: 'تأكيد عنوان بريدك الإلكتروني الجديد' }),
    body: message<{ link: string }>({
      fr: 'Cliquez sur ce lien pour confirmer cette adresse comme adresse de votre compte (valable 1 heure): {link}',
      ar: 'اضغط على هذا الرابط لتأكيد هذا العنوان كعنوان لحسابك (صالح لمدة ساعة واحدة): {link}',
    }),
  },

  emailChangedNotice: {
    subject: message({ fr: "L'adresse e-mail de votre compte a changé", ar: 'تم تغيير عنوان البريد الإلكتروني لحسابك' }),
    body: message<{ newEmail: string }>({
      fr: "L'adresse e-mail de votre compte Smart Dépannage est maintenant {newEmail}. Si ce n'est pas vous, contactez-nous immédiatement.",
      ar: 'أصبح عنوان البريد الإلكتروني لحسابك في Smart-Dépannage هو {newEmail}. إذا لم تكن أنت من قام بذلك، فاتصل بنا فورًا.',
      isolate: ['newEmail'],
    }),
    bodyBySupport: message<{ newEmail: string }>({
      fr: "L'adresse e-mail de votre compte Smart Dépannage est maintenant {newEmail} (modifiée par notre équipe). Si ce n'est pas vous, contactez-nous immédiatement.",
      ar: 'أصبح عنوان البريد الإلكتروني لحسابك في Smart-Dépannage هو {newEmail} (تم التعديل من طرف فريقنا). إذا لم تكن أنت من قام بذلك، فاتصل بنا فورًا.',
      isolate: ['newEmail'],
    }),
  },

  phoneReleasedNotice: {
    subject: message({ fr: 'Le numéro de téléphone de votre compte a été retiré', ar: 'تمت إزالة رقم الهاتف من حسابك' }),
    body: message({
      fr: "Le numéro de téléphone de votre compte Smart Dépannage a été retiré: une autre personne a prouvé qu'il est le sien (code reçu par SMS). Vous pouvez ajouter un autre numéro depuis votre profil.",
      ar: 'تمت إزالة رقم الهاتف من حسابك في Smart-Dépannage: أثبت شخص آخر أن هذا الرقم رقمه (رمز وصله عبر SMS). يمكنك إضافة رقم آخر من ملفك الشخصي.',
    }),
  },

  // Four bodies, not one with pieces: the number is either changed or removed, and either did or did not have a number before.
  phoneChangedNotice: {
    subject: message({ fr: 'Le numéro de téléphone de votre compte a changé', ar: 'تم تغيير رقم هاتف حسابك' }),
    bodyChanged: message<{ newPhone: string }>({
      fr: "Le numéro de téléphone de votre compte Smart Dépannage est maintenant {newPhone}. Si ce n'est pas vous, changez votre mot de passe et contactez-nous.",
      ar: 'أصبح رقم هاتف حسابك في Smart-Dépannage هو {newPhone}. إذا لم تكن أنت من قام بذلك، فغيّر كلمة المرور واتصل بنا.',
      isolate: ['newPhone'],
    }),
    bodyChangedFrom: message<{ newPhone: string; oldPhone: string }>({
      fr: "Le numéro de téléphone de votre compte Smart Dépannage est maintenant {newPhone} (avant: {oldPhone}). Si ce n'est pas vous, changez votre mot de passe et contactez-nous.",
      ar: 'أصبح رقم هاتف حسابك في Smart-Dépannage هو {newPhone} (الرقم السابق: {oldPhone}). إذا لم تكن أنت من قام بذلك، فغيّر كلمة المرور واتصل بنا.',
      isolate: ['newPhone', 'oldPhone'],
    }),
    bodyRemoved: message({
      fr: "Le numéro de téléphone a été retiré de votre compte Smart Dépannage. Si ce n'est pas vous, changez votre mot de passe et contactez-nous.",
      ar: 'تمت إزالة رقم الهاتف من حسابك في Smart-Dépannage. إذا لم تكن أنت من قام بذلك، فغيّر كلمة المرور واتصل بنا.',
    }),
    bodyRemovedFrom: message<{ oldPhone: string }>({
      fr: "Le numéro de téléphone a été retiré de votre compte Smart Dépannage (avant: {oldPhone}). Si ce n'est pas vous, changez votre mot de passe et contactez-nous.",
      ar: 'تمت إزالة رقم الهاتف من حسابك في Smart-Dépannage (الرقم السابق: {oldPhone}). إذا لم تكن أنت من قام بذلك، فغيّر كلمة المرور واتصل بنا.',
      isolate: ['oldPhone'],
    }),
  },
};

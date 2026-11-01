import { message } from './message';

/** What a visitor (a customer with no account yet) is sent: the link to follow the request, and the proof to open an account. */
export const guest = {
  tracking: {
    // "#" and not "n°" in the SMS: a character outside the basic SMS alphabet turns the whole French message into the 70-character kind.
    sms: message<{ ref: string; link: string }>({
      fr: 'Smart Dépannage: votre demande {ref} est enregistrée. Suivez-la ici: {link}',
      ar: 'تم تسجيل طلبك {ref} في Smart-Dépannage. تتبّعه من هنا: {link}',
      isolate: ['ref'],
    }),
    subject: message({ fr: 'Votre demande Smart Dépannage', ar: 'طلبك في Smart-Dépannage' }),
    // `greeting` is one of the two below; the body is the French e-mail with its line breaks.
    greetingNamed: message<{ name: string }>({ fr: 'Bonjour {name},', ar: 'مرحبًا {name}،', isolate: ['name'] }),
    greeting: message({ fr: 'Bonjour,', ar: 'مرحبًا،' }),
    body: message<{ greeting: string; reference: number; link: string }>({
      fr: "{greeting}\n\nVotre demande n°{reference} est enregistrée. Suivez son avancement avec ce lien personnel (ne le partagez pas) :\n{link}\n\nL'équipe Smart Dépannage",
      ar: '{greeting}\n\nتم تسجيل طلبك رقم {reference}. تتبّع تقدّمه عبر هذا الرابط الشخصي (لا تشاركه مع أحد):\n{link}\n\nفريق Smart-Dépannage',
      isolate: ['reference'],
    }),
  },

  activation: {
    emailSubject: message({ fr: 'Activation de votre compte', ar: 'تفعيل حسابك' }),
    emailBody: message<{ link: string }>({
      fr: 'Cliquez sur ce lien pour activer votre compte: {link}',
      ar: 'اضغط على هذا الرابط لتفعيل حسابك: {link}',
    }),
    sms: message<{ code: string }>({
      fr: 'Smart Dépannage: votre code d’activation est {code}. Il est valable 10 minutes.',
      ar: 'رمز تفعيل حسابك في Smart-Dépannage هو {code}. صالح لمدة 10 دقائق.',
    }),
  },
};

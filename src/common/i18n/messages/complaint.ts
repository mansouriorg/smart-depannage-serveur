import { message } from './message';

/** What the person who filed a complaint (and the other side of it) is told. `title` is what they typed. */
export const complaint = {
  updated: {
    title: message({ fr: 'Réclamation mise à jour', ar: 'تم تحديث الشكوى' }),
    message: message<{ title: string }>({
      fr: 'Votre réclamation "{title}" a été mise à jour.',
      ar: 'تم تحديث شكواك «{title}».',
      isolate: ['title'],
    }),
  },

  reply: {
    title: message({ fr: 'Nouveau message sur une réclamation', ar: 'رسالة جديدة بخصوص شكوى' }),
    message: message<{ title: string }>({
      fr: 'Nouveau message sur la réclamation "{title}".',
      ar: 'رسالة جديدة بخصوص الشكوى «{title}».',
      isolate: ['title'],
    }),
  },
};

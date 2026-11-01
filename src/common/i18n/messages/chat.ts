import { message } from './message';

/** The notice of a new chat message. What was written is shown as it is; only the frame around it is translated. */
export const chat = {
  newMessage: {
    title: message<{ ref: string }>({ fr: 'Nouveau message (demande {ref})', ar: 'رسالة جديدة (الطلب {ref})', isolate: ['ref'] }),
    attachment: message({ fr: 'Pièce jointe', ar: 'مرفق' }),
    // "Sami: the text". Without a sender name the text stands alone.
    fromSender: message<{ name: string; text: string }>({ fr: '{name}: {text}', ar: '{name}: {text}', isolate: ['name', 'text'] }),
  },
};

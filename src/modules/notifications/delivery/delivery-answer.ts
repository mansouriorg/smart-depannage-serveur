/**
 * What the caller is told about a message it asked for. "sent" is true only
 * when a provider is configured and the message was really accepted for
 * delivery; otherwise the person is told why nothing will arrive.
 */
export function deliveryAnswer(
  result: { queued: boolean },
  notConfigured: boolean,
  kind: 'email' | 'sms',
  okMessage: string,
): { sent: boolean; message: string } {
  if (notConfigured) {
    return {
      sent: false,
      message:
        kind === 'email'
          ? "L'envoi d'e-mails n'est pas configuré sur le serveur: aucun message n'a été envoyé."
          : "L'envoi de SMS n'est pas configuré sur le serveur: aucun message n'a été envoyé.",
    };
  }

  if (!result.queued) {
    return {
      sent: false,
      message: "Le message n'a pas pu être préparé pour l'envoi. Réessayez dans un instant.",
    };
  }

  return { sent: true, message: okMessage };
}

import { allMessages, say } from './index';

/**
 * The French of every message is what the services wrote before P3-04, character for character (the catalogue only moved the
 * words). This table pins it: each line is the key, the values, and the text the old code produced with them. A French
 * customer, visitor or technician must not see a single difference, and a reworded message fails here first.
 *
 * Where the old code chose between two wordings with a condition (a name or "l’artisan", a date or none), each wording is its
 * own message and has its own line.
 */
const FRENCH: Array<[string, Record<string, string | number>, string]> = [
  ['appointment.reminder.title', {}, `Rappel de rendez-vous`],
  ['appointment.reminder.message', { lead: `une heure`, when: `19/10/2026 à 08:00` }, `Votre intervention est prévue dans une heure, le 19/10/2026 à 08:00.`],
  ['appointment.lead.minutes', { count: 1 }, `1 minute`],
  ['appointment.lead.minutes', { count: 5 }, `5 minutes`],
  ['appointment.lead.hours', { count: 1 }, `1 heure`],
  ['appointment.lead.hours', { count: 5 }, `5 heures`],
  ['appointment.lead.hoursAndMinutes', { hours: `2 heures`, minutes: `30 minutes` }, `2 heures 30 minutes`],
  ['application.received.subject', {}, `Candidature artisan reçue`],
  ['application.received.body', {}, `Votre candidature artisan a bien été reçue. Notre équipe va l’examiner.`],
  ['application.received.sms', {}, `Smart Dépannage: votre candidature artisan a bien été reçue.`],
  ['application.approved.title', {}, `Candidature artisan approuvée`],
  ['application.approved.message', {}, `Votre candidature artisan a été approuvée.`],
  ['application.approved.inviteSubject', {}, `Votre candidature est acceptée`],
  ['application.approved.inviteBody', { link: `https://example.test/l/abc` }, `Bonne nouvelle: votre candidature artisan est acceptée. Choisissez votre mot de passe (lien valable 24 heures, usage unique) : https://example.test/l/abc`],
  ['application.approved.inviteSms', { link: `https://example.test/l/abc` }, `Smart Dépannage: votre candidature est acceptée. Créez votre mot de passe ici: https://example.test/l/abc`],
  ['application.rejected.title', {}, `Candidature artisan refusée`],
  ['application.rejected.message', {}, `Votre candidature artisan a été refusée. Vous pouvez contacter le support pour plus d’informations.`],
  ['application.rejected.emailBody', { reason: `Le client est injoignable` }, `Votre candidature artisan n’a pas été retenue.\n\nMotif: Le client est injoignable`],
  ['auth.passwordReset.subject', {}, `Réinitialisation de votre mot de passe`],
  ['auth.passwordReset.body', { link: `https://example.test/l/abc` }, `Cliquez sur ce lien pour réinitialiser votre mot de passe: https://example.test/l/abc`],
  ['auth.emailVerification.subject', {}, `Vérification de votre email`],
  ['auth.emailVerification.body', { link: `https://example.test/l/abc` }, `Cliquez sur ce lien pour vérifier votre email: https://example.test/l/abc`],
  ['auth.phoneCode.sms', { code: `123456` }, `Votre code de vérification est: 123456`],
  ['auth.passwordSetup.subject', {}, `Création de votre mot de passe`],
  ['auth.passwordSetup.body', { link: `https://example.test/l/abc` }, `Votre compte a été créé. Cliquez ici pour créer votre mot de passe: https://example.test/l/abc`],
  ['auth.passwordSetup.bodyWithLifetime', { link: `https://example.test/l/abc` }, `Votre compte Smart Dépannage a été créé. Choisissez votre mot de passe (lien valable 24 heures, usage unique) : https://example.test/l/abc`],
  ['auth.passwordSetup.sms', { link: `https://example.test/l/abc` }, `Smart Dépannage: créez votre mot de passe ici: https://example.test/l/abc`],
  ['auth.emailChange.subject', {}, `Confirmez votre nouvelle adresse e-mail`],
  ['auth.emailChange.body', { link: `https://example.test/l/abc` }, `Cliquez sur ce lien pour confirmer cette adresse comme adresse de votre compte (valable 1 heure): https://example.test/l/abc`],
  ['auth.emailChangedNotice.subject', {}, `L'adresse e-mail de votre compte a changé`],
  ['auth.emailChangedNotice.body', { newEmail: `nouveau@example.com` }, `L'adresse e-mail de votre compte Smart Dépannage est maintenant nouveau@example.com. Si ce n'est pas vous, contactez-nous immédiatement.`],
  ['auth.emailChangedNotice.bodyBySupport', { newEmail: `nouveau@example.com` }, `L'adresse e-mail de votre compte Smart Dépannage est maintenant nouveau@example.com (modifiée par notre équipe). Si ce n'est pas vous, contactez-nous immédiatement.`],
  ['auth.phoneReleasedNotice.subject', {}, `Le numéro de téléphone de votre compte a été retiré`],
  ['auth.phoneReleasedNotice.body', {}, `Le numéro de téléphone de votre compte Smart Dépannage a été retiré: une autre personne a prouvé qu'il est le sien (code reçu par SMS). Vous pouvez ajouter un autre numéro depuis votre profil.`],
  ['auth.phoneChangedNotice.subject', {}, `Le numéro de téléphone de votre compte a changé`],
  ['auth.phoneChangedNotice.bodyChanged', { newPhone: `+216 20 111 222` }, `Le numéro de téléphone de votre compte Smart Dépannage est maintenant +216 20 111 222. Si ce n'est pas vous, changez votre mot de passe et contactez-nous.`],
  ['auth.phoneChangedNotice.bodyChangedFrom', { newPhone: `+216 20 111 222`, oldPhone: `+216 20 333 444` }, `Le numéro de téléphone de votre compte Smart Dépannage est maintenant +216 20 111 222 (avant: +216 20 333 444). Si ce n'est pas vous, changez votre mot de passe et contactez-nous.`],
  ['auth.phoneChangedNotice.bodyRemoved', {}, `Le numéro de téléphone a été retiré de votre compte Smart Dépannage. Si ce n'est pas vous, changez votre mot de passe et contactez-nous.`],
  ['auth.phoneChangedNotice.bodyRemovedFrom', { oldPhone: `+216 20 333 444` }, `Le numéro de téléphone a été retiré de votre compte Smart Dépannage (avant: +216 20 333 444). Si ce n'est pas vous, changez votre mot de passe et contactez-nous.`],
  ['chat.newMessage.title', { ref: `#12` }, `Nouveau message (demande #12)`],
  ['chat.newMessage.attachment', {}, `Pièce jointe`],
  ['chat.newMessage.fromSender', { name: `Sami`, text: `Je suis en bas` }, `Sami: Je suis en bas`],
  ['complaint.updated.title', {}, `Réclamation mise à jour`],
  ['complaint.updated.message', { title: `Retard` }, `Votre réclamation "Retard" a été mise à jour.`],
  ['complaint.reply.title', {}, `Nouveau message sur une réclamation`],
  ['complaint.reply.message', { title: `Retard` }, `Nouveau message sur la réclamation "Retard".`],
  ['guest.tracking.sms', { link: `https://example.test/l/abc`, ref: `#12` }, `Smart Dépannage: votre demande #12 est enregistrée. Suivez-la ici: https://example.test/l/abc`],
  ['guest.tracking.subject', {}, `Votre demande Smart Dépannage`],
  ['guest.tracking.greetingNamed', { name: `Sami` }, `Bonjour Sami,`],
  ['guest.tracking.greeting', {}, `Bonjour,`],
  ['guest.tracking.body', { greeting: `Bonjour Sami,`, link: `https://example.test/l/abc`, reference: 12 }, `Bonjour Sami,\n\nVotre demande n°12 est enregistrée. Suivez son avancement avec ce lien personnel (ne le partagez pas) :\nhttps://example.test/l/abc\n\nL'équipe Smart Dépannage`],
  ['guest.activation.emailSubject', {}, `Activation de votre compte`],
  ['guest.activation.emailBody', { link: `https://example.test/l/abc` }, `Cliquez sur ce lien pour activer votre compte: https://example.test/l/abc`],
  ['guest.activation.sms', { code: `123456` }, `Smart Dépannage: votre code d’activation est 123456. Il est valable 10 minutes.`],
  ['invoice.ready.title', {}, `Facture disponible`],
  ['invoice.ready.message', { number: `FAC-2026-0007` }, `Votre facture FAC-2026-0007 est disponible.`],
  ['invoice.email.subject', { number: `FAC-2026-0007` }, `Votre facture FAC-2026-0007`],
  ['invoice.email.body', { amount: `1 234,500 TND`, number: `FAC-2026-0007` }, `Bonjour,\n\nVotre facture FAC-2026-0007 d’un montant de 1 234,500 TND TTC est disponible.\n\nVous pouvez la télécharger en PDF depuis votre page de suivi.\n\nCordialement.`],
  ['invoice.email.bodyWithStamp', { amount: `1 234,500 TND`, number: `FAC-2026-0007` }, `Bonjour,\n\nVotre facture FAC-2026-0007 d’un montant de 1 234,500 TND TTC (timbre fiscal compris) est disponible.\n\nVous pouvez la télécharger en PDF depuis votre page de suivi.\n\nCordialement.`],
  ['mission.assigned.artisanTitle', {}, `Nouvelle mission assignée`],
  ['mission.assigned.artisanMessage', { address: `12 rue de Marseille, Tunis` }, `Une mission vous a été assignée: 12 rue de Marseille, Tunis.`],
  ['mission.assigned.clientTitle', {}, `Artisan assigné`],
  ['mission.assigned.clientMessage', {}, `Un artisan a été assigné à votre intervention.`],
  ['mission.assigned.schedule', { when: `19/10/2026 à 08:00` }, `Rendez-vous le 19/10/2026 à 08:00.`],
  ['mission.accepted.title', {}, `Mission acceptée`],
  ['mission.accepted.clientNamed', { name: `Sami` }, `Sami a accepté votre intervention.`],
  ['mission.accepted.client', {}, `L’artisan a accepté votre intervention.`],
  ['mission.accepted.planned', {}, `L’artisan a accepté la mission planifiée.`],
  ['mission.accepted.smsNamed', { name: `Sami` }, `Smart Dépannage: Votre demande a été acceptée ! Sami prend en charge votre dossier.`],
  ['mission.accepted.sms', {}, `Smart Dépannage: Votre demande a été acceptée ! Un artisan prend en charge votre dossier.`],
  ['mission.onTheWay.title', {}, `Artisan en route`],
  ['mission.onTheWay.clientNamed', { name: `Sami` }, `Votre artisan Sami est en route.`],
  ['mission.onTheWay.client', {}, `Votre artisan est en route.`],
  ['mission.arrived.title', {}, `Artisan arrivé`],
  ['mission.arrived.clientNamed', { name: `Sami` }, `Votre artisan Sami est arrivé sur place.`],
  ['mission.arrived.client', {}, `Votre artisan est arrivé sur place.`],
  ['mission.declined.clientTitle', {}, `Nouvel artisan en recherche`],
  ['mission.declined.clientMessage', {}, `Votre artisan n’est plus disponible pour cette intervention. Nous en cherchons un autre et revenons vers vous.`],
  ['mission.started.title', {}, `Travaux commencés`],
  ['mission.started.message', {}, `L’intervention a commencé.`],
  ['mission.completed.clientTitle', {}, `Intervention terminée`],
  ['mission.completed.clientMessage', {}, `L’artisan a terminé l’intervention. Vous pouvez la valider.`],
  ['mission.completed.smsAfterStatusChange', {}, `Intervention terminée. Merci de votre confiance !`],
  ['mission.completed.smsAfterProof', {}, `Smart Dépannage: Votre intervention est terminée ! Une preuve sécurisée a été enregistrée sur votre dossier.`],
  ['mission.completed.sms', {}, `Smart Dépannage: votre intervention est terminée.`],
  ['mission.cancelled.title', {}, `Mission annulée`],
  ['mission.cancelled.message', { reason: `Le client est injoignable`, ref: `#12` }, `La mission #12 a été annulée: Le client est injoignable`],
  ['mission.rescheduled.title', {}, `Rendez-vous modifié`],
  ['mission.rescheduled.message', { ref: `#12`, when: `19/10/2026 à 08:00` }, `Le rendez-vous de l’intervention #12 est fixé le 19/10/2026 à 08:00.`],
  ['mission.rescheduled.messageWithoutDate', { ref: `#12` }, `Le rendez-vous de l’intervention #12 est fixé.`],
  ['mission.withdrawn.title', {}, `Mission retirée`],
  ['mission.withdrawn.message', { ref: `#12` }, `La mission #12 a été confiée à un autre artisan.`],
  ['mission.proofRefused.title', {}, `Photo refusée`],
  ['mission.proofRefused.message', { next: `Reprenez-la sur place.`, ref: `#12`, what: `avant` }, `La photo avant intervention de la mission #12 a été refusée par l’équipe. Reprenez-la sur place.`],
  ['mission.proofRefused.before', {}, `avant`],
  ['mission.proofRefused.after', {}, `après`],
  ['mission.proofRefused.retake', {}, `Reprenez-la sur place.`],
  ['mission.proofRefused.contact', {}, `L’équipe vous contactera.`],
  ['payment.received.title', {}, `Paiement confirmé`],
  ['payment.received.message', { amount: `1 234,500 TND` }, `Votre paiement de 1 234,500 TND a été confirmé.`],
  ['payment.refunded.title', {}, `Remboursement effectué`],
  ['payment.refunded.message', { sum: `50,000 TND` }, `Un remboursement de 50,000 TND a été effectué sur votre paiement.`],
  ['payment.refunded.byCardTitle', {}, `Remboursement enregistré`],
  ['payment.refunded.byCardMessage', { sum: `50,000 TND` }, `Un remboursement de 50,000 TND a été enregistré sur votre paiement par carte. Il sera versé sur votre carte par notre prestataire de paiement.`],
  ['quote.sent.title', {}, `Devis reçu`],
  ['quote.sent.message', { amount: `1 234,500 TND` }, `Un devis de 1 234,500 TND TTC vous a été envoyé.`],
  ['quote.sent.sms', { amount: `1 234,500 TND` }, `Smart Dépannage: vous avez reçu un devis de 1 234,500 TND TTC.`],
  ['quote.sent.emailSubject', {}, `Votre devis Smart Dépannage`],
  ['quote.sent.emailBody', { amount: `1 234,500 TND` }, `Vous avez reçu un devis de 1 234,500 TND TTC.`],
  ['quote.accepted.title', {}, `Devis accepté`],
  ['quote.accepted.message', { ref: `#12` }, `Le client a accepté le devis #12.`],
];

describe('the French messages are the old texts (P3-04)', () => {
  const byKey = new Map(allMessages().map((entry) => [entry.key, entry.definition]));

  it('every message has a pin, and every pin names a message', () => {
    const pinned = new Set(FRENCH.map(([key]) => key));

    expect([...byKey.keys()].filter((key) => !pinned.has(key))).toEqual([]);
    expect([...pinned].filter((key) => !byKey.has(key))).toEqual([]);
  });

  for (const [key, params, expected] of FRENCH) {
    it(`${key} ${JSON.stringify(params)} reads as it always did`, () => {
      const definition = byKey.get(key);

      expect(definition).toBeDefined();
      expect(say(definition as any, 'fr', params as any)).toBe(expected);
    });
  }

  it('French output has no direction mark in it, whatever the values', () => {
    for (const [key, params] of FRENCH) {
      expect(/[\u2066-\u2069\u061C\u200E\u200F]/.test(say(byKey.get(key) as any, 'fr', params as any))).toBe(false);
    }
  });
});

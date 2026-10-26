/**
 * The card payment, from the request to the page of the provider (P2-10).
 *
 * A request to pay by card is first recorded like any payment (PENDING, one open payment per job, P2-03). `startOnlinePayment` then
 * asks the provider for a payment and keeps what it answers on the row: the provider's number, the page where the customer pays,
 * and the moment the payment lapses. It runs after the request was recorded (never inside its transaction: the lock of the job must
 * not be held while a provider answers), and it is safe to run twice:
 *
 *  - a payment that was started is answered as it is (no second payment at the provider);
 *  - two askers at the same moment: one claims the row (`gatewayClaimedAt`, one conditional write), the other waits for the answer
 *    of the first and returns it, or is told to try again in a moment;
 *  - a provider that does not answer leaves the row PENDING with nobody behind it (an "empty" request, as before this step): asking
 *    again starts it, choosing another way of paying cancels it, and the timer cancels it when it stays that way (`expireOnline`).
 */
import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';

import { getFrontendUrl } from '../../config/env';
import { describeError } from '../notifications/delivery/delivery-error';
import { GatewayError } from './gateway/payment-gateway';
import { PaymentGatewayService } from './gateway/payment-gateway.service';

type Db = any;
type Row = Record<string, any>;

export const ONLINE_METHODS: readonly string[] = ['ONLINE', 'ONLINE_CARD'];

export const isOnlineMethod = (method: unknown): boolean => ONLINE_METHODS.includes(String(method));

/** Our name for a payment at the provider; the provider echoes it, and a payment whose name differs is not confirmed. */
export const orderIdOf = (payment: Row): string => `DEP-${payment.interventionId}-P${payment.id}`;

export const CARD_WORDS = {
  unavailable: 'Le paiement par carte est momentanément indisponible. Réessayez dans quelques instants ou choisissez un autre mode de paiement.',
  preparing: 'Votre paiement par carte est en cours de préparation. Réessayez dans un instant.',
  expired: 'Le délai pour payer par carte est dépassé.',
  // Written on the payment and on its timeline (the customer can read it): the timer still asks the provider about it for a week.
  gaveUp: 'Le prestataire de paiement n’a pas pu être interrogé pendant plus d’un jour.',
  checking: 'Votre précédent paiement par carte est en cours de vérification chez le prestataire. Réessayez dans quelques instants.',
  notStarted: 'La demande de paiement par carte n’a pas abouti.',
  refused: 'Le paiement par carte a été refusé.',
  late: 'Reçu après l’annulation de la demande : à vérifier avant de confirmer ou de rembourser.',
  over: 'Reçu en ligne, mais le montant dépasse ce qu’il reste à payer sur la mission : à vérifier (remboursement à prévoir).',
  waitsAtProvider: 'Ce paiement par carte attend la réponse du prestataire : utilisez « Vérifier auprès du prestataire » ou attendez son expiration.',
  nothingToCheck: 'Ce paiement n’a pas été transmis à un prestataire : il n’y a rien à vérifier.',
  other: 'Reçu en ligne : le paiement a été annulé ou refusé ici avant d’être reçu. À vérifier avant de confirmer ou de rembourser.',
  jobCancelled: 'Reçu en ligne, mais la mission est annulée : à vérifier (remboursement à prévoir).',
  failedAtProvider: 'Ce paiement par carte a été refusé ou clos : rien n’a été reçu. Demandez un nouveau paiement.',
  notAsked: 'Le prestataire n’a pas été interrogé sur ce paiement : il n’est pas (ou plus) celui qui est connecté à ce serveur.',
  changed: 'Un paiement vient d’être modifié sur cette mission. Réessayez.',
};

/** The one page of the website the provider sends the customer back to, whatever the outcome (the page asks the server what became of the payment). */
export const RETURN_PATH = '/paiement/retour';

export const returnUrl = (): string => `${getFrontendUrl()}${RETURN_PATH}`;

/** How long a second asker waits for the first one, and how often it looks. */
const WAIT_STEP_MS = 250;
const WAIT_MAX_MS = 8000;
/** A claim older than this is a request that died: another asker may take over. */
const CLAIM_STALE_MS = 60_000;

const logger = new Logger('OnlinePayment');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface StartOptions {
  customerName?: string | null;
  now?: () => Date;
  /** For a spec: how the waiting is done, and for how long. */
  wait?: (ms: number) => Promise<void>;
  waitMs?: number;
}

/** A second asker waits until the first one has stored the provider's answer. */
async function waitForStart(db: Db, paymentId: number, options: StartOptions): Promise<Row> {
  const wait = options.wait ?? sleep;
  const limit = options.waitMs ?? WAIT_MAX_MS;

  for (let waited = 0; waited <= limit; waited += WAIT_STEP_MS) {
    const row: Row | null = await db.payment.findUnique({ where: { id: paymentId } });

    if (!row) throw new ConflictException(CARD_WORDS.preparing);
    if (row.providerPaymentId || String(row.status) !== 'PENDING') return row;

    await wait(WAIT_STEP_MS);
  }

  throw new ConflictException(CARD_WORDS.preparing);
}

/**
 * Asks the provider for the payment of a request and keeps its answer on the row. Returns the row as it is now (with `payUrl`
 * and `expiresAt` when a provider took it). With no provider set up, or a payment that is not a card payment, or one that is no longer
 * PENDING, nothing is asked and the row is returned as it is.
 */
export async function startOnlinePayment(db: Db, gateway: PaymentGatewayService, payment: Row, options: StartOptions = {}): Promise<Row> {
  if (!gateway.connected() || !isOnlineMethod(payment.method)) return payment;
  if (String(payment.status) !== 'PENDING' || payment.providerPaymentId) return payment;

  const now = (options.now ?? (() => new Date()))();
  const claimed = await db.payment.updateMany({
    where: {
      id: payment.id,
      status: 'PENDING',
      providerPaymentId: null,
      OR: [{ gatewayClaimedAt: null }, { gatewayClaimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } }],
    },
    data: { gatewayClaimedAt: now },
  });

  if (claimed.count !== 1) return waitForStart(db, payment.id, options);

  let created;

  try {
    created = await gateway.create({
      orderId: orderIdOf(payment),
      amount: Number(String(payment.amount)),
      currency: String(payment.currency),
      description: `Dépannage n° ${payment.interventionId}`,
      lifespanMinutes: gateway.config.lifespanMinutes,
      successUrl: returnUrl(),
      failUrl: returnUrl(),
      webhookUrl: gateway.webhookUrl(),
      customer: { name: options.customerName ?? null },
    });
  } catch (error) {
    // Let the next asker try: the row stays as it was.
    await db.payment.updateMany({ where: { id: payment.id, providerPaymentId: null }, data: { gatewayClaimedAt: null } });

    if (error instanceof GatewayError) {
      // The customer is told to try again; the logs say why (a refused key is not a passing outage). Nothing but the name and the code.
      logger.warn(`The provider did not take card payment ${payment.id} (${describeError(error)}).`);

      throw new ServiceUnavailableException(CARD_WORDS.unavailable);
    }

    throw error;
  }

  await db.payment.updateMany({
    where: { id: payment.id, status: 'PENDING', providerPaymentId: null },
    data: {
      provider: gateway.provider(),
      providerPaymentId: created.providerPaymentId,
      payUrl: created.payUrl,
      expiresAt: new Date(now.getTime() + gateway.config.lifespanMinutes * 60_000),
      gatewayClaimedAt: null,
    },
  });

  return (await db.payment.findUnique({ where: { id: payment.id } })) ?? payment;
}

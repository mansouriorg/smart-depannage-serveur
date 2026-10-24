import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { lockCashLedger, lockJob, lockPayouts } from '../assignment/artisan-lock';
import { canonicalStatus } from '../intervention-workflow/intervention-status';
import { InterventionEventType, PaymentMethod, PaymentProvider, PaymentStatus, Role } from '../../../generated/prisma/client';
import { currencyCode } from '../../common/locale/locale';
import { compareMoney, formatMoney, money, percentOf, subtractMoney } from '../../common/money/money';
import { isValidAmount } from '../../common/money/money-rules';
import { pick } from '../../common/views/pick';
import { CollectCashDto, LedgerQueryDto, RecordAdjustmentDto, RecordRemittanceDto } from './dto/cash-ledger.dto';
import { COLLECT_CASH_IN, LedgerEntryView, LedgerTotals } from './cash-ledger.types';
import { describeAmount, isPlaceholder, supersede } from '../payments/open-payment';
import { TypeSums, commissionRateFor, jobIsInPaidPayout, ledgerTotals, paymentPosition, totalsOfSums, viewOfEntry } from './cash-ledger-ops';

const MAX_ROW_ID = 2_147_483_647;
const isRowId = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_ROW_ID;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** The back office people who handle money: they see every ledger and write to it. */
const FINANCE_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT];

/** A prisma error that says a unique value is already taken. */
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002';

const negate = (amount: number) => subtractMoney(0, amount);

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;

  const text = value.trim();

  return text ? text : null;
};

export interface LedgerPage {
  totals: LedgerTotals;
  entries: LedgerEntryView[];
  /** Send it as `before` to read the next page; null at the end. */
  nextBefore: number | null;
}

@Injectable()
export class CashLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  // ==========================================================
  // Who may do what
  // ==========================================================

  private assertArtisan(role: Role) {
    if (role !== Role.ARTISAN) throw new ForbiddenException('Réservé aux artisans.');
  }

  private assertFinance(role: Role) {
    if (!FINANCE_ROLES.includes(role)) throw new ForbiddenException('Réservé à la comptabilité et aux administrateurs.');
  }

  /** The artisan's profile must be approved, as for every other thing an artisan does on a mission. */
  private async assertApprovedArtisan(userId: number) {
    const profile = await this.prisma.artisanProfile.findUnique({ where: { userId } });

    if (!profile) throw new NotFoundException('Profil artisan introuvable.');

    if (profile.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException('Votre profil artisan doit être approuvé pour effectuer cette action.');
    }
  }

  private positive(value: unknown, what: string): number {
    if (!isValidAmount(value, 0.001)) throw new BadRequestException(`${what} invalide: un montant positif, avec au plus trois décimales.`);

    return money(value as number);
  }

  private async artisanOrFail(artisanId: number) {
    if (!isRowId(artisanId)) throw new NotFoundException('Artisan introuvable.');

    const artisan = await this.prisma.user.findFirst({ where: { id: artisanId, role: Role.ARTISAN } });

    if (!artisan) throw new NotFoundException('Artisan introuvable.');

    return artisan;
  }

  // ==========================================================
  // The artisan takes cash from the customer
  // ==========================================================

  /**
   * The artisan of a job says how much cash the customer gave them.
   *
   * The customer's payment is made (or, when the customer had already asked to pay in cash and nothing was taken yet,
   * that request is the one that is used) and waits for confirmation as every cash payment does; the cash and the
   * commission on it go into the artisan's ledger at once. The amount cannot be more than what is left to pay on the job.
   */
  async collectCash(userId: number, role: Role, interventionId: number, dto: CollectCashDto) {
    this.assertArtisan(role);

    if (!isRowId(interventionId)) throw new NotFoundException('Mission introuvable.');

    const amount = this.positive(dto?.amount, 'Montant');
    const note = cleanText(dto?.note);
    const requestKey = cleanText(dto?.requestKey);

    if (!requestKey || requestKey.length < 8 || requestKey.length > 64) {
      throw new BadRequestException('Une clé de requête de 8 à 64 caractères est obligatoire: elle évite d’enregistrer deux fois le même encaissement.');
    }

    await this.assertApprovedArtisan(userId);

    let outcome: { payment: Record<string, any>; entry: Record<string, any>; replayed: boolean };

    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        await lockJob(tx, interventionId);
        await lockCashLedger(tx, userId);

        const done = await tx.cashLedgerEntry.findFirst({ where: { artisanId: userId, requestKey } });

        if (done) {
          const sameRequest = done.type === 'COLLECTION' && done.interventionId === interventionId && compareMoney(done.cashAmount, amount) === 0;

          if (!sameRequest) throw new ConflictException('Cette clé de requête a déjà servi pour une autre demande.');

          const payment = await tx.payment.findUnique({ where: { id: done.paymentId } });

          return { payment: payment as Record<string, any>, entry: done, replayed: true };
        }

        const job = await tx.intervention.findUnique({ where: { id: interventionId }, select: { id: true, artisanId: true, status: true } });

        // The mission of somebody else is not found: no one learns that it exists.
        if (!job || job.artisanId !== userId) throw new NotFoundException('Mission introuvable.');

        const status = canonicalStatus(String(job.status));

        if (!status || !COLLECT_CASH_IN.includes(status)) {
          throw new BadRequestException('Les espèces ne peuvent être encaissées qu’une fois sur place, pendant ou après le travail.');
        }

        // Once a payout that was paid has taken the job, the share has been given: cash taken after that is for the back office to put
        // right. (A payout that is not paid yet no longer matches the cash and is made again.)
        await lockPayouts(tx, userId);

        if (await jobIsInPaidPayout(tx, interventionId)) {
          throw new ConflictException('Un payout déjà payé comprend cette mission: contactez l’administration pour enregistrer cet encaissement.');
        }

        const { invoice, quote, document, payments, declared, remaining } = await paymentPosition(tx, interventionId);

        if (!document || remaining === null) throw new BadRequestException('Aucun devis accepté ni facture: il n’y a pas de montant à encaisser.');

        const currency: string = document.currency ?? currencyCode();

        if (currency !== currencyCode()) {
          throw new BadRequestException(`Cette mission est facturée en ${currency}, le registre est tenu en ${currencyCode()}.`);
        }

        if (compareMoney(remaining, 0) <= 0) throw new BadRequestException('Cette mission est déjà payée.');

        if (compareMoney(amount, remaining) > 0) {
          throw new BadRequestException(`Le montant dépasse ce qu’il reste à payer sur cette mission (${formatMoney(remaining, { currency })}).`);
        }

        // A request to pay in cash that the customer made, and that nobody has taken yet, is the payment that is being made.
        const open = payments
          .filter((payment) => payment.method === PaymentMethod.CASH && ([PaymentStatus.PENDING, PaymentStatus.AWAITING_CONFIRMATION] as string[]).includes(payment.status) && !declared.has(payment.id))
          .sort((a, b) => b.id - a.id)[0];

        // One open payment per job: what the customer asked for in another way than cash is not paid twice. An online request
        // that nobody can pay is cancelled; a transfer waiting for its confirmation is for the back office to cancel first.
        // (Cash that was declared before is a fact, not a request: it is never in the way.)
        const others = payments.filter((other) => ([PaymentStatus.PENDING, PaymentStatus.AWAITING_CONFIRMATION] as string[]).includes(other.status) && other.method !== PaymentMethod.CASH);
        const blocking = others.find((other) => !isPlaceholder(other));

        if (blocking) {
          throw new ConflictException(`Un paiement de ${describeAmount(blocking)} est déjà en attente pour cette mission: contactez l’administration.`);
        }

        for (const other of others) {
          if (!(await supersede(tx, other))) throw new ConflictException('Un paiement vient d’être modifié sur cette mission. Réessayez.');
        }

        let payment: Record<string, any>;

        if (open) {
          const changed = await tx.payment.updateMany({
            where: { id: open.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.AWAITING_CONFIRMATION] } },
            data: { amount, status: PaymentStatus.AWAITING_CONFIRMATION },
          });

          if (changed.count !== 1) throw new ConflictException('Ce paiement vient d’être modifié. Réessayez.');

          payment = (await tx.payment.findUnique({ where: { id: open.id } })) as Record<string, any>;
        } else {
          payment = await tx.payment.create({
            data: {
              interventionId,
              quoteId: quote?.id,
              invoiceId: invoice?.id,
              method: PaymentMethod.CASH,
              provider: PaymentProvider.CASH,
              status: PaymentStatus.AWAITING_CONFIRMATION,
              amount,
              amountRefunded: 0,
              currency,
              clientNote: note ?? undefined,
              createdById: userId,
            },
          });
        }

        const rate = await commissionRateFor(tx, interventionId);
        const commission = percentOf(amount, rate);

        const entry = await tx.cashLedgerEntry.create({
          data: {
            artisanId: userId,
            type: 'COLLECTION',
            interventionId,
            paymentId: payment.id,
            cashAmount: amount,
            commissionAmount: commission,
            commissionRate: rate,
            currency,
            note,
            requestKey,
            recordedById: userId,
          },
        });

        return { payment, entry, replayed: false };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Cet encaissement est déjà enregistré.');

      throw error;
    }

    if (!outcome.replayed) {
      await this.events.create({
        interventionId,
        type: InterventionEventType.PAYMENT_PENDING,
        title: 'Espèces encaissées',
        message: `L’artisan a déclaré avoir encaissé ${formatMoney(amount, { currency: outcome.payment.currency })} en espèces.`,
        createdById: userId,
        metadata: { paymentId: outcome.payment.id, amount, currency: outcome.payment.currency, entryId: outcome.entry.id },
      });
    }

    return {
      replayed: outcome.replayed,
      payment: { ...pick(outcome.payment, ['id', 'interventionId', 'method', 'status', 'currency', 'createdAt']), amount: money(outcome.payment.amount) },
      entry: viewOfEntry(outcome.entry),
      totals: await ledgerTotals(this.prisma, userId),
    };
  }

  // ==========================================================
  // Reading a ledger
  // ==========================================================

  /** The ledger of the signed-in artisan. */
  async getMyLedger(userId: number, role: Role, query: LedgerQueryDto = {}): Promise<LedgerPage> {
    this.assertArtisan(role);

    return this.pageOf(userId, query);
  }

  /** The ledger of one artisan, for the people who handle money. */
  async getArtisanLedger(role: Role, artisanId: number, query: LedgerQueryDto = {}): Promise<LedgerPage & { artisan: { id: number; name: string | null; phone: string | null } }> {
    this.assertFinance(role);

    const artisan = await this.artisanOrFail(artisanId);
    const page = await this.pageOf(artisan.id, query);

    return { artisan: { id: artisan.id, name: artisan.name ?? null, phone: artisan.phone ?? null }, ...page };
  }

  private async pageOf(artisanId: number, query: LedgerQueryDto): Promise<LedgerPage> {
    const limit = Math.min(Math.max(Math.trunc(Number(query?.limit) || DEFAULT_PAGE), 1), MAX_PAGE);
    const before = isRowId(query?.before) ? query.before : null;

    const rows: Array<Record<string, any>> = await this.prisma.cashLedgerEntry.findMany({
      where: { artisanId, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });

    const entries = rows.slice(0, limit);

    return {
      totals: await ledgerTotals(this.prisma, artisanId),
      entries: entries.map(viewOfEntry),
      nextBefore: rows.length > limit ? entries[entries.length - 1].id : null,
    };
  }

  /** Every artisan who has a line in the ledger, with what they hold and what they owe; those who owe the most first. */
  async listBalances(role: Role) {
    this.assertFinance(role);

    // One query for every figure, so that they all come from the same moment.
    const groups: Array<Record<string, any>> = await this.prisma.cashLedgerEntry.groupBy({ by: ['artisanId', 'type'], _sum: { cashAmount: true, commissionAmount: true } });
    const byArtisan = new Map<number, TypeSums>();

    for (const group of groups) {
      byArtisan.set(group.artisanId, [...(byArtisan.get(group.artisanId) ?? []), group]);
    }

    const ids = [...byArtisan.keys()];
    const users: Array<Record<string, any>> = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
    const byId = new Map(users.map((user) => [user.id, user]));

    return ids
      .map((artisanId) => ({
        artisanId,
        name: (byId.get(artisanId)?.name ?? null) as string | null,
        phone: (byId.get(artisanId)?.phone ?? null) as string | null,
        ...totalsOfSums(byArtisan.get(artisanId) as TypeSums),
      }))
      .sort((a, b) => compareMoney(b.balance, a.balance) || a.artisanId - b.artisanId);
  }

  // ==========================================================
  // The back office writes to a ledger
  // ==========================================================

  /** The artisan hands commission over to the platform. It cannot be more than they owe. */
  async recordRemittance(userId: number, role: Role, artisanId: number, dto: RecordRemittanceDto) {
    this.assertFinance(role);

    const amount = this.positive(dto?.amount, 'Montant');
    const requestKey = cleanText(dto?.requestKey);
    const artisan = await this.artisanOrFail(artisanId);

    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await lockCashLedger(tx, artisan.id);

        if (requestKey) {
          const done = await tx.cashLedgerEntry.findFirst({ where: { artisanId: artisan.id, requestKey } });

          if (done) {
            if (done.type !== 'REMITTANCE' || compareMoney(negate(money(done.commissionAmount)), amount) !== 0) {
              throw new ConflictException('Cette clé de requête a déjà servi pour une autre demande.');
            }

            return { entry: done, replayed: true };
          }
        }

        const totals = await ledgerTotals(tx, artisan.id);

        if (compareMoney(totals.balance, 0) <= 0) throw new BadRequestException('Cet artisan ne doit rien à la plateforme.');

        if (compareMoney(amount, totals.balance) > 0) {
          throw new BadRequestException(`Cet artisan ne doit que ${formatMoney(totals.balance, { currency: totals.currency })}: un versement plus grand n’est pas enregistré.`);
        }

        const entry = await tx.cashLedgerEntry.create({
          data: {
            artisanId: artisan.id,
            type: 'REMITTANCE',
            cashAmount: 0,
            commissionAmount: negate(amount),
            currency: currencyCode(),
            reference: cleanText(dto?.reference),
            note: cleanText(dto?.note),
            requestKey,
            recordedById: userId,
          },
        });

        return { entry, replayed: false };
      });

      return { replayed: outcome.replayed, entry: viewOfEntry(outcome.entry), totals: await ledgerTotals(this.prisma, artisan.id) };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ce versement est déjà enregistré.');

      throw error;
    }
  }

  /** The back office puts a figure of a ledger right, with the reason; the amounts are signed. */
  async recordAdjustment(userId: number, role: Role, artisanId: number, dto: RecordAdjustmentDto) {
    this.assertFinance(role);

    const commission = this.signed(dto?.commissionAmount, 'Commission');
    const cash = this.signed(dto?.cashAmount, 'Espèces');
    const reason = cleanText(dto?.reason);
    const requestKey = cleanText(dto?.requestKey);

    if (compareMoney(commission, 0) === 0 && compareMoney(cash, 0) === 0) throw new BadRequestException('Une correction doit changer un montant.');
    if (!reason || reason.length < 3) throw new BadRequestException('Une correction doit dire pourquoi.');

    const artisan = await this.artisanOrFail(artisanId);

    if (dto?.interventionId !== undefined && dto?.interventionId !== null) {
      if (!isRowId(dto.interventionId)) throw new NotFoundException('Mission introuvable.');

      const job = await this.prisma.intervention.findUnique({ where: { id: dto.interventionId }, select: { id: true } });

      if (!job) throw new NotFoundException('Mission introuvable.');
    }

    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await lockCashLedger(tx, artisan.id);

        if (requestKey) {
          const done = await tx.cashLedgerEntry.findFirst({ where: { artisanId: artisan.id, requestKey } });

          if (done) {
            const same = done.type === 'ADJUSTMENT' && compareMoney(done.commissionAmount, commission) === 0 && compareMoney(done.cashAmount, cash) === 0;

            if (!same) throw new ConflictException('Cette clé de requête a déjà servi pour une autre demande.');

            return { entry: done, replayed: true };
          }
        }

        const entry = await tx.cashLedgerEntry.create({
          data: {
            artisanId: artisan.id,
            type: 'ADJUSTMENT',
            interventionId: dto?.interventionId ?? undefined,
            cashAmount: cash,
            commissionAmount: commission,
            currency: currencyCode(),
            note: reason,
            requestKey,
            recordedById: userId,
          },
        });

        return { entry, replayed: false };
      });

      return { replayed: outcome.replayed, entry: viewOfEntry(outcome.entry), totals: await ledgerTotals(this.prisma, artisan.id) };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Cette correction est déjà enregistrée.');

      throw error;
    }
  }

  /** A signed amount: absent is 0, anything else is a number of millimes that a column holds. */
  private signed(value: unknown, what: string): number {
    if (value === undefined || value === null) return 0;

    if (!isValidAmount(value, -99_999_999_999.999)) throw new BadRequestException(`${what} invalide: un montant avec au plus trois décimales.`);

    return money(value as number);
  }
}

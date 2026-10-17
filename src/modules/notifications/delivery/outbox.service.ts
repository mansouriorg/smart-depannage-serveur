import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import type { DeliveryConfig } from '../../../config/delivery';

import { DELIVERY_CONFIG, DeliveryProviders } from './delivery-providers';
import { DeliveryError, describeError } from './delivery-error';
import { isDeliverableEmail, toE164 } from './contact';

export type OutboxChannel = 'EMAIL' | 'SMS' | 'PUSH';

export type OutboxInput = {
  channel: OutboxChannel;
  userId?: number | null;
  /** E-mail address or phone number. Not used for push (the user's devices are looked up when sending). */
  recipient?: string | null;
  /** E-mail subject, or the push title. */
  subject?: string | null;
  body: string;
  /** Extra payload for push. */
  data?: unknown;
  notificationId?: number;
  deliveryLogId?: number;
  /** After this time the message is not sent any more (a code or a link that has expired is worse than none). */
  expiresAt?: Date | null;
  /**
   * A newer message with the same key replaces the ones with that key that are
   * still waiting, so asking three times for a code never results in three codes.
   */
  supersedeKey?: string | null;
};

type Outcome = {
  status: 'SENT' | 'SKIPPED';
  provider: string;
  providerMessageId?: string;
  note?: string;
};

/**
 * Wait before retry number 1, 2, 3...: 30 s, 2 min, 10 min, 1 h, then 6 h. With
 * the default of 5 attempts a message is tried 5 times, so only the first four
 * waits happen; the 6 h wait appears when OUTBOX_MAX_ATTEMPTS is 6 or more.
 */
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

/** A message stuck in SENDING for longer than this was lost with a crashed process. */
const STALE_LOCK_MS = 5 * 60_000;

/** At most this many first attempts run at the same time; the rest wait for the next worker round. */
const MAX_FIRST_ATTEMPTS = 5;

/** One worker round handles at most this many batches in a row (a burst is cleared without waiting for the next tick). */
const MAX_ROUNDS = 10;

const CHANNELS: OutboxChannel[] = ['EMAIL', 'SMS', 'PUSH'];

const SUPERSEDED = 'replaced by a newer message';
const EXPIRED = 'expired before it could be sent';

/** Finished rows are kept this long, for support, then deleted. */
const KEEP_FINISHED_DAYS = 30;

export function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1];
}

/**
 * Every e-mail, SMS and push goes through here (P1-03).
 *
 * The code that wants to send a message writes a row (enqueue) and carries on:
 * a slow or broken provider never slows down or breaks a request. A worker
 * picks the rows up, sends them, and tries again later when the provider fails
 * for a reason that can pass. Several server processes can run side by side: a
 * row is claimed with a compare-and-set, so two workers never send it twice.
 *
 * Message bodies can be one-time codes and links, so they are emptied from the
 * row as soon as it is finished, and they never go to the log.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private timer: any;
  private lastPurge = 0;
  private housekeeping = false;
  /** Channels whose worker round is running: a slow gateway never starts a second round on itself. */
  private readonly busy = new Set<OutboxChannel>();
  private readonly warned = new Set<string>();
  private closing = false;
  private activeFirstAttempts = 0;
  /** Work in progress, so a shutdown can wait for it instead of cutting a message in half. */
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly firstAttemptTimers = new Set<any>();
  /** Messages that were sent but whose result could not be written down yet: never sent again, only recorded. */
  private readonly unrecorded = new Map<
    number,
    { row: any; attempt: number; status: 'SENT' | 'SKIPPED' | 'FAILED'; now: Date; result: any }
  >();
  /** Wait before writing a result down again; tests set it to 0. */
  protected recordRetryMs = 250;

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: DeliveryProviders,
    @Inject(DELIVERY_CONFIG) private readonly config: DeliveryConfig,
  ) {}

  // ==========================================================
  // Lifecycle
  // ==========================================================

  onModuleInit() {
    const describe = (name: string, ok: boolean) => `${name}: ${ok ? 'on' : 'NOT CONFIGURED'}`;

    this.logger.log(
      `Delivery - ${describe('e-mail', this.providers.email.isConfigured())}, ` +
        `${describe('SMS', this.providers.sms.isConfigured())}, ` +
        `${describe('push', this.providers.push.isConfigured())}` +
        `${this.config.outbox.workerEnabled ? '' : ' (sending worker OFF in this process: messages wait in the outbox for a process that has it on)'}`,
    );

    for (const [channel, provider] of [
      ['EMAIL', this.providers.email],
      ['SMS', this.providers.sms],
    ] as const) {
      if (!provider.isConfigured()) {
        this.warnNotConfigured(channel);
      }
    }

    void this.selfCheck();

    if (this.config.outbox.workerEnabled) {
      this.timer = setInterval(() => this.track(this.tick()), this.config.outbox.pollMs);
      this.timer.unref?.();
    }
  }

  /** Stops taking new work and waits for the messages being sent right now. */
  async onModuleDestroy() {
    this.closing = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    for (const timer of this.firstAttemptTimers) {
      clearTimeout(timer);
    }

    this.firstAttemptTimers.clear();

    await Promise.allSettled([...this.inflight]);

    // The database is still open at this point: one last try to write down the
    // results that are still waiting, so those messages are not sent again later.
    await this.flushUnrecorded();
  }

  /**
   * The table is created by a schema change that must be applied by hand
   * (prisma db push / migrate). Without it nothing is ever sent, so say so
   * loudly at start-up instead of failing silently on the first request.
   */
  private async selfCheck() {
    try {
      await this.prisma.notificationOutbox.findFirst({ select: { id: true } });
    } catch (error: any) {
      this.logger.error(
        `The NotificationOutbox table cannot be read (${describeError(error)}). ` +
          'No e-mail, SMS or push can be sent until it exists: apply the schema change ' +
          '("npx prisma db push" or "npx prisma migrate dev") and restart.',
      );
    }
  }

  private track(job: Promise<unknown>) {
    this.inflight.add(job);

    const done = () => {
      this.inflight.delete(job);
    };

    job.then(done, done);
  }

  // ==========================================================
  // What the rest of the server uses
  // ==========================================================

  isEmailConfigured(): boolean {
    return this.providers.email.isConfigured();
  }

  isSmsConfigured(): boolean {
    return this.providers.sms.isConfigured();
  }

  isPushConfigured(): boolean {
    return this.providers.push.isConfigured();
  }

  providerName(channel: OutboxChannel): string {
    const provider =
      channel === 'EMAIL' ? this.providers.email : channel === 'SMS' ? this.providers.sms : this.providers.push;

    return provider.name;
  }

  /** Writes the message down and starts a first attempt in the background. */
  async enqueue(input: OutboxInput): Promise<{ id: number }> {
    const row = await this.prisma.notificationOutbox.create({
      data: {
        channel: input.channel,
        userId: input.userId ?? undefined,
        recipient: input.recipient ?? undefined,
        subject: input.subject ?? undefined,
        body: input.body,
        data: (input.data ?? undefined) as any,
        notificationId: input.notificationId,
        deliveryLogId: input.deliveryLogId,
        expiresAt: input.expiresAt ?? undefined,
        supersedeKey: input.supersedeKey ?? undefined,
        maxAttempts: this.config.outbox.maxAttempts,
      },
      select: { id: true },
    });

    if (input.supersedeKey) {
      await this.cancelSuperseded(input.supersedeKey, row.id);
    }

    this.startFirstAttempt(row.id);

    return row;
  }

  /**
   * The older messages with this key that have not left yet are not needed any
   * more. "Older" is by id, so two messages enqueued at the same moment cannot
   * cancel each other: the later one always wins.
   */
  private async cancelSuperseded(key: string, keepId: number) {
    try {
      const older = await this.prisma.notificationOutbox.findMany({
        where: { supersedeKey: key, status: 'PENDING', id: { lt: keepId } },
        select: { id: true, deliveryLogId: true },
      });

      if (!older.length) return;

      await this.prisma.notificationOutbox.updateMany({
        where: { id: { in: older.map((entry: any) => entry.id) }, status: 'PENDING' },
        data: { status: 'SKIPPED', body: '', subject: null, lastError: SUPERSEDED },
      });

      const logIds = older.map((entry: any) => entry.deliveryLogId).filter(Boolean);

      if (logIds.length) {
        await this.prisma.notificationDeliveryLog.updateMany({
          where: { id: { in: logIds } },
          data: { status: 'SKIPPED', error: SUPERSEDED },
        });
      }
    } catch (error: any) {
      // The new message is already safe in the outbox; an old one may still go out, which is harmless.
      this.logger.warn(`Outbox: older messages with the same key were not cancelled (${describeError(error)})`);
    }
  }

  private startFirstAttempt(id: number) {
    if (
      !this.config.outbox.workerEnabled ||
      this.closing ||
      this.activeFirstAttempts >= MAX_FIRST_ATTEMPTS
    ) {
      return; // the worker picks it up at its next round
    }

    this.activeFirstAttempts++;

    const timer: any = setTimeout(() => {
      this.firstAttemptTimers.delete(timer);

      this.track(
        this.processById(id)
          .catch((error: any) => this.logger.error(`Outbox #${id}: ${describeError(error)}`))
          .finally(() => {
            this.activeFirstAttempts--;
          }),
      );
    }, 0);

    timer.unref?.();
    this.firstAttemptTimers.add(timer);
  }

  // ==========================================================
  // Worker
  // ==========================================================

  /**
   * One worker round. Each channel has its own round, so an SMS gateway that
   * takes 10 seconds per message cannot hold back e-mail or push, and a round
   * keeps going while batches come back full (a burst is cleared at once).
   */
  private async tick() {
    if (this.closing) return;

    const jobs: Promise<unknown>[] = [this.doHousekeeping()];

    for (const channel of CHANNELS) {
      if (this.busy.has(channel)) continue;

      this.busy.add(channel);

      jobs.push(this.drain(channel).finally(() => this.busy.delete(channel)));
    }

    await Promise.all(jobs); // none of them rejects
  }

  private async drain(channel: OutboxChannel) {
    try {
      for (let round = 0; round < MAX_ROUNDS && !this.closing; round++) {
        const handled = await this.processDue(undefined, channel);

        if (handled < this.config.outbox.batchSize) break;
      }
    } catch (error: any) {
      this.logger.error(`Outbox worker (${channel}): ${describeError(error)}`);
    }
  }

  private async doHousekeeping() {
    if (this.housekeeping) return;

    this.housekeeping = true;

    try {
      await this.flushUnrecorded();

      if (!this.closing && Date.now() - this.lastPurge > 3_600_000) {
        this.lastPurge = Date.now();
        await this.purge();
      }
    } catch (error: any) {
      this.logger.error(`Outbox housekeeping: ${describeError(error)}`);
    } finally {
      this.housekeeping = false;
    }
  }

  /**
   * Sends what is due. Returns how many messages it handled.
   *
   * One slow channel (an SMS gateway that takes its time) must not hold back
   * the others, so each channel works through its own messages in turn while
   * the channels run side by side. `now` is for tests; without it every message
   * is stamped with the real time at which it is handled. `only` limits the
   * round to one channel (what the worker does).
   */
  async processDue(now?: Date, only?: OutboxChannel): Promise<number> {
    const clock = () => now ?? new Date();
    const start = clock();

    const due = await this.prisma.notificationOutbox.findMany({
      where: {
        ...(only ? { channel: only } : {}),
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: start } },
          { status: 'SENDING', lockedAt: { lt: new Date(start.getTime() - STALE_LOCK_MS) } },
        ],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: this.config.outbox.batchSize,
    });

    const byChannel = new Map<string, any[]>();

    for (const row of due) {
      const list = byChannel.get(row.channel);

      if (list) {
        list.push(row);
      } else {
        byChannel.set(row.channel, [row]);
      }
    }

    // allSettled: when one channel hits a database error the others still run to
    // the end (and a shutdown waiting for this round waits for all of them).
    const settled = await Promise.allSettled(
      [...byChannel.values()].map(async (rows) => {
        let handled = 0;

        for (const row of rows) {
          if (this.closing) break;

          // Already sent; only the bookkeeping is late. Never send it a second time.
          if (this.unrecorded.has(row.id)) continue;

          const at = clock();

          if (await this.claim(row, at)) {
            await this.process(row, at);
            handled++;
          }
        }

        return handled;
      }),
    );

    const failed = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;

    if (failed) {
      throw failed.reason;
    }

    return settled.reduce((sum, result) => sum + ((result as PromiseFulfilledResult<number>).value ?? 0), 0);
  }

  async processById(id: number): Promise<boolean> {
    const row = await this.prisma.notificationOutbox.findUnique({ where: { id } });

    if (!row || row.status !== 'PENDING' || row.nextAttemptAt > new Date()) {
      return false;
    }

    const now = new Date();

    if (!(await this.claim(row, now))) {
      return false;
    }

    await this.process(row, now);

    return true;
  }

  /**
   * Compare-and-set: the row is only taken if nobody changed it since it was
   * read, so two workers (or a worker and the first attempt) never both send it.
   */
  private async claim(row: any, now: Date): Promise<boolean> {
    const result = await this.prisma.notificationOutbox.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: 'SENDING', lockedAt: now },
    });

    return result.count === 1;
  }

  private async process(row: any, now: Date) {
    const attempt = row.attempts + 1;

    // A code or link that has expired, or that a newer one has replaced while
    // this one was waiting or being retried, is worth nothing: drop it (and its text).
    const stale = await this.staleReason(row, now);

    if (stale) {
      await this.record(row, row.attempts, 'SKIPPED', now, { note: stale });

      this.logger.log(`Outbox #${row.id} ${row.channel}: skipped (${stale})`);

      return;
    }

    let outcome: Outcome;

    try {
      outcome = await this.deliver(row);
    } catch (error: any) {
      await this.fail(row, attempt, error, now);

      return;
    }

    // The message has left. From here on nothing may send it again, whatever
    // happens to the bookkeeping.
    await this.record(row, attempt, outcome.status, now, {
      provider: outcome.provider,
      providerMessageId: outcome.providerMessageId,
      note: outcome.note,
    });

    this.logger.log(
      `Outbox #${row.id} ${row.channel}: ${outcome.status.toLowerCase()} via ${outcome.provider}` +
        `${outcome.note ? ` (${outcome.note})` : ''}`,
    );
  }

  /** Why a message should not be sent at `at` any more, or null. */
  private async staleReason(row: any, at: Date): Promise<string | null> {
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= at.getTime()) {
      return EXPIRED;
    }

    if (row.supersedeKey) {
      const newer = await this.prisma.notificationOutbox.findFirst({
        where: { supersedeKey: row.supersedeKey, id: { gt: row.id } },
        select: { id: true },
      });

      if (newer) return SUPERSEDED;
    }

    return null;
  }

  /** The provider refused or could not be reached: try again later, or give up. */
  private async fail(row: any, attempt: number, error: any, now: Date) {
    const retryable = error instanceof DeliveryError ? error.retryable : true;
    // Only our own wording is kept: a provider's or a library's error text can repeat the address or the code.
    const reason = error instanceof DeliveryError ? error.message : `unexpected error (${describeError(error)})`;

    if (retryable && attempt < row.maxAttempts) {
      const nextAttemptAt = new Date(now.getTime() + backoffMs(attempt));

      // No point waiting for a try that would be too late, or for a message that
      // was replaced while it was being sent: finish it now so its text goes too.
      const stale = await this.staleReason(row, nextAttemptAt);

      if (stale) {
        await this.record(row, attempt, 'SKIPPED', now, { note: stale });

        this.logger.log(`Outbox #${row.id} ${row.channel}: skipped (${stale})`);

        return;
      }

      await this.prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: 'PENDING',
          attempts: attempt,
          lockedAt: null,
          nextAttemptAt,
          lastError: reason,
        },
      });

      this.logger.warn(
        `Outbox #${row.id} ${row.channel}: attempt ${attempt}/${row.maxAttempts} failed, will retry (${reason})`,
      );

      return;
    }

    await this.record(row, attempt, 'FAILED', now, { error: reason });

    this.logger.error(`Outbox #${row.id} ${row.channel}: given up after ${attempt} attempt(s) (${reason})`);
  }

  /**
   * Writes the result down. A message that has been sent is never sent again
   * because writing failed: the write is retried now and, if it still fails,
   * on every worker round until it works. (If the whole process dies in
   * between, the row is picked up as stale and sent once more: delivery is
   * "at least once".)
   */
  private async record(
    row: any,
    attempt: number,
    status: 'SENT' | 'SKIPPED' | 'FAILED',
    now: Date,
    result: { provider?: string; providerMessageId?: string; note?: string; error?: string },
  ) {
    let lastError: any;

    for (let round = 0; round < 3; round++) {
      try {
        await this.finish(row, attempt, status, now, result);

        return;
      } catch (error: any) {
        lastError = error;

        if (round < 2 && this.recordRetryMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.recordRetryMs * (round + 1)));
        }
      }
    }

    this.unrecorded.set(row.id, { row, attempt, status, now, result });

    this.logger.error(
      `Outbox #${row.id}: the message was handled (${status.toLowerCase()}) but the result could not be recorded ` +
        `(${describeError(lastError)}); it will not be sent again and recording is retried`,
    );
  }

  private async flushUnrecorded() {
    for (const [id, entry] of [...this.unrecorded]) {
      try {
        await this.finish(entry.row, entry.attempt, entry.status, entry.now, entry.result);
        this.unrecorded.delete(id);
      } catch {
        // Still down; the next round tries again.
      }
    }
  }

  private async deliver(row: any): Promise<Outcome> {
    if (row.channel === 'EMAIL') {
      return this.deliverEmail(row);
    }

    if (row.channel === 'SMS') {
      return this.deliverSms(row);
    }

    if (row.channel === 'PUSH') {
      return this.deliverPush(row);
    }

    throw new DeliveryError(`unknown channel ${row.channel}`, false);
  }

  private async deliverEmail(row: any): Promise<Outcome> {
    const provider = this.providers.email;

    if (!provider.isConfigured()) {
      this.debugShow(row, row.recipient);
      throw new DeliveryError('e-mail provider not configured (SMTP_HOST)', false);
    }

    if (!row.recipient) {
      throw new DeliveryError('no e-mail address', false);
    }

    // Placeholder addresses (guests): the mail could only bounce off the relay.
    if (!isDeliverableEmail(row.recipient)) {
      return { status: 'SKIPPED', provider: provider.name, note: 'this address cannot receive e-mail' };
    }

    const sent = await provider.send({
      to: row.recipient,
      subject: row.subject ?? '',
      text: row.body,
    });

    return { status: 'SENT', provider: provider.name, providerMessageId: sent.providerMessageId };
  }

  private async deliverSms(row: any): Promise<Outcome> {
    const provider = this.providers.sms;
    const to = row.recipient ? toE164(row.recipient, this.config.defaultCountryCode) : null;

    if (!provider.isConfigured()) {
      this.debugShow(row, row.recipient);
      throw new DeliveryError('SMS provider not configured (SMS_PROVIDER)', false);
    }

    if (!to) {
      throw new DeliveryError('not a valid phone number', false);
    }

    const sent = await provider.send(to, row.body);

    return { status: 'SENT', provider: provider.name, providerMessageId: sent.providerMessageId };
  }

  private async deliverPush(row: any): Promise<Outcome> {
    const provider = this.providers.push;

    if (!provider.isConfigured()) {
      throw new DeliveryError('push provider not configured (PUSH_PROVIDER)', false);
    }

    const tokens = row.userId
      ? await this.prisma.pushDeviceToken.findMany({
          where: { userId: row.userId, isActive: true },
          select: { token: true },
        })
      : [];

    if (!tokens.length) {
      return { status: 'SKIPPED', provider: provider.name, note: 'no active device' };
    }

    const results = await provider.send(
      tokens.map((entry: { token: string }) => entry.token),
      { title: row.subject ?? '', body: row.body, data: row.data ?? undefined },
    );

    const gone = results.filter((result) => result.gone).map((result) => result.token);

    if (gone.length) {
      // The push has already left: a database hiccup here must not make the
      // retry send it a second time to the devices that got it.
      try {
        await this.prisma.pushDeviceToken.updateMany({
          where: { token: { in: gone } },
          data: { isActive: false },
        });
      } catch (error: any) {
        this.logger.warn(`Outbox #${row.id}: unregistered devices were not switched off (${describeError(error)})`);
      }
    }

    const delivered = results.find((result) => result.ok);

    if (delivered) {
      return { status: 'SENT', provider: provider.name, providerMessageId: delivered.ticketId };
    }

    if (results.every((result) => result.gone)) {
      return { status: 'SKIPPED', provider: provider.name, note: 'every device had unregistered' };
    }

    throw new DeliveryError(
      `push not delivered (${[...new Set(results.map((result) => result.error))].join(', ')})`,
      results.some((result) => result.retryable),
    );
  }

  /** Row is done, one way or the other: record the result, empty the body, tell the delivery log. */
  private async finish(
    row: any,
    attempt: number,
    status: 'SENT' | 'SKIPPED' | 'FAILED',
    now: Date,
    result: { provider?: string; providerMessageId?: string; note?: string; error?: string },
  ) {
    const lastError = result.error ?? result.note ?? null;

    await this.prisma.notificationOutbox.update({
      where: { id: row.id },
      data: {
        status,
        attempts: attempt,
        lockedAt: null,
        sentAt: status === 'SENT' ? now : undefined,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        lastError,
        // One-time codes and links: gone as soon as there is nothing left to send.
        body: '',
        subject: null,
      },
    });

    if (row.deliveryLogId) {
      try {
        await this.prisma.notificationDeliveryLog.update({
          where: { id: row.deliveryLogId },
          data: {
            status,
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            error: lastError ?? undefined,
            sentAt: status === 'SENT' ? now : undefined,
          },
        });
      } catch (error: any) {
        this.logger.warn(`Outbox #${row.id}: delivery log not updated (${describeError(error)})`);
      }
    }
  }

  /** Deletes finished rows older than KEEP_FINISHED_DAYS. */
  async purge(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.notificationOutbox.deleteMany({
      where: {
        status: { in: ['SENT', 'FAILED', 'SKIPPED'] },
        createdAt: { lt: new Date(now.getTime() - KEEP_FINISHED_DAYS * 86_400_000) },
      },
    });

    return result.count;
  }

  // ==========================================================
  // Log hygiene
  // ==========================================================

  private warnNotConfigured(channel: string) {
    if (this.warned.has(channel)) return;

    this.warned.add(channel);

    const what =
      channel === 'EMAIL'
        ? 'E-mail is not configured (SMTP_HOST is empty): verification and password links are not sent.'
        : 'SMS is not configured (SMS_PROVIDER is empty): verification codes are not sent.';

    this.logger.warn(what);
  }

  /**
   * Message bodies carry one-time codes and links, so the log never shows them,
   * with one exception for a developer without a provider: DELIVERY_DEBUG_LOG=true
   * (ignored in production) prints the message so the flow can be tried.
   */
  private debugShow(row: any, recipient?: string | null) {
    if (!this.config.debugLogBodies) return;

    this.logger.log(
      `[DELIVERY_DEBUG_LOG] ${row.channel} to ${recipient ?? '?'} | ${row.subject ? `${row.subject} | ` : ''}${row.body}`,
    );
  }
}

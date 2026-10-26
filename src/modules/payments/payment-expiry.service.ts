import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PaymentGatewayService } from './gateway/payment-gateway.service';
import { PaymentsService } from './payments.service';
import { describeError } from '../notifications/delivery/delivery-error';

/**
 * The timer of the card payments (P2-10): every minute, the payments that wait at the provider are asked about when nobody has, and
 * the ones whose time is over are closed (`PaymentsService.sweepOnline`). It does nothing without a provider, in a process started
 * with PAYMENT_EXPIRY_WORKER=off, and in a test. Two processes running it do no harm: every step is a conditional write under the lock of the job.
 */
/** How often the old calls of the provider are looked for. */
const PURGE_EVERY_MS = 60 * 60_000;

@Injectable()
export class PaymentExpiryService {
  private readonly logger = new Logger(PaymentExpiryService.name);
  private running = false;
  private lastPurge = 0;

  constructor(
    private readonly payments: PaymentsService,
    private readonly gateway: PaymentGatewayService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running || !this.gateway.config.expiry.workerEnabled) return;

    // A round that is still running (a slow provider) is not started a second time.
    this.running = true;

    try {
      // Once an hour, the calls of the provider that are older than three months are forgotten (also when the provider was switched
      // off since: its calls stay in the table).
      if (Date.now() - this.lastPurge >= PURGE_EVERY_MS) {
        this.lastPurge = Date.now();

        // A purge that fails is written down and is not tried again before the hour is over; the round below goes on.
        try {
          const goneCount = await this.payments.purgeWebhookLog();

          if (goneCount > 0) this.logger.log(`Card payments: ${goneCount} old calls of the provider forgotten.`);
        } catch (error) {
          this.logger.error(`The old calls of the provider could not be forgotten (${describeError(error)}).`);
        }
      }

      if (!this.gateway.connected()) return;

      const done = await this.payments.sweepOnline();
      const { confirmed: confirmedCount, expired: closedCount, dropped: droppedCount, looked: lookedCount, unreachable: unreachedCount } = done;

      if (confirmedCount + closedCount + droppedCount > 0) {
        this.logger.log(`Card payments: ${confirmedCount} confirmed, ${closedCount} closed, ${droppedCount} dropped (${lookedCount} looked at, ${unreachedCount} not reached).`);
      }
    } catch (error) {
      this.logger.error(`The round of the card payments failed (${describeError(error)}).`);
    } finally {
      this.running = false;
    }
  }
}

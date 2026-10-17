import { Injectable, Logger } from '@nestjs/common';

import { adminAlertPhone } from '../../config/delivery';
import { RATE_RULES, RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { describeError } from '../notifications/delivery/delivery-error';
import { InterventionsGateway } from './interventions.gateway';

/** A request that was just made, whoever made it (a signed-in client or a visitor with no account). */
export type NewRequest = {
  id: number;
  serviceType: string;
  address?: string | null;
  [column: string]: unknown;
};

const SMS_ADDRESS_LENGTH = 80;
const ISSUE_EXCERPT_LENGTH = 200;

/**
 * Tells the back office about what customers do on their own (P1-04).
 *
 * Every way of making a request ends here, so a new route cannot forget to alert
 * anybody: the guest request had no alert at all, and the signed-in client route
 * had none either. A request that is created is a request somebody must see, so
 * the admin dashboard that is open gets it at once (socket event
 * `newIntervention`), the staff get their own notification, and the person in
 * charge gets a text when ADMIN_ALERT_PHONE is set.
 *
 * Nothing here can fail the caller: the request already exists, and an alert that
 * did not leave is a log line, not an error shown to a customer.
 */
@Injectable()
export class StaffAlertsService {
  private readonly logger = new Logger(StaffAlertsService.name);

  constructor(
    private readonly gateway: InterventionsGateway,
    private readonly notifications: NotificationsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** A new request exists. Never throws. */
  async newRequest(request: NewRequest): Promise<void> {
    // 1. The dashboards that are open right now.
    // The hash of the tracking token is the key to the customer's page: no socket needs it.
    await this.attempt('live event', async () => {
      const { trackingToken: _hash, ...row } = request;

      this.gateway.sendNewIntervention(row);
    });

    // 2. Each staff member's own notification (in the app, and live).
    await this.attempt('staff notification', () =>
      this.notifications.notifyNewInterventionCreated(request.id),
    );

    // 3. The text to the person in charge, only when ADMIN_ALERT_PHONE is set.
    // (A number written in the code used to receive this for every request.)
    await this.attempt('alert SMS', async () => {
      const alertPhone = adminAlertPhone();

      // At most 20 an hour for the whole server: a loop of requests must not turn into a loop of paid SMS.
      if (!alertPhone || !this.rateLimit.tryConsume('admin-alert-sms', RATE_RULES.adminAlertSms)) {
        return;
      }

      await this.notifications.sendSms(
        alertPhone,
        `Alerte: Nouvelle demande (${request.serviceType}) à ${shorten(request.address, SMS_ADDRESS_LENGTH)}`,
      );
    });
  }

  /**
   * A customer reported a problem from the tracking link and a complaint was
   * opened. The complaint itself already reached the support staff's
   * notifications; this is the live event the dashboard shows. Never throws.
   */
  async problemReported(report: { interventionId: number; complaintId: number; issue: string }): Promise<void> {
    await this.attempt('live problem event', async () => {
      this.gateway.sendInterventionIssue({
        interventionId: report.interventionId,
        complaintId: report.complaintId,
        issue: shorten(report.issue, ISSUE_EXCERPT_LENGTH),
      });
    });
  }

  private async attempt(what: string, work: () => unknown): Promise<void> {
    try {
      await work();
    } catch (error: any) {
      // Kind of error only: the work carries a customer's address and phone number.
      this.logger.error(`Staff alert (${what}) failed (${describeError(error)})`);
    }
  }
}

function shorten(text: string | null | undefined, max: number): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();

  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

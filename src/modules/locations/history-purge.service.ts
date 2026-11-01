import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { readLocationConfig } from '../../common/geo/location-rules';
import { getBusinessTimeZone } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { describeError } from '../notifications/delivery/delivery-error';

import { purgeLocationHistory, purgeSlot } from './history-purge';

/**
 * The daily round that deletes the old positions (P3-05), from 03:30 in the business time zone (Africa/Tunis unless BUSINESS_TIMEZONE or the
 * company settings say otherwise), whatever the time zone of the machine. It is asked every fifteen minutes and runs at the first ask inside
 * the window 03:30 to 05:59 there, once a day: a server that was restarting at 03:30, or a database that was away, does not lose the day,
 * because the next ask tries again. The zone is read when it is asked, not when the server starts, because the company settings are read
 * after the classes are defined. The local date is marked done only when the round succeeded; a round that fails is written down and tried
 * again at the next ask of the window (a delete of rows that are gone deletes nothing, so a second try, or two processes, do no harm).
 */
@Injectable()
export class LocationHistoryPurgeService {
  private readonly logger = new Logger(LocationHistoryPurgeService.name);
  private running = false;
  /** The local date of the last round that succeeded, so that a later ask the same day does not delete again. */
  private lastDay: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * What the scheduler calls. It takes no argument and passes the time itself: the scheduler hands its callback an argument of its own
   * (the cron library's `onComplete`), which must never be taken for a date.
   */
  @Cron('*/15 * * * *')
  async run(): Promise<void> {
    await this.tick(new Date());
  }

  async tick(now: Date): Promise<void> {
    const slot = purgeSlot(now, getBusinessTimeZone());

    if (!slot.due || slot.day === this.lastDay || this.running) return;

    this.running = true;

    try {
      const { historyDays } = readLocationConfig();
      const { deleted, heldJobs, cutShort } = await purgeLocationHistory(this.prisma, historyDays);

      this.lastDay = slot.day;

      if (cutShort) {
        this.logger.warn(`The round stopped at its limit with positions left to delete (${deleted} deleted); the rest goes tomorrow.`);
      }

      if (deleted > 0) {
        this.logger.log(`Positions of the technicians: ${deleted} older than ${historyDays} days deleted (${heldJobs} jobs with a complaint or a dispute are left out: their positions are kept).`);
      }
    } catch (error) {
      this.logger.error(`The old positions could not be deleted (${describeError(error)}); the next ask of the window tries again.`);
    } finally {
      this.running = false;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../../common/time/clock';
import type { Env } from '../../config/env.validation';
import {
  EVENT_REMINDER_SLUG,
  POST_EVENT_THANKYOU_SLUG,
} from '../../db/schema/messaging';
import {
  myEventsUrlFor,
  reminderBody,
  reminderSubject,
} from './reminder-notice';
import {
  ScheduledMessagesRepository,
  type DueEvent,
} from './scheduled-messages.repository';
import { ScheduledSender } from './scheduled-sender';
import {
  surveyUrlFor,
  thankYouBody,
  thankYouSubject,
} from './thank-you-notice';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The messages this service sends on a schedule rather than in reply to an
 * event: the reminder a day BEFORE (US-MSG-01) and the thank-you with the
 * survey link a day AFTER (US-MSG-08).
 *
 * Each sweep decides only who is due and what the message says. The sending —
 * claim, languages, the organizer's wording, the ledger, completion — is
 * `ScheduledSender`'s, and identical for both.
 *
 * Both need `PUBLIC_WEB_URL`: every one of these messages carries a link, and a
 * root-relative link is dead in a mail client. Without it the sweeps do
 * nothing and say why once, rather than sending messages whose links go
 * nowhere.
 *
 * Like the order-expiry sweep, nothing here decides WHEN it runs — that is the
 * cron next door — so an operator can call either by hand.
 */
@Injectable()
export class ScheduledMessagesService {
  private readonly logger = new Logger(ScheduledMessagesService.name);
  private readonly publicWebUrl: string | undefined;
  private readonly reminderLeadMs: number;
  private readonly thankYouDelayMs: number;
  private readonly thankYouWindowMs: number;
  private readonly batch: number;
  private warnedUnconfigured = false;

  constructor(
    private readonly runs: ScheduledMessagesRepository,
    private readonly sender: ScheduledSender,
    config: ConfigService<Env, true>,
    private readonly clock: Clock,
  ) {
    this.publicWebUrl = config.get('PUBLIC_WEB_URL', { infer: true });
    this.reminderLeadMs =
      config.get('EVENT_REMINDER_LEAD_HOURS', { infer: true }) * HOUR_MS;
    this.thankYouDelayMs =
      config.get('FEEDBACK_REQUEST_DELAY_HOURS', { infer: true }) * HOUR_MS;
    this.thankYouWindowMs =
      config.get('FEEDBACK_REQUEST_WINDOW_DAYS', { infer: true }) * DAY_MS;
    this.batch = config.get('FEEDBACK_REQUEST_BATCH', { infer: true });
  }

  /** Remind one batch of events' attendees. Returns how many events. */
  async sendReminders(): Promise<number> {
    const base = this.baseUrl();
    if (!base) return 0;
    const now = this.clock.now();
    const due = await this.runs.remindersDue({
      now,
      leadMs: this.reminderLeadMs,
      limit: this.batch,
    });
    const myEventsUrl = myEventsUrlFor(base);

    let reminded = 0;
    for (const event of due) {
      const sent = await this.sender.send(
        event,
        EVENT_REMINDER_SLUG,
        now,
        {
          event_name: event.eventName,
          event_venue: whereOf(event) ?? '',
        },
        ({ name, locale, wording }) => {
          const notice = {
            attendeeName: name,
            eventName: event.eventName,
            startAt: event.startAt,
            timezone: event.timezone,
            where: whereOf(event),
            myEventsUrl,
            locale,
            ...wording,
          };
          return {
            subject: reminderSubject(notice),
            text: reminderBody(notice),
          };
        },
      );
      if (sent) reminded += 1;
    }
    return reminded;
  }

  /** Thank one batch of events' attendees. Returns how many events. */
  async sendThankYous(): Promise<number> {
    const base = this.baseUrl();
    if (!base) return 0;
    const now = this.clock.now();
    const due = await this.runs.thankYousDue({
      now,
      delayMs: this.thankYouDelayMs,
      windowMs: this.thankYouWindowMs,
      limit: this.batch,
    });

    let thanked = 0;
    for (const event of due) {
      const surveyUrl = surveyUrlFor(base, event.eventId);
      const sent = await this.sender.send(
        event,
        POST_EVENT_THANKYOU_SLUG,
        now,
        { event_name: event.eventName, survey_url: surveyUrl },
        ({ name, locale, wording }) => {
          const notice = {
            attendeeName: name,
            eventName: event.eventName,
            surveyUrl,
            locale,
            ...wording,
          };
          return {
            subject: thankYouSubject(notice),
            text: thankYouBody(notice),
          };
        },
      );
      if (sent) thanked += 1;
    }
    return thanked;
  }

  private baseUrl(): string | undefined {
    if (!this.publicWebUrl) this.warnUnconfigured();
    return this.publicWebUrl;
  }

  /** Said once, not every hour: the setting is missing, not the run broken. */
  private warnUnconfigured(): void {
    if (this.warnedUnconfigured) return;
    this.warnedUnconfigured = true;
    this.logger.warn(
      'PUBLIC_WEB_URL is not set — event reminders and post-event thank-yous are OFF, because every one of them carries a link and a link with no address is dead in a mail client.',
    );
  }
}

/**
 * Where the event happens, or null when there is genuinely nothing to say — in
 * which case the reminder omits the line rather than printing "Where: ".
 */
function whereOf(event: DueEvent): string | null {
  if (event.isOnline) return event.onlineNote;
  return [event.venueName, event.city].filter(Boolean).join(', ') || null;
}

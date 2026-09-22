import { Injectable, Logger } from '@nestjs/common';
import { SmsProvider, type SmsMessage } from './sms.provider';

/**
 * Dev SMS provider: records that a text was sent, instead of sending it.
 *
 * Enabled, so a dev box exercises the whole path — the number is normalised,
 * the channel switch is read, the delivery row is written — without an account,
 * a cost, or any way to text a real attendee by accident.
 *
 * It logs NEITHER the number NOR the body, and not at debug either. A number is
 * PII, a confirmation text carries a booking reference and a ticket link, and
 * LOG_LEVEL is `debug` in the shipped .env, so "only at debug" would hide
 * nothing. The character count is logged instead: it is the one thing a dev
 * actually wants — it says whether the text crossed into a second segment.
 */
@Injectable()
export class LogSmsProvider extends SmsProvider {
  readonly enabled = true;
  private readonly logger = new Logger('SmsProvider');

  send(message: SmsMessage): Promise<void> {
    this.logger.log(
      { characters: message.text.length },
      'SMS sent (dev provider)',
    );
    return Promise.resolve();
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { SmsProvider } from './sms.provider';

/**
 * No SMS at all: nothing is sent, and nothing is recorded.
 *
 * This is what a production deployment gets until somebody configures a
 * provider, and it is the honest answer for one. `log` would be worse there
 * than useless — it would write "sent" rows for texts that never left, and
 * US-MSG-06 is explicit that the log never claims a delivery the provider has
 * not reported. So the delivery log stays empty of texts rather than filling
 * with fiction.
 *
 * `enabled: false` is the part that matters: callers ask first and skip the
 * work. `send` resolves anyway, so a caller that forgets gets a no-op rather
 * than a dead-lettered registration.
 */
@Injectable()
export class OffSmsProvider extends SmsProvider {
  readonly enabled = false;
  private readonly logger = new Logger('SmsProvider');

  /** The message is deliberately not read: nothing about it is used or kept. */
  send(): Promise<void> {
    this.logger.debug('SMS is not configured — nothing was sent');
    return Promise.resolve();
  }
}

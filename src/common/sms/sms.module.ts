import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { MessageDeliveriesRepository } from '../messaging/message-deliveries.repository';
import { MessagingModule } from '../messaging/messaging.module';
import { SystemClock } from '../time/clock';
import { LogSmsProvider } from './log-sms.provider';
import { OffSmsProvider } from './off-sms.provider';
import { RecordingSmsProvider } from './recording-sms.provider';
import { resolveSmsTransport } from './sms-transport';
import { SmsProvider } from './sms.provider';
import { TwilioSmsProvider } from './twilio-sms.provider';

/** Builds one transport from config. Anything satisfying the port qualifies. */
type TransportFactory = (config: ConfigService<Env, true>) => SmsProvider;

/**
 * The transports that actually SEND, keyed by the resolved provider name.
 *
 * A lookup table rather than a branch, as `EmailModule` has: a domestic Thai
 * gateway becomes one entry here plus one value on the zod enum, and no
 * existing line changes. `off` is deliberately absent — it is not a transport
 * that sends, and building it below skips the recorder entirely.
 */
const TRANSPORTS: Record<'log' | 'twilio', TransportFactory> = {
  log: () => new LogSmsProvider(),
  twilio: (config) => new TwilioSmsProvider(config),
};

/**
 * Provides the SmsProvider port app-wide (US-DISC-06).
 *
 * Whatever sends is WRAPPED in RecordingSmsProvider, so the delivery log
 * (US-MSG-06) is written from one place — the same reasoning as email, where
 * "remember to log it" proved to be a rule nobody could enforce.
 *
 * `off` is the exception: it is returned UNWRAPPED, because there is nothing
 * to record. A recorder around it would be harmless today and wrong the moment
 * anybody made `off` log a row — the log would then claim deliveries that
 * never happened.
 *
 * NOTHING HAS BEEN SENT THROUGH A REAL PROVIDER. The Twilio adapter is proven
 * against a stubbed fetch only; its first use with real credentials is
 * untested.
 */
@Global()
@Module({
  imports: [MessagingModule],
  providers: [
    {
      provide: SmsProvider,
      useFactory: (
        config: ConfigService<Env, true>,
        deliveries: MessageDeliveriesRepository,
      ) => {
        const name = resolveSmsTransport({
          SMS_PROVIDER: config.get('SMS_PROVIDER', { infer: true }),
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
        });
        if (name === 'off') return new OffSmsProvider();
        return new RecordingSmsProvider(
          TRANSPORTS[name](config),
          deliveries,
          new SystemClock(),
        );
      },
      inject: [ConfigService, MessageDeliveriesRepository],
    },
  ],
  exports: [SmsProvider],
})
export class SmsModule {}

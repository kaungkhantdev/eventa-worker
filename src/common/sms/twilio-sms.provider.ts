import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { SmsDeliveryError, SmsProvider, type SmsMessage } from './sms.provider';

/** Twilio's REST base. Versioned by Twilio, so the date is part of the path. */
const MESSAGES_URL = (accountSid: string): string =>
  `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

/**
 * How long one send may hold a consumer open. Short on purpose: a confirmation
 * text is a courtesy that follows an email already delivered, and a provider
 * that has not answered in ten seconds is one to retry, not to wait for.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** HTTP statuses worth another attempt: the server's fault, or its rate limit. */
const RETRYABLE_STATUS = (status: number): boolean =>
  status >= 500 || status === 429;

/**
 * Just enough of `fetch` to send one form and read one JSON body. Injected so
 * the spec needs no network, and typed here rather than reaching for the DOM
 * lib — the worker compiles without it.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** What Twilio answers with when it refuses — the two fields safe to repeat. */
interface TwilioError {
  code?: number;
}

/**
 * Real delivery through Twilio's REST API.
 *
 * Plain `fetch` and no SDK: this is one form POST, and a vendor SDK would add a
 * dependency, its own retry policy and its own logging to a path where all
 * three are already decided here.
 *
 * NOTHING THIS CLASS THROWS OR LOGS CONTAINS THE NUMBER OR THE TEXT. Twilio's
 * own error message quotes the `To` number back — "The 'To' number +66… is not
 * a valid phone number" — and the consumer logs the error while the recorder
 * writes its message into the delivery log, so copying that string through
 * would publish a phone number in two places. Only the HTTP status and Twilio's
 * numeric code travel; both are enough to look the failure up in Twilio's own
 * console, which has the rest.
 *
 * UNPROVEN AGAINST A REAL ACCOUNT. There is no Twilio account for this product
 * yet; every test here runs against a stubbed fetch, so the shape of the
 * request is verified and the behaviour of the live API is not.
 */
@Injectable()
export class TwilioSmsProvider extends SmsProvider {
  readonly enabled = true;
  private readonly logger = new Logger('SmsProvider');
  private readonly url: string;
  private readonly authorization: string;
  private readonly from: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {
    super();
    const sid = config.getOrThrow('TWILIO_ACCOUNT_SID', { infer: true });
    const token = config.getOrThrow('TWILIO_AUTH_TOKEN', { infer: true });
    this.url = MESSAGES_URL(sid);
    this.authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
    this.from = config.getOrThrow('TWILIO_FROM', { infer: true });
  }

  async send(message: SmsMessage): Promise<void> {
    const response = await this.post(message);
    if (!response.ok) throw await this.refusal(response);

    const body = (await response.json()) as { sid?: string };
    // The provider's own id, which is what a failed text is traced by. The
    // number and the body stay out of the log entirely.
    this.logger.log({ sid: body.sid }, 'SMS sent');
  }

  private async post(
    message: SmsMessage,
  ): Promise<Pick<Response, 'ok' | 'status' | 'json'>> {
    try {
      return await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: message.to,
          From: this.from,
          Body: message.text,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // A timeout or a refused connection says nothing about the message, so
      // it is always worth another attempt.
      throw new SmsDeliveryError('Could not reach the SMS provider', true, {
        cause,
      });
    }
  }

  /** Twilio's own code where it gave one — never its prose. */
  private async refusal(
    response: Pick<Response, 'status' | 'json'>,
  ): Promise<SmsDeliveryError> {
    const code = await this.codeOf(response);
    return new SmsDeliveryError(
      `SMS provider refused the message (HTTP ${response.status}${code ? `, Twilio ${code}` : ''})`,
      RETRYABLE_STATUS(response.status),
    );
  }

  private async codeOf(
    response: Pick<Response, 'json'>,
  ): Promise<number | undefined> {
    try {
      return ((await response.json()) as TwilioError).code;
    } catch {
      // A refusal with an unreadable body is still a refusal; the status alone
      // carries the decision.
      return undefined;
    }
  }
}

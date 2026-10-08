import type { ZodType } from 'zod';

/** Context extracted from a consumed message. */
export interface MessageContext {
  routingKey: string;
  messageId?: string;
  correlationId?: string;
}

/** A consumer for one routing key. Implemented via ValidatedHandler. */
export interface MessageHandler {
  readonly routingKey: string;
  handle(raw: unknown, ctx: MessageContext): Promise<void>;
}

/**
 * Base handler: validates the raw message against a zod schema (tolerant reader —
 * unknown fields are stripped, not rejected) before running the business step.
 */
export abstract class ValidatedHandler<T> implements MessageHandler {
  abstract readonly routingKey: string;
  protected abstract readonly schema: ZodType<T>;

  async handle(raw: unknown, ctx: MessageContext): Promise<void> {
    const payload = this.schema.parse(raw);
    await this.process(payload, ctx);
  }

  protected abstract process(payload: T, ctx: MessageContext): Promise<void>;
}

/** Structural guard used to discover handlers among app providers. */
export function isMessageHandler(value: unknown): value is MessageHandler {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MessageHandler).routingKey === 'string' &&
    typeof (value as { handle?: unknown }).handle === 'function'
  );
}

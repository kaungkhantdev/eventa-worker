import { Injectable, Logger } from '@nestjs/common';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { AuditRepository } from './audit.repository';
import {
  IDENTITY_SIGNED_IN,
  signedInSchema,
  type SignedInEvent,
} from './signed-in.schema';

/**
 * Handles `identity.signed_in`: writes the sign-in to the audit trail — the side
 * effect eventa-api used to do inline on the login request path.
 */
@Injectable()
export class SignedInHandler extends ValidatedHandler<SignedInEvent> {
  readonly routingKey = IDENTITY_SIGNED_IN;
  protected readonly schema = signedInSchema;
  private readonly logger = new Logger(SignedInHandler.name);

  constructor(private readonly audit: AuditRepository) {
    super();
  }

  protected async process(
    payload: SignedInEvent,
    ctx: MessageContext,
  ): Promise<void> {
    await this.audit.recordSignIn({
      organizationId: payload.organizationId,
      userId: payload.userId,
      device: payload.device,
      ip: payload.ip ?? null,
      occurredAt: new Date(payload.occurredAt),
    });
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId },
      'Recorded sign-in audit',
    );
  }
}

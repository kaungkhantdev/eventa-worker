import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { auditEvents } from '../../db/schema';

export interface SignInAudit {
  organizationId: number;
  userId: string;
  device: string;
  ip: string | null;
  occurredAt: Date;
}

/** Writes the (append-only) audit trail. eventa-api owns the schema. */
@Injectable()
export class AuditRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async recordSignIn(input: SignInAudit): Promise<void> {
    await this.db.insert(auditEvents).values({
      organizationId: input.organizationId,
      type: 'signin',
      title: `Signed in from ${input.device}`,
      actorUserId: input.userId,
      ipAddress: input.ip,
      occurredAt: input.occurredAt,
    });
  }
}

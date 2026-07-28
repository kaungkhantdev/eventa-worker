import {
  bigint,
  customType,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

// MIRROR of eventa-api's `audit_type` enum + `audit_events` table. eventa-api
// OWNS the schema and migrations; this is only a typed view of the one table the
// worker writes to (append-only audit trail). Keep it in sync with entities.md.
export const auditTypeEnum = pgEnum('audit_type', [
  'signin',
  'newdev',
  'pwd',
  'twofa',
  'perm',
  'xport',
  'fail',
  'apikey',
  'revoke',
]);

export const auditEvents = pgTable('audit_events', {
  id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  type: auditTypeEnum().notNull(),
  title: text().notNull(),
  meta: text(),
  actorUserId: uuid(),
  ipAddress: inet(),
  occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

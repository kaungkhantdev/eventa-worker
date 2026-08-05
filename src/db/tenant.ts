import { sql } from 'drizzle-orm';
import type { Database } from './drizzle.constants';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Run `work` with the tenant GUC set, mirroring eventa-api's helper of the same
 * name. Every table this service reads is RLS-protected with
 * `organization_id = current_setting('app.current_org', true)::bigint`, and
 * `current_setting(..., true)` is NULL when unset — so an unscoped connection
 * reads ZERO ROWS rather than erroring. Forgetting this does not fail loudly;
 * it silently sends an email with no tickets in it.
 *
 * `set_config(..., true)` is SET LOCAL: transaction-scoped and auto-reset on
 * commit, so it is safe on a pooled connection.
 */
export async function withTenant<T>(
  db: Database,
  organizationId: number,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_org', ${String(organizationId)}, true)`,
    );
    return work(tx);
  });
}

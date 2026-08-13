import { sql } from 'drizzle-orm';
import type { Database } from './drizzle.constants';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Run `work` with the tenant GUC set, mirroring eventa-api's helper of the same
 * name. Every table this service reads is RLS-protected with
 * `organization_id = current_setting('app.current_org', true)::bigint`.
 *
 * **This is defence in depth, not the tenant boundary.** Postgres skips RLS for
 * superusers and table owners, and this service currently connects as the role
 * that owns the schema — so the policies do not apply to it today, and will
 * only start to once it moves to the non-owning `eventa_app` role that
 * eventa-api's `0002_enable_rls.sql` prescribes. Every query therefore carries
 * its own explicit `organization_id` predicate and must keep doing so; treating
 * this wrapper as the guard would leave the reads unscoped in practice.
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

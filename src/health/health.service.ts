import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/drizzle.constants';
import { RabbitConnection } from '../rabbitmq/rabbit.connection';

export type CheckStatus = 'up' | 'down';

export interface ReadinessResult {
  status: 'ok' | 'error';
  checks: Record<string, CheckStatus>;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly rabbit: RabbitConnection,
  ) {}

  async readiness(): Promise<ReadinessResult> {
    const checks: Record<string, CheckStatus> = {};

    try {
      await this.db.execute(sql`select 1`);
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }
    checks.rabbitmq = this.rabbit.isConnected ? 'up' : 'down';

    const ok = Object.values(checks).every((c) => c === 'up');
    return { status: ok ? 'ok' : 'error', checks };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import {
  events,
  orderItems,
  orders,
  organizations,
  PAID_PAYMENT_STATUS,
  paymentSettings,
  payments,
  ticketTypes,
} from '../../db/schema';
import { withTenant, type Tx } from '../../db/tenant';
import type { ReceiptLine, ReceiptSeller } from './payment-receipt';

/** eventa-api's column default; a row always has one, this is belt and braces. */
const DEFAULT_VAT_RATE = 0.07;

/** Everything a receipt prints, as the ledger recorded it. */
export interface ReceiptSource {
  number: string;
  buyerName: string;
  eventName: string;
  paidAt: Date;
  method: string;
  seller: ReceiptSeller;
  lines: ReceiptLine[];
  subtotalSatang: number;
  discountSatang: number;
  vatSatang: number;
  totalSatang: number;
  currency: string;
  vatRate: number;
}

/**
 * Read access for the payment receipt (US-SET-10). eventa-api owns these
 * tables. Every query carries its own `organization_id` predicate — `withTenant`
 * is defence in depth, not the boundary (see `db/tenant.ts`).
 */
@Injectable()
export class ReceiptsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The receipt for an order's settled payment, or null when there is nothing
   * to give a receipt for: no payment has gone through, or it was given back.
   *
   * When a second payment arrived for an already-paid order, the receipt is for
   * the FIRST — the one that settled it. The duplicate is refunded on its own
   * path and is not what the attendee bought their tickets with.
   */
  async loadReceipt(
    organizationId: number,
    orderId: string,
  ): Promise<ReceiptSource | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [head] = await this.head(tx, organizationId, orderId);
      if (!head?.paidAt) return null;
      return {
        number: head.number,
        buyerName: head.buyerName,
        eventName: head.eventName,
        paidAt: head.paidAt,
        method: head.method,
        seller: {
          name: head.sellerName,
          address: head.address,
          taxId: head.taxId,
        },
        lines: await this.lines(tx, organizationId, orderId),
        subtotalSatang: head.subtotalSatang,
        discountSatang: head.discountSatang,
        vatSatang: head.vatSatang,
        totalSatang: head.totalSatang,
        currency: head.currency,
        vatRate:
          head.vatRate === null ? DEFAULT_VAT_RATE : Number(head.vatRate),
      };
    });
  }

  /** US-SET-10's "email receipts". No settings row means the default: on. */
  async emailReceiptsOn(organizationId: number): Promise<boolean> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({ on: paymentSettings.emailReceipts })
        .from(paymentSettings)
        .where(eq(paymentSettings.organizationId, organizationId))
        .limit(1);
      return row?.on ?? true;
    });
  }

  private head(tx: Tx, organizationId: number, orderId: string) {
    return tx
      .select({
        number: orders.reference,
        buyerName: orders.buyerName,
        eventName: events.name,
        subtotalSatang: orders.subtotalSatang,
        discountSatang: orders.discountAmountSatang,
        vatSatang: orders.vatAmountSatang,
        totalSatang: orders.totalSatang,
        currency: orders.currency,
        sellerName: organizations.name,
        address: organizations.address,
        taxId: organizations.taxId,
        vatRate: organizations.vatRate,
        method: payments.method,
        paidAt: payments.paidAt,
      })
      .from(orders)
      .innerJoin(
        payments,
        and(
          eq(payments.orderId, orders.id),
          eq(payments.organizationId, organizationId),
          eq(payments.status, PAID_PAYMENT_STATUS),
          isNotNull(payments.paidAt),
        ),
      )
      .innerJoin(events, eq(events.id, orders.eventId))
      .innerJoin(organizations, eq(organizations.id, orders.organizationId))
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.organizationId, organizationId),
          isNull(orders.deletedAt),
        ),
      )
      .orderBy(asc(payments.paidAt))
      .limit(1);
  }

  private lines(
    tx: Tx,
    organizationId: number,
    orderId: string,
  ): Promise<ReceiptLine[]> {
    return tx
      .select({
        name: ticketTypes.name,
        quantity: orderItems.quantity,
        unitSatang: orderItems.unitPriceSatang,
        lineSatang: orderItems.lineSubtotalSatang,
      })
      .from(orderItems)
      .innerJoin(ticketTypes, eq(ticketTypes.id, orderItems.ticketTypeId))
      .where(
        and(
          eq(orderItems.orderId, orderId),
          eq(orderItems.organizationId, organizationId),
        ),
      )
      .orderBy(asc(orderItems.id));
  }
}

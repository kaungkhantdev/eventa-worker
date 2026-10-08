import { z } from 'zod';

/** Routing key for money that arrived for inventory we could not honour. */
export const PAYMENT_REFUND_REQUIRED = 'payment.refund_required';

/** Tolerant reader — only the fields this handler uses are required. */
export const refundRequiredSchema = z
  .object({
    version: z.number().optional(),
    organizationId: z.number(),
    orderId: z.string(),
    reference: z.string(),
    eventId: z.string(),
    buyerEmail: z.string(),
    amountSatang: z.number(),
    currency: z.string().optional(),
    reason: z.string().optional(),
    occurredAt: z.string().optional(),
  })
  .passthrough();

export type RefundRequiredEvent = z.infer<typeof refundRequiredSchema>;

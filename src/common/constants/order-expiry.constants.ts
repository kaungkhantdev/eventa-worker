/** The order-expiry module's named constants. */

/** The registered job name, so it can be inspected or stopped via SchedulerRegistry. */
export const ORDER_EXPIRY_JOB = 'order-expiry';

export const MS_PER_HOUR = 60 * 60 * 1000;

/** An allocation of 0 means unlimited — mirrors eventa-api's `TicketingPolicy`. */
export const UNLIMITED = 0;

export const WAITLISTED = 'waitlisted' as const;

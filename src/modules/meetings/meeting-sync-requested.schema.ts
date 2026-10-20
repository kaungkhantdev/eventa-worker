import { z } from 'zod';

/** Routing key eventa-api's `meeting-sync.event.ts` writes to the outbox. */
export const MEETING_SYNC_REQUESTED = 'meeting.sync_requested';

/**
 * Tolerant reader for `meeting.sync_requested` — only what the sync needs.
 *
 * The producer (version 1) also sends a snapshot of the meeting — title,
 * times, guest email, person, mode, notes and more. NONE of it is read: the
 * sync works from the current row, because a message can be stale by the time
 * it is consumed. Unknown fields are STRIPPED, so the guest's address does not
 * even survive parsing, and a newer producer's additions pass untouched.
 *
 * `intent` is read for the log line only; the row decides what to do.
 */
export const meetingSyncRequestedSchema = z.object({
  version: z.number().optional(),
  organizationId: z.number().int().positive(),
  meetingId: z.string().uuid(),
  intent: z.enum(['create', 'update', 'cancel']).optional(),
});

export type MeetingSyncRequestedEvent = z.infer<
  typeof meetingSyncRequestedSchema
>;

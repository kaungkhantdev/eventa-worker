import {
  CANCELLATION_NOTICE_SLUG,
  EVENT_REMINDER_SLUG,
  OFF_UNTIL_SWITCHED_ON_SLUGS,
  PAYMENT_RECEIPT_SLUG,
  POST_EVENT_THANKYOU_SLUG,
  REGISTRATION_CONFIRMATION_SLUG,
  WAITLIST_OFFER_SLUG,
} from '../../db/schema/messaging';
import { activeWhenUnset } from './template-defaults';

/**
 * What a message does in a workspace whose organizer never touched it — the
 * question every send asks when there is no `message_templates` row.
 */
describe('activeWhenUnset', () => {
  it('keeps the event reminder off until a workspace switches it on', () => {
    expect(activeWhenUnset(EVENT_REMINDER_SLUG)).toBe(false);
  });

  it('keeps every other message on', () => {
    // A workspace that never opened its settings must still confirm
    // registrations, send receipts and tell people an event is off.
    for (const slug of [
      REGISTRATION_CONFIRMATION_SLUG,
      CANCELLATION_NOTICE_SLUG,
      PAYMENT_RECEIPT_SLUG,
      WAITLIST_OFFER_SLUG,
      POST_EVENT_THANKYOU_SLUG,
    ]) {
      expect(activeWhenUnset(slug)).toBe(true);
    }
  });

  it('treats a slug it does not know as on, as before', () => {
    expect(activeWhenUnset('a-message-added-later')).toBe(true);
  });

  it('holds exactly what eventa-api’s catalog marks defaultActive: false', () => {
    // A cross-repo pin. The other half is eventa-api's
    // src/modules/message-templates/message-template-catalog.ts, whose spec
    // pins the same list. That side decides what the organizer SEES, this one
    // what is SENT.
    expect(OFF_UNTIL_SWITCHED_ON_SLUGS).toEqual([EVENT_REMINDER_SLUG]);
  });
});

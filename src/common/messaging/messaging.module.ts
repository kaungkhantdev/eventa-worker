import { Global, Module } from '@nestjs/common';
import { MessageTemplatesRepository } from './message-templates.repository';

/**
 * The organizer's message settings, available to every handler that sends an
 * automated message — global for the same reason EmailModule is: asking "may I
 * send this?" is part of sending, not a concern of any one domain.
 */
@Global()
@Module({
  providers: [MessageTemplatesRepository],
  exports: [MessageTemplatesRepository],
})
export class MessagingModule {}

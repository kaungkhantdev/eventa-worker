import { Global, Module } from '@nestjs/common';
import { MessageDeliveriesRepository } from './message-deliveries.repository';
import { MessageTemplatesRepository } from './message-templates.repository';

/**
 * The two things every send needs and no domain owns: the organizer's kill
 * switch (may I send this?) and the delivery log (what became of it?). Global
 * for the same reason EmailModule is — both are part of sending rather than a
 * concern of any one domain.
 */
@Global()
@Module({
  providers: [MessageTemplatesRepository, MessageDeliveriesRepository],
  exports: [MessageTemplatesRepository, MessageDeliveriesRepository],
})
export class MessagingModule {}

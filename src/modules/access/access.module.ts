import { Module } from '@nestjs/common';
import { MemberInvitedHandler } from './member-invited.handler';

/**
 * Workspace access side effects (mirrors eventa-api's `access` context):
 * consumes `identity.member_invited` and delivers the teammate's join link
 * (US-SET-11) through the EmailProvider port. The link and its token are
 * built by the API; this side only delivers them.
 */
@Module({
  providers: [MemberInvitedHandler],
})
export class AccessModule {}

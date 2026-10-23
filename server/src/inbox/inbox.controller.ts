import {
    Body,
    Controller,
    Get,
    MessageEvent,
    Param,
    Patch,
    Post,
    Query,
    Sse,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Observable, interval, map, merge } from 'rxjs';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { InboxViewer } from './inbox-visibility';
import { InboxService } from './inbox.service';
import type { UploadedFile as InboxUpload } from './inbox.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { RecordConsentDto } from './dto/record-consent.dto';

const INBOX_ROLES = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER];
/// Proxies (Caddy, Cloudflare) close idle streams; a comment line every 25s keeps it open.
const HEARTBEAT_MS = 25_000;

const viewerOf = (user: SessionPayload): InboxViewer => ({
    userId: user.sub,
    role: user.role!,
    grants: user.permissions ?? [],
});

/**
 * The shared inbox: WhatsApp, Messenger and Instagram conversations in one
 * list. Vendors and influencers are refused by their guards; which
 * conversations a member sees is decided in InboxService by assignment and
 * the chat.* grants.
 */
@Controller('inbox')
@RequireSection('chat')
@Roles(...INBOX_ROLES)
export class InboxController {
    constructor(
        private readonly inbox: InboxService,
        private readonly events: InboxEventsService,
    ) { }

    @Get('conversations')
    list(@CurrentUser() user: SessionPayload, @Query() q: QueryConversationsDto) {
        return this.inbox.listConversations(user.orgId!, viewerOf(user), q);
    }

    @Get('counts')
    counts(@CurrentUser() user: SessionPayload) {
        return this.inbox.counts(user.orgId!, viewerOf(user));
    }

    @Get('members')
    members(@CurrentUser() user: SessionPayload) {
        return this.inbox.assignableMembers(user.orgId!);
    }

    @Get('conversations/:id')
    get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.inbox.getConversation(user.orgId!, viewerOf(user), id);
    }

    @Get('conversations/:id/messages')
    messages(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query() q: QueryMessagesDto) {
        return this.inbox.listMessages(user.orgId!, viewerOf(user), id, q);
    }

    @Post('conversations/:id/messages')
    send(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: SendMessageDto) {
        return this.inbox.send(user.orgId!, viewerOf(user), id, dto);
    }

    @Post('conversations/:id/read')
    read(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.inbox.markRead(user.orgId!, viewerOf(user), id);
    }

    @Patch('conversations/:id')
    update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateConversationDto) {
        return this.inbox.update(user.orgId!, viewerOf(user), id, dto);
    }

    @Post('conversations/:id/notes')
    addNote(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: CreateNoteDto) {
        return this.inbox.addNote(user.orgId!, viewerOf(user), id, dto);
    }

    @Get('contacts/:id')
    contact(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.inbox.getContact(user.orgId!, viewerOf(user), id);
    }

    @Patch('contacts/:id')
    updateContact(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateContactDto) {
        return this.inbox.updateContact(user.orgId!, viewerOf(user), id, dto);
    }

    @Post('contacts/:id/consent')
    consent(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: RecordConsentDto) {
        return this.inbox.recordConsent(user.orgId!, viewerOf(user), id, dto);
    }

    @Post('uploads')
    @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT)
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
    upload(@CurrentUser() user: SessionPayload, @UploadedFile() file: InboxUpload) {
        return this.inbox.upload(user.orgId!, file);
    }

    /**
     * Live inbox changes for this organization. The client reads it with a
     * streamed fetch (the access token is a Bearer header, which EventSource
     * cannot send) and refetches what each event names.
     */
    @Sse('stream')
    @SkipThrottle()
    stream(@CurrentUser() user: SessionPayload): Observable<MessageEvent> {
        return merge(
            this.events.stream(user.orgId!).pipe(map((event) => ({ type: event.type, data: event }) as MessageEvent)),
            interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }) as MessageEvent)),
        );
    }
}

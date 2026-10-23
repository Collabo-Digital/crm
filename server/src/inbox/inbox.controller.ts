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
import { Observable, interval, map, merge, tap } from 'rxjs';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { InboxService } from './inbox.service';
import type { UploadedFile as InboxUpload } from './inbox.service';
import { InboxTeamService } from './inbox-team.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { CreatePaymentLinkDto } from '../payments/dto/payments.dto';
import { BulkConversationsDto } from './dto/bulk-conversations.dto';

export const INBOX_ROLES = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER];
/// Proxies (Caddy, Cloudflare) close idle streams; a comment line every 25s keeps it open.
const HEARTBEAT_MS = 25_000;

/**
 * The shared inbox: WhatsApp, Messenger and Instagram conversations in one
 * list. Vendors and influencers are refused by their guards; which
 * conversations a member sees is decided in InboxService by assignment, team
 * and the chat.* grants.
 */
@Controller('inbox')
@RequireSection('chat')
@Roles(...INBOX_ROLES)
export class InboxController {
    constructor(
        private readonly inbox: InboxService,
        private readonly teams: InboxTeamService,
        private readonly events: InboxEventsService,
    ) { }

    @Get('conversations')
    async list(@CurrentUser() user: SessionPayload, @Query() q: QueryConversationsDto) {
        return this.inbox.listConversations(user.orgId!, await this.teams.viewer(user), q);
    }

    @Post('conversations/bulk')
    async bulk(@CurrentUser() user: SessionPayload, @Body() dto: BulkConversationsDto) {
        return this.inbox.bulk(user.orgId!, await this.teams.viewer(user), dto);
    }

    @Get('counts')
    async counts(@CurrentUser() user: SessionPayload) {
        return this.inbox.counts(user.orgId!, await this.teams.viewer(user));
    }

    @Get('conversations/:id')
    async get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.inbox.getConversation(user.orgId!, await this.teams.viewer(user), id);
    }

    @Get('conversations/:id/messages')
    async messages(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query() q: QueryMessagesDto) {
        return this.inbox.listMessages(user.orgId!, await this.teams.viewer(user), id, q);
    }

    @Post('conversations/:id/messages')
    async send(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: SendMessageDto) {
        return this.inbox.send(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    /** The product tray: the store's products, and whether this chat can get catalog messages. */
    @Get('conversations/:id/products')
    async products(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query('search') search?: string) {
        return this.inbox.products(user.orgId!, await this.teams.viewer(user), id, search?.slice(0, 100));
    }

    /** Payment links sent in this chat, and the customer's unpaid orders. */
    @Get('conversations/:id/payment-links')
    async paymentLinks(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.inbox.paymentLinksFor(user.orgId!, await this.teams.viewer(user), id);
    }

    /** A payment link from the organization's own Razorpay account, for the teammate to send. */
    @Post('conversations/:id/payment-links')
    async createPaymentLink(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: CreatePaymentLinkDto) {
        return this.inbox.createPaymentLink(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    /** Turn a cart the customer sent into a draft order with a checkout link. */
    @Post('conversations/:id/messages/:messageId/draft-order')
    async draftFromCart(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Param('messageId') messageId: string) {
        return this.inbox.draftFromCart(user.orgId!, await this.teams.viewer(user), id, messageId);
    }

    @Post('conversations/:id/read')
    async read(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.inbox.markRead(user.orgId!, await this.teams.viewer(user), id);
    }

    @Patch('conversations/:id')
    async update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateConversationDto) {
        return this.inbox.update(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    @Post('conversations/:id/notes')
    async addNote(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: CreateNoteDto) {
        return this.inbox.addNote(user.orgId!, await this.teams.viewer(user), id, dto);
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
     * cannot send) and refetches what each event names. While it is open the
     * member counts as present for routing and the team list.
     */
    @Sse('stream')
    @SkipThrottle()
    stream(@CurrentUser() user: SessionPayload): Observable<MessageEvent> {
        const orgId = user.orgId!;
        const present = () => void this.teams.touchPresence(orgId, user.sub).catch(() => undefined);
        present();
        return merge(
            this.events.stream(orgId).pipe(map((event) => ({ type: event.type, data: event }) as MessageEvent)),
            interval(HEARTBEAT_MS).pipe(
                tap(present),
                map(() => ({ type: 'ping', data: {} }) as MessageEvent),
            ),
        );
    }
}

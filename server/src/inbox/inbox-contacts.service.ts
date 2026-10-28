import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelContact, ChannelPlatform, ChannelStatus, ConsentType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { countryCodeOf, normalizePhone as toE164 } from '../common/phone.util';
import { ensureManualChannel } from '../channel/ensure-manual-channel';
import { normalizePhone } from './contact-import.service';
import { ContactIdentityService, storedPhoneIs } from '../messaging/contact-identity.service';
import { MessagingSendService } from '../messaging/send/messaging-send.service';
import { StartChatDto } from './dto/start-chat.dto';
import { PrismaService } from '../prisma/prisma.service';
import { resolveReportingTimeZone, zonedDayEndExclusive, zonedDayStart } from '../common/utils/zoned-date.util';
import { ConsentService } from '../messaging/consent.service';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { AutomationEventService } from '../messaging/automation-event.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { contactName } from '../messaging/contact-name';
import { canBrowseCustomers } from '../auth/permissions';
import { InboxViewer, canAssignOthers, canReply, seesAll, visibilityWhere } from './inbox-visibility';
import { ASSIGNABLE_ROLES, InboxTeamService } from './inbox-team.service';
import { UpdateContactDto } from './dto/update-contact.dto';
import { RecordConsentDto } from './dto/record-consent.dto';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { BulkTagContactsDto } from './dto/bulk-tag-contacts.dto';


const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

const customerName = (c: { firstName: string | null; lastName: string | null }) =>
    [c.firstName, c.lastName].filter(Boolean).join(' ') || null;

const CUSTOMERS_NEEDED = 'Finding store customers needs access to Customers or Orders. Ask an admin.';

const listInclude = {
    channel: { select: { id: true, name: true } },
    customer: { select: { id: true, firstName: true, lastName: true } },
    ownerUser: { select: { id: true, firstName: true, lastName: true } },
    ownerTeam: { select: { id: true, name: true } },
    conversations: { select: { id: true }, orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } }, take: 1 },
} satisfies Prisma.ChannelContactInclude;

/**
 * Chat contacts: the list, one contact's profile with its store customer and
 * other conversations, and the edits the team makes to them.
 */
@Injectable()
export class InboxContactsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly consent: ConsentService,
        private readonly events: InboxEventsService,
        private readonly teams: InboxTeamService,
        private readonly automationEvents: AutomationEventService,
        private readonly automationJobs: AutomationJobs,
        private readonly identity: ContactIdentityService,
        private readonly sender: MessagingSendService,
    ) { }

    /**
     * Starts a WhatsApp chat with a number, or adds it as a contact: finds or
     * creates the person on the organization's WhatsApp number, links the
     * store customer, and returns the conversation to open. Until they write,
     * the first message has to be a template.
     */
    async startChat(orgId: string, viewer: InboxViewer, dto: StartChatDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot start chats.');
        const channel = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { id: true },
        });
        if (!channel) throw new BadRequestException('Connect a WhatsApp number in Settings → Channels first.');
        // Starting from a customer is the customer page's button; the chat's number still links its customer below.
        if (dto.customerId && !canBrowseCustomers(viewer.role, viewer.grants)) throw new ForbiddenException(CUSTOMERS_NEEDED);
        const customer = dto.customerId
            ? await this.prisma.customer.findFirst({ where: { id: dto.customerId, organizationId: orgId, deletedAt: null }, select: { id: true, defaultAddress: true } })
            : null;
        if (dto.customerId && !customer) throw new NotFoundException('Customer not found');
        // A store customer's number is often saved without its country code: their address says which.
        const digits =
            normalizePhone(dto.phone, dto.countryCode) ??
            (customer ? toE164(dto.phone, countryCodeOf(customer.defaultAddress) ?? 'IN')?.replace(/^\+/, '') ?? null : null);
        if (!digits) throw new BadRequestException('Enter a WhatsApp number with its country code, like +91 98765 43210.');
        const name = dto.name?.trim() || null;

        const { contactId, created } = await this.prisma.$transaction(async (tx) => {
            let contact = await tx.channelContact.findFirst({
                where: { channelId: channel.id, OR: [{ waId: digits }, { externalId: digits }, { previousExternalIds: { has: digits } }] },
            });
            const created = !contact;
            if (!contact) {
                contact = await tx.channelContact.create({
                    data: {
                        organizationId: orgId,
                        channelId: channel.id,
                        platform: ChannelPlatform.WHATSAPP,
                        externalId: digits,
                        waId: digits,
                        phone: `+${digits}`,
                        displayName: name,
                        customerId: customer?.id ?? null,
                    },
                });
            } else if ((name && !contact.displayName) || (customer && !contact.customerId)) {
                contact = await tx.channelContact.update({
                    where: { id: contact.id },
                    data: { ...(name && !contact.displayName ? { displayName: name } : {}), ...(customer && !contact.customerId ? { customerId: customer.id } : {}) },
                });
            }
            if (!contact.customerId) await this.identity.linkCustomerByPhone(tx, contact);
            if (dto.optIn && !contact.optedOutAt && !contact.optInAt) {
                await this.consent.record(tx, contact, ConsentType.OPT_IN, 'agent', { note: 'Agreed when the chat was started' }, viewer.userId);
            }
            return { contactId: contact.id, created };
        });

        const conversationId = await this.sender.conversationFor(contactId);
        // An agent who only sees their own chats must be able to open the one they started.
        if (!seesAll(viewer)) {
            await this.prisma.conversation.updateMany({ where: { id: conversationId, assignedUserId: null }, data: { assignedUserId: viewer.userId } });
        }
        this.events.publish(orgId, { type: 'conversation.updated', conversationId });
        return { contactId, conversationId, created };
    }

    async list(orgId: string, viewer: InboxViewer, q: QueryContactsDto) {
        const limit = q.limit ?? 25;
        const page = q.page ?? 1;
        const and: Prisma.ChannelContactWhereInput[] = [{ organizationId: orgId, isGroup: false }];
        // Contacts with no conversation (an imported address book) are only for members who see everything.
        if (!seesAll(viewer)) and.push({ conversations: { some: visibilityWhere(viewer) } });
        if (q.platform) and.push({ platform: q.platform });
        if (q.channelId) and.push({ channelId: q.channelId });
        if (q.tag) and.push({ tags: { has: q.tag } });
        if (q.ownerUserId) and.push({ ownerUserId: q.ownerUserId === 'none' ? null : q.ownerUserId });
        if (q.ownerTeamId) and.push({ ownerTeamId: q.ownerTeamId === 'none' ? null : q.ownerTeamId });
        if (q.consent === 'subscribed') and.push({ optInAt: { not: null }, optedOutAt: null, blockedAt: null });
        if (q.consent === 'no_consent') and.push({ optInAt: null, optedOutAt: null, blockedAt: null });
        if (q.consent === 'opted_out') and.push({ optedOutAt: { not: null } });
        if (q.consent === 'blocked') and.push({ blockedAt: { not: null } });
        if (q.from || q.to) {
            // Calendar days in the organization's reporting zone, as Orders reads them; `to` is inclusive.
            const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
            const timeZone = resolveReportingTimeZone(org ?? {});
            if (q.from) and.push({ createdAt: { gte: zonedDayStart(q.from, timeZone) } });
            if (q.to) and.push({ createdAt: { lt: zonedDayEndExclusive(q.to, timeZone) } });
        }
        if (q.search?.trim()) {
            const term = q.search.trim();
            const like = { contains: term, mode: 'insensitive' as const };
            const digits = term.replace(/[^\d]/g, '');
            and.push({
                OR: [
                    { displayName: like },
                    { addressBookName: like },
                    { username: { ...like, contains: term.replace(/^@/, '') } },
                    ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
                    { customer: { email: like } },
                ],
            });
        }
        const where = { AND: and };
        const dir = q.sortOrder ?? 'desc';
        const [rows, total] = await Promise.all([
            this.prisma.channelContact.findMany({
                where,
                include: listInclude,
                orderBy: [
                    q.sortBy === 'lastInboundAt' ? { lastInboundMessageAt: { sort: dir, nulls: 'last' } } : { createdAt: dir },
                    { id: dir },
                ],
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.channelContact.count({ where }),
        ]);
        return {
            data: rows.map((c) => ({
                id: c.id,
                name: contactName(c),
                platform: c.platform,
                channel: c.channel,
                phone: c.phone,
                username: c.username,
                avatarUrl: c.profilePicUrl,
                tags: c.tags,
                optedIn: !!c.optInAt && !c.optedOutAt,
                optedOut: !!c.optedOutAt,
                blocked: !!c.blockedAt,
                customer: c.customer ? { id: c.customer.id, name: customerName(c.customer) } : null,
                owner: {
                    user: c.ownerUser ? { id: c.ownerUser.id, name: fullName(c.ownerUser) } : null,
                    team: c.ownerTeam,
                },
                lastInboundAt: c.lastInboundMessageAt,
                createdAt: c.createdAt,
                conversationId: c.conversations[0]?.id ?? null,
            })),
            meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
        };
    }

    /** Every tag in use with how many contacts carry it, most used first — among contacts the member may see. */
    async tags(orgId: string, viewer: InboxViewer) {
        if (!seesAll(viewer)) {
            const visible = await this.prisma.channelContact.findMany({
                where: { organizationId: orgId, conversations: { some: visibilityWhere(viewer) } },
                select: { tags: true },
                take: 5000,
            });
            const counts = new Map<string, number>();
            for (const c of visible) for (const tag of c.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
            return [...counts]
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
                .slice(0, 300);
        }
        const rows = await this.prisma.$queryRaw<Array<{ tag: string; count: bigint }>>`
            SELECT tag, count(*) AS count
            FROM "channel_contacts", unnest("tags") AS tag
            WHERE "organization_id" = ${orgId}
            GROUP BY tag
            ORDER BY count DESC, tag ASC
            LIMIT 300
        `;
        return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
    }

    async get(orgId: string, viewer: InboxViewer, contactId: string) {
        const contact = await this.load(orgId, viewer, contactId);
        return this.view(contact, viewer);
    }

    async update(orgId: string, viewer: InboxViewer, contactId: string, dto: UpdateContactDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot edit contacts.');
        const contact = await this.load(orgId, viewer, contactId);

        if (dto.customerId) {
            const customer = await this.prisma.customer.findFirst({
                where: { id: dto.customerId, organizationId: orgId, deletedAt: null },
                select: { id: true },
            });
            if (!customer) throw new BadRequestException('Customer not found');
            if (dto.customerId !== contact.customerId) await this.checkCanLink(viewer, contact, dto.customerId);
        }
        await this.checkOwner(orgId, viewer, contact, dto);
        const attributes = dto.attributes
            ? Object.fromEntries(
                Object.entries({ ...((contact.attributes as Record<string, unknown>) ?? {}), ...dto.attributes }).filter(([, v]) => v !== null),
            )
            : undefined;

        let tagEvents: string[] = [];
        const updated = await this.prisma.$transaction(async (tx) => {
            const row = await tx.channelContact.update({
                where: { id: contact.id },
                data: {
                    ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() || null } : {}),
                    ...(dto.tags ? { tags: cleanTags(dto.tags) } : {}),
                    ...(attributes ? { attributes: attributes as Prisma.InputJsonValue } : {}),
                    ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
                    ...(dto.blocked !== undefined ? { blockedAt: dto.blocked ? new Date() : null } : {}),
                    ...(dto.ownerUserId !== undefined ? { ownerUserId: dto.ownerUserId } : {}),
                    ...(dto.ownerTeamId !== undefined ? { ownerTeamId: dto.ownerTeamId } : {}),
                },
            });
            if (dto.customerId !== undefined) {
                await tx.conversation.updateMany({ where: { contactId: contact.id }, data: { customerId: dto.customerId } });
            }
            if (dto.tags) tagEvents = await this.automationEvents.recordTagsAdded(tx, contact, newTags(contact.tags, row.tags));
            return row;
        });
        for (const id of tagEvents) await this.automationJobs.event(id);
        await this.publishFor(orgId, [contact.id]);
        return this.view(updated, viewer);
    }

    /**
     * Two chats are one person: both end up on the same store customer. One
     * customer between them is shared; two different ones are left for the
     * team to sort out; with none, the customer is found by the WhatsApp
     * number or made from the chat that says more about them. Each chat keeps
     * its own thread, window and consent.
     */
    async samePerson(orgId: string, viewer: InboxViewer, contactId: string, otherId: string) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot edit contacts.');
        if (otherId === contactId) throw new BadRequestException('Choose another chat.');
        const [contact, other] = await Promise.all([this.load(orgId, viewer, contactId), this.load(orgId, viewer, otherId)]);
        if (contact.isGroup || other.isGroup) throw new BadRequestException('A group chat is not one person.');
        if (contact.customerId && other.customerId && contact.customerId !== other.customerId) {
            throw new BadRequestException('These chats are linked to two different store customers. Unlink one of them first.');
        }
        await this.prisma.$transaction(async (tx) => {
            const customerId = contact.customerId ?? other.customerId ?? (await this.customerFor(tx, orgId, contact, other));
            await tx.channelContact.updateMany({ where: { id: { in: [contact.id, other.id] } }, data: { customerId } });
            await tx.conversation.updateMany({ where: { contactId: { in: [contact.id, other.id] } }, data: { customerId } });
        });
        await this.publishFor(orgId, [contact.id, other.id]);
        return this.get(orgId, viewer, contact.id);
    }

    /** Link a chat to a customer from the customer's page. A chat already linked to someone else stays theirs. */
    async linkToCustomer(orgId: string, viewer: InboxViewer, customerId: string, contactId: string) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot edit contacts.');
        const contact = await this.load(orgId, viewer, contactId);
        if (contact.isGroup) throw new BadRequestException('A group chat cannot be linked to a customer.');
        const customer = await this.prisma.customer.findFirst({
            where: { id: customerId, organizationId: orgId, deletedAt: null },
            select: { id: true },
        });
        if (!customer) throw new NotFoundException('Customer not found');
        if (contact.customerId && contact.customerId !== customer.id) {
            throw new BadRequestException('This chat is linked to another store customer. Unlink it there first.');
        }
        if (contact.customerId !== customer.id) await this.checkCanLink(viewer, contact, customer.id);
        await this.setCustomer(orgId, contact.id, customer.id);
        return { contactId: contact.id, customerId: customer.id };
    }

    async unlinkFromCustomer(orgId: string, viewer: InboxViewer, customerId: string, contactId: string) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot edit contacts.');
        const contact = await this.load(orgId, viewer, contactId);
        if (contact.customerId !== customerId) throw new NotFoundException('This chat is not linked to this customer.');
        await this.setCustomer(orgId, contact.id, null);
        return { contactId: contact.id, customerId: null };
    }

    async recordConsent(orgId: string, viewer: InboxViewer, contactId: string, dto: RecordConsentDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot change consent.');
        const contact = await this.load(orgId, viewer, contactId);
        await this.prisma.$transaction((tx) =>
            this.consent.record(tx, contact, dto.type as ConsentType, 'agent', dto.note ? { note: dto.note } : null, viewer.userId),
        );
        return this.get(orgId, viewer, contact.id);
    }

    /** Add and remove tags on many contacts. Contacts the member cannot see are skipped. */
    async bulkTag(orgId: string, viewer: InboxViewer, dto: BulkTagContactsDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot tag contacts.');
        const add = cleanTags(dto.add ?? []);
        const remove = new Set(cleanTags(dto.remove ?? []));
        if (!add.length && !remove.size) throw new BadRequestException('Choose a tag to add or remove.');
        const contacts = await this.prisma.channelContact.findMany({
            where: {
                id: { in: [...new Set(dto.ids)] },
                organizationId: orgId,
                ...(seesAll(viewer) ? {} : { conversations: { some: visibilityWhere(viewer) } }),
            },
            select: { id: true, tags: true, organizationId: true, channelId: true, externalId: true },
        });
        const tagEvents = await this.prisma.$transaction(async (tx) => {
            const ids: string[] = [];
            for (const c of contacts) {
                const tags = cleanTags([...c.tags, ...add]).filter((t) => !remove.has(t));
                await tx.channelContact.update({ where: { id: c.id }, data: { tags } });
                ids.push(...(await this.automationEvents.recordTagsAdded(tx, c, newTags(c.tags, tags))));
            }
            return ids;
        });
        for (const id of tagEvents) await this.automationJobs.event(id);
        await this.publishFor(orgId, contacts.map((c) => c.id));
        return { updated: contacts.length, skipped: dto.ids.length - contacts.length };
    }

    /**
     * Store customers to link this contact to: by search, or the ones sharing
     * its number. Searching reads the whole customer list, so it needs the
     * sections that open it; the number's own matches are the chat's.
     */
    async customerCandidates(orgId: string, viewer: InboxViewer, contactId: string, q: string | undefined) {
        const contact = await this.load(orgId, viewer, contactId);
        const term = q?.trim();
        if (!term) return { results: await this.phoneMatches(contact) };
        if (!canBrowseCustomers(viewer.role, viewer.grants)) throw new ForbiddenException(CUSTOMERS_NEEDED);
        const like = { contains: term, mode: 'insensitive' as const };
        const digits = term.replace(/[^\d]/g, '');
        const rows = await this.prisma.customer.findMany({
            where: {
                organizationId: orgId,
                deletedAt: null,
                OR: [
                    { firstName: like },
                    { lastName: like },
                    { email: like },
                    ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
                ],
            },
            select: { id: true, firstName: true, lastName: true, email: true, phone: true, ordersCount: true },
            orderBy: { ordersCount: 'desc' },
            take: 10,
        });
        return { results: rows.map((c) => ({ ...c, name: customerName(c) })) };
    }

    /** The profile the side panel shows. */
    async view(contact: ChannelContact, viewer: InboxViewer) {
        const [customer, otherChats, consent, owner, phoneMatches, fromAd] = await Promise.all([
            contact.customerId
                ? this.prisma.customer.findUnique({
                    where: { id: contact.customerId },
                    select: {
                        id: true, firstName: true, lastName: true, email: true, phone: true, ordersCount: true,
                        totalSpent: true, vipLevel: true, tags: true, createdAt: true,
                        orders: {
                            where: { deletedAt: null },
                            orderBy: { createdAt: 'desc' },
                            take: 5,
                            select: { id: true, name: true, totalPrice: true, currency: true, financialStatus: true, fulfillmentStatus: true, createdAt: true, cancelledAt: true },
                        },
                    },
                })
                : Promise.resolve(null),
            this.otherChats(contact, viewer),
            this.prisma.consentEvent.findMany({
                where: { contactId: contact.id },
                orderBy: { occurredAt: 'desc' },
                take: 10,
                select: { type: true, source: true, occurredAt: true },
            }),
            this.owner(contact),
            this.phoneMatches(contact),
            // The latest click-to-message ad this person came from.
            this.prisma.adReferral.findFirst({
                where: { contactId: contact.id },
                orderBy: { occurredAt: 'desc' },
                select: { adId: true, headline: true, body: true, sourceUrl: true, mediaUrl: true, occurredAt: true },
            }),
        ]);
        return {
            id: contact.id,
            platform: contact.platform,
            isGroup: contact.isGroup,
            name: contactName(contact),
            displayName: contact.displayName,
            addressBookName: contact.addressBookName,
            username: contact.username,
            phone: contact.phone,
            externalId: contact.externalId,
            avatarUrl: contact.profilePicUrl,
            tags: contact.tags,
            attributes: (contact.attributes as Record<string, unknown> | null) ?? {},
            optedOutAt: contact.optedOutAt,
            optInAt: contact.optInAt,
            blockedAt: contact.blockedAt,
            firstSeenAt: contact.createdAt,
            lastInboundAt: contact.lastInboundMessageAt,
            owner,
            customer: customer
                ? {
                    id: customer.id,
                    name: customerName(customer),
                    email: customer.email,
                    phone: customer.phone,
                    ordersCount: customer.ordersCount,
                    totalSpent: customer.totalSpent.toString(),
                    vipLevel: customer.vipLevel,
                    tags: customer.tags,
                    since: customer.createdAt,
                    recentOrders: customer.orders.map((o) => ({ ...o, totalPrice: o.totalPrice.toString() })),
                }
                : null,
            /** Store customers with this phone number. More than one means the link needs a person's judgement. */
            phoneMatches,
            otherChats,
            consent,
            fromAd,
        };
    }

    /** A contact this member may see: it has a conversation they can open. */
    private async load(orgId: string, viewer: InboxViewer, contactId: string): Promise<ChannelContact> {
        const contact = await this.prisma.channelContact.findFirst({
            where: {
                id: contactId,
                organizationId: orgId,
                ...(seesAll(viewer) ? {} : { conversations: { some: visibilityWhere(viewer) } }),
            },
        });
        if (!contact) throw new NotFoundException('Contact not found');
        return contact;
    }

    /**
     * The same person's other numbers and profiles, through the linked
     * customer. Like the contact list, a chat the member cannot open is left out.
     */
    private async otherChats(contact: ChannelContact, viewer: InboxViewer) {
        if (!contact.customerId) return [];
        const rows = await this.prisma.channelContact.findMany({
            where: {
                organizationId: contact.organizationId,
                customerId: contact.customerId,
                id: { not: contact.id },
                ...(seesAll(viewer) ? {} : { conversations: { some: visibilityWhere(viewer) } }),
            },
            include: {
                channel: { select: { name: true } },
                conversations: { select: { id: true, lastMessageAt: true, lastMessagePreview: true }, take: 1 },
            },
            take: 20,
        });
        return rows
            .map((c) => ({
                contactId: c.id,
                platform: c.platform,
                channel: c.channel,
                name: contactName(c),
                phone: c.phone,
                username: c.username,
                optedIn: !!c.optInAt && !c.optedOutAt,
                conversationId: c.conversations[0]?.id ?? null,
                lastMessageAt: c.conversations[0]?.lastMessageAt ?? null,
                lastMessagePreview: c.conversations[0]?.lastMessagePreview ?? null,
            }))
            .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
    }

    /**
     * The store customer for two chats that have none: the one customer with
     * the WhatsApp number, else a new one on the manual channel, as a chat's
     * draft order makes it. Name and number come from the chat that says more.
     */
    private async customerFor(tx: Prisma.TransactionClient, orgId: string, a: ChannelContact, b: ChannelContact): Promise<string> {
        const detail = (c: ChannelContact) => (c.platform === ChannelPlatform.WHATSAPP && c.phone ? 2 : 0) + (c.displayName || c.addressBookName ? 1 : 0);
        const chats = detail(b) > detail(a) ? [b, a] : [a, b];
        const phone = chats.find((c) => c.platform === ChannelPlatform.WHATSAPP && c.phone)?.phone ?? null;
        if (phone) {
            const matches = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "customers"
                WHERE "organization_id" = ${orgId}
                  AND "deleted_at" IS NULL
                  AND "phone" IS NOT NULL
                  AND ${storedPhoneIs(Prisma.raw('"phone"'), phone.replace(/\D/g, ''))}
                LIMIT 2
            `;
            if (matches.length > 1) {
                throw new BadRequestException(`${phone} belongs to more than one store customer. Link the right one with Find customer first.`);
            }
            if (matches.length === 1) return matches[0].id;
        }
        const name = chats.map((c) => contactName(c).replace(/^@/, '')).find((n) => /\p{L}/u.test(n));
        const [firstName, ...rest] = name ? name.trim().split(/\s+/) : [];
        const channel = await ensureManualChannel(tx, orgId);
        const customer = await tx.customer.create({
            data: {
                organizationId: orgId,
                channelId: channel.id,
                externalId: `manual_${randomUUID()}`,
                firstName: firstName ?? null,
                lastName: rest.join(' ') || null,
                phone,
            },
            select: { id: true },
        });
        return customer.id;
    }

    /** Point a chat, and its conversation, at a store customer or at none. */
    private async setCustomer(orgId: string, contactId: string, customerId: string | null) {
        await this.prisma.$transaction(async (tx) => {
            await tx.channelContact.update({ where: { id: contactId }, data: { customerId } });
            await tx.conversation.updateMany({ where: { contactId }, data: { customerId } });
        });
        await this.publishFor(orgId, [contactId]);
    }

    private async owner(contact: ChannelContact) {
        const [user, team] = await Promise.all([
            contact.ownerUserId
                ? this.prisma.user.findUnique({ where: { id: contact.ownerUserId }, select: { id: true, firstName: true, lastName: true } })
                : null,
            contact.ownerTeamId
                ? this.prisma.inboxTeam.findUnique({ where: { id: contact.ownerTeamId }, select: { id: true, name: true } })
                : null,
        ]);
        return { user: user ? { id: user.id, name: fullName(user) } : null, team };
    }

    private async phoneMatches(contact: ChannelContact) {
        const digits = (contact.waId ?? contact.phone ?? '').replace(/[^\d]/g, '');
        if (digits.length < 10) return [];
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "customers"
            WHERE "organization_id" = ${contact.organizationId}
              AND "deleted_at" IS NULL
              AND "phone" IS NOT NULL
              AND right(regexp_replace("phone", '\\D', '', 'g'), 10) = ${digits.slice(-10)}
            LIMIT 5
        `;
        if (!rows.length) return [];
        const customers = await this.prisma.customer.findMany({
            where: { id: { in: rows.map((r) => r.id) } },
            select: { id: true, firstName: true, lastName: true, email: true, phone: true, ordersCount: true },
            orderBy: { ordersCount: 'desc' },
        });
        return customers.map((c) => ({ ...c, name: customerName(c) }));
    }

    /**
     * The chat's panel shows its customer's orders and spend, so a member who
     * cannot open the store's customers may only link one that shares the
     * chat's number. Otherwise any customer's history was a link away.
     */
    private async checkCanLink(viewer: InboxViewer, contact: ChannelContact, customerId: string) {
        if (canBrowseCustomers(viewer.role, viewer.grants)) return;
        const matches = await this.phoneMatches(contact);
        if (!matches.some((m) => m.id === customerId)) {
            throw new ForbiddenException('You can link this chat only to a store customer with the same phone number.');
        }
    }

    /**
     * Taking a contact for yourself or letting go of your own needs nothing
     * more than replying does; naming someone else, or a team, is assigning.
     */
    private async checkOwner(orgId: string, viewer: InboxViewer, contact: ChannelContact, dto: UpdateContactDto) {
        if (dto.ownerUserId !== undefined && dto.ownerUserId !== contact.ownerUserId) {
            const selfService =
                (dto.ownerUserId === viewer.userId && contact.ownerUserId === null) ||
                (dto.ownerUserId === null && contact.ownerUserId === viewer.userId);
            if (!selfService && !canAssignOthers(viewer)) {
                throw new ForbiddenException('You cannot give this contact to someone else.');
            }
            if (dto.ownerUserId) {
                const member = await this.prisma.organizationMember.findFirst({
                    where: { organizationId: orgId, userId: dto.ownerUserId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
                    select: { id: true },
                });
                if (!member) throw new BadRequestException('That person is not an active team member who can reply.');
            }
        }
        if (dto.ownerTeamId !== undefined && dto.ownerTeamId !== contact.ownerTeamId) {
            if (!canAssignOthers(viewer)) throw new ForbiddenException('You cannot move this contact to a team.');
            if (dto.ownerTeamId) await this.teams.assertTeam(orgId, dto.ownerTeamId);
        }
    }

    private async publishFor(orgId: string, contactIds: string[]) {
        const conversations = await this.prisma.conversation.findMany({
            where: { contactId: { in: contactIds } },
            select: { id: true },
        });
        for (const c of conversations) this.events.publish(orgId, { type: 'conversation.updated', conversationId: c.id });
    }
}

function cleanTags(tags: string[]): string[] {
    return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

/** Tags in `after` the contact did not have before, ignoring case. */
function newTags(before: string[], after: string[]): string[] {
    const had = new Set(before.map((t) => t.toLowerCase()));
    return after.filter((t) => !had.has(t.toLowerCase()));
}

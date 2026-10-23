import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelContact, ConsentType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveReportingTimeZone, zonedDayEndExclusive, zonedDayStart } from '../common/utils/zoned-date.util';
import { ConsentService } from '../messaging/consent.service';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { InboxViewer, canAssignOthers, canReply, seesAll, visibilityWhere } from './inbox-visibility';
import { ASSIGNABLE_ROLES, InboxTeamService } from './inbox-team.service';
import { UpdateContactDto } from './dto/update-contact.dto';
import { RecordConsentDto } from './dto/record-consent.dto';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { BulkTagContactsDto } from './dto/bulk-tag-contacts.dto';

export function contactName(c: Pick<ChannelContact, 'displayName' | 'addressBookName' | 'username' | 'phone' | 'externalId'>): string {
    return c.displayName ?? c.addressBookName ?? (c.username ? `@${c.username}` : null) ?? c.phone ?? c.externalId;
}

const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

const customerName = (c: { firstName: string | null; lastName: string | null }) =>
    [c.firstName, c.lastName].filter(Boolean).join(' ') || null;

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
    ) { }

    async list(orgId: string, viewer: InboxViewer, q: QueryContactsDto) {
        const limit = q.limit ?? 25;
        const page = q.page ?? 1;
        const and: Prisma.ChannelContactWhereInput[] = [{ organizationId: orgId }];
        // Contacts with no conversation (an imported address book) are only for members who see everything.
        if (!seesAll(viewer)) and.push({ conversations: { some: visibilityWhere(viewer) } });
        if (q.platform) and.push({ platform: q.platform });
        if (q.channelId) and.push({ channelId: q.channelId });
        if (q.tag) and.push({ tags: { has: q.tag } });
        if (q.ownerUserId) and.push({ ownerUserId: q.ownerUserId === 'none' ? null : q.ownerUserId });
        if (q.ownerTeamId) and.push({ ownerTeamId: q.ownerTeamId === 'none' ? null : q.ownerTeamId });
        if (q.consent === 'subscribed') and.push({ optedOutAt: null, blockedAt: null });
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
                    { username: like },
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
        return this.view(contact);
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
        }
        await this.checkOwner(orgId, viewer, contact, dto);
        const attributes = dto.attributes
            ? Object.fromEntries(
                Object.entries({ ...((contact.attributes as Record<string, unknown>) ?? {}), ...dto.attributes }).filter(([, v]) => v !== null),
            )
            : undefined;

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
            return row;
        });
        await this.publishFor(orgId, [contact.id]);
        return this.view(updated);
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
            select: { id: true, tags: true },
        });
        await this.prisma.$transaction(
            contacts.map((c) =>
                this.prisma.channelContact.update({
                    where: { id: c.id },
                    data: { tags: cleanTags([...c.tags, ...add]).filter((t) => !remove.has(t)) },
                }),
            ),
        );
        await this.publishFor(orgId, contacts.map((c) => c.id));
        return { updated: contacts.length, skipped: dto.ids.length - contacts.length };
    }

    /** Store customers to link this contact to: by search, or the ones sharing its number. */
    async customerCandidates(orgId: string, viewer: InboxViewer, contactId: string, q: string | undefined) {
        const contact = await this.load(orgId, viewer, contactId);
        const term = q?.trim();
        if (!term) return { results: await this.phoneMatches(contact) };
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
    async view(contact: ChannelContact) {
        const [customer, conversations, consent, owner, phoneMatches] = await Promise.all([
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
            // The same person on every channel, through the linked customer.
            this.prisma.conversation.findMany({
                where: contact.customerId
                    ? { organizationId: contact.organizationId, customerId: contact.customerId }
                    : { contactId: contact.id },
                select: { id: true, platform: true, status: true, lastMessageAt: true, lastMessagePreview: true, channel: { select: { name: true } } },
                orderBy: { lastMessageAt: 'desc' },
                take: 10,
            }),
            this.prisma.consentEvent.findMany({
                where: { contactId: contact.id },
                orderBy: { occurredAt: 'desc' },
                take: 10,
                select: { type: true, source: true, occurredAt: true },
            }),
            this.owner(contact),
            this.phoneMatches(contact),
        ]);
        return {
            id: contact.id,
            platform: contact.platform,
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
            conversations,
            consent,
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

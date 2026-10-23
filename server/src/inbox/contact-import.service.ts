import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus, ConsentType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../messaging/consent.service';
import { parseCsv } from '../product/csv/shopify-csv.format';
import { InboxViewer, canManageInbox } from './inbox-visibility';

const MAX_ROWS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const BATCH = 500;
const YES = /^(y|yes|true|1|opted[\s_-]?in|subscribed)$/i;

export interface ImportMapping {
    /** Header of the phone number column. */
    phone: string;
    name?: string;
    /** Header of a column of comma- or semicolon-separated tags. */
    tags?: string;
    /** Header of a yes/no column recording marketing consent. */
    optIn?: string;
    /** Attribute key → column header. */
    attributes?: Record<string, string>;
}

export interface ImportOptions {
    /** Prefixed to numbers written without a country code, e.g. "91". */
    defaultCountryCode?: string;
    /** Tags added to every imported contact. */
    tags?: string[];
    /** The business confirms everyone in the file agreed to hear from it. */
    markOptedIn?: boolean;
}

/**
 * WhatsApp digits for a spreadsheet phone cell: punctuation dropped, a
 * leading 00 read as +, and the default country code added to a number
 * that has none (10 digits or fewer). Null when it cannot be a phone number.
 */
export function normalizePhone(raw: string, defaultCountryCode?: string): string | null {
    let digits = raw.replace(/[^\d+]/g, '');
    const international = digits.startsWith('+') || digits.startsWith('00');
    digits = digits.replace(/^\+/, '').replace(/^00/, '').replace(/\D/g, '');
    if (!international) {
        // A local number (trunk 0 dropped) is ambiguous without the country it belongs to.
        const local = digits.replace(/^0+/, '');
        if (local.length <= 10) {
            if (!defaultCountryCode) return null;
            digits = `${defaultCountryCode}${local}`;
        }
    }
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export interface PlannedRow {
    digits: string;
    name: string | null;
    tags: string[];
    attributes: Record<string, string>;
    optIn: boolean;
}

/** One spreadsheet row as what it changes. Blank cells change nothing. */
export function planRow(
    cells: Record<string, string>,
    mapping: ImportMapping,
    options: ImportOptions,
): PlannedRow | { error: string } {
    const rawPhone = cells[mapping.phone]?.trim() ?? '';
    if (!rawPhone) return { error: 'No phone number' };
    const digits = normalizePhone(rawPhone, options.defaultCountryCode);
    if (!digits) return { error: `“${rawPhone}” is not a phone number with a country code` };
    const tagCell = mapping.tags ? cells[mapping.tags] ?? '' : '';
    const attributes: Record<string, string> = {};
    for (const [key, header] of Object.entries(mapping.attributes ?? {})) {
        const value = cells[header]?.trim();
        if (value) attributes[key] = value;
    }
    return {
        digits,
        name: (mapping.name ? cells[mapping.name]?.trim() : '') || null,
        tags: [...new Set([...(options.tags ?? []), ...tagCell.split(/[,;]/)].map((t) => t.trim()).filter(Boolean))],
        attributes,
        optIn: options.markOptedIn === true || (!!mapping.optIn && YES.test(cells[mapping.optIn]?.trim() ?? '')),
    };
}

/**
 * Contacts from a spreadsheet onto the WhatsApp number. Existing contacts
 * are matched by phone number; filled cells update them, tags are added to
 * the ones they have, and blank cells leave what is there. An imported
 * opt-in never overrides someone who opted out.
 */
@Injectable()
export class ContactImportService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly consent: ConsentService,
    ) { }

    preview(file: { buffer: Buffer; size: number } | undefined) {
        const rows = this.read(file);
        return { headers: rows[0] ?? [], sample: rows.slice(1, 6), rowCount: Math.max(0, rows.length - 1) };
    }

    async run(
        orgId: string,
        viewer: InboxViewer,
        file: { buffer: Buffer; size: number; originalname: string } | undefined,
        mapping: ImportMapping,
        options: ImportOptions,
    ) {
        if (!canManageInbox(viewer)) throw new ForbiddenException('Only owners, admins and managers can import contacts.');
        const rows = this.read(file);
        const headers = rows[0] ?? [];
        for (const header of [mapping.phone, mapping.name, mapping.tags, mapping.optIn, ...Object.values(mapping.attributes ?? {})]) {
            if (header && !headers.includes(header)) throw new BadRequestException(`The file has no column called “${header}”.`);
        }
        if (options.defaultCountryCode && !/^\d{1,4}$/.test(options.defaultCountryCode)) {
            throw new BadRequestException('The default country code is 1 to 4 digits, like 91.');
        }
        const channel = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { id: true },
        });
        if (!channel) throw new BadRequestException('Connect a WhatsApp number before importing contacts.');

        const errors: Array<{ row: number; error: string }> = [];
        const planned = new Map<string, PlannedRow>();
        rows.slice(1).forEach((cells, i) => {
            const plan = planRow(Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? ''])), mapping, options);
            if ('error' in plan) {
                errors.push({ row: i + 2, error: plan.error });
                return;
            }
            // The same number twice: the later row's filled cells win, tags add up.
            const prior = planned.get(plan.digits);
            planned.set(
                plan.digits,
                prior
                    ? {
                        digits: plan.digits,
                        name: plan.name ?? prior.name,
                        tags: [...new Set([...prior.tags, ...plan.tags])],
                        attributes: { ...prior.attributes, ...plan.attributes },
                        optIn: prior.optIn || plan.optIn,
                    }
                    : plan,
            );
        });

        let created = 0;
        let updated = 0;
        const plans = [...planned.values()];
        for (let i = 0; i < plans.length; i += BATCH) {
            const batch = plans.slice(i, i + BATCH);
            const digits = batch.map((p) => p.digits);
            const existing = await this.prisma.channelContact.findMany({
                where: { channelId: channel.id, OR: [{ waId: { in: digits } }, { externalId: { in: digits } }] },
                select: { id: true, organizationId: true, waId: true, externalId: true, tags: true, attributes: true, optedOutAt: true, optInAt: true },
            });
            const byDigits = new Map(existing.map((c) => [c.waId ?? c.externalId, c]));
            await this.prisma.$transaction(async (tx) => {
                for (const plan of batch) {
                    const found = byDigits.get(plan.digits);
                    if (found) {
                        await tx.channelContact.update({
                            where: { id: found.id },
                            data: {
                                ...(plan.name ? { displayName: plan.name } : {}),
                                ...(plan.tags.length ? { tags: [...new Set([...found.tags, ...plan.tags])] } : {}),
                                ...(Object.keys(plan.attributes).length
                                    ? { attributes: { ...((found.attributes as Record<string, unknown>) ?? {}), ...plan.attributes } as Prisma.InputJsonValue }
                                    : {}),
                            },
                        });
                        if (plan.optIn && !found.optedOutAt && !found.optInAt) {
                            await this.consent.record(tx, found, ConsentType.OPT_IN, 'import', { file: file!.originalname }, viewer.userId);
                        }
                        updated++;
                    } else {
                        const contact = await tx.channelContact.create({
                            data: {
                                organizationId: orgId,
                                channelId: channel.id,
                                platform: ChannelPlatform.WHATSAPP,
                                externalId: plan.digits,
                                waId: plan.digits,
                                phone: `+${plan.digits}`,
                                displayName: plan.name,
                                tags: plan.tags,
                                ...(Object.keys(plan.attributes).length ? { attributes: plan.attributes } : {}),
                            },
                            select: { id: true, organizationId: true },
                        });
                        if (plan.optIn) await this.consent.record(tx, contact, ConsentType.OPT_IN, 'import', { file: file!.originalname }, viewer.userId);
                        created++;
                    }
                }
            });
        }
        const record = await this.prisma.contactImport.create({
            data: {
                organizationId: orgId,
                channelId: channel.id,
                filename: file!.originalname,
                rowCount: rows.length - 1,
                created,
                updated,
                skipped: errors.length,
                errors: errors.slice(0, 100) as Prisma.InputJsonValue,
                createdById: viewer.userId,
            },
        });
        return { id: record.id, rowCount: rows.length - 1, created, updated, skipped: errors.length, errors: errors.slice(0, 100) };
    }

    async history(orgId: string) {
        return this.prisma.contactImport.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { id: true, filename: true, rowCount: true, created: true, updated: true, skipped: true, createdAt: true },
        });
    }

    private read(file: { buffer: Buffer; size: number } | undefined): string[][] {
        if (!file) throw new BadRequestException('Choose a CSV file.');
        if (file.size > MAX_BYTES) throw new BadRequestException('The file can be at most 5 MB.');
        const rows = parseCsv(file.buffer.toString('utf8')).filter((r) => r.some((c) => c.trim()));
        if (rows.length < 2) throw new BadRequestException('The file needs a header row and at least one contact.');
        if (rows.length - 1 > MAX_ROWS) throw new BadRequestException(`Import at most ${MAX_ROWS.toLocaleString('en-IN')} contacts at a time.`);
        rows[0] = rows[0].map((h) => h.trim());
        return rows;
    }
}

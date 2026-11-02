import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface RateRow {
    countryPrefix: string;
    label?: string | null;
    currency: string;
    marketing?: number | null;
    utility?: number | null;
    authentication?: number | null;
}

/**
 * Per-message template rates the business copies from its Meta rate card.
 * Meta publishes them per market and currency and changes them each
 * quarter, so they are the business's data, not ours.
 */
@Injectable()
export class MessageRatesService {
    constructor(private readonly prisma: PrismaService) { }

    async list(orgId: string) {
        const rows = await this.prisma.messageRate.findMany({ where: { organizationId: orgId }, orderBy: { countryPrefix: 'asc' } });
        return rows.map((r) => ({
            countryPrefix: r.countryPrefix,
            label: r.label,
            currency: r.currency,
            marketing: r.marketing?.toNumber() ?? null,
            utility: r.utility?.toNumber() ?? null,
            authentication: r.authentication?.toNumber() ?? null,
            updatedAt: r.updatedAt,
        }));
    }

    /** Replace the whole table. */
    async replace(orgId: string, rows: RateRow[]) {
        const prefixes = rows.map((r) => r.countryPrefix.trim());
        if (prefixes.some((p) => p !== '*' && !/^\d{1,4}$/.test(p))) {
            throw new BadRequestException('Country codes are 1 to 4 digits, or * for every other country.');
        }
        if (new Set(prefixes).size !== prefixes.length) throw new BadRequestException('Each country code can appear once.');
        const money = (v: number | null | undefined) => (v === null || v === undefined ? null : new Prisma.Decimal(v));
        await this.prisma.$transaction([
            this.prisma.messageRate.deleteMany({ where: { organizationId: orgId } }),
            this.prisma.messageRate.createMany({
                data: rows.map((r) => ({
                    organizationId: orgId,
                    countryPrefix: r.countryPrefix.trim(),
                    label: r.label?.trim() || null,
                    currency: r.currency.trim().toUpperCase(),
                    marketing: money(r.marketing),
                    utility: money(r.utility),
                    authentication: money(r.authentication),
                })),
            }),
        ]);
        return this.list(orgId);
    }
}

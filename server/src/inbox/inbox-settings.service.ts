import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboxSettings, parseInboxSettings, validateInboxSettings } from './inbox-settings.schema';

/** Business hours, auto-replies, routing and auto-close, stored per organization. */
@Injectable()
export class InboxSettingsService {
    constructor(private readonly prisma: PrismaService) { }

    /** The settings, and the time zone business hours are read in. */
    async get(orgId: string): Promise<{ settings: InboxSettings; timeZone: string }> {
        const org = await this.prisma.organization.findUnique({
            where: { id: orgId },
            select: { timezone: true, settings: { select: { inboxSettings: true } } },
        });
        const settings = parseInboxSettings(org?.settings?.inboxSettings);
        return { settings, timeZone: validZone(settings.businessHours.timezone) ?? validZone(org?.timezone) ?? 'UTC' };
    }

    async view(orgId: string) {
        const { settings, timeZone } = await this.get(orgId);
        return { ...settings, organizationTimeZone: timeZone };
    }

    async update(orgId: string, raw: unknown) {
        const settings = validateInboxSettings(raw);
        if (settings.businessHours.timezone && !validZone(settings.businessHours.timezone)) {
            settings.businessHours.timezone = '';
        }
        await this.prisma.organizationSettings.upsert({
            where: { organizationId: orgId },
            create: { organizationId: orgId, inboxSettings: settings as unknown as Prisma.InputJsonValue },
            update: { inboxSettings: settings as unknown as Prisma.InputJsonValue },
        });
        return this.view(orgId);
    }
}

function validZone(zone: string | null | undefined): string | null {
    if (!zone) return null;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: zone });
        return zone;
    } catch {
        return null;
    }
}

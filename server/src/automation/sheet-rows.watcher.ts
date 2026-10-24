import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationStatus, ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationEventService } from '../messaging/automation-event.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { GoogleService, SheetColumn } from '../integrations/google/google.service';
import { AutomationHooksService, fullPhone } from './automation-hooks.service';

/**
 * "A row is added to a sheet": every GOOGLE_SHEETS_POLL_SECONDS the sheets
 * that active automations watch are read, and each new row starts each of
 * them for the person in its phone column. A row raises one event per
 * automation (unique), so a second server reading the same sheet adds nothing.
 */
@Injectable()
export class SheetRowsWatcher implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SheetRowsWatcher.name);
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly google: GoogleService,
        private readonly hooks: AutomationHooksService,
        private readonly automationEvents: AutomationEventService,
        private readonly jobs: AutomationJobs,
        private readonly config: ConfigService,
    ) { }

    onModuleInit() {
        const seconds = this.config.get<number>('google.pollSeconds') ?? 120;
        this.timer = setInterval(() => void this.tick(), seconds * 1000);
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const triggers = await this.prisma.automationTrigger.findMany({
                where: { triggerType: 'crm.sheet.row', isActive: true, subjectId: { not: null }, automation: { status: AutomationStatus.ACTIVE } },
                include: { channel: { select: { id: true, platform: true } }, automation: { select: { id: true, organizationId: true } } },
            });
            const bySheet = new Map<string, typeof triggers>();
            for (const t of triggers) bySheet.set(t.subjectId!, [...(bySheet.get(t.subjectId!) ?? []), t]);
            for (const [sheetId, watching] of bySheet) {
                let fresh: Awaited<ReturnType<GoogleService['newRows']>>;
                try {
                    fresh = await this.google.newRows(sheetId);
                } catch (err) {
                    this.logger.warn(`Sheet ${sheetId} could not be read: ${err instanceof Error ? err.message : err}`);
                    continue;
                }
                for (const row of fresh.rows) {
                    for (const t of watching) await this.start(t, sheetId, fresh.columns, row);
                }
            }
        } catch (err) {
            this.logger.error(`Watching sheets failed: ${err instanceof Error ? err.stack : err}`);
        } finally {
            this.running = false;
        }
    }

    private async start(
        trigger: { automation: { id: string; organizationId: string }; channel: { id: string; platform: ChannelPlatform } | null; config: Prisma.JsonValue },
        sheetId: string,
        columns: SheetColumn[],
        row: { number: number; cells: string[] },
    ): Promise<void> {
        if (!trigger.channel) return;
        const phoneColumn = (((trigger.config ?? {}) as { phoneField?: string }).phoneField ?? '').trim();
        const index = columns.findIndex((c) => c.header.toLowerCase() === phoneColumn.toLowerCase() || c.key === phoneColumn);
        const digits = index >= 0 ? fullPhone(row.cells[index]) : null;
        if (!digits) {
            await this.google.noteSkipped(sheetId, `Row ${row.number} has no phone number with its country code in “${phoneColumn}”.`);
            return;
        }
        const contact = await this.hooks.contactFor(trigger.automation.organizationId, trigger.channel, digits).catch(() => null);
        if (!contact) return;
        const vars = {
            'sheet.row': String(row.number),
            ...Object.fromEntries(columns.map((c, i) => [`sheet.${c.key}`, (row.cells[i] ?? '').slice(0, 500)])),
        };
        try {
            const event = await this.automationEvents.record(this.prisma, {
                organizationId: trigger.automation.organizationId,
                channelId: trigger.channel.id,
                eventType: 'crm.sheet.row',
                externalId: `${trigger.automation.id}:${sheetId}:${row.number}`,
                occurredAt: new Date(),
                contactId: contact.id,
                actorExternalId: contact.externalId,
                payload: { automationId: trigger.automation.id, sheetId, vars },
            });
            await this.jobs.event(event.id);
        } catch (err) {
            // Already raised for this automation and row.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
            throw err;
        }
    }
}

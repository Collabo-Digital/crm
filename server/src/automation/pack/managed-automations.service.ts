import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AutomationStatus, ChannelPlatform, ChannelStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { PACK_LANGUAGE, templatePack, type PackSet, type PackSlot } from '../../campaigns/templates/pack/template-pack';
import { pickPackTemplate, type PackTemplateRow } from '../../campaigns/templates/pack/pick-pack-template';
import { parseDefinition, triggerTypeFor, type StepDef } from '../blocks/definition.schema';
import { AutomationService, type AutomationListRow } from '../automation.service';
import { withRedisLock } from '../engine/redis-lock';
import { readCartDiscount, type CartDiscount } from './cart-discount';
import { MANAGED_AUTOMATIONS, MANAGED_BY_KEY, registryMatch, templateSlotsIn, type PackSettings } from './managed-automations';
import { packStateOf, slotStanding, type PackState } from './pack-state';

/** Slots by key; their category and title do not depend on the app's address. */
const SLOTS = new Map<string, PackSlot>(templatePack('').map((s) => [s.key, s]));

export type WithPackState<T> = T & { packKey: string | null; packState: PackState | null; packNote: string | null };

interface SyncOptions {
    /** Pack keys to put live once their templates are approved (the turn-on route). */
    turnOn?: string[];
    /** The cart discount changed: rebuild the cart recovery for it. */
    rebuildCart?: boolean;
}

/**
 * The automations of Collabo's recommended template pack (registry in
 * managed-automations.ts): made for the organization's current WhatsApp
 * account once it has a pack, put live when their templates are approved,
 * and reported on the automations list. An automation the merchant edited
 * away from the registry is theirs: it is reported, never changed.
 */
@Injectable()
export class ManagedAutomationsService {
    private readonly logger = new Logger(ManagedAutomationsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly automations: AutomationService,
        private readonly redis: RedisService,
    ) { }

    /**
     * Bring them up to date: make the missing ones, and put live each one
     * waiting to go live whose templates are all approved. One sync per
     * organization at a time, on every server. `turnOn` asks for these to go
     * live too; `rebuildCart` follows a change of the cart discount.
     */
    async sync(orgId: string, opts: SyncOptions = {}): Promise<void> {
        await withRedisLock(this.redis, `automation:pack-sync:${orgId}`, () => this.syncNow(orgId, opts), { ttlMs: 120_000, waitMs: 30_000 });
    }

    /** The automations list's pack fields, for every row (null on the merchant's own). */
    async withPackState<T extends { id: string; status: AutomationStatus; packKey: string | null }>(orgId: string, rows: T[]): Promise<Array<WithPackState<T>>> {
        const pack = rows.filter((r) => r.packKey);
        if (!pack.length) return rows.map((r) => ({ ...r, packState: null, packNote: null }));
        const found = await this.packOf(orgId);
        const [templates, details, merchant] = await Promise.all([
            found ? this.packTemplates(orgId, found.wabaId) : Promise.resolve([]),
            this.prisma.automation.findMany({ where: { id: { in: pack.map((r) => r.id) } }, select: { id: true, definition: true, activateWhenReady: true } }),
            this.prisma.automationTrigger.findMany({
                where: { organizationId: orgId, isActive: true, automation: { status: AutomationStatus.ACTIVE, packKey: null } },
                select: { triggerType: true, automation: { select: { name: true } } },
            }),
        ]);
        const byId = new Map(details.map((d) => [d.id, d]));
        return rows.map((row) => {
            const detail = row.packKey ? byId.get(row.id) : undefined;
            if (!detail) return { ...row, packState: null, packNote: null };
            let steps: StepDef[] = [];
            try {
                steps = parseDefinition(detail.definition);
            } catch {
                // A draft that no longer parses: reported by its status alone.
            }
            const triggerType = steps[0] ? triggerTypeFor(steps[0]) : null;
            const slots = templateSlotsIn(steps).flatMap((key) => {
                const slot = SLOTS.get(key);
                return slot ? [slotStanding(templates, slot)] : [];
            });
            const entry = MANAGED_BY_KEY.get(row.packKey!);
            // One the merchant edited never goes live by itself (sync leaves it alone).
            const edited = !entry || registryMatch(entry, detail.definition, found?.settings ?? { cartDiscount: null }) === 'edited';
            const { state, note } = packStateOf({
                status: row.status,
                activateWhenReady: detail.activateWhenReady && !edited,
                slots,
                duplicateOf: merchant.find((t) => t.triggerType === triggerType)?.automation.name ?? null,
            });
            return { ...row, packState: state, packNote: note };
        });
    }

    /** Ask for these recommended automations to go live (by default every one that is on by default). */
    async turnOn(orgId: string, keys?: string[]): Promise<{ automations: Array<WithPackState<AutomationListRow>> }> {
        const chosen = keys ?? MANAGED_AUTOMATIONS.filter((m) => m.defaultOn).map((m) => m.packKey);
        const unknown = chosen.find((k) => !MANAGED_BY_KEY.has(k));
        if (unknown) throw new BadRequestException(`There is no recommended automation called “${unknown}”.`);
        await this.sync(orgId, { turnOn: chosen });
        return { automations: await this.list(orgId) };
    }

    /**
     * Save the cart-recovery discount (null removes it) and rebuild the cart
     * recovery for it: the third reminder exists only with a discount.
     */
    async setCartDiscount(orgId: string, input: CartDiscount | null): Promise<{ cartDiscount: CartDiscount | null }> {
        if (input && !input.text.trim()) throw new BadRequestException('Say what the code takes off, like ₹200 or 10%.');
        const discount: CartDiscount | null = input ? { code: input.code.toUpperCase(), text: input.text.trim(), validDays: input.validDays } : null;
        const found = await this.packOf(orgId);
        if (!found) throw new BadRequestException('Set up the recommended WhatsApp templates first.');
        // One key of the pack's settings, patched in place: the template pack writes others.
        const settings = Prisma.sql`CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END`;
        if (discount) {
            await this.prisma.$executeRaw`
                UPDATE "template_packs" SET "settings" = jsonb_set(${settings}, '{cartDiscount}', ${JSON.stringify(discount)}::jsonb), "updated_at" = now()
                WHERE "id" = ${found.pack.id}
            `;
        } else {
            await this.prisma.$executeRaw`
                UPDATE "template_packs" SET "settings" = ${settings} - 'cartDiscount', "updated_at" = now()
                WHERE "id" = ${found.pack.id}
            `;
        }
        await this.sync(orgId, { rebuildCart: true });
        return { cartDiscount: discount };
    }

    /** The organization's pack automations as list rows, in the registry's order. */
    async list(orgId: string): Promise<Array<WithPackState<AutomationListRow>>> {
        const order = MANAGED_AUTOMATIONS.map((m) => m.packKey);
        const rows = (await this.automations.packList(orgId)).sort((a, b) => order.indexOf(a.packKey ?? '') - order.indexOf(b.packKey ?? ''));
        return this.withPackState(orgId, rows);
    }

    // ─── Sync ───────────────────────────────────────────────────────────

    private async syncNow(orgId: string, opts: SyncOptions): Promise<void> {
        const found = await this.packOf(orgId);
        if (!found) return;
        const { pack, channelId, wabaId, settings } = found;
        const online = (await this.prisma.channel.count({ where: { organizationId: orgId, platform: ChannelPlatform.SHOPIFY, status: ChannelStatus.CONNECTED } })) > 0;
        const sets: PackSet[] = online ? ['core', 'online_store'] : ['core'];

        let rows = await this.packRows(orgId);
        for (const entry of MANAGED_AUTOMATIONS) {
            if (!sets.includes(entry.set) || rows.some((r) => r.packKey === entry.packKey)) continue;
            await this.automations.createSystem(orgId, {
                packKey: entry.packKey,
                name: entry.name,
                description: entry.description,
                channelId,
                steps: entry.steps(settings),
                activateWhenReady: pack.autoActivate && entry.defaultOn,
            });
        }
        rows = await this.packRows(orgId);

        const turnOn = rows
            .filter((r) => opts.turnOn?.includes(r.packKey!) && r.status !== AutomationStatus.ACTIVE && r.status !== AutomationStatus.ARCHIVED && !r.activateWhenReady)
            .filter((r) => registryMatch(MANAGED_BY_KEY.get(r.packKey!)!, r.definition, settings) !== 'edited');
        if (turnOn.length) {
            await this.prisma.automation.updateMany({ where: { id: { in: turnOn.map((r) => r.id) } }, data: { activateWhenReady: true } });
            for (const r of turnOn) r.activateWhenReady = true;
        }

        const templates = await this.packTemplates(orgId, wabaId);
        for (const row of rows) {
            const entry = MANAGED_BY_KEY.get(row.packKey!);
            if (!entry || row.status === AutomationStatus.ARCHIVED) continue;
            const match = registryMatch(entry, row.definition, settings);
            if (match === 'edited') continue;
            const steps = entry.steps(settings);
            let draft: unknown = row.definition;
            // Only on a change of the discount: at other times a draft equal to another build may be the merchant's own edit.
            if (match === 'stale' && opts.rebuildCart) {
                const saved = await this.automations.saveSystemDefinition(row.id, orgId, steps, row.definition);
                if (!saved) continue;
                draft = saved;
                if (row.status === AutomationStatus.ACTIVE) await this.publish(row.id, orgId, row.packKey!, draft);
            }
            if (!row.activateWhenReady || row.status === AutomationStatus.ACTIVE) continue;
            if (!templateSlotsIn(steps).every((slot) => this.approved(templates, slot))) continue;
            const triggerType = triggerTypeFor(steps[0]);
            const duplicate = await this.prisma.automationTrigger.findFirst({
                where: { organizationId: orgId, triggerType, isActive: true, automation: { status: AutomationStatus.ACTIVE, packKey: null } },
                select: { automation: { select: { name: true } } },
            });
            if (duplicate) {
                // Two automations on one event would message the customer twice: the merchant's own stays.
                await this.prisma.automation.update({ where: { id: row.id }, data: { activateWhenReady: false } });
                this.logger.log(`Recommended automation ${row.packKey} of ${orgId} held back: "${duplicate.automation.name}" already starts on ${triggerType}.`);
                continue;
            }
            await this.publish(row.id, orgId, row.packKey!, draft);
        }
    }

    /** Publish the draft this sync decided on; a merchant's edit or publish in the meantime wins. */
    private async publish(id: string, orgId: string, packKey: string, draft: unknown) {
        try {
            const issues = await this.automations.publishSystem(id, orgId, draft);
            if (issues === null) this.logger.log(`Recommended automation ${packKey} of ${orgId} not published: its draft was edited meanwhile.`);
            else if (issues.length) this.logger.warn(`Recommended automation ${packKey} of ${orgId} not published: ${issues.map((i) => i.code).join(', ')}`);
        } catch (err) {
            // Published by someone else at the same moment: that version number is taken.
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
            this.logger.log(`Recommended automation ${packKey} of ${orgId} was published meanwhile.`);
        }
    }

    private approved(templates: PackTemplateRow[], key: string): boolean {
        const slot = SLOTS.get(key);
        return !!slot && !!pickPackTemplate(templates, key, slot.category, PACK_LANGUAGE);
    }

    /** The pack of the organization's current WhatsApp account, with its settings. Null without one. */
    private async packOf(orgId: string) {
        const channel = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { id: true, externalStoreId: true },
        });
        if (!channel?.externalStoreId) return null;
        const pack = await this.prisma.templatePack.findUnique({ where: { wabaId: channel.externalStoreId } });
        if (!pack || pack.organizationId !== orgId) return null;
        const settings: PackSettings = { cartDiscount: readCartDiscount(pack.settings) };
        return { pack, channelId: channel.id, wabaId: channel.externalStoreId, settings };
    }

    private packRows(orgId: string) {
        return this.prisma.automation.findMany({
            where: { organizationId: orgId, packKey: { not: null } },
            select: { id: true, packKey: true, status: true, activateWhenReady: true, definition: true },
        });
    }

    private packTemplates(orgId: string, wabaId: string): Promise<PackTemplateRow[]> {
        return this.prisma.messageTemplate.findMany({
            where: { organizationId: orgId, wabaId, packSlot: { not: null } },
            select: { id: true, packSlot: true, packVersion: true, status: true, category: true, language: true, updatedAt: true },
        });
    }
}

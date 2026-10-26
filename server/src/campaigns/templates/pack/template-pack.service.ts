import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus, MessageTemplate, Prisma, TemplatePack } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MessagingMediaStorage } from '../../../messaging/media/messaging-media.storage';
import { Priority } from '../../../rate-limit/rate-limit.types';
import type { TemplateDraft } from '../template-components';
import { TemplatesService } from '../templates.service';
import { PackFields } from './pack-fields';
import { PACK_STOPPED, classifyPackFailure } from './pack-refusal';
import { latestPackTemplate, pickPackTemplate } from './pick-pack-template';
import { SAMPLE_INVOICE_FILENAME, SAMPLE_INVOICE_PDF } from './sample-invoice-pdf';
import { PACK_LANGUAGE, PackSet, PackSlot, PackVariant, TEMPLATE_PACK_VERSION, packTemplateName, templatePack } from './template-pack';
import { TemplatePackJobs } from './template-pack-jobs';
import { PackEnsureReason, claimPackRow, packPriority } from './template-pack.queue';

const HOUR = 3600_000;
/** Meta allows 100 template creations an hour per account; one at a time, a little apart, stays far below. */
const CREATE_SPACING_MS = 2_000;
/** How long a pack job waits for the account's template lock before it is put back for a minute. */
const LOCK_WAIT_MS = 5_000;
/** How often one slot moves to the next version for a name Meta already holds, in one run. */
const NAME_ATTEMPTS = 3;

/** A template of the slot at the pack's version that is not one of these is the slot's template; nothing is made for it. */
const GONE = new Set(['REJECTED', 'DISABLED', 'DELETED']);
/** Meta's verdict on the wording: it is never submitted again on this account. */
const REFUSED = new Set(['REJECTED', 'DISABLED']);
/** Still with Meta: re-read by the reconcile. */
const IN_REVIEW = new Set(['PENDING', 'IN_APPEAL', 'PAUSED']);

export interface PackSettings {
    cartDiscount?: { code: string; text: string; validDays: number };
    /** The pack version at which a slot last had its one automatic replacement. */
    replaced?: Record<string, number>;
}

export type PackSlotState = 'approved' | 'pending' | 'paused' | 'attention' | 'not_created';

export interface TemplatePackView {
    pack: null | {
        status: 'pending' | 'running' | 'ready' | 'stopped';
        origin: 'connect' | 'backfill' | 'manual';
        autoActivate: boolean;
        version: number;
        stoppedReason: string | null;
        lastRunAt: string | null;
        cartDiscount: { code: string; text: string; validDays: number } | null;
    };
    sets: PackSet[];
    slots: Array<{
        slot: string;
        set: PackSet;
        title: string;
        description: string;
        category: 'UTILITY' | 'MARKETING';
        state: PackSlotState;
        template: null | {
            id: string;
            name: string;
            status: string;
            category: string;
            requestedCategory: string | null;
            statusReason: string | null;
            rejectionInfo: { reason?: string; recommendation?: string } | null;
            qualityScore: string | null;
            source: 'library' | 'collabo';
            packVersion: number;
        };
    }>;
    counts: { total: number; approved: number; pending: number; attention: number };
}

type LiveChannel = { id: string; wabaId: string; metadata: Prisma.JsonValue };
type SlotOutcome =
    | { kind: 'created'; row: MessageTemplate }
    | { kind: 'refused' }
    | { kind: 'rate_limited' }
    | { kind: 'template_limit' }
    | { kind: 'auth' };

const settingsOf = (v: Prisma.JsonValue | null): PackSettings => (v && typeof v === 'object' && !Array.isArray(v) ? (v as PackSettings) : {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A utility-template restriction Meta put on the account (account_update
 * restriction_info, kept verbatim under `metadata.accountRestrictions`).
 */
export function utilityRestricted(metadata: Prisma.JsonValue | null, now = Date.now()): boolean {
    const list = (metadata as { accountRestrictions?: unknown } | null)?.accountRestrictions;
    return (Array.isArray(list) ? list : []).some((r) => {
        const { restriction_type: type, expiration } = (r ?? {}) as { restriction_type?: unknown; expiration?: unknown };
        const ends = Number(expiration);
        return typeof type === 'string' && /UTILITY/i.test(type) && !(Number.isFinite(ends) && ends > 0 && ends * 1000 <= now);
    });
}

const sameVariant = (t: MessageTemplate, v: PackVariant) =>
    v.source === 'library' ? t.packSource === 'library' && t.libraryTemplateName === v.libraryTemplateName : t.packSource === 'collabo';

/**
 * Collabo's recommended templates on a merchant's WhatsApp account (see
 * template-pack.ts): created in the background, one at a time, Meta's
 * Template Library first; kept in step with Meta's verdicts; and reported to
 * the templates page. Automations follow through the engine's managed-sync.
 */
@Injectable()
export class TemplatePackService {
    private readonly logger = new Logger(TemplatePackService.name);
    private readonly frontendUrl: string;
    /** Between two creates on an account. */
    spacingMs = CREATE_SPACING_MS;

    constructor(
        private readonly prisma: PrismaService,
        private readonly templates: TemplatesService,
        private readonly storage: MessagingMediaStorage,
        private readonly jobs: TemplatePackJobs,
        config: ConfigService,
    ) {
        this.frontendUrl = config.get<string>('frontendUrl') ?? '';
    }

    /** The sets that apply to the organization now. */
    async sets(orgId: string): Promise<PackSet[]> {
        const [razorpay, store] = await Promise.all([
            this.prisma.paymentAccount.findFirst({ where: { organizationId: orgId, disconnectedAt: null, credentials: { not: null } }, select: { id: true } }),
            this.prisma.channel.findFirst({ where: { organizationId: orgId, platform: ChannelPlatform.SHOPIFY, status: ChannelStatus.CONNECTED }, select: { id: true } }),
        ]);
        return ['core', ...(razorpay ? (['payment'] as const) : []), ...(store ? (['online_store'] as const) : [])];
    }

    /**
     * The `ensure` job: creates every template the account's pack is missing.
     * A pack exists only where WhatsApp connect, the start-up backfill or the
     * merchant made its row; without one this does nothing.
     */
    async ensure(orgId: string, wabaId: string, reason: PackEnsureReason): Promise<void> {
        const pack = await this.prisma.templatePack.findUnique({ where: { wabaId } });
        if (!pack || pack.organizationId !== orgId) return;
        const channel = await this.liveChannel(orgId, wabaId);
        if (!channel) return void (await this.halt(pack.id, PACK_STOPPED.disconnected));
        if (utilityRestricted(channel.metadata)) return void (await this.halt(pack.id, PACK_STOPPED.restricted));
        const priority = packPriority(reason);
        const outcome = await this.templates.withAccountLock(wabaId, () => this.fill(pack, channel, priority), LOCK_WAIT_MS);
        if (outcome === 'rate_limited') {
            this.logger.warn(`Meta's template creation limit on ${wabaId}: the pack resumes in an hour.`);
            await this.jobs.ensure(orgId, wabaId, reason, HOUR);
        }
        await this.followUp(orgId, wabaId);
    }

    private async fill(pack: TemplatePack, channel: LiveChannel, priority: Priority): Promise<'done' | 'rate_limited' | 'stopped'> {
        const orgId = pack.organizationId;
        await this.prisma.templatePack.update({ where: { id: pack.id }, data: { status: 'running', stoppedReason: null } });
        // Sync first: adopts what an earlier run, or a request Meta took without answering, made.
        await this.templates.pull(orgId, channel, { adopt: true });
        const settings = settingsOf(pack.settings);
        const slots = await this.slotsFor(orgId);
        let rows = await this.packRows(orgId, channel.wabaId);
        const pace = this.pacer();
        for (const slot of slots) {
            if (rows.some((t) => t.packSlot === slot.key && (t.packVersion ?? 0) >= TEMPLATE_PACK_VERSION && !GONE.has(t.status))) continue;
            const slotRows = rows.filter((t) => t.packSlot === slot.key);
            const variants = slot.variants.filter((v) => !slotRows.some((t) => REFUSED.has(t.status) && sameVariant(t, v)));
            if (!variants.length) continue;
            // A slot whose template Meta turned down gets one replacement per pack version.
            if (slotRows.some((t) => (t.packVersion ?? 0) >= TEMPLATE_PACK_VERSION)) {
                if (settings.replaced?.[slot.key] === TEMPLATE_PACK_VERSION) continue;
                await this.recordReplacement(pack.id, settings, slot.key);
            }
            const outcome = await this.createSlot(orgId, channel, slot, variants, rows, priority, pace);
            if (outcome.kind === 'created') rows = [...rows.filter((t) => t.id !== outcome.row.id), outcome.row];
            else if (outcome.kind === 'rate_limited') return this.finish(pack.id, 'running', 'rate_limited');
            else if (outcome.kind === 'template_limit') return this.halt(pack.id, PACK_STOPPED.templateLimit);
            else if (outcome.kind === 'auth') return this.halt(pack.id, PACK_STOPPED.auth);
        }
        const complete = slots.every((s) => rows.some((t) => t.packSlot === s.key && (t.packVersion ?? 0) >= TEMPLATE_PACK_VERSION));
        return this.finish(pack.id, complete ? 'ready' : 'running', 'done');
    }

    /** Ready once every slot of the sets has a template at this version, whatever Meta made of it. */
    private async finish<T extends 'done' | 'rate_limited'>(packId: string, status: 'ready' | 'running', outcome: T): Promise<T> {
        await this.prisma.templatePack.update({
            where: { id: packId },
            data: { status, lastRunAt: new Date(), ...(status === 'ready' ? { version: TEMPLATE_PACK_VERSION } : {}) },
        });
        return outcome;
    }

    /**
     * Creates the slot's template from the first variant Meta takes: the
     * library one is approved the moment it is made, Collabo's wording goes
     * to review. A name Meta already holds is adopted when it is the pack's
     * own template, and otherwise the next version is tried.
     */
    private async createSlot(
        orgId: string,
        channel: LiveChannel,
        slot: PackSlot,
        variants: PackVariant[],
        rows: MessageTemplate[],
        priority: Priority,
        pace: () => Promise<void>,
    ): Promise<SlotOutcome> {
        let version = TEMPLATE_PACK_VERSION;
        const taken = (v: number) => rows.some((t) => t.packSlot === slot.key && t.packVersion === v);
        while (taken(version)) version++;
        for (const variant of variants) {
            const draft = variant.source === 'collabo' ? await this.draftOf(orgId, slot, variant) : null;
            for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++, version++) {
                const name = packTemplateName(slot.key, version);
                const fields: PackFields = {
                    packSlot: slot.key,
                    packVersion: version,
                    packSource: variant.source,
                    libraryTemplateName: variant.source === 'library' ? variant.libraryTemplateName : null,
                };
                const held = await this.prisma.messageTemplate.findUnique({
                    where: { wabaId_name_language: { wabaId: channel.wabaId, name, language: PACK_LANGUAGE } },
                    select: { id: true },
                });
                if (held) continue;
                await pace();
                try {
                    const row = variant.source === 'library'
                        ? await this.templates.createFromLibrary(orgId, channel, { name, libraryTemplateName: variant.libraryTemplateName, buttonInputs: variant.buttonInputs }, fields, priority)
                        : await this.templates.submit(orgId, channel, { ...draft!, name }, { createdById: null, starterKey: null, priority, pack: fields });
                    this.logger.log(`Pack template ${name} created on ${channel.wabaId} (${variant.source}): ${row.status}.`);
                    return { kind: 'created', row };
                } catch (err) {
                    const failure = classifyPackFailure(err);
                    if (failure.kind === 'transient') throw err;
                    if (failure.kind === 'rate_limited' || failure.kind === 'template_limit' || failure.kind === 'auth') {
                        this.logger.warn(`Pack template ${name} not created on ${channel.wabaId} (${failure.kind}): ${err instanceof Error ? err.message : err}`);
                        return failure;
                    }
                    if (failure.kind === 'refused') {
                        this.logger.warn(`Meta refused pack template ${name} on ${channel.wabaId} (${variant.source}): ${failure.message}`);
                        break;
                    }
                    const adopted = (await this.templates.pullName(orgId, channel, name, priority)).find((t) => t.language === PACK_LANGUAGE);
                    if (adopted?.packSlot === slot.key && !GONE.has(adopted.status)) return { kind: 'created', row: adopted };
                }
            }
        }
        return { kind: 'refused' };
    }

    /** Collabo's wording as a draft; the GST invoice's document header gets the bundled sample. */
    private async draftOf(orgId: string, slot: PackSlot, variant: Extract<PackVariant, { source: 'collabo' }>): Promise<TemplateDraft> {
        const draft: TemplateDraft = { ...variant.draft, name: '', language: PACK_LANGUAGE, category: slot.category };
        if (slot.invoiceDocument) {
            const { storageKey } = await this.storage.save(orgId, SAMPLE_INVOICE_PDF, 'application/pdf');
            draft.header = { format: 'DOCUMENT', storageKey, mime: 'application/pdf', filename: SAMPLE_INVOICE_FILENAME };
        }
        return draft;
    }

    /**
     * The `reconcile` job: re-reads every pack template still with Meta (so
     * an approval reaches the automations even when Meta's webhook does not),
     * then follows the failure policy. A rejected or disabled template, or a
     * utility one Meta approved as marketing, is replaced once per pack
     * version from a library variant not yet used on the account; the same
     * wording is never submitted again.
     */
    async reconcile(orgId: string, wabaId: string): Promise<void> {
        const pack = await this.prisma.templatePack.findUnique({ where: { wabaId } });
        if (!pack || pack.organizationId !== orgId) return;
        const channel = await this.liveChannel(orgId, wabaId);
        if (channel) await this.templates.withAccountLock(wabaId, () => this.review(pack, channel), LOCK_WAIT_MS);
        await this.jobs.managedSync(orgId);
    }

    private async review(pack: TemplatePack, channel: LiveChannel): Promise<void> {
        const orgId = pack.organizationId;
        for (const t of await this.packRows(orgId, channel.wabaId)) {
            if (!t.externalId || !IN_REVIEW.has(t.status)) continue;
            try {
                await this.templates.refreshStatus(channel, t, Priority.NORMAL);
            } catch (err) {
                const failure = classifyPackFailure(err);
                if (failure.kind === 'rate_limited' || failure.kind === 'auth') break;
                this.logger.warn(`Pack template ${t.name} not re-read: ${err instanceof Error ? err.message : err}`);
            }
        }
        let rows = await this.packRows(orgId, channel.wabaId);
        if (rows.some((t) => t.status === 'LIMIT_EXCEEDED')) return void (await this.halt(pack.id, PACK_STOPPED.templateLimit));
        if (utilityRestricted(channel.metadata)) return void (await this.halt(pack.id, PACK_STOPPED.restricted));
        const settings = settingsOf(pack.settings);
        const pace = this.pacer();
        for (const slot of await this.slotsFor(orgId)) {
            const latest = latestPackTemplate(rows, slot.key);
            if (!latest) continue;
            if (pickPackTemplate(rows, slot.key, slot.category)?.category === slot.category) continue;
            const asMarketing = slot.category === 'UTILITY' && latest.status === 'APPROVED' && latest.category !== slot.category;
            if (!asMarketing && !REFUSED.has(latest.status)) continue;
            if (settings.replaced?.[slot.key] === TEMPLATE_PACK_VERSION) continue;
            const library = slot.variants.find((v) => v.source === 'library' && !rows.some((t) => t.packSlot === slot.key && sameVariant(t, v)));
            if (!library) continue;
            await this.recordReplacement(pack.id, settings, slot.key);
            const outcome = await this.createSlot(orgId, channel, slot, [library], rows, Priority.NORMAL, pace);
            if (outcome.kind === 'created') rows = [...rows, outcome.row];
            else if (outcome.kind === 'rate_limited') return this.jobs.reconcileIn(orgId, channel.wabaId, HOUR, 'retry');
            else if (outcome.kind === 'template_limit') return void (await this.halt(pack.id, PACK_STOPPED.templateLimit));
            else if (outcome.kind === 'auth') return void (await this.halt(pack.id, PACK_STOPPED.auth));
        }
    }

    /** What the templates page shows about the pack. */
    async view(orgId: string): Promise<TemplatePackView> {
        const channel = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { externalStoreId: true },
        });
        const wabaId = channel?.externalStoreId ?? null;
        const [pack, sets, rows] = await Promise.all([
            wabaId ? this.prisma.templatePack.findUnique({ where: { wabaId } }) : null,
            this.sets(orgId),
            wabaId ? this.packRows(orgId, wabaId) : Promise.resolve([] as MessageTemplate[]),
        ]);
        const ownPack = pack?.organizationId === orgId ? pack : null;
        const slots = templatePack(this.frontendUrl)
            .filter((s) => sets.includes(s.set))
            .map((slot) => {
                const { state, template } = slotState(rows, slot);
                return {
                    slot: slot.key,
                    set: slot.set,
                    title: slot.title,
                    description: slot.description,
                    category: slot.category as 'UTILITY' | 'MARKETING',
                    state,
                    template: template && {
                        id: template.id,
                        name: template.name,
                        status: template.status,
                        category: template.category,
                        requestedCategory: template.requestedCategory,
                        statusReason: template.statusReason,
                        rejectionInfo: template.rejectionInfo as { reason?: string; recommendation?: string } | null,
                        qualityScore: template.qualityScore,
                        source: (template.packSource ?? 'collabo') as 'library' | 'collabo',
                        packVersion: template.packVersion ?? 0,
                    },
                };
            });
        const count = (s: PackSlotState) => slots.filter((x) => x.state === s).length;
        const settings = settingsOf(ownPack?.settings ?? null);
        return {
            pack: ownPack && {
                status: ownPack.status as 'pending' | 'running' | 'ready' | 'stopped',
                origin: ownPack.origin as 'connect' | 'backfill' | 'manual',
                autoActivate: ownPack.autoActivate,
                version: ownPack.version,
                stoppedReason: ownPack.stoppedReason,
                lastRunAt: ownPack.lastRunAt?.toISOString() ?? null,
                cartDiscount: settings.cartDiscount ?? null,
            },
            sets,
            slots,
            counts: { total: slots.length, approved: count('approved'), pending: count('pending'), attention: count('attention') },
        };
    }

    /**
     * Sets up, or repairs, the pack on the organization's account from the
     * templates page. A pack made here does not switch its automations on by
     * itself; the merchant does that.
     */
    async start(orgId: string): Promise<TemplatePackView> {
        const channel = await this.templates.channelFor(orgId);
        await claimPackRow(this.prisma, { organizationId: orgId, channelId: channel.id, wabaId: channel.wabaId, autoActivate: false, origin: 'manual' });
        await this.jobs.ensure(orgId, channel.wabaId, 'manual');
        return this.view(orgId);
    }

    /** After a run: the engine's automations follow, and templates in review are re-read later. */
    private async followUp(orgId: string, wabaId: string) {
        await this.jobs.managedSync(orgId);
        const inReview = await this.prisma.messageTemplate.count({
            where: { organizationId: orgId, wabaId, packSlot: { not: null }, status: { in: ['PENDING', 'IN_APPEAL'] } },
        });
        if (inReview) await this.jobs.reconcileLater(orgId, wabaId);
    }

    private liveChannel(orgId: string, wabaId: string): Promise<LiveChannel | null> {
        return this.prisma.channel
            .findFirst({
                where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, externalStoreId: wabaId, status: { not: ChannelStatus.DISCONNECTED } },
                select: { id: true, metadata: true },
            })
            .then((c) => (c ? { id: c.id, wabaId, metadata: c.metadata } : null));
    }

    private packRows(orgId: string, wabaId: string) {
        return this.prisma.messageTemplate.findMany({ where: { organizationId: orgId, wabaId, packSlot: { not: null } } });
    }

    private async slotsFor(orgId: string): Promise<PackSlot[]> {
        const sets = await this.sets(orgId);
        return templatePack(this.frontendUrl).filter((s) => sets.includes(s.set));
    }

    /** Merged in Postgres: the cart discount in the same settings is written by the automations' routes. */
    private async recordReplacement(packId: string, settings: PackSettings, slot: string) {
        settings.replaced = { ...settings.replaced, [slot]: TEMPLATE_PACK_VERSION };
        await this.prisma.$executeRaw`
            UPDATE "template_packs"
            SET "settings" = jsonb_set(
                    coalesce("settings", '{}'::jsonb),
                    '{replaced}',
                    coalesce("settings" -> 'replaced', '{}'::jsonb) || jsonb_build_object(${slot}::text, ${TEMPLATE_PACK_VERSION}::int)
                ),
                "updated_at" = now()
            WHERE "id" = ${packId}
        `;
    }

    private async halt(packId: string, reason: string): Promise<'stopped'> {
        this.logger.warn(`Template pack ${packId} stopped: ${reason}`);
        await this.prisma.templatePack.update({ where: { id: packId }, data: { status: 'stopped', stoppedReason: reason, lastRunAt: new Date() } });
        return 'stopped';
    }

    /** One create at a time, `spacingMs` apart. */
    private pacer() {
        let last = 0;
        return async () => {
            const wait = last + this.spacingMs - Date.now();
            if (last && wait > 0) await sleep(wait);
            last = Date.now();
        };
    }
}

/**
 * A slot's state and the template shown for it: the one it sends with when
 * one is approved, otherwise its newest.
 */
export function slotState(rows: MessageTemplate[], slot: Pick<PackSlot, 'key' | 'category'>): { state: PackSlotState; template: MessageTemplate | null } {
    const best = pickPackTemplate(rows, slot.key, slot.category);
    if (best) return { state: best.category === slot.category ? 'approved' : 'attention', template: best };
    const latest = latestPackTemplate(rows, slot.key);
    if (!latest) return { state: 'not_created', template: null };
    if (latest.status === 'PENDING' || latest.status === 'IN_APPEAL') return { state: 'pending', template: latest };
    if (latest.status === 'PAUSED') return { state: 'paused', template: latest };
    return { state: 'attention', template: latest };
}

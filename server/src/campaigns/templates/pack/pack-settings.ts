import { Prisma } from '@prisma/client';

/**
 * TemplatePack.settings. The pack job, the template routes and the automation
 * routes (the cart discount) each write their own keys, so every write is one
 * statement that changes only its key; a read-modify-write could undo another
 * writer's change made meanwhile.
 */
export interface PackSettings {
    cartDiscount?: { code: string; text: string; validDays: number };
    /** The pack version at which a slot last had its one automatic replacement. */
    replaced?: Record<string, number>;
    /** Slots Meta refused every variant of, at that pack version: not tried again until Repair. */
    refused?: Record<string, { version: number; reason: string; at: string }>;
    /** Slots whose template the merchant deleted in Collabo: not made again until Repair. */
    removed?: Record<string, true>;
    /** Hourly retries after Meta's limits since the last run that finished; capped. */
    requeues?: number;
    /** The sample invoice PDF saved for the GST invoice template's header, reused. */
    sampleInvoice?: string;
}

export const packSettingsOf = (v: Prisma.JsonValue | null): PackSettings =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as PackSettings) : {};

export type PackRowWhere = { id: string } | { wabaId: string; organizationId: string };

const where = (w: PackRowWhere) =>
    'id' in w ? Prisma.sql`"id" = ${w.id}` : Prisma.sql`"waba_id" = ${w.wabaId} AND "organization_id" = ${w.organizationId}`;

const SETTINGS = Prisma.sql`CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END`;

/** settings[key][entry] = value. */
export function setPackEntrySql(w: PackRowWhere, key: 'replaced' | 'refused' | 'removed', entry: string, value: unknown): Prisma.Sql {
    return Prisma.sql`
        UPDATE "template_packs"
        SET "settings" = jsonb_set(
                ${SETTINGS},
                ARRAY[${key}]::text[],
                CASE WHEN jsonb_typeof(${SETTINGS} -> ${key}) = 'object' THEN ${SETTINGS} -> ${key} ELSE '{}'::jsonb END
                    || jsonb_build_object(${entry}::text, ${JSON.stringify(value)}::jsonb)
            ),
            "updated_at" = now()
        WHERE ${where(w)}
    `;
}

/** settings[key] = value. */
export function setPackSettingSql(w: PackRowWhere, key: 'requeues' | 'sampleInvoice', value: unknown): Prisma.Sql {
    return Prisma.sql`
        UPDATE "template_packs"
        SET "settings" = jsonb_set(${SETTINGS}, ARRAY[${key}]::text[], ${JSON.stringify(value)}::jsonb), "updated_at" = now()
        WHERE ${where(w)}
    `;
}

/** Removes these keys from settings. */
export function dropPackSettingsSql(w: PackRowWhere, keys: Array<keyof PackSettings>): Prisma.Sql {
    return Prisma.sql`
        UPDATE "template_packs"
        SET "settings" = ${SETTINGS} - ${keys}::text[], "updated_at" = now()
        WHERE ${where(w)}
    `;
}

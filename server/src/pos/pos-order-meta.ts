import { Prisma } from '@prisma/client';

/** What a bill keeps on `Order.metadata.pos`. */
export interface PosOrderMeta {
    storeId: string;
    roundOff: number;
    clientSaleId: string;
}

export function readPosMeta(metadata: Prisma.JsonValue | null | undefined): PosOrderMeta | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const pos = (metadata as Record<string, unknown>).pos;
    if (!pos || typeof pos !== 'object' || Array.isArray(pos)) return null;
    const p = pos as Record<string, unknown>;
    return {
        storeId: typeof p.storeId === 'string' ? p.storeId : '',
        roundOff: typeof p.roundOff === 'number' ? p.roundOff : 0,
        clientSaleId: typeof p.clientSaleId === 'string' ? p.clientSaleId : '',
    };
}

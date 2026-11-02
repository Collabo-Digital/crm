import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { readStoreLinkToken, storeLinkKey } from '../../../commerce/store-links';
import { isKnownCourierUrl } from '../../../order/known-couriers';

export type PublicOrderStatus = 'confirmed' | 'shipped' | 'out_for_delivery' | 'delivered' | 'cancelled';

export interface PublicOrderLink {
    storeName: string;
    order: {
        name: string;
        status: PublicOrderStatus;
        carrier: string | null;
        trackingNumber: string | null;
        trackingUrl: string | null;
        /** The page opens a known courier's tracking at once; any other address waits for the customer to choose it. */
        knownCourier: boolean;
    };
}

export interface PublicCartLink {
    storeName: string;
    url: string | null;
    completed: boolean;
}

const INVALID = "This link isn't valid.";
/** Shopify's fulfilment states that never left the warehouse. */
const NOT_SHIPPED = new Set(['cancelled', 'error', 'failure']);

/** An address a browser may be sent to: https only, or http too for a courier's page. */
function safeUrl(url: string | null | undefined, protocols: string[]): string | null {
    if (!url) return null;
    try {
        return protocols.includes(new URL(url).protocol) ? url : null;
    } catch {
        return null;
    }
}

const storeNameOf = (org: { name: string; settings: { storeProfileSettings: Prisma.JsonValue } | null }) =>
    ((org.settings?.storeProfileSettings as { storeName?: string } | null)?.storeName ?? '').trim() || org.name;

/**
 * What the links in the pack's order and cart messages open: the order's
 * status and its courier's tracking, and the abandoned checkout. Public,
 * because customers have no login; the signed token is the only key, and
 * nothing about the customer (name, phone, address) is given out.
 */
@Injectable()
export class PublicLinksService {
    private readonly key: Buffer;

    constructor(
        private readonly prisma: PrismaService,
        config: ConfigService,
    ) {
        // As bill links: customers open these long after the message.
        this.key = storeLinkKey(config.get<string>('encryptionKey') || config.get<string>('jwt.accessSecret')!);
    }

    async order(token: string): Promise<PublicOrderLink> {
        const id = readStoreLinkToken(this.key, 'order', token);
        const order = id
            ? await this.prisma.order.findFirst({
                where: { id, deletedAt: null },
                select: {
                    name: true,
                    cancelledAt: true,
                    fulfillmentStatus: true,
                    organization: { select: { name: true, settings: { select: { storeProfileSettings: true } } } },
                    fulfillments: {
                        select: { status: true, trackingNumber: true, trackingUrl: true, trackingCompany: true, deliveredAt: true, outForDeliveryAt: true },
                        orderBy: { createdAt: 'desc' },
                    },
                },
            })
            : null;
        if (!order) throw new NotFoundException(INVALID);
        const shipments = order.fulfillments.filter((f) => !NOT_SHIPPED.has(f.status.toLowerCase()));
        const status: PublicOrderStatus = order.cancelledAt
            ? 'cancelled'
            : shipments.some((f) => f.deliveredAt || f.status.toLowerCase() === 'delivered')
                ? 'delivered'
                : shipments.some((f) => f.outForDeliveryAt)
                    ? 'out_for_delivery'
                    : shipments.length || order.fulfillmentStatus === 'FULFILLED' || order.fulfillmentStatus === 'PARTIAL'
                        ? 'shipped'
                        : 'confirmed';
        const tracked = shipments.find((f) => f.trackingUrl || f.trackingNumber) ?? null;
        const trackingUrl = safeUrl(tracked?.trackingUrl, ['https:', 'http:']);
        return {
            storeName: storeNameOf(order.organization),
            order: {
                name: order.name,
                status,
                carrier: tracked?.trackingCompany || null,
                trackingNumber: tracked?.trackingNumber || null,
                trackingUrl,
                knownCourier: isKnownCourierUrl(trackingUrl),
            },
        };
    }

    async cart(token: string): Promise<PublicCartLink> {
        const id = readStoreLinkToken(this.key, 'cart', token);
        const checkout = id
            ? await this.prisma.checkout.findUnique({
                where: { id },
                select: { recoveryUrl: true, completedAt: true, organization: { select: { name: true, settings: { select: { storeProfileSettings: true } } } } },
            })
            : null;
        if (!checkout) throw new NotFoundException(INVALID);
        return {
            storeName: storeNameOf(checkout.organization),
            url: safeUrl(checkout.recoveryUrl, ['https:']),
            completed: !!checkout.completedAt,
        };
    }
}

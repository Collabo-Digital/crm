import { Injectable, NotFoundException } from '@nestjs/common';
import { GstType, InvoiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { readStoredTaxLines } from '../channel/shopify-push.service';
import { PosCatalogService } from './pos-catalog.service';
import { readPosMeta } from './pos-sale.service';
import { round2 } from './pos-pricing';

type ReceiptLine = {
    title: string;
    variantTitle: string | null;
    hsn: string | null;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxableValue: number;
    gstRate: number | null;
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
};

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const sum = (values: number[]) => round2(values.reduce((s, v) => s + v, 0));

/** "12 MG Road, Kochi, Kerala 682016" from an address blob in the app's canonical keys. */
function addressLine(a: unknown): string | null {
    if (!a || typeof a !== 'object') return null;
    const r = a as Record<string, unknown>;
    const part = (k: string) => {
        const v = r[k];
        return typeof v === 'string' ? v.trim() : '';
    };
    const text = [part('address1'), part('address2'), part('city'), [part('province'), part('zip')].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ');
    return text || null;
}

/**
 * Everything a till prints on a receipt. Tax comes from the GST invoice when
 * one was issued — the statutory figures — and otherwise from the tax the
 * sale charged on each line. Served under Orders, so a cashier without the
 * Invoices section can still print one.
 */
@Injectable()
export class PosReceiptService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgSettings: OrganizationSettingsService,
        private readonly catalog: PosCatalogService,
    ) { }

    async receipt(orgId: string, orderId: string) {
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId, deletedAt: null },
            include: {
                lineItems: {
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    include: { variant: { select: { hsnCode: true, product: { select: { hsnCode: true } } } } },
                },
                payments: { orderBy: { createdAt: 'asc' } },
                customer: { select: { firstName: true, lastName: true, phone: true, gstin: true } },
                posStaff: { select: { name: true } },
                dispatchWarehouse: { select: { name: true } },
                invoices: {
                    where: { status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] } },
                    include: { lineItems: true },
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                },
            },
        });
        if (!order) throw new NotFoundException('That bill was not found.');

        const [settings, profile, org, defaultGstin] = await Promise.all([
            this.catalog.settings(orgId),
            this.orgSettings.getStoreProfileSettings(orgId),
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, logo: true, gstEnabled: true } }),
            this.prisma.organizationGstin.findFirst({
                where: { organizationId: orgId, isActive: true },
                orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
                select: { gstin: true, address: true },
            }),
        ]);
        const invoice = order.invoices[0] ?? null;
        const storeName = profile.storeName.trim() || org?.name || '';

        const lines: ReceiptLine[] = order.lineItems.map((li) => {
            const quantity = li.quantity;
            const unitPrice = num(li.price);
            const discount = num(li.totalDiscount);
            const base = {
                title: li.title,
                variantTitle: li.variantTitle,
                quantity,
                unitPrice,
                discount,
            };
            const invoiced = invoice?.lineItems.find((x) => x.orderLineItemId === li.id);
            if (invoiced) {
                return {
                    ...base,
                    hsn: invoiced.hsnCode,
                    taxableValue: num(invoiced.taxableValue),
                    gstRate: num(invoiced.gstRate),
                    cgst: num(invoiced.cgstAmount),
                    sgst: num(invoiced.sgstAmount),
                    igst: num(invoiced.igstAmount),
                    total: num(invoiced.totalAmount),
                };
            }
            const taxLines = readStoredTaxLines(li.channelTaxLines);
            const head = (title: string) => sum(taxLines.filter((t) => t.title.toUpperCase() === title).map((t) => Number(t.price)));
            const tax = li.channelTaxAmount != null ? num(li.channelTaxAmount) : sum(taxLines.map((t) => Number(t.price)));
            const charged = round2(unitPrice * quantity - discount);
            return {
                ...base,
                hsn: li.variant?.hsnCode ?? li.variant?.product?.hsnCode ?? null,
                taxableValue: order.taxesIncluded ? round2(charged - tax) : charged,
                gstRate: taxLines.length ? round2(taxLines.reduce((s, t) => s + t.rate, 0) * 100) : null,
                cgst: head('CGST'),
                sgst: head('SGST'),
                igst: head('IGST'),
                total: order.taxesIncluded ? charged : round2(charged + tax),
            };
        });

        const byRate = new Map<number, { rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
        for (const l of lines) {
            if (l.gstRate === null) continue;
            const row = byRate.get(l.gstRate) ?? { rate: l.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
            row.taxable = round2(row.taxable + l.taxableValue);
            row.cgst = round2(row.cgst + l.cgst);
            row.sgst = round2(row.sgst + l.sgst);
            row.igst = round2(row.igst + l.igst);
            byRate.set(l.gstRate, row);
        }

        const total = num(order.totalPrice);
        const roundOff = readPosMeta(order.metadata)?.roundOff ?? 0;
        const payable = round2(total + roundOff);
        const paid = sum(order.payments.map((p) => num(p.amount)));
        const posMeta = readPosMeta(order.metadata);

        return {
            width: settings.receiptWidth,
            footer: settings.receiptFooter,
            store: {
                name: storeName,
                address:
                    addressLine({ ...profile }) ??
                    addressLine(invoice?.sellerAddress) ??
                    (org?.gstEnabled ? addressLine(defaultGstin?.address) : null),
                phone: profile.supportPhone.trim() || null,
                gstin: invoice?.sellerGstin ?? (org?.gstEnabled ? (defaultGstin?.gstin ?? null) : null),
                logoUrl: profile.logoUrl.trim() || org?.logo || null,
            },
            order: {
                id: order.id,
                name: order.name,
                createdAt: order.createdAt.toISOString(),
                staffName: order.posStaff?.name ?? null,
                storeName: order.dispatchWarehouse?.name ?? (posMeta?.storeId === 'default' ? storeName : null),
            },
            invoice: invoice
                ? {
                    number: invoice.invoiceNumber,
                    date: invoice.invoiceDate.toISOString(),
                    placeOfSupply: invoice.placeOfSupplyName || invoice.placeOfSupply || null,
                    gstType: invoice.gstType === GstType.IGST ? ('INTER' as const) : ('INTRA' as const),
                }
                : null,
            customer: order.customer
                ? {
                    name: [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ') || null,
                    phone: order.customer.phone,
                    gstin: order.customer.gstin,
                }
                : null,
            lines,
            totals: {
                subtotal: sum(lines.map((l) => l.unitPrice * l.quantity)),
                discount: sum(lines.map((l) => l.discount)),
                taxable: sum(lines.map((l) => l.taxableValue)),
                cgst: sum(lines.map((l) => l.cgst)),
                sgst: sum(lines.map((l) => l.sgst)),
                igst: sum(lines.map((l) => l.igst)),
                roundOff,
                total,
                payable,
            },
            gstSummary: [...byRate.values()].sort((a, b) => a.rate - b.rate),
            payments: order.payments.map((p) => ({
                method: p.method,
                amount: num(p.amount),
                tendered: p.tendered != null ? num(p.tendered) : null,
                change: p.tendered != null ? round2(num(p.tendered) - num(p.amount)) : null,
                reference: p.reference,
            })),
            paid,
            balanceDue: Math.max(0, round2(payable - paid)),
        };
    }
}

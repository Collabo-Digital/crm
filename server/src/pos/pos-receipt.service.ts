import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GstType, InvoiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { parseInvoiceSettings } from '../organization-settings/schemas/invoice-settings.schema';
import { readStoredTaxLines } from '../channel/shopify-push.service';
import { billLinkPrefix } from '../campaigns/templates/template-starters';
import { COMPOSITION_LINE, addressLine, businessIds, returnsOf, upiPayUri } from '../invoice/render/build-parts';
import { readRenderSnapshot } from '../invoice/render/render-snapshot';
import { PosCatalogService } from './pos-catalog.service';
import { billLinkKey, billToken, maskPhone } from './pos-bill-link';
import { readPosMeta } from './pos-order-meta';
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

/** The key bill links are signed with and the address they open, as both the receipt and the bill service make them. */
export function billLinks(config: ConfigService): { key: Buffer; prefix: string } {
    return {
        key: billLinkKey(config.get<string>('encryptionKey') || config.get<string>('jwt.accessSecret')!),
        prefix: billLinkPrefix(config.get<string>('frontendUrl') ?? ''),
    };
}

/** When the receipt was first printed, kept at `metadata.pos.printedAt`. */
function printedAt(metadata: Prisma.JsonValue | null): string | null {
    const pos = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).pos : null;
    const at = pos && typeof pos === 'object' && !Array.isArray(pos) ? (pos as Record<string, unknown>).printedAt : null;
    return typeof at === 'string' ? at : null;
}

/**
 * Everything a till prints on a receipt. Tax comes from the GST invoice when
 * one was issued — the statutory figures — and otherwise from the tax the
 * sale charged on each line. Served under Orders, so a cashier without the
 * Invoices section can still print one.
 */
@Injectable()
export class PosReceiptService {
    private readonly links: { key: Buffer; prefix: string };

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgSettings: OrganizationSettingsService,
        private readonly catalog: PosCatalogService,
        config: ConfigService,
    ) {
        this.links = billLinks(config);
    }

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

        const [settings, profile, org, defaultGstin, settingsRow] = await Promise.all([
            this.catalog.settings(orgId),
            this.orgSettings.getStoreProfileSettings(orgId),
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, logo: true, gstEnabled: true } }),
            this.prisma.organizationGstin.findFirst({
                where: { organizationId: orgId, isActive: true },
                orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
                select: { gstin: true, legalName: true, address: true },
            }),
            this.prisma.organizationSettings.findUnique({ where: { organizationId: orgId }, select: { invoiceSettings: true } }),
        ]);
        const invoice = order.invoices[0] ?? null;
        const storeName = profile.storeName.trim() || org?.name || '';
        // How the receipt looks follows the current settings; what kind of
        // document it is follows the invoice, which keeps the type it was issued as.
        const design = parseInvoiceSettings(settingsRow?.invoiceSettings ?? null);
        const snapshot = invoice ? readRenderSnapshot(invoice.metadata) : null;

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
        // A, B… by ascending rate: each item line carries its letter instead of its tax.
        const gstSummary = [...byRate.values()].sort((a, b) => a.rate - b.rate).map((row, i) => ({ ...row, code: String.fromCharCode(65 + i) }));
        const codes = new Map(gstSummary.map((row) => [row.rate, row.code]));

        const total = num(order.totalPrice);
        const roundOff = readPosMeta(order.metadata)?.roundOff ?? 0;
        const payable = round2(total + roundOff);
        const paid = sum(order.payments.map((p) => num(p.amount)));
        const balanceDue = Math.max(0, round2(payable - paid));
        const posMeta = readPosMeta(order.metadata);
        const gstin = invoice?.sellerGstin ?? (org?.gstEnabled ? (defaultGstin?.gstin ?? null) : null);
        const legalName = invoice?.sellerLegalName ?? (org?.gstEnabled ? (defaultGstin?.legalName ?? null) : null);

        // The public bill link opens only a till's bills.
        const ebill = order.posSale ? { kind: 'ebill' as const, url: `${this.links.prefix}${billToken(this.links.key, order.id)}` } : null;
        const upi =
            design.receiptQr === 'upi-when-due' && balanceDue > 0 && settings.upiId
                ? {
                    kind: 'upi' as const,
                    uri: upiPayUri(settings.upiId, settings.upiPayeeName || storeName, balanceDue, invoice?.invoiceNumber ?? order.name),
                    amount: balanceDue,
                }
                : null;
        const phone = order.customer?.phone ?? null;

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
                gstin,
                logoUrl: profile.logoUrl.trim() || org?.logo || null,
                /** Printed under the store name, so null when it is the same name. */
                legalName: legalName && legalName.trim().toLowerCase() !== storeName.trim().toLowerCase() ? legalName : null,
                whatsapp: profile.whatsappPhone.trim() || null,
                ids: businessIds(design, gstin, 'onReceipt'),
            },
            document: invoice
                ? {
                    title: snapshot?.documentType === 'BILL_OF_SUPPLY' ? ('BILL OF SUPPLY' as const) : ('TAX INVOICE' as const),
                    subtitle: snapshot?.composition ? COMPOSITION_LINE : null,
                }
                : { title: 'BILL' as const, subtitle: null },
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
                    phone,
                    gstin: order.customer.gstin,
                    phoneShown: design.receiptCustomerContact === 'hide' ? null : design.receiptCustomerContact === 'mask' ? maskPhone(phone) : phone,
                }
                : null,
            lines: lines.map((l) => ({ ...l, taxCode: l.gstRate === null ? null : (codes.get(l.gstRate) ?? null) })),
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
            gstSummary,
            payments: order.payments.map((p) => ({
                method: p.method,
                amount: num(p.amount),
                tendered: p.tendered != null ? num(p.tendered) : null,
                change: p.tendered != null ? round2(num(p.tendered) - num(p.amount)) : null,
                reference: p.reference,
                at: p.createdAt.toISOString(),
            })),
            paid,
            balanceDue,
            returnPolicy: returnsOf(design),
            qr: design.receiptQr === 'off' ? null : (upi ?? ebill),
            printedBefore: printedAt(order.metadata) !== null,
        };
    }

    /**
     * Records a receipt's first print, so every later one says DUPLICATE, and
     * answers whether it had been printed before this call. One statement, so
     * two tills printing at once get one original between them.
     */
    async markPrinted(orgId: string, orderId: string): Promise<{ printedBefore: boolean }> {
        const first = await this.prisma.$executeRaw`
            UPDATE "orders"
            SET "metadata" = jsonb_set(
                coalesce("metadata", '{}'::jsonb),
                '{pos}',
                coalesce("metadata"->'pos', '{}'::jsonb) || jsonb_build_object('printedAt', ${new Date().toISOString()}::text)
            )
            WHERE "id" = ${orderId} AND "organization_id" = ${orgId} AND "deleted_at" IS NULL
                AND "metadata"->'pos'->>'printedAt' IS NULL
        `;
        if (first > 0) return { printedBefore: false };
        const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId: orgId, deletedAt: null }, select: { id: true } });
        if (!order) throw new NotFoundException('That bill was not found.');
        return { printedBefore: true };
    }
}

export type PosReceipt = Awaited<ReturnType<PosReceiptService['receipt']>>;

import { Logger, NotFoundException } from '@nestjs/common';
import { PaymentLinkStatus } from '@prisma/client';
import { promises as fs } from 'fs';
import { resolve, sep } from 'path';
import { resolveReportingTimeZone } from '../../common/utils/zoned-date.util';
import {
    InvoiceSettingsSchema,
    parseInvoiceSettings,
    type InvoiceSettings,
    type UpdateInvoiceSettingsInput,
} from '../../organization-settings/schemas/invoice-settings.schema';
import { parseStoreProfileSettings } from '../../organization-settings/schemas/store-profile-settings.schema';
import { parseTaxSettings, type TaxSettings } from '../../organization-settings/schemas/tax-settings.schema';
import { parsePosSettings } from '../../pos/pos-settings.schema';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BillContext } from './build-bill-document';
import type { InvoiceDocumentInput } from './build-invoice-document';
import { addressLine, currentBrand, currentSnapshot, type DocumentBrand } from './build-parts';
import type { DocImage } from './document-model';
import { readRenderSnapshot } from './render-snapshot';

/**
 * The database side of the builders: each function reads what one document
 * needs and hands the pure builder plain values.
 */

const logger = new Logger('InvoiceDocuments');

/** LocalImageStorage's folder. */
const UPLOADS = resolve(process.cwd(), 'uploads', 'products');

/**
 * An uploaded file's bytes, by its storage key. The image storage's own
 * `read(storageKey)` replaces this body once it exists; nothing else here
 * touches the disk.
 */
export async function readUploadedFile(storageKey: string): Promise<Buffer> {
    const path = resolve(UPLOADS, storageKey);
    if (!path.startsWith(UPLOADS + sep)) throw new Error(`${storageKey} is not an upload`);
    return fs.readFile(path);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG or JPEG by the file's first bytes, whatever its name says; null for anything else. */
export function imageOf(data: Buffer): DocImage | null {
    if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return { data, format: 'png' };
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, format: 'jpg' };
    return null;
}

/** An uploaded logo or signature, or null when there is none or it can't be used: a picture never stops a PDF. */
export async function loadDocImage(storageKey: string | null | undefined): Promise<DocImage | null> {
    if (!storageKey) return null;
    try {
        const image = imageOf(await readUploadedFile(storageKey));
        if (!image) logger.warn(`Upload ${storageKey} is not a PNG or JPEG; printing without it.`);
        return image;
    } catch (err) {
        logger.warn(`Upload ${storageKey} not read; printing without it: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

/** The organization's settings as documents read them now. */
export interface CurrentSettings {
    orgName: string;
    gstEnabled: boolean;
    /** What a sale at the till is priced in. */
    currency: string;
    timeZone: string;
    design: InvoiceSettings;
    brand: DocumentBrand;
    tax: TaxSettings;
    /** The store profile's address on one line, as the till's receipt prints it. */
    storeAddress: string | null;
}

export async function loadCurrentSettings(prisma: PrismaService, orgId: string): Promise<CurrentSettings> {
    const [org, row] = await Promise.all([
        prisma.organization.findUnique({
            where: { id: orgId },
            select: { name: true, website: true, timezone: true, currency: true, gstEnabled: true },
        }),
        prisma.organizationSettings.findUnique({
            where: { organizationId: orgId },
            select: { invoiceSettings: true, taxSettings: true, storeProfileSettings: true, posSettings: true },
        }),
    ]);
    if (!org) throw new NotFoundException('Organization not found');
    const profile = parseStoreProfileSettings(row?.storeProfileSettings ?? null);
    return {
        orgName: org.name,
        gstEnabled: org.gstEnabled,
        currency: (org.currency || 'INR').toUpperCase(),
        timeZone: resolveReportingTimeZone(org),
        design: parseInvoiceSettings(row?.invoiceSettings ?? null),
        brand: currentBrand(org, profile, parsePosSettings(row?.posSettings ?? null).upiId),
        tax: parseTaxSettings(row?.taxSettings ?? null),
        storeAddress: addressLine(profile),
    };
}

/** An invoice or credit note with its order as it is now, its snapshot and its pictures. */
export async function loadInvoiceDocument(prisma: PrismaService, orgId: string, invoiceId: string): Promise<InvoiceDocumentInput> {
    const [invoice, settings] = await Promise.all([
        prisma.invoice.findFirst({
            where: { id: invoiceId, organizationId: orgId },
            include: {
                lineItems: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
                creditNoteFor: { select: { invoiceNumber: true, invoiceDate: true } },
                order: {
                    select: {
                        name: true,
                        createdAt: true,
                        externalCreatedAt: true,
                        financialStatus: true,
                        paymentGateways: true,
                        posSale: true,
                        metadata: true,
                        shippingAddress: true,
                        customer: { select: { phone: true, email: true } },
                        lineItems: { select: { id: true, title: true, variantTitle: true, sku: true } },
                        fulfillments: {
                            where: { OR: [{ trackingNumber: { not: null } }, { trackingCompany: { not: null } }] },
                            orderBy: { createdAt: 'desc' },
                            take: 1,
                            select: { trackingCompany: true, trackingNumber: true },
                        },
                        payments: { orderBy: { createdAt: 'asc' }, select: { method: true, amount: true, reference: true, createdAt: true } },
                        paymentLinks: {
                            where: { status: PaymentLinkStatus.PAID },
                            orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
                            take: 1,
                            select: { provider: true, paymentMethod: true, paymentId: true, amountPaid: true, paidAt: true },
                        },
                        timeline: { where: { action: 'paid' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
                    },
                },
            },
        }),
        loadCurrentSettings(prisma, orgId),
    ]);
    if (!invoice) throw new NotFoundException('Invoice not found');

    const snapshot = readRenderSnapshot(invoice.metadata) ?? currentSnapshot(settings.design, settings.brand);
    const [logo, signature] = await Promise.all([loadDocImage(snapshot.brand.logoStorageKey), loadDocImage(snapshot.design.signature?.storageKey)]);
    const { order } = invoice;
    const link = order.paymentLinks[0];
    const tracking = order.fulfillments[0];
    const meta = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? (order.metadata as Record<string, unknown>) : {};
    return {
        invoice: {
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            status: invoice.status,
            cancelledAt: invoice.cancelledAt,
            currency: invoice.currency,
            gstType: invoice.gstType,
            reverseCharge: invoice.reverseCharge,
            sellerLegalName: invoice.sellerLegalName,
            sellerGstin: invoice.sellerGstin,
            sellerAddress: invoice.sellerAddress,
            sellerStateCode: invoice.sellerStateCode,
            sellerStateName: invoice.sellerStateName,
            dispatchName: invoice.dispatchName,
            dispatchAddress: invoice.dispatchAddress,
            buyerName: invoice.buyerName,
            buyerGstin: invoice.buyerGstin,
            buyerAddress: invoice.buyerAddress,
            buyerStateCode: invoice.buyerStateCode,
            buyerStateName: invoice.buyerStateName,
            placeOfSupply: invoice.placeOfSupply,
            placeOfSupplyName: invoice.placeOfSupplyName,
            subtotal: Number(invoice.subtotal),
            totalCgst: Number(invoice.totalCgst),
            totalSgst: Number(invoice.totalSgst),
            totalIgst: Number(invoice.totalIgst),
            shippingCharge: Number(invoice.shippingCharge),
            grandTotal: Number(invoice.grandTotal),
            notes: invoice.notes,
            creditNoteReason: invoice.creditNoteReason,
            lineItems: invoice.lineItems.map((li) => ({
                orderLineItemId: li.orderLineItemId,
                description: li.description,
                hsnCode: li.hsnCode,
                unitOfMeasure: li.unitOfMeasure,
                quantity: li.quantity,
                unitPrice: Number(li.unitPrice),
                discount: Number(li.discount),
                taxableValue: Number(li.taxableValue),
                gstRate: Number(li.gstRate),
                cgstRate: Number(li.cgstRate),
                cgstAmount: Number(li.cgstAmount),
                sgstRate: Number(li.sgstRate),
                sgstAmount: Number(li.sgstAmount),
                igstRate: Number(li.igstRate),
                igstAmount: Number(li.igstAmount),
                totalAmount: Number(li.totalAmount),
            })),
        },
        original: invoice.creditNoteFor,
        order: {
            name: order.name,
            placedAt: order.externalCreatedAt ?? order.createdAt,
            financialStatus: order.financialStatus,
            paymentGateways: order.paymentGateways,
            paymentMethod: typeof meta.paymentMethod === 'string' ? meta.paymentMethod : null,
            posSale: order.posSale,
            shippingAddress: order.shippingAddress,
            customer: order.customer,
            lineItems: order.lineItems,
            tracking: tracking ? { company: tracking.trackingCompany, number: tracking.trackingNumber } : null,
            payments: order.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
            paymentLink: link ? { ...link, amountPaid: Number(link.amountPaid) } : null,
            paidEventAt: order.timeline[0]?.createdAt ?? null,
        },
        snapshot,
        logo,
        signature,
        timeZone: settings.timeZone,
        defaultUnit: settings.tax.defaultUnitOfMeasure,
    };
}

/** What a till's bill prints besides its receipt: the current settings and logo. */
export async function loadBillContext(prisma: PrismaService, orgId: string): Promise<BillContext> {
    const settings = await loadCurrentSettings(prisma, orgId);
    return {
        design: settings.design,
        brand: settings.brand,
        logo: await loadDocImage(settings.brand.logoStorageKey),
        timeZone: settings.timeZone,
        currency: settings.currency,
    };
}

/** The registration a preview prints: the organization's own GSTIN when it has GST, else none. */
export interface PreviewRegistration {
    gstin: string;
    legalName: string;
    address: unknown;
    stateCode: string;
    stateName: string;
}

/** What a preview needs: the settings being edited over the saved ones, the real seller when there is one, the pictures. */
export interface PreviewContext {
    settings: CurrentSettings;
    design: InvoiceSettings;
    registration: PreviewRegistration | null;
    logo: DocImage | null;
    signature: DocImage | null;
}

export async function loadPreviewContext(prisma: PrismaService, orgId: string, edits: UpdateInvoiceSettingsInput = {}): Promise<PreviewContext> {
    const [settings, registration] = await Promise.all([
        loadCurrentSettings(prisma, orgId),
        // The default registration, else the oldest active one: the till's choice.
        prisma.organizationGstin.findFirst({
            where: { organizationId: orgId, isActive: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            select: { gstin: true, legalName: true, address: true, stateCode: true, stateName: true },
        }),
    ]);
    // Merged like a save, but never written: the signature stays the uploaded one.
    const design = InvoiceSettingsSchema.parse({ ...settings.design, ...edits });
    const [logo, signature] = await Promise.all([loadDocImage(settings.brand.logoStorageKey), loadDocImage(design.signature?.storageKey)]);
    return { settings, design, registration: settings.gstEnabled ? registration : null, logo, signature };
}

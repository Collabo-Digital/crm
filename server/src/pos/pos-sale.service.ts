import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, InvoiceStatus, OrderFinancialStatus, PosStaff, Prisma, ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CounterSaleOptions, OrderService } from '../order/order.service';
import { CreateOfflineOrderDto } from '../order/dto/create-offline-order.dto';
import { extractOrderShopifySync } from '../order/order-shopify-sync.util';
import { InvoiceService } from '../invoice/invoice.service';
import { CommerceEventsService } from '../commerce/commerce-events.service';
import { ShopifyPushService } from '../channel/shopify-push.service';
import { ShopifyOAuthService } from '../channel/shopify-oauth.service';
import { ShopifyGraphqlClient } from '../channel/shopify-graphql.client';
import { ORDER_MARK_AS_PAID_MUTATION, OrderMarkAsPaidResponse, OrderMarkAsPaidVariables } from '../channel/shopify-graphql.types';
import { ensureManualChannel } from '../channel/ensure-manual-channel';
import { countryCodeOf, normalizePhone, phoneLookupVariants } from '../common/phone.util';
import { extractStateFromAddress } from '../gst/place-of-supply.util';
import { getStateName } from '../gst/constants/indian-states';
import { PosCatalogService } from './pos-catalog.service';
import { PosStaffService } from './pos-staff.service';
import { PosWhatsAppService } from './pos-whatsapp.service';
import { BillDelivery, PosBillService } from './pos-bill.service';
import { PosOrderMeta, readPosMeta } from './pos-order-meta';
import { PosSettings } from './pos-settings.schema';
import { PosApprovalReason, PosTokenClaims } from './pos-tokens';
import { CollectPaymentInput, SaleCustomerInput, SaleInput } from './pos-requests.schema';
import {
    discountNeedsApproval,
    mainPaymentMethod,
    payableFor,
    paymentStatus,
    round2,
    rupees,
    settlePayments,
    spreadDiscounts,
} from './pos-pricing';

export type PosSaleResult = {
    orderId: string;
    orderName: string;
    total: number;
    payable: number;
    roundOff: number;
    paid: number;
    balanceDue: number;
    change: number;
    financialStatus: 'PAID' | 'PARTIALLY_PAID' | 'PENDING';
    invoiceId: string | null;
    invoiceNumber: string | null;
    customerId: string | null;
    /** The bill's public page, sent to the customer. */
    billUrl: string;
    delivery: BillDelivery[];
};

/** A customer already on file that the bill is for, as the sale needs them. */
const buyerSelect = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    gstin: true,
    billingStateCode: true,
    defaultAddress: true,
} satisfies Prisma.CustomerSelect;
type Buyer = Prisma.CustomerGetPayload<{ select: typeof buyerSelect }>;

/** Thrown inside the sale's transaction when a retry of the same bill finds the first one saved. */
class SaleAlreadySaved extends Error {
    constructor(readonly orderId: string) {
        super('This sale was already saved.');
    }
}

/** The hidden product custom lines are billed on. Archived and deleted, so no list or search shows it. */
export const CUSTOM_ITEM_EXTERNAL_ID = 'pos_custom_item';

/**
 * Ringing up a bill: prices and discounts worked out on the server, manager
 * approvals checked, then the sale made by `createOfflineOrder` — the same
 * stock, GST, invoice, Shopify and loyalty path as the offline order form —
 * with the payments saved in its transaction.
 */
@Injectable()
export class PosSaleService {
    private readonly logger = new Logger(PosSaleService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orders: OrderService,
        private readonly catalog: PosCatalogService,
        private readonly staff: PosStaffService,
        private readonly whatsapp: PosWhatsAppService,
        private readonly bills: PosBillService,
        private readonly invoices: InvoiceService,
        private readonly commerceEvents: CommerceEventsService,
        private readonly shopifyPush: ShopifyPushService,
        private readonly shopifyOAuth: ShopifyOAuthService,
        private readonly graphql: ShopifyGraphqlClient,
    ) { }

    async createSale(orgId: string, userId: string, input: SaleInput): Promise<PosSaleResult> {
        // The same bill sent again (a retry after a dropped connection) is the bill already made.
        const saved = await this.findSale(orgId, input.clientSaleId);
        if (saved) return this.result(orgId, saved);

        const settings = await this.catalog.settings(orgId);
        const staff = await this.staffFor(orgId, userId, input.staffToken, settings.requireStaffPin);
        const customer = identifiedCustomer(input.customer);
        let phone: string | null = null;
        if (customer?.phone) {
            phone = normalizePhone(customer.phone, 'IN');
            if (!phone) throw new BadRequestException('Enter a valid phone number for the customer.');
        }
        if (settings.customerAtCheckout === 'required' && !phone && !customer?.customerId) {
            throw new BadRequestException("Add the customer's mobile number to bill.");
        }
        const store = await this.catalog.resolveStore(orgId, input.storeId);
        const lines = await this.priceLines(orgId, input);
        const buyer = customer ? await this.findBuyer(orgId, customer, phone) : null;
        const approval = await this.checkApprovals(orgId, userId, settings, lines, input.approvalToken);

        // GST rule 46: a bill of the store's limit or more names the buyer and their address.
        const address = customer?.address ? billingAddress(customer.address) : null;
        const savedAddress = !address && buyer && hasStatedAddress(buyer.defaultAddress) ? buyer.defaultAddress : null;
        const named = !!customer?.name?.trim() || !!(buyer?.firstName || buyer?.lastName);
        let overLimit = false;

        let order: { id: string; customerId: string | null };
        let change = 0;
        try {
            const dto: CreateOfflineOrderDto = {
                customer: customer ? customerFields(customer, buyer, phone) : {},
                lineItems: lines.items.map((l, i) => ({
                    productVariantId: l.variantId,
                    quantity: l.quantity,
                    unitPriceOverride: l.unitPrice,
                    discount: lines.discounts[i],
                })),
                ...(store.warehouseId ? { warehouseId: store.warehouseId } : {}),
                ...(sellsAtStoreState(customer, buyer) && store.stateCode ? { placeOfSupplyCode: store.stateCode } : {}),
                ...(address ? { billingAddress: address } : {}),
                // `settle` writes the method to the order; a bill paid later has none yet.
                paymentMethod: mainPaymentMethod(input.payments) ?? 'OTHER',
                ...(input.note ? { note: input.note } : {}),
            };
            const options: CounterSaleOptions = {
                walkIn: !customer,
                customTitles: lines.items.map((l) => l.customTitle),
                pos: { staffId: staff?.id ?? null },
                settle: (grandTotal) => {
                    const { payable, roundOff } = payableFor(grandTotal, settings.roundOff);
                    const limit = settings.customerRequiredAbove;
                    overLimit = limit !== null && payable >= limit - 0.005;
                    if (overLimit && !(named && (address || savedAddress))) {
                        throw new BadRequestException(`GST rules need the buyer's name and address on bills of ${wholeRupees(limit!)} or more.`);
                    }
                    const settled = settlePayments(input.payments, payable);
                    change = settled.change;
                    const pos: PosOrderMeta = { storeId: store.id, roundOff, clientSaleId: input.clientSaleId };
                    return {
                        financialStatus: paymentStatus(settled.paid, payable),
                        metadata: { paymentMethod: mainPaymentMethod(input.payments), pos },
                    };
                },
                inTransaction: async (tx, order) => {
                    // Two copies of one bill racing: the Serializable transaction
                    // makes one of them see the other here, or fail and retry into it.
                    const twin = await tx.order.findFirst({
                        where: { organizationId: orgId, posSale: true, id: { not: order.id }, metadata: { path: ['pos', 'clientSaleId'], equals: input.clientSaleId } },
                        select: { id: true },
                    });
                    if (twin) throw new SaleAlreadySaved(twin.id);
                    if (buyer && customer) await fillBuyer(tx, orgId, buyer.id, customer, phone);
                    // The invoice, made after this, prints the address the customer already had.
                    if (overLimit && savedAddress) {
                        await tx.order.update({ where: { id: order.id }, data: { billingAddress: savedAddress as Prisma.InputJsonValue } });
                    }
                    if (input.payments.length) {
                        await tx.orderPayment.createMany({
                            data: input.payments.map((p) => ({
                                organizationId: orgId,
                                orderId: order.id,
                                method: p.method,
                                amount: p.amount,
                                tendered: p.method === 'CASH' && p.tendered != null ? p.tendered : null,
                                reference: p.reference || null,
                                posStaffId: staff?.id ?? null,
                                receivedById: userId,
                            })),
                        });
                    }
                    await this.staff.log(
                        orgId,
                        'sale',
                        {
                            posStaffId: staff?.id ?? null,
                            approvedById: approval?.staff ?? null,
                            orderId: order.id,
                            deviceUserId: userId,
                            details: {
                                clientSaleId: input.clientSaleId,
                                storeId: store.id,
                                ...(approval ? { approval: { reason: approval.reason, approvalId: approval.jti } } : {}),
                            },
                        },
                        tx,
                    );
                },
            };

            ({ order } = await this.orders.createOfflineOrder(orgId, userId, dto, options));
        } catch (err) {
            if (approval) await this.staff.releaseApproval(approval);
            if (err instanceof SaleAlreadySaved) return this.result(orgId, err.orderId);
            throw err;
        }

        // The sale is made: from here a failure only leaves the opt-in unrecorded or the bill unsent.
        const raw = phone ?? buyer?.phone ?? null;
        const billPhone = raw ? { raw, e164: phone ?? normalizePhone(raw, countryCodeOf(buyer?.defaultAddress) ?? 'IN') } : null;
        const name = customer?.name?.trim() || [buyer?.firstName, buyer?.lastName].filter(Boolean).join(' ') || null;
        if (customer?.offersOptIn && order.customerId && billPhone?.e164) {
            await this.whatsapp.optIn(orgId, userId, { customerId: order.customerId, e164: billPhone.e164, name }, order.id).catch((err) =>
                this.logger.warn(`WhatsApp opt-in for order ${order.id} not recorded: ${err instanceof Error ? err.message : err}`),
            );
        }
        if (billPhone) {
            await this.bills
                .afterSale(orgId, userId, { orderId: order.id, staffId: staff?.id ?? null, phone: billPhone, customerId: order.customerId, name, autoSend: settings.autoSendBill })
                .catch((err) => this.logger.warn(`Bill for order ${order.id} not sent: ${err instanceof Error ? err.message : err}`));
        }
        return this.result(orgId, order.id, change);
    }

    /** Takes a payment towards a bill's balance. */
    async collectPayment(orgId: string, userId: string, orderId: string, input: CollectPaymentInput): Promise<PosSaleResult> {
        const settings = await this.catalog.settings(orgId);
        const staff = await this.staffFor(orgId, userId, input.staffToken, settings.requireStaffPin);
        let change = 0;
        let becamePaid = false;
        await this.prisma.$transaction(async (tx) => {
            // One collection at a time per bill, so two tills cannot both take the last of a balance.
            await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} AND "organization_id" = ${orgId} FOR UPDATE`;
            const order = await tx.order.findFirst({
                where: { id: orderId, organizationId: orgId, deletedAt: null, posSale: true },
                include: { payments: { select: { amount: true } } },
            });
            if (!order) throw new NotFoundException('That bill was not found.');
            if (order.cancelledAt) throw new BadRequestException("This bill was cancelled, so it can't take a payment.");
            const payable = round2(Number(order.totalPrice) + (readPosMeta(order.metadata)?.roundOff ?? 0));
            const paidBefore = round2(order.payments.reduce((sum, p) => sum + Number(p.amount), 0));
            const balance = round2(payable - paidBefore);
            if (balance <= 0) throw new BadRequestException('This bill is already paid in full.');
            if (input.amount > balance + 0.005) {
                throw new BadRequestException(`That's more than the balance due of ${rupees(balance)}.`);
            }
            change = settlePayments([input], balance).change;
            await tx.orderPayment.create({
                data: {
                    organizationId: orgId,
                    orderId,
                    method: input.method,
                    amount: input.amount,
                    tendered: input.method === 'CASH' && input.tendered != null ? input.tendered : null,
                    reference: input.reference || null,
                    posStaffId: staff?.id ?? null,
                    receivedById: userId,
                },
            });
            const status = paymentStatus(round2(paidBefore + input.amount), payable);
            if (status !== order.financialStatus) {
                await tx.order.update({ where: { id: orderId }, data: { financialStatus: status } });
            }
            becamePaid = status === OrderFinancialStatus.PAID && order.financialStatus !== OrderFinancialStatus.PAID;
            await tx.orderTimelineEvent.create({
                data: {
                    orderId,
                    actorId: userId,
                    action: becamePaid ? 'paid' : 'payment',
                    message: `${rupees(input.amount)} collected at the point of sale (${input.method})`,
                },
            });
            await this.staff.log(orgId, 'payment', { posStaffId: staff?.id ?? null, orderId, deviceUserId: userId, details: { method: input.method, amount: input.amount } }, tx);
        });

        if (becamePaid) {
            // The same follow-ups as marking an order paid: never throwing, after the commit.
            await this.invoices.autoInvoiceForPaidOrder(orgId, orderId);
            await this.commerceEvents.order(orderId, ['paid']);
            await this.markPaidOnShopify(orgId, orderId);
        }
        return this.result(orgId, orderId, change);
    }

    async result(orgId: string, orderId: string, change?: number): Promise<PosSaleResult> {
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId },
            include: {
                payments: { select: { method: true, amount: true, tendered: true } },
                invoices: {
                    where: { status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] } },
                    select: { id: true, invoiceNumber: true },
                    take: 1,
                },
            },
        });
        if (!order) throw new NotFoundException('That bill was not found.');
        // A bill whose delivery can't be read is still a sale made.
        const delivery = await this.bills.delivery(orgId, order.metadata).catch((err) => {
            this.logger.warn(`Bill delivery of order ${order.id} not read: ${err instanceof Error ? err.message : err}`);
            return [];
        });
        const total = Number(order.totalPrice);
        const roundOff = readPosMeta(order.metadata)?.roundOff ?? 0;
        const payable = round2(total + roundOff);
        const paid = round2(order.payments.reduce((sum, p) => sum + Number(p.amount), 0));
        const cashChange = round2(
            order.payments.reduce((sum, p) => sum + (p.tendered != null ? Number(p.tendered) - Number(p.amount) : 0), 0),
        );
        const stored = order.financialStatus;
        return {
            orderId: order.id,
            orderName: order.name,
            total,
            payable,
            roundOff,
            paid,
            balanceDue: Math.max(0, round2(payable - paid)),
            change: change ?? cashChange,
            financialStatus:
                stored === OrderFinancialStatus.PAID || stored === OrderFinancialStatus.PARTIALLY_PAID || stored === OrderFinancialStatus.PENDING
                    ? stored
                    : paymentStatus(paid, payable) as 'PAID' | 'PARTIALLY_PAID' | 'PENDING',
            invoiceId: order.invoices[0]?.id ?? null,
            invoiceNumber: order.invoices[0]?.invoiceNumber ?? null,
            customerId: order.customerId,
            billUrl: this.bills.billUrl(order.id),
            delivery,
        };
    }

    private async findSale(orgId: string, clientSaleId: string): Promise<string | null> {
        const order = await this.prisma.order.findFirst({
            where: { organizationId: orgId, posSale: true, metadata: { path: ['pos', 'clientSaleId'], equals: clientSaleId } },
            select: { id: true },
        });
        return order?.id ?? null;
    }

    /** The staff member the till is unlocked for: required when the store asks for PINs, and never a stale one. */
    private async staffFor(orgId: string, userId: string, token: string | undefined, required: boolean): Promise<PosStaff | null> {
        if (!token) {
            if (required) throw new ForbiddenException('Unlock the till with your staff PIN first.');
            return null;
        }
        const staff = await this.staff.staffFromToken(orgId, userId, token);
        if (!staff) throw new ForbiddenException('The till has locked. Unlock it with your staff PIN again.');
        return staff;
    }

    /**
     * Each line's variant, unit price and absolute discount. Product lines
     * take the catalogue price unless the cashier typed one; custom lines go
     * on the hidden custom-item variant for their GST rate and HSN.
     */
    private async priceLines(orgId: string, input: SaleInput) {
        const variantIds = input.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
        if (new Set(variantIds).size !== variantIds.length) {
            throw new BadRequestException('A product is on the bill twice. Change the quantity on one line instead.');
        }
        const [variants, org] = await Promise.all([
            this.prisma.productVariant.findMany({
                where: { id: { in: variantIds }, product: { organizationId: orgId, deletedAt: null } },
                select: { id: true, price: true, product: { select: { title: true, status: true, channel: { select: { currency: true } } } } },
            }),
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { currency: true } }),
        ]);
        if (variants.length !== variantIds.length) {
            throw new BadRequestException('A product on this bill is no longer in the catalogue. Remove it and add it again.');
        }
        const catalogue = await this.catalog.cataloguePrices((org?.currency || 'INR').toUpperCase(), variants);
        const byId = new Map(variants.map((v, i) => [v.id, { variant: v, price: catalogue[i] }]));

        const customVariants = new Map<string, string>();
        const items: Array<{ variantId: string; quantity: number; unitPrice: number; customTitle: string | null; overridden: boolean }> = [];
        for (const line of input.lines) {
            if (line.custom) {
                const key = `${line.custom.gstRate ?? ''}|${line.custom.hsn ?? ''}`;
                if (!customVariants.has(key)) {
                    customVariants.set(key, await this.customItemVariant(orgId, line.custom.gstRate ?? null, line.custom.hsn ?? null));
                }
                items.push({ variantId: customVariants.get(key)!, quantity: line.quantity, unitPrice: round2(line.custom.unitPrice), customTitle: line.custom.title, overridden: false });
                continue;
            }
            const { variant, price } = byId.get(line.variantId!)!;
            if (variant.product.status !== ProductStatus.ACTIVE) {
                throw new BadRequestException(`“${variant.product.title}” is not on sale. Make it active to sell it.`);
            }
            if (line.unitPrice === undefined && price === null) {
                throw new BadRequestException(`“${variant.product.title}” is priced in another currency and no exchange rate is available right now. Type the price to sell it.`);
            }
            const unitPrice = line.unitPrice !== undefined ? round2(line.unitPrice) : price!;
            items.push({
                variantId: variant.id,
                quantity: line.quantity,
                unitPrice,
                customTitle: null,
                overridden: line.unitPrice !== undefined && (price === null || Math.abs(unitPrice - price) >= 0.005),
            });
        }
        const gross = items.map((l) => round2(l.unitPrice * l.quantity));
        const discounts = spreadDiscounts(
            input.lines.map((l, i) => ({ gross: gross[i], discount: l.discount })),
            input.cartDiscount,
        );
        return {
            items,
            discounts,
            gross: round2(gross.reduce((s, g) => s + g, 0)),
            totalDiscount: round2(discounts.reduce((s, d) => s + d, 0)),
        };
    }

    /**
     * A manager's approval, when the bill's discount is over the store's limit
     * or a price was changed and the store asks for approval. Used up here, and
     * given back by the caller if the sale then fails. When both apply, one
     * approval of either kind covers the bill: the manager saw all of it.
     */
    private async checkApprovals(
        orgId: string,
        userId: string,
        settings: PosSettings,
        lines: { items: Array<{ overridden: boolean }>; gross: number; totalDiscount: number },
        token: string | undefined,
    ): Promise<PosTokenClaims | null> {
        const needs: PosApprovalReason[] = [];
        if (discountNeedsApproval(settings.discountApprovalPercent, lines.totalDiscount, lines.gross)) needs.push('discount');
        if (settings.priceOverrideNeedsApproval && lines.items.some((l) => l.overridden)) needs.push('price_override');
        if (!needs.length) return null;

        const refusal = needs[0] === 'discount' ? "This discount needs a manager's PIN." : "Changing the price needs a manager's PIN.";
        if (!token) throw new BadRequestException(refusal);
        const claims = this.staff.readApproval(orgId, userId, token);
        if (!claims) throw new BadRequestException('This manager approval has expired. Ask for the PIN again.');
        if (!claims.reason || !needs.includes(claims.reason)) throw new BadRequestException(refusal);
        if (claims.reason === 'discount' && claims.amount !== undefined && lines.totalDiscount > claims.amount + 0.005) {
            throw new BadRequestException(`The manager approved a discount of up to ${rupees(claims.amount)}; this bill's is ${rupees(lines.totalDiscount)}.`);
        }
        if (!(await this.staff.consumeApproval(claims))) {
            throw new BadRequestException('This manager approval was already used. Ask for the PIN again.');
        }
        return claims;
    }

    /**
     * The customer on file the bill is for: by id, else by phone, else by
     * email — one customer per email, so a new one cannot take it. Null for
     * someone new, whom the sale creates.
     */
    private async findBuyer(orgId: string, c: SaleCustomerInput, phone: string | null): Promise<Buyer | null> {
        if (c.customerId) {
            const known = await this.prisma.customer.findFirst({ where: { id: c.customerId, organizationId: orgId }, select: buyerSelect });
            if (!known) throw new NotFoundException('That customer was not found.');
            return known;
        }
        const byPhone = phone
            ? await this.prisma.customer.findFirst({
                where: { organizationId: orgId, deletedAt: null, phone: { in: phoneLookupVariants(phone) } },
                orderBy: [{ ordersCount: 'desc' }, { updatedAt: 'desc' }],
                select: buyerSelect,
            })
            : null;
        if (byPhone || !c.email) return byPhone;
        return this.prisma.customer.findFirst({ where: { organizationId: orgId, deletedAt: null, email: c.email }, select: buyerSelect });
    }

    /** The org's custom-item variant for this GST rate and HSN, made on first use. */
    private async customItemVariant(orgId: string, gstRate: number | null, hsn: string | null): Promise<string> {
        const channel = await ensureManualChannel(this.prisma, orgId);
        const product = await this.findOrCreate(
            () => this.prisma.product.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: CUSTOM_ITEM_EXTERNAL_ID } }, select: { id: true } }),
            () =>
                this.prisma.product.create({
                    data: {
                        organizationId: orgId,
                        channelId: channel.id,
                        externalId: CUSTOM_ITEM_EXTERNAL_ID,
                        title: 'Custom item',
                        status: ProductStatus.ARCHIVED,
                        // Hidden from every product list, search, stock screen and push.
                        deletedAt: new Date(),
                        metadata: { posCustomItem: true },
                    },
                    select: { id: true },
                }),
        );
        const externalId = `pos_custom_${gstRate ?? 'default'}_${hsn ?? 'none'}`;
        const variant = await this.findOrCreate(
            () => this.prisma.productVariant.findUnique({ where: { productId_externalId: { productId: product.id, externalId } }, select: { id: true } }),
            () =>
                this.prisma.productVariant.create({
                    data: {
                        productId: product.id,
                        organizationId: orgId,
                        externalId,
                        title: [gstRate !== null ? `GST ${gstRate}%` : 'Default GST', hsn ? `HSN ${hsn}` : null].filter(Boolean).join(' · '),
                        price: 0,
                        trackQuantity: false,
                        continueSellingWhenOutOfStock: true,
                        requiresShipping: false,
                        gstRate,
                        hsnCode: hsn,
                    },
                    select: { id: true },
                }),
        );
        return variant.id;
    }

    /** Find, else create; a create that loses a race to another reads the winner. */
    private async findOrCreate<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
        const found = await find();
        if (found) return found;
        try {
            return await create();
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                const raced = await find();
                if (raced) return raced;
            }
            throw err;
        }
    }

    /**
     * A bill already on Shopify that is now paid in full is marked paid there
     * too. One not pushed yet needs nothing: the push sends the payments as
     * they stand. Best effort, like the push itself.
     */
    private async markPaidOnShopify(orgId: string, orderId: string): Promise<void> {
        try {
            const order = await this.prisma.order.findFirst({
                where: { id: orderId, organizationId: orgId },
                select: { externalId: true, metadata: true, channel: { select: { id: true, platform: true } } },
            });
            if (!order) return;
            const onShopify = order.channel.platform === ChannelPlatform.SHOPIFY;
            const sync = extractOrderShopifySync(order.metadata);
            const shopifyOrderId = onShopify ? order.externalId : sync?.status === 'SYNCED' ? sync.shopifyOrderId : undefined;
            if (!shopifyOrderId) return;
            const channelId = onShopify ? order.channel.id : (await this.shopifyPush.findShopifyChannel(orgId))?.id;
            if (!channelId) return;
            const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(channelId);
            const res = await this.graphql.request<OrderMarkAsPaidResponse, OrderMarkAsPaidVariables>(
                { shopDomain, accessToken: token },
                ORDER_MARK_AS_PAID_MUTATION,
                { input: { id: ShopifyGraphqlClient.toGid('Order', shopifyOrderId) } },
            );
            ShopifyGraphqlClient.throwIfUserErrors(res.orderMarkAsPaid.userErrors, 'orderMarkAsPaid');
        } catch (err) {
            this.logger.warn(`Could not mark bill ${orderId} paid on Shopify: ${err instanceof Error ? err.message : err}`);
        }
    }
}

/** The customer on the bill, or null for a walk-in: an opt-in tick or an address alone names nobody. */
function identifiedCustomer(c: SaleCustomerInput | undefined): SaleCustomerInput | null {
    if (!c) return null;
    return c.customerId || c.phone || c.name?.trim() || c.email ? c : null;
}

function splitName(name: string | undefined): { firstName?: string; lastName?: string } {
    const [firstName, ...rest] = (name ?? '').trim().split(/\s+/).filter(Boolean);
    return { ...(firstName ? { firstName } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}) };
}

/**
 * The customer block `createOfflineOrder` takes: a customer on file by id,
 * with a GSTIN typed at the counter so the sale is taxed as B2B; else the
 * details it creates the new customer with.
 */
function customerFields(c: SaleCustomerInput, buyer: Buyer | null, phone: string | null): CreateOfflineOrderDto['customer'] {
    const gst = { ...(c.gstin ? { gstin: c.gstin } : {}), ...(c.billingStateCode ? { billingStateCode: c.billingStateCode } : {}) };
    if (buyer) return { customerId: buyer.id, ...gst };
    return { ...(c.email ? { email: c.email } : {}), ...(phone ? { phone } : {}), ...splitName(c.name), ...gst };
}

/**
 * A customer on file gets what the counter typed where they have nothing:
 * a name only when they have none at all, and an email only if no other
 * customer has it. Read again inside the sale's transaction.
 */
async function fillBuyer(tx: Prisma.TransactionClient, orgId: string, buyerId: string, c: SaleCustomerInput, phone: string | null): Promise<void> {
    const current = await tx.customer.findUniqueOrThrow({ where: { id: buyerId }, select: buyerSelect });
    const name = splitName(c.name);
    const data: Prisma.CustomerUpdateInput = {
        ...(name.firstName && !current.firstName && !current.lastName ? name : {}),
        ...(phone && !current.phone ? { phone } : {}),
        ...(c.gstin && !current.gstin ? { gstin: c.gstin } : {}),
        ...(c.billingStateCode && !current.billingStateCode ? { billingStateCode: c.billingStateCode } : {}),
    };
    if (c.email && !current.email && !(await tx.customer.findFirst({ where: { organizationId: orgId, email: c.email }, select: { id: true } }))) {
        data.email = c.email;
    }
    if (Object.keys(data).length) await tx.customer.update({ where: { id: buyerId }, data });
}

/**
 * Whether the place of supply is the store's own state. Goods handed over
 * at the counter are supplied where the store is; without this a store in
 * a second state would fall back to the default registration's. A buyer
 * whose state is known keeps the rule the offline order form applies.
 */
function sellsAtStoreState(c: SaleCustomerInput | null, buyer: Buyer | null): boolean {
    if (!c) return true;
    if (c.gstin || c.billingStateCode) return false;
    return !buyer?.gstin && !buyer?.billingStateCode;
}

/** The address typed at the counter, in the keys offline orders keep addresses in. */
function billingAddress(a: NonNullable<SaleCustomerInput['address']>): Record<string, string> {
    return { address1: a.address1, city: a.city, zip: a.zip, province: getStateName(a.stateCode) ?? '', stateCode: a.stateCode, country: 'India', country_code: 'IN' };
}

/** A saved address with a street and a state the invoice can name. */
function hasStatedAddress(a: Prisma.JsonValue | null): boolean {
    return !!a && typeof a === 'object' && !Array.isArray(a) && typeof a.address1 === 'string' && !!a.address1.trim() && !!extractStateFromAddress(a);
}

/** "₹50,000", or with paise when there are some. */
const wholeRupees = (n: number) => (Number.isInteger(n) ? `₹${n.toLocaleString('en-IN')}` : rupees(n));

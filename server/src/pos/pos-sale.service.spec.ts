import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderFinancialStatus, PosStaffRole, ProductStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PosSaleService } from './pos-sale.service';
import { PosStaffService } from './pos-staff.service';
import { parsePosSettings } from './pos-settings.schema';
import { SaleInput } from './pos-requests.schema';

/**
 * Ringing up a bill. The order itself is `createOfflineOrder`'s (its own specs
 * cover stock, GST and the invoice); these pin what the point of sale hands
 * it — lines, discounts, the customer, the store — and what it decides:
 * approvals, the amount to pay, payment status, payments, and replays.
 */

const ORG = 'org_1';
const USER = 'u_device';
const CLIENT_SALE_ID = '6f1c2a8e-3b7d-4c55-9a10-2b1f0e9d7c41';

interface Opts {
    settings?: Record<string, unknown>;
    /** What `createOfflineOrder` prices the sale at. */
    total?: number;
    /** A bill already saved under this clientSaleId. */
    saved?: string | null;
    /** A copy of the bill another request saved while this one ran. */
    twin?: string | null;
    warehousing?: boolean;
    /** A customer on file the sale's customer turns out to be. */
    buyer?: Record<string, unknown> | null;
    /** Another customer with the email typed. */
    emailTaken?: { id: string } | null;
}

const BUYER = { id: 'cust_9', firstName: null, lastName: null, email: null, phone: '+919800000009', gstin: null, billingStateCode: null, defaultAddress: null };

async function build(opts: Opts = {}) {
    const settings = parsePosSettings(opts.settings ?? {});
    const staffRows = [
        { id: 'st_cash', organizationId: ORG, name: 'Ravi', role: PosStaffRole.CASHIER, isActive: true, pinHash: await bcrypt.hash('1234', 4) },
        { id: 'st_mgr', organizationId: ORG, name: 'Meera', role: PosStaffRole.MANAGER, isActive: true, pinHash: await bcrypt.hash('9876', 4) },
    ];
    const store = new Map<string, unknown>();
    const redis = {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        del: jest.fn(async (k: string) => void store.delete(k)),
        acquireLock: jest.fn(async (k: string) => (store.has(k) ? false : (store.set(k, 1), true))),
        runScript: jest.fn(async () => 1),
    };
    const prisma: any = {
        posStaff: {
            findMany: jest.fn(async () => staffRows),
            findFirst: jest.fn(async ({ where }: any) => staffRows.find((s) => s.id === where.id) ?? null),
        },
        posActivity: { create: jest.fn() },
        order: { findFirst: jest.fn(async () => (opts.saved ? { id: opts.saved } : null)) },
        organization: { findUnique: jest.fn().mockResolvedValue({ currency: 'INR' }) },
        productVariant: {
            findMany: jest.fn(async ({ where }: any) =>
                [
                    { id: 'var_shirt', price: 1000, product: { title: 'Linen shirt', status: ProductStatus.ACTIVE, channel: { currency: 'INR' } } },
                    { id: 'var_cap', price: 400, product: { title: 'Cap', status: ProductStatus.ACTIVE, channel: { currency: 'INR' } } },
                    { id: 'var_draft', price: 50, product: { title: 'Draft tee', status: ProductStatus.DRAFT, channel: { currency: 'INR' } } },
                ].filter((v) => where.id.in.includes(v.id)),
            ),
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn(async ({ data }: any) => ({ id: `var_${data.externalId}` })),
        },
        product: {
            findUnique: jest.fn(async () => (prisma.product.create.mock.calls.length ? { id: 'prod_custom' } : null)),
            create: jest.fn().mockResolvedValue({ id: 'prod_custom' }),
        },
        channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
        customer: {
            // The customer on file the counter finds: by id, by phone or by email.
            findFirst: jest.fn(async () => opts.buyer ?? null),
        },
    };
    const tx = {
        order: { findFirst: jest.fn(async () => (opts.twin ? { id: opts.twin } : null)), update: jest.fn() },
        orderPayment: { createMany: jest.fn() },
        posActivity: { create: jest.fn() },
        customer: {
            findUniqueOrThrow: jest.fn(async () => opts.buyer),
            findFirst: jest.fn(async () => opts.emailTaken ?? null),
            update: jest.fn(),
        },
    };
    const orders = {
        createOfflineOrder: jest.fn(async (_org: string, _user: string, dto: any, options: any) => {
            const settled = options.settle?.(opts.total ?? 1049.6);
            const customerId = options.walkIn ? null : (dto.customer.customerId ?? 'cust_1');
            await options.inTransaction?.(tx, { id: 'order_1', customerId });
            return { order: { id: 'order_1', customerId, financialStatus: settled?.financialStatus } };
        }),
    };
    const catalog = {
        settings: jest.fn().mockResolvedValue(settings),
        resolveStore: jest.fn(async (_o: string, storeId?: string) =>
            opts.warehousing === false
                ? { id: 'default', warehouseId: null, name: 'Acme', stateCode: null }
                : { id: storeId ?? 'wh_main', warehouseId: storeId ?? 'wh_main', name: 'MG Road', stateCode: '29' },
        ),
        cataloguePrices: jest.fn(async (_c: string, variants: any[]) => variants.map((v) => Number(v.price))),
    };
    const staff = new PosStaffService(prisma, redis as any, { get: () => 'a'.repeat(32) } as any);
    const whatsapp = { optIn: jest.fn().mockResolvedValue(undefined) };
    const bills = {
        afterSale: jest.fn().mockResolvedValue(undefined),
        delivery: jest.fn().mockResolvedValue([]),
        billUrl: jest.fn((id: string) => `https://app.example.com/b/${id}.sig`),
    };
    const service = new PosSaleService(
        prisma,
        orders as any,
        catalog as any,
        staff,
        whatsapp as any,
        bills as any,
        { autoInvoiceForPaidOrder: jest.fn() } as any,
        { order: jest.fn() } as any,
        { findShopifyChannel: jest.fn() } as any,
        {} as any,
        {} as any,
    );
    const result = jest.spyOn(service, 'result').mockImplementation(async (_o, orderId, change) => ({ orderId, change }) as any);
    const call = () => orders.createOfflineOrder.mock.calls[0] as [string, string, any, any];
    return { service, orders, call, tx, prisma, staff, whatsapp, bills, catalog, result, redis };
}

const input = (over: Partial<SaleInput> = {}): SaleInput => ({
    clientSaleId: CLIENT_SALE_ID,
    lines: [{ variantId: 'var_shirt', quantity: 1 }],
    payments: [{ method: 'CASH', amount: 1050, tendered: 2000 }],
    ...over,
});

describe('PosSaleService.createSale — the bill handed to createOfflineOrder', () => {
    it('a walk-in cash sale: no customer, catalogue prices, the store as dispatch warehouse and place of supply', async () => {
        const { service, call } = await build();
        await service.createSale(ORG, USER, input());
        const [, user, dto, options] = call();
        expect(user).toBe(USER);
        expect(options.walkIn).toBe(true);
        expect(dto.customer).toEqual({});
        expect(dto.lineItems).toEqual([{ productVariantId: 'var_shirt', quantity: 1, unitPriceOverride: 1000, discount: 0 }]);
        expect(dto).toMatchObject({ warehouseId: 'wh_main', placeOfSupplyCode: '29', paymentMethod: 'CASH' });
        expect(options.pos).toEqual({ staffId: null });
    });

    it('without warehouses the bill names no store warehouse and leaves place of supply to the usual rules', async () => {
        const { service, call } = await build({ warehousing: false });
        await service.createSale(ORG, USER, input());
        const dto = call()[2];
        expect(dto).not.toHaveProperty('warehouseId');
        expect(dto).not.toHaveProperty('placeOfSupplyCode');
    });

    it('a new customer: phone in E.164, name split, and their state kept for a B2B buyer', async () => {
        const { service, call } = await build();
        await service.createSale(ORG, USER, input({ customer: { phone: '98000 00001', name: 'Asha Rani Menon', gstin: '29ABCDE1234F1Z5' } }));
        const [, , dto, options] = call();
        expect(options.walkIn).toBe(false);
        expect(dto.customer).toEqual({ phone: '+919800000001', firstName: 'Asha', lastName: 'Rani Menon', gstin: '29ABCDE1234F1Z5' });
        expect(dto).not.toHaveProperty('placeOfSupplyCode');
    });

    it('refuses a phone number that is not one', async () => {
        const { service } = await build();
        await expect(service.createSale(ORG, USER, input({ customer: { phone: '12345' } }))).rejects.toThrow('Enter a valid phone number for the customer.');
    });


    it('turns line and cart discounts into one amount off each line', async () => {
        const { service, call } = await build();
        await service.createSale(ORG, USER, input({
            lines: [
                { variantId: 'var_shirt', quantity: 1, discount: { type: 'percent', value: 10 } },
                { variantId: 'var_cap', quantity: 2 },
            ],
            cartDiscount: { type: 'amount', value: 170 },
            payments: [],
        }));
        // 900 + 800 left: ₹170 spread 90 / 80.
        expect(call()[2].lineItems.map((l: any) => l.discount)).toEqual([190, 80]);
    });

    it('refuses the same product on two lines', async () => {
        const { service } = await build();
        await expect(
            service.createSale(ORG, USER, input({ lines: [{ variantId: 'var_shirt', quantity: 1 }, { variantId: 'var_shirt', quantity: 1, unitPrice: 900 }] })),
        ).rejects.toThrow('A product is on the bill twice. Change the quantity on one line instead.');
    });

    it('refuses a product that is not on sale', async () => {
        const { service } = await build();
        await expect(service.createSale(ORG, USER, input({ lines: [{ variantId: 'var_draft', quantity: 1 }] }))).rejects.toThrow('“Draft tee” is not on sale. Make it active to sell it.');
    });
});

describe('PosSaleService.createSale — custom items', () => {
    it('bills them on the hidden custom-item variant for their GST rate and HSN, under their own title', async () => {
        const { service, call, prisma } = await build();
        await service.createSale(ORG, USER, input({
            lines: [
                { variantId: 'var_shirt', quantity: 1 },
                { custom: { title: 'Alteration', unitPrice: 150, gstRate: 5, hsn: '998821' }, quantity: 1 },
                { custom: { title: 'Hemming', unitPrice: 80, gstRate: 5, hsn: '998821' }, quantity: 1 },
                { custom: { title: 'Loose belt', unitPrice: 300 }, quantity: 1 },
            ],
            payments: [],
        }));
        const [, , dto, options] = call();
        expect(options.customTitles).toEqual([null, 'Alteration', 'Hemming', 'Loose belt']);
        expect(dto.lineItems.map((l: any) => [l.productVariantId, l.unitPriceOverride])).toEqual([
            ['var_shirt', 1000],
            ['var_pos_custom_5_998821', 150],
            ['var_pos_custom_5_998821', 80],
            ['var_pos_custom_default_none', 300],
        ]);
        // One hidden product, archived and deleted so no list shows it; one variant per rate and HSN.
        expect(prisma.product.create).toHaveBeenCalledTimes(1);
        expect(prisma.product.create.mock.calls[0][0].data).toMatchObject({ externalId: 'pos_custom_item', status: ProductStatus.ARCHIVED, deletedAt: expect.any(Date) });
        expect(prisma.productVariant.create).toHaveBeenCalledTimes(2);
        expect(prisma.productVariant.create.mock.calls[0][0].data).toMatchObject({ gstRate: 5, hsnCode: '998821', trackQuantity: false });
        expect(prisma.productVariant.create.mock.calls[1][0].data).toMatchObject({ gstRate: null, hsnCode: null });
    });

    it('reuses the hidden product and variant once made', async () => {
        const { service, call, prisma } = await build();
        prisma.product.findUnique.mockResolvedValue({ id: 'prod_custom' });
        prisma.productVariant.findUnique.mockResolvedValue({ id: 'var_existing' });
        await service.createSale(ORG, USER, input({ lines: [{ custom: { title: 'Gift wrap', unitPrice: 30 }, quantity: 1 }], payments: [] }));
        expect(prisma.product.create).not.toHaveBeenCalled();
        expect(prisma.productVariant.create).not.toHaveBeenCalled();
        expect(call()[2].lineItems[0].productVariantId).toBe('var_existing');
    });
});

describe('PosSaleService.createSale — amount to pay and payment status', () => {
    it('rounds to the rupee, keeps the round-off on the bill, and works out the status from what was paid', async () => {
        const { service, call } = await build({ total: 1049.6 });
        await service.createSale(ORG, USER, input({ payments: [{ method: 'CASH', amount: 1050, tendered: 2000 }] }));
        const settled = call()[3].settle(1049.6);
        expect(settled).toEqual({
            financialStatus: OrderFinancialStatus.PAID,
            metadata: { paymentMethod: 'CASH', pos: { storeId: 'wh_main', roundOff: 0.4, clientSaleId: CLIENT_SALE_ID } },
        });
    });

    it('hands back the change from the cash', async () => {
        const { service, result } = await build();
        await service.createSale(ORG, USER, input({ payments: [{ method: 'CASH', amount: 1050, tendered: 2000 }] }));
        expect(result).toHaveBeenCalledWith(ORG, 'order_1', 950);
    });

    it('a part-paid bill, and one to be paid later', async () => {
        const part = await build();
        await part.service.createSale(ORG, USER, input({ payments: [{ method: 'UPI', amount: 500 }] }));
        expect(part.call()[3].settle(1049.6).financialStatus).toBe(OrderFinancialStatus.PARTIALLY_PAID);

        const later = await build();
        await later.service.createSale(ORG, USER, input({ payments: [] }));
        expect(later.call()[3].settle(1049.6)).toMatchObject({ financialStatus: OrderFinancialStatus.PENDING, metadata: { paymentMethod: null } });
    });

    it('with round-off off, the exact total is due', async () => {
        const { service, call } = await build({ settings: { roundOff: false } });
        await service.createSale(ORG, USER, input({ payments: [{ method: 'CARD', amount: 1049.6 }] }));
        expect(call()[3].settle(1049.6)).toMatchObject({ financialStatus: OrderFinancialStatus.PAID, metadata: { pos: { roundOff: 0 } } });
    });

    it('refuses payments over the amount to pay', async () => {
        const { service } = await build({ total: 1049.6 });
        await expect(service.createSale(ORG, USER, input({ payments: [{ method: 'CARD', amount: 1100 }] }))).rejects.toThrow(BadRequestException);
    });

    it('saves each payment with the order, in its transaction, with who took it', async () => {
        const { service, tx } = await build();
        await service.createSale(ORG, USER, input({ payments: [{ method: 'UPI', amount: 600, reference: 'UTR123' }, { method: 'CARD', amount: 450, tendered: 500 }] }));
        expect(tx.orderPayment.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({ orderId: 'order_1', method: 'UPI', amount: 600, tendered: null, reference: 'UTR123', receivedById: USER }),
                // Only cash has money handed over.
                expect.objectContaining({ method: 'CARD', amount: 450, tendered: null }),
            ],
        });
        expect(tx.posActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'sale', orderId: 'order_1', deviceUserId: USER }) });
    });
});

describe('PosSaleService.createSale — staff PINs and manager approval', () => {
    it('a store that asks for PINs refuses a sale from a locked till', async () => {
        const { service } = await build({ settings: { requireStaffPin: true } });
        await expect(service.createSale(ORG, USER, input())).rejects.toThrow(new ForbiddenException('Unlock the till with your staff PIN first.'));
    });

    it('bills under the staff member who unlocked the till', async () => {
        const { service, staff, call } = await build({ settings: { requireStaffPin: true } });
        const { staffToken } = await staff.unlock(ORG, USER, '1234');
        await service.createSale(ORG, USER, input({ staffToken }));
        expect(call()[3].pos).toEqual({ staffId: 'st_cash' });
    });

    it("a discount over the limit needs a manager's approval, and takes it once", async () => {
        const { service, staff, orders, tx } = await build({ settings: { discountApprovalPercent: 10 } });
        const bill = input({ lines: [{ variantId: 'var_shirt', quantity: 1, discount: { type: 'percent', value: 15 } }], payments: [] });
        await expect(service.createSale(ORG, USER, bill)).rejects.toThrow("This discount needs a manager's PIN.");

        const { approvalToken } = await staff.approve(ORG, USER, { pin: '9876', reason: 'discount' });
        await service.createSale(ORG, USER, { ...bill, approvalToken });
        expect(orders.createOfflineOrder).toHaveBeenCalledTimes(1);
        expect(tx.posActivity.create.mock.calls[0][0].data).toMatchObject({ type: 'sale', approvedById: 'st_mgr' });

        await expect(service.createSale(ORG, USER, { ...bill, clientSaleId: '0d4c1f9e-1111-4a2b-8c3d-5e6f7a8b9c0d', approvalToken })).rejects.toThrow(
            'This manager approval was already used. Ask for the PIN again.',
        );
    });

    it('a discount within the limit needs nobody', async () => {
        const { service, orders } = await build({ settings: { discountApprovalPercent: 10 } });
        await service.createSale(ORG, USER, input({ lines: [{ variantId: 'var_shirt', quantity: 1, discount: { type: 'amount', value: 100 } }], payments: [] }));
        expect(orders.createOfflineOrder).toHaveBeenCalled();
    });

    it('a changed price needs a manager when the store says so; the catalogue price does not', async () => {
        const { service, staff, orders } = await build({ settings: { priceOverrideNeedsApproval: true } });
        await service.createSale(ORG, USER, input({ lines: [{ variantId: 'var_shirt', quantity: 1, unitPrice: 1000 }], payments: [] }));
        const changed = input({ clientSaleId: '0d4c1f9e-2222-4a2b-8c3d-5e6f7a8b9c0d', lines: [{ variantId: 'var_shirt', quantity: 1, unitPrice: 900 }], payments: [] });
        await expect(service.createSale(ORG, USER, changed)).rejects.toThrow("Changing the price needs a manager's PIN.");
        // An approval for something else does not cover it.
        const { approvalToken: wrongKind } = await staff.approve(ORG, USER, { pin: '9876', reason: 'discount' });
        await expect(service.createSale(ORG, USER, { ...changed, approvalToken: wrongKind })).rejects.toThrow("Changing the price needs a manager's PIN.");
        const { approvalToken } = await staff.approve(ORG, USER, { pin: '9876', reason: 'price_override' });
        await service.createSale(ORG, USER, { ...changed, approvalToken });
        expect(orders.createOfflineOrder).toHaveBeenCalledTimes(2);
        expect(orders.createOfflineOrder.mock.calls[1][2].lineItems[0].unitPriceOverride).toBe(900);
    });

    it('a manager who named an amount approved no more than that', async () => {
        const { service, staff } = await build({ settings: { discountApprovalPercent: 5 } });
        const { approvalToken } = await staff.approve(ORG, USER, { pin: '9876', reason: 'discount', amount: 100 });
        await expect(
            service.createSale(ORG, USER, input({ lines: [{ variantId: 'var_shirt', quantity: 1, discount: { type: 'amount', value: 150 } }], payments: [], approvalToken })),
        ).rejects.toThrow(/approved a discount of up to ₹100.00/);
    });

    it('gives the approval back when the sale fails', async () => {
        const { service, staff, orders } = await build({ settings: { discountApprovalPercent: 0 } });
        const { approvalToken } = await staff.approve(ORG, USER, { pin: '9876', reason: 'discount' });
        const bill = input({ lines: [{ variantId: 'var_shirt', quantity: 1, discount: { type: 'amount', value: 10 } }], payments: [], approvalToken });
        orders.createOfflineOrder.mockRejectedValueOnce(new BadRequestException('Insufficient stock'));
        await expect(service.createSale(ORG, USER, bill)).rejects.toThrow('Insufficient stock');
        await service.createSale(ORG, USER, bill);
        expect(orders.createOfflineOrder).toHaveBeenCalledTimes(2);
    });
});

describe('PosSaleService.createSale — the same bill twice', () => {
    it('returns the bill already saved, without selling again', async () => {
        const { service, orders, result } = await build({ saved: 'order_saved' });
        await service.createSale(ORG, USER, input());
        expect(orders.createOfflineOrder).not.toHaveBeenCalled();
        expect(result).toHaveBeenCalledWith(ORG, 'order_saved');
    });

    it('a copy saved while this one ran wins, and this one is undone', async () => {
        const { service, tx, result } = await build({ twin: 'order_twin' });
        await service.createSale(ORG, USER, input());
        expect(tx.orderPayment.createMany).not.toHaveBeenCalled();
        expect(result).toHaveBeenCalledWith(ORG, 'order_twin');
    });
});

describe('PosSaleService.createSale — the customer at checkout', () => {
    it('a store that requires the customer needs a mobile number or a customer on file', async () => {
        const { service, orders } = await build({ settings: { customerAtCheckout: 'required' }, buyer: BUYER });
        const refusal = "Add the customer's mobile number to bill.";
        await expect(service.createSale(ORG, USER, input())).rejects.toThrow(refusal);
        // A name, an offers tick or an address alone is not enough.
        await expect(service.createSale(ORG, USER, input({ customer: { name: 'Asha', offersOptIn: true } }))).rejects.toThrow(refusal);
        expect(orders.createOfflineOrder).not.toHaveBeenCalled();
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001' } }));
        await service.createSale(ORG, USER, input({ clientSaleId: '0d4c1f9e-3333-4a2b-8c3d-5e6f7a8b9c0d', customer: { customerId: 'cust_9' } }));
        expect(orders.createOfflineOrder).toHaveBeenCalledTimes(2);
    });

    it('reads an old stored askCustomer: required still requires the customer', async () => {
        const { service } = await build({ settings: { askCustomer: 'required' } });
        await expect(service.createSale(ORG, USER, input())).rejects.toThrow("Add the customer's mobile number to bill.");
    });

    it.each(['ask', 'off'])('with %s, a walk-in with nothing below the limit is billed', async (customerAtCheckout) => {
        const { service, call } = await build({ settings: { customerAtCheckout } });
        await service.createSale(ORG, USER, input());
        expect(call()[3].walkIn).toBe(true);
    });

    it('finds the customer by their number, however it was saved, before making one', async () => {
        const { service, call, prisma } = await build({ buyer: BUYER });
        await service.createSale(ORG, USER, input({ customer: { phone: '98000 00009', name: 'Asha Menon' } }));
        const where = prisma.customer.findFirst.mock.calls[0][0].where;
        expect(where).toMatchObject({ organizationId: ORG, deletedAt: null });
        expect(where.phone.in).toEqual(expect.arrayContaining(['+919800000009', '9800000009']));
        expect(call()[2].customer).toEqual({ customerId: 'cust_9' });
    });

    it('a number nobody has, with an email another customer has, is that customer: one customer per email', async () => {
        const { service, call, prisma, tx } = await build();
        prisma.customer.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(BUYER);
        tx.customer.findUniqueOrThrow.mockResolvedValueOnce(BUYER);
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001', email: 'asha@example.com' } }));
        expect(prisma.customer.findFirst.mock.calls[1][0].where).toMatchObject({ organizationId: ORG, email: 'asha@example.com' });
        expect(call()[2].customer).toEqual({ customerId: 'cust_9' });
    });

    it('someone new is made with the name, email and number given', async () => {
        const { service, call } = await build();
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001', name: 'Asha Rani Menon', email: 'asha@example.com' } }));
        expect(call()[2].customer).toEqual({ phone: '+919800000001', email: 'asha@example.com', firstName: 'Asha', lastName: 'Rani Menon' });
        expect(call()[3].walkIn).toBe(false);
    });

    it('a customer picked by id who is not this org’s is refused', async () => {
        const { service, orders } = await build();
        await expect(service.createSale(ORG, USER, input({ customer: { customerId: 'cust_x' } }))).rejects.toThrow('That customer was not found.');
        expect(orders.createOfflineOrder).not.toHaveBeenCalled();
    });

    it('fills a customer on file only where empty, inside the sale’s transaction', async () => {
        const { service, tx } = await build({ buyer: { ...BUYER, phone: null } });
        await service.createSale(ORG, USER, input({ customer: { customerId: 'cust_9', phone: '9800000001', name: 'Asha Menon', email: 'asha@example.com', gstin: '29ABCDE1234F1Z5' } }));
        expect(tx.customer.update).toHaveBeenCalledWith({
            where: { id: 'cust_9' },
            data: { firstName: 'Asha', lastName: 'Menon', phone: '+919800000001', gstin: '29ABCDE1234F1Z5', email: 'asha@example.com' },
        });
    });

    it('never overwrites what a customer has, and leaves an email that is someone else’s', async () => {
        const kept = await build({ buyer: { ...BUYER, firstName: 'Ravi', email: 'ravi@example.com' } });
        await kept.service.createSale(ORG, USER, input({ customer: { customerId: 'cust_9', name: 'Asha Menon', email: 'asha@example.com' } }));
        expect(kept.tx.customer.update).not.toHaveBeenCalled();

        const taken = await build({ buyer: BUYER, emailTaken: { id: 'cust_other' } });
        await taken.service.createSale(ORG, USER, input({ customer: { customerId: 'cust_9', email: 'asha@example.com' } }));
        expect(taken.tx.customer.update).not.toHaveBeenCalled();
    });

    it('a B2B customer found by phone keeps the order form’s place of supply', async () => {
        const { service, call } = await build({ buyer: { ...BUYER, gstin: '32ABCDE1234F1Z1' } });
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000009' } }));
        expect(call()[2]).not.toHaveProperty('placeOfSupplyCode');
    });
});

describe('PosSaleService.createSale — bills of the limit or more name the buyer', () => {
    const big = { total: 52_000, settings: {} };
    const address = { address1: '12 MG Road', city: 'Kochi', zip: '682016', stateCode: '32' };

    it("refuses a walk-in bill of ₹50,000 or more, saying what GST needs", async () => {
        const { service } = await build(big);
        await expect(service.createSale(ORG, USER, input({ payments: [] }))).rejects.toThrow(new BadRequestException("GST rules need the buyer's name and address on bills of ₹50,000 or more."));
    });

    it('names the amount the store set', async () => {
        const { service } = await build({ total: 150_000, settings: { customerRequiredAbove: 100_000 } });
        await expect(service.createSale(ORG, USER, input({ customer: { phone: '9800000001' }, payments: [] }))).rejects.toThrow("GST rules need the buyer's name and address on bills of ₹1,00,000 or more.");
    });

    it('counts the amount to pay, so ₹49,999.60 rounded up to ₹50,000 needs it too', async () => {
        const { service } = await build({ total: 49_999.6 });
        await expect(service.createSale(ORG, USER, input({ payments: [] }))).rejects.toThrow(/GST rules need/);
        const off = await build({ total: 49_999.6, settings: { roundOff: false } });
        await off.service.createSale(ORG, USER, input({ payments: [] }));
        expect(off.orders.createOfflineOrder).toHaveBeenCalled();
    });

    it('a name and a typed address let it through, the address on the bill', async () => {
        const { service, call } = await build(big);
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001', name: 'Asha', address }, payments: [] }));
        expect(call()[2].billingAddress).toEqual({ address1: '12 MG Road', city: 'Kochi', zip: '682016', province: 'Kerala', stateCode: '32', country: 'India', country_code: 'IN' });
        // A counter sale is still supplied where the store is.
        expect(call()[2].placeOfSupplyCode).toBe('29');
    });

    it('a customer on file with a name and an address needs nothing typed; their address goes on the bill', async () => {
        const saved = { address1: '4 Beach Road', city: 'Kochi', zip: '682001', stateCode: '32' };
        const { service, tx } = await build({ ...big, buyer: { ...BUYER, firstName: 'Asha', defaultAddress: saved } });
        await service.createSale(ORG, USER, input({ customer: { customerId: 'cust_9' }, payments: [] }));
        expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'order_1' }, data: { billingAddress: saved } });
    });

    it('an address with no state is not enough', async () => {
        const { service } = await build({ ...big, buyer: { ...BUYER, firstName: 'Asha', defaultAddress: { address1: '4 Beach Road', city: 'Kochi' } } });
        await expect(service.createSale(ORG, USER, input({ customer: { customerId: 'cust_9' }, payments: [] }))).rejects.toThrow(/GST rules need/);
    });

    it('below the limit, or with no limit, a walk-in is billed', async () => {
        const below = await build({ total: 49_000 });
        await below.service.createSale(ORG, USER, input({ payments: [] }));
        const none = await build({ total: 900_000, settings: { customerRequiredAbove: null } });
        await none.service.createSale(ORG, USER, input({ payments: [] }));
        expect(below.orders.createOfflineOrder).toHaveBeenCalled();
        expect(none.orders.createOfflineOrder).toHaveBeenCalled();
    });

    it('gives the manager’s approval back when the limit refuses the bill', async () => {
        const { service, staff } = await build({ ...big, settings: { discountApprovalPercent: 0 } });
        const { approvalToken } = await staff.approve(ORG, USER, { pin: '9876', reason: 'discount' });
        const bill = input({ lines: [{ variantId: 'var_shirt', quantity: 1, discount: { type: 'amount', value: 10 } }], payments: [], approvalToken });
        await expect(service.createSale(ORG, USER, bill)).rejects.toThrow(/GST rules need/);
        await expect(service.createSale(ORG, USER, { ...bill, customer: { name: 'Asha', address } })).resolves.toBeDefined();
    });
});

describe('PosSaleService.createSale — consent and the bill', () => {
    it('a number for the bill is not marketing consent: no opt-in is recorded, the bill goes to it', async () => {
        const { service, whatsapp, bills } = await build();
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001', name: 'Asha' } }));
        expect(whatsapp.optIn).not.toHaveBeenCalled();
        expect(bills.afterSale).toHaveBeenCalledWith(ORG, USER, {
            orderId: 'order_1', staffId: null, phone: { raw: '+919800000001', e164: '+919800000001' }, customerId: 'cust_1', name: 'Asha', autoSend: true,
        });
    });

    it('the offers tick records the marketing opt-in for the number given', async () => {
        const { service, whatsapp } = await build();
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001', name: 'Asha', offersOptIn: true } }));
        expect(whatsapp.optIn).toHaveBeenCalledWith(ORG, USER, { customerId: 'cust_1', e164: '+919800000001', name: 'Asha' }, 'order_1');
    });

    it('a customer picked from the list gets the bill on the number on file', async () => {
        const { service, bills } = await build({ buyer: BUYER });
        await service.createSale(ORG, USER, input({ customer: { customerId: 'cust_9' } }));
        expect(bills.afterSale.mock.calls[0][2]).toMatchObject({ phone: { raw: '+919800000009', e164: '+919800000009' }, customerId: 'cust_9' });
    });

    it('with bills sent only when asked, the bill is kept back', async () => {
        const { service, bills } = await build({ settings: { autoSendBill: false } });
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001' } }));
        expect(bills.afterSale.mock.calls[0][2]).toMatchObject({ autoSend: false });
    });

    it('no number, no bill', async () => {
        const { service, bills } = await build();
        await service.createSale(ORG, USER, input({ customer: { name: 'Asha' } }));
        await service.createSale(ORG, USER, input({ clientSaleId: '0d4c1f9e-4444-4a2b-8c3d-5e6f7a8b9c0d' }));
        expect(bills.afterSale).not.toHaveBeenCalled();
    });

    it('a bill that fails to send, or an opt-in that fails to save, never fails the sale', async () => {
        const { service, whatsapp, bills, result } = await build();
        whatsapp.optIn.mockRejectedValueOnce(new Error('db hiccup'));
        bills.afterSale.mockRejectedValueOnce(new Error('redis down'));
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001', offersOptIn: true } }));
        expect(result).toHaveBeenCalledWith(ORG, 'order_1', 950);
    });

    it('a retried sale already saved sends nothing again', async () => {
        const { service, bills } = await build({ saved: 'order_saved' });
        await service.createSale(ORG, USER, input({ customer: { phone: '9800000001' } }));
        expect(bills.afterSale).not.toHaveBeenCalled();
    });
});

describe('PosSaleService.result', () => {
    const bill = {
        id: 'order_1', name: '#M1001', totalPrice: 1049.6, financialStatus: OrderFinancialStatus.PARTIALLY_PAID,
        metadata: { pos: { storeId: 'wh_main', roundOff: 0.4, clientSaleId: CLIENT_SALE_ID } },
        payments: [{ method: 'CASH', amount: 500, tendered: 600 }],
        customerId: 'cust_1',
        invoices: [{ id: 'inv_1', invoiceNumber: 'INV-26-27/000001' }],
    };
    const sending = [{ channel: 'whatsapp', status: 'sending', to: '+919800000001', reason: null }];

    it('reports the exact total, the rounded amount to pay, what is paid and due, the change, and the bill’s link and delivery', async () => {
        const { service, prisma, result, bills } = await build();
        result.mockRestore();
        prisma.order.findFirst.mockResolvedValueOnce(bill);
        bills.delivery.mockResolvedValueOnce(sending);
        expect(await service.result(ORG, 'order_1')).toEqual({
            orderId: 'order_1',
            orderName: '#M1001',
            total: 1049.6,
            payable: 1050,
            roundOff: 0.4,
            paid: 500,
            balanceDue: 550,
            change: 100,
            financialStatus: 'PARTIALLY_PAID',
            invoiceId: 'inv_1',
            invoiceNumber: 'INV-26-27/000001',
            customerId: 'cust_1',
            billUrl: 'https://app.example.com/b/order_1.sig',
            delivery: sending,
        });
        expect(bills.delivery).toHaveBeenCalledWith(ORG, bill.metadata);
    });

    it('a delivery that cannot be read leaves the sale’s result whole', async () => {
        const { service, prisma, result, bills } = await build();
        result.mockRestore();
        prisma.order.findFirst.mockResolvedValueOnce(bill);
        bills.delivery.mockRejectedValueOnce(new Error('db hiccup'));
        expect(await service.result(ORG, 'order_1')).toMatchObject({ orderId: 'order_1', paid: 500, delivery: [] });
    });
});

describe('PosSaleService.collectPayment', () => {
    async function withBill(paidBefore: number, status: OrderFinancialStatus = OrderFinancialStatus.PARTIALLY_PAID) {
        const built = await build();
        const bill = {
            id: 'order_1', totalPrice: 1049.6, financialStatus: status, cancelledAt: null,
            metadata: { pos: { roundOff: 0.4 } }, payments: paidBefore ? [{ amount: paidBefore }] : [],
        };
        const txc = {
            $queryRaw: jest.fn(),
            order: { findFirst: jest.fn().mockResolvedValue(bill), update: jest.fn() },
            orderPayment: { create: jest.fn() },
            orderTimelineEvent: { create: jest.fn() },
            posActivity: { create: jest.fn() },
        };
        built.prisma.$transaction = jest.fn(async (fn: any) => fn(txc));
        const events = (built.service as any).commerceEvents;
        const invoices = (built.service as any).invoices;
        jest.spyOn(built.service as any, 'markPaidOnShopify').mockResolvedValue(undefined);
        return { ...built, txc, events, invoices };
    }

    it('takes the balance and marks the bill paid, with the same follow-ups as marking an order paid', async () => {
        const { service, txc, events, invoices, result } = await withBill(500);
        await service.collectPayment(ORG, USER, 'order_1', { method: 'CASH', amount: 550, tendered: 600 });
        expect(txc.$queryRaw).toHaveBeenCalled();
        expect(txc.orderPayment.create.mock.calls[0][0].data).toMatchObject({ method: 'CASH', amount: 550, tendered: 600 });
        expect(txc.order.update).toHaveBeenCalledWith({ where: { id: 'order_1' }, data: { financialStatus: OrderFinancialStatus.PAID } });
        expect(invoices.autoInvoiceForPaidOrder).toHaveBeenCalledWith(ORG, 'order_1');
        expect(events.order).toHaveBeenCalledWith('order_1', ['paid']);
        expect(result).toHaveBeenCalledWith(ORG, 'order_1', 50);
    });

    it('a part of the balance leaves the bill part-paid', async () => {
        const { service, txc, events } = await withBill(0, OrderFinancialStatus.PENDING);
        await service.collectPayment(ORG, USER, 'order_1', { method: 'UPI', amount: 200 });
        expect(txc.order.update).toHaveBeenCalledWith({ where: { id: 'order_1' }, data: { financialStatus: OrderFinancialStatus.PARTIALLY_PAID } });
        expect(events.order).not.toHaveBeenCalled();
    });

    it('refuses more than the balance, and a bill already paid', async () => {
        const due = await withBill(500);
        await expect(due.service.collectPayment(ORG, USER, 'order_1', { method: 'CARD', amount: 600 })).rejects.toThrow("That's more than the balance due of ₹550.00.");
        const paid = await withBill(1050, OrderFinancialStatus.PAID);
        await expect(paid.service.collectPayment(ORG, USER, 'order_1', { method: 'CARD', amount: 1 })).rejects.toThrow('This bill is already paid in full.');
    });

    it('only for a point-of-sale bill of this org', async () => {
        const { service, txc } = await withBill(0);
        txc.order.findFirst.mockResolvedValueOnce(null);
        await expect(service.collectPayment(ORG, USER, 'order_x', { method: 'CASH', amount: 10 })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('PosSaleService — no store to bill at', () => {
    it('refuses the bill, and makes no order, while the workspace has no Store location', async () => {
        const { service, orders, catalog } = await build();
        catalog.resolveStore.mockRejectedValueOnce(new BadRequestException('Add a store location before billing.'));

        await expect(service.createSale(ORG, USER, input())).rejects.toThrow('Add a store location before billing.');
        expect(orders.createOfflineOrder).not.toHaveBeenCalled();
    });
});

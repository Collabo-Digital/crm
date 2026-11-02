import { parseDefinition, ruleWhere } from './segment-rules';
import { ShopifySegmentsService, customerNumber } from './shopify-segments.service';

describe('Shopify customer segments', () => {
    it('read the customer number from either kind of member id', () => {
        expect(customerNumber('gid://shopify/Customer/7012345678')).toBe('7012345678');
        expect(customerNumber('gid://shopify/CustomerSegmentMember/7012345678')).toBe('7012345678');
        expect(customerNumber('nonsense')).toBeNull();
    });

    it('become a segment rule on the contact’s store customer', () => {
        const def = parseDefinition({ match: 'all', rules: [{ field: 'shopify_segment', op: 'in', value: 'seg_1' }] });
        expect(ruleWhere(def.rules[0], new Date())).toEqual({ customer: { is: { shopifySegments: { some: { segmentId: 'seg_1' } } } } });
        expect(ruleWhere({ field: 'shopify_segment', op: 'not_in', value: 'seg_1' }, new Date())).toEqual({ NOT: { customer: { is: { shopifySegments: { some: { segmentId: 'seg_1' } } } } } });
    });

    it('sync every page of members, keep the ones Collabo knows, and drop the ones who left', async () => {
        const pages = [
            { totalCount: 3, edges: [{ node: { id: 'gid://shopify/CustomerSegmentMember/101' } }, { node: { id: 'gid://shopify/CustomerSegmentMember/102' } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
            { totalCount: 3, edges: [{ node: { id: 'gid://shopify/CustomerSegmentMember/103' } }], pageInfo: { hasNextPage: false, endCursor: null } },
        ];
        const graphql = { request: jest.fn(async (_a: unknown, _q: string, vars: { after: string | null }) => ({ customerSegmentMembers: vars.after ? pages[1] : pages[0] })) };
        const deletes: any[] = [];
        const created: any[] = [];
        const prisma = {
            shopifySegment: {
                findFirst: jest.fn(async () => ({ id: 'seg_1', channelId: 'ch_shop', externalId: 'gid://shopify/Segment/9' })),
                update: jest.fn(async ({ data }: any) => ({ id: 'seg_1', externalId: 'gid://shopify/Segment/9', name: 'VIPs', query: null, ...data })),
            },
            customer: { findMany: jest.fn(async ({ where }: any) => where.externalId.in.filter((n: string) => n !== '103').map((n: string) => ({ id: `cust_${n}` }))) },
            shopifySegmentMember: {
                deleteMany: jest.fn((args: any) => { deletes.push(args); return Promise.resolve({ count: 0 }); }),
                createMany: jest.fn((args: any) => { created.push(...args.data); return Promise.resolve({ count: args.data.length }); }),
            },
            $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
        };
        const oauth = { getAccessToken: jest.fn(async () => ({ token: 't', shopDomain: 'shop.myshopify.com', channelId: 'ch_shop' })) };
        const view = await new ShopifySegmentsService(prisma as any, graphql as any, oauth as any).sync('org_1', 'seg_1');
        expect(graphql.request).toHaveBeenCalledTimes(2);
        expect(created.map((c) => c.customerId)).toEqual(['cust_101', 'cust_102']);
        expect(view).toMatchObject({ memberCount: 3, matchedCount: 2, lastError: null });
        // Members not seen in this sync leave the segment.
        expect(deletes.at(-1).where.syncedAt.lt).toBeInstanceOf(Date);
    });
});

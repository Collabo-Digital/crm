import { parseAudience, rateFor, skipReason, type AudienceMember } from './broadcast-audience';
import { parseVariables, resolveValues, type RecipientContext } from './broadcast-variables';
import { templateParams, toMetaComponents } from '../templates/template-components';
import { rfmGroup } from '../segments/rfm.service';
import { definitionWhere, parseDefinition } from '../segments/segment-rules';

const member = (patch: Partial<AudienceMember> = {}): AudienceMember => ({
    blockedAt: null,
    optedOutAt: null,
    optInAt: null,
    waId: '919800000000',
    externalId: 'US.123',
    excluded: false,
    alreadyReceived: false,
    recentlyMessaged: false,
    ...patch,
});

describe('skipReason', () => {
    const marketing = { marketing: true, requireOptIn: false };
    it('sends to an ordinary contact', () => {
        expect(skipReason(member(), marketing)).toBeNull();
    });
    it('leaves out the blocked always, and the opted-out only from marketing', () => {
        const now = new Date();
        expect(skipReason(member({ blockedAt: now }), { marketing: false, requireOptIn: false })).toBe('blocked');
        expect(skipReason(member({ optedOutAt: now }), marketing)).toBe('opted_out');
        expect(skipReason(member({ optedOutAt: now }), { marketing: false, requireOptIn: false })).toBeNull();
    });
    it('honours a required opt-in, exclusions and frequency caps', () => {
        expect(skipReason(member(), { marketing: true, requireOptIn: true })).toBe('no_opt_in');
        expect(skipReason(member({ optInAt: new Date() }), { marketing: true, requireOptIn: true })).toBeNull();
        expect(skipReason(member({ excluded: true }), marketing)).toBe('excluded');
        expect(skipReason(member({ alreadyReceived: true }), marketing)).toBe('already_received');
        expect(skipReason(member({ recentlyMessaged: true }), marketing)).toBe('recently_messaged');
    });
    it('can reach a username-only user by BSUID but not a contact with neither', () => {
        expect(skipReason(member({ waId: null, externalId: 'IN.5555' }), marketing)).toBeNull();
        expect(skipReason(member({ waId: null, externalId: '6505551234' }), marketing)).toBe('no_whatsapp_id');
    });
});

describe('parseAudience', () => {
    it('fills defaults and rejects nonsense', () => {
        expect(parseAudience({ tags: ['vip'] })).toMatchObject({ everyone: false, tags: ['vip'], exclude: { messagedWithinHours: null }, requireOptIn: false });
        expect(() => parseAudience({ exclude: { messagedWithinHours: 0 } })).toThrow();
    });
});

describe('rateFor', () => {
    const rates = [{ countryPrefix: '*' }, { countryPrefix: '91' }, { countryPrefix: '1' }, { countryPrefix: '971' }];
    it('takes the longest matching prefix, else the default row', () => {
        expect(rateFor('919800000000', rates)?.countryPrefix).toBe('91');
        expect(rateFor('971500000000', rates)?.countryPrefix).toBe('971');
        expect(rateFor('447700000000', rates)?.countryPrefix).toBe('*');
        expect(rateFor(null, rates)?.countryPrefix).toBe('*');
        expect(rateFor('447700000000', [{ countryPrefix: '91' }])).toBeNull();
    });
});

describe('resolveValues', () => {
    const components = toMetaComponents(
        {
            name: 'x',
            language: 'en',
            category: 'MARKETING',
            parameterFormat: 'NAMED',
            header: { format: 'IMAGE' },
            body: { text: 'Hi {{first_name}}, code {{code}}, tier {{tier}} today.', examples: { first_name: 'a', code: 'b', tier: 'c' } },
        },
        'h',
    );
    const params = templateParams(components, 'NAMED');
    const vars = parseVariables({
        values: {
            'body.first_name': { source: 'first_name', fallback: 'there' },
            'body.code': { source: 'static', value: 'SAVE10' },
            'body.tier': { source: 'attribute', value: 'tier' },
        },
        headerMedia: { storageKey: 'org/x.png', mime: 'image/png', kind: 'image' },
    });
    const ctx = (patch: Partial<RecipientContext> = {}): RecipientContext => ({ name: 'Riya Kapoor', phone: null, attributes: { tier: 'gold' }, customer: null, ...patch });

    it('fills each value from its source, preferring the store customer’s first name', () => {
        expect(resolveValues(params, vars, ctx({ customer: { firstName: 'Riya', lastName: 'K', email: null } }), 'MEDIA1').values).toEqual({
            header: { mediaId: 'MEDIA1' },
            'body.first_name': 'Riya',
            'body.code': 'SAVE10',
            'body.tier': 'gold',
        });
    });
    it('uses the fallback, or reports the value missing', () => {
        const result = resolveValues(params, vars, ctx({ name: null, attributes: {} }), 'MEDIA1');
        expect(result.values['body.first_name']).toBe('there');
        expect(result.missing).toEqual(['body.tier']);
        expect(resolveValues(params, vars, ctx()).missing).toEqual(['header']);
    });
});

describe('segments', () => {
    it('places every recency/frequency pair in one RFM group', () => {
        const groups = new Set<string>();
        for (let r = 1; r <= 5; r++) for (let f = 1; f <= 5; f++) groups.add(rfmGroup(r, f));
        expect([...groups].sort()).toEqual(['at_risk', 'champions', 'hibernating', 'lost', 'loyal', 'needs_attention', 'new']);
        expect(rfmGroup(5, 5)).toBe('champions');
        expect(rfmGroup(1, 1)).toBe('lost');
        expect(rfmGroup(1, 5)).toBe('at_risk');
    });

    it('turns rules into one query, all or any', () => {
        const now = new Date('2026-10-23T00:00:00Z');
        const def = parseDefinition({
            match: 'all',
            rules: [
                { field: 'tag', op: 'has', value: 'vip' },
                { field: 'orders_count', op: 'gte', value: 2 },
                { field: 'rfm', op: 'in', value: ['champions'] },
                { field: 'broadcast', op: 'replied', value: 'b1' },
            ],
        });
        expect(definitionWhere(def, now)).toEqual({
            AND: [
                { tags: { has: 'vip' } },
                { customer: { is: { ordersCount: { gte: 2 } } } },
                { customer: { is: { rfm: { is: { segment: { in: ['champions'] } } } } } },
                { broadcastRecipients: { some: { broadcastId: 'b1', repliedAt: { not: null } } } },
            ],
        });
        expect(() => parseDefinition({ match: 'all', rules: [{ field: 'tag', op: 'is', value: 'x' }] })).toThrow();
        expect(() => parseDefinition({ match: 'all', rules: [] })).toThrow();
    });
});

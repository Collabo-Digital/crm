import { normalizePhone, planRow } from './contact-import.service';

describe('normalizePhone', () => {
    it('keeps international numbers and adds the default country code to local ones', () => {
        expect(normalizePhone('+91 98450 12345')).toBe('919845012345');
        expect(normalizePhone('0091-98450-12345')).toBe('919845012345');
        expect(normalizePhone('98450 12345', '91')).toBe('919845012345');
        expect(normalizePhone('098450 12345', '91')).toBe('919845012345');
        expect(normalizePhone('(650) 555-1234', '1')).toBe('16505551234');
        expect(normalizePhone('919845012345')).toBe('919845012345');
    });
    it('refuses what cannot be a WhatsApp number', () => {
        expect(normalizePhone('12345')).toBeNull();
        expect(normalizePhone('not a phone')).toBeNull();
        expect(normalizePhone('98450 12345')).toBeNull();
    });
});

describe('planRow', () => {
    const mapping = { phone: 'Phone', name: 'Name', tags: 'Tags', optIn: 'Consent', attributes: { city: 'City' } };
    it('reads filled cells and leaves blank ones out', () => {
        expect(planRow({ Phone: '+919845012345', Name: '', Tags: 'vip; wholesale', Consent: 'yes', City: '' }, mapping, { tags: ['diwali'] })).toEqual({
            digits: '919845012345',
            name: null,
            tags: ['diwali', 'vip', 'wholesale'],
            attributes: {},
            optIn: true,
        });
    });
    it('records consent only when the file or the importer says so', () => {
        const row = { Phone: '+919845012345', Name: 'Riya', Tags: '', Consent: 'no', City: 'Pune' };
        expect(planRow(row, mapping, {})).toMatchObject({ name: 'Riya', attributes: { city: 'Pune' }, optIn: false });
        expect(planRow(row, mapping, { markOptedIn: true })).toMatchObject({ optIn: true });
    });
    it('explains a row it cannot use', () => {
        expect(planRow({ Phone: '' }, mapping, {})).toEqual({ error: 'No phone number' });
        expect(planRow({ Phone: '12' }, mapping, {})).toEqual({ error: '“12” is not a phone number with a country code' });
    });
});

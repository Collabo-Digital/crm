import { a1, idTokenEmail } from './google.client';
import { sheetColumns } from './google.service';

describe('a1', () => {
    it('quotes the tab, doubling its apostrophes', () => {
        expect(a1('Sheet1', 'A1:ZZ1')).toBe("'Sheet1'!A1:ZZ1");
        expect(a1("Leads (Mehta's)", 'A2:ZZ')).toBe("'Leads (Mehta''s)'!A2:ZZ");
    });
});

describe('idTokenEmail', () => {
    const token = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

    it('reads the email Google put in the ID token', () => {
        expect(idTokenEmail(token({ email: 'owner@example.com' }))).toBe('owner@example.com');
    });

    it('is null without one', () => {
        expect(idTokenEmail(undefined)).toBeNull();
        expect(idTokenEmail('not-a-token')).toBeNull();
        expect(idTokenEmail(token({ sub: '123' }))).toBeNull();
    });
});

describe('sheetColumns', () => {
    it('names each column’s variable after its header', () => {
        expect(sheetColumns(['Full Name', 'Phone (WhatsApp)', 'City'])).toEqual([
            { header: 'Full Name', key: 'full_name' },
            { header: 'Phone (WhatsApp)', key: 'phone_whatsapp' },
            { header: 'City', key: 'city' },
        ]);
    });

    it('gives empty and repeated headers their column’s place', () => {
        expect(sheetColumns(['Name', '', 'name', '★'])).toEqual([
            { header: 'Name', key: 'name' },
            { header: 'Column 2', key: 'column_2' },
            { header: 'name', key: 'name_3' },
            { header: '★', key: 'column_4' },
        ]);
    });
});

import { visitorAddress } from './visitor-address.util';

describe('visitorAddress', () => {
    it('counts an IPv4 address as itself, however it is written', () => {
        expect(visitorAddress('198.51.100.7')).toBe('198.51.100.7');
        expect(visitorAddress('::ffff:198.51.100.7')).toBe('198.51.100.7');
        expect(visitorAddress('::ffff:c633:6407')).toBe('198.51.100.7');
    });

    it('counts an IPv6 address by its /64', () => {
        expect(visitorAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
        expect(visitorAddress('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
        expect(visitorAddress('2001:DB8::1')).toBe('2001:db8:0:0::/64');
    });

    it('has a name for a request without an address', () => {
        expect(visitorAddress(undefined)).toBe('unknown');
    });
});

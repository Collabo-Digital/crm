import { ChannelPlatform } from '@prisma/client';
import { chatTarget, hostAllowed, makeCode, normalizeDomain, parseWidgetSettings, referenceIn, withReference } from './growth.util';
import { widgetScript } from './widget-script';

describe('chat links', () => {
    it('make codes that are easy to read off a poster', () => {
        const code = makeCode();
        expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
        expect(code).not.toMatch(/[01OIL]/);
    });

    it('end WhatsApp’s pre-filled message with the reference, and find it in the reply', () => {
        const text = withReference('Hi! I saw the Diwali offer.', 'K7Q2M9XD');
        expect(text).toBe('Hi! I saw the Diwali offer.\n\nRef: K7Q2M9XD');
        expect(referenceIn(text)).toBe('K7Q2M9XD');
        expect(referenceIn('hi ref k7q2m9xd thanks')).toBe('K7Q2M9XD');
        expect(referenceIn('I prefer the red one')).toBeNull();
        expect(withReference('', 'K7Q2M9XD')).toBe('Ref: K7Q2M9XD');
    });

    it('open the right place per channel', () => {
        const wa = chatTarget({ platform: ChannelPlatform.WHATSAPP, credentials: { displayPhoneNumber: '+91 98765 43210' }, externalStoreId: null, externalStoreUrl: null }, 'K7Q2M9XD', 'Hello');
        expect(wa).toBe(`https://wa.me/919876543210?text=${encodeURIComponent('Hello\n\nRef: K7Q2M9XD')}`);
        expect(chatTarget({ platform: ChannelPlatform.FACEBOOK, credentials: { pageId: '1234' }, externalStoreId: null, externalStoreUrl: null }, 'K7Q2M9XD', null)).toBe('https://m.me/1234?ref=K7Q2M9XD');
        expect(chatTarget({ platform: ChannelPlatform.INSTAGRAM, credentials: {}, externalStoreId: '1', externalStoreUrl: 'https://instagram.com/acme.store' }, 'K7Q2M9XD', null)).toBe('https://ig.me/m/acme.store');
        expect(chatTarget({ platform: ChannelPlatform.WHATSAPP, credentials: {}, externalStoreId: null, externalStoreUrl: null }, 'K7Q2M9XD', null)).toBeNull();
    });
});

describe('the website widget', () => {
    it('accepts sign-ups only from the merchant’s sites and their subdomains', () => {
        expect(hostAllowed('shop.example.com', ['example.com'])).toBe(true);
        expect(hostAllowed('example.com', ['example.com'])).toBe(true);
        expect(hostAllowed('badexample.com', ['example.com'])).toBe(false);
        expect(hostAllowed('example.com.evil.io', ['example.com'])).toBe(false);
        expect(hostAllowed(null, ['example.com'])).toBe(false);
        expect(hostAllowed('example.com', [])).toBe(false);
    });

    it('keeps domains as host names', () => {
        expect(normalizeDomain('https://www.Shop.com/products')).toBe('www.shop.com');
        expect(normalizeDomain('shop.example.in')).toBe('shop.example.in');
        expect(normalizeDomain('not a domain')).toBeNull();
    });

    it('fills every setting with a default', () => {
        const s = parseWidgetSettings({ button: { color: '#000000' } });
        expect(s.button.color).toBe('#000000');
        expect(s.button.label).toBe('Chat with us');
        expect(s.popup.enabled).toBe(false);
        expect(s.popup.consentText.length).toBeGreaterThan(10);
        expect(parseWidgetSettings({ button: { color: 'red' } }).button.color).toBe('#25D366');
    });

    it('is a script browsers can run, whose settings cannot close it or run as HTML', () => {
        const settings = parseWidgetSettings({ button: { greeting: '</script><img src=x onerror=alert(1)>' }, popup: { enabled: true } });
        const js = widgetScript({ key: 'abcdefghijkl', api: 'https://api.example.com/api/v1', chatUrl: 'https://api.example.com/api/v1/l/K7Q2M9XD', storeName: 'Acme', settings });
        expect(() => new Function(js)).not.toThrow();
        expect(js).not.toContain('</script>');
        expect(js).toContain('\\u003c/script>');
        expect(js).not.toMatch(/innerHTML\s*=\s*[^'"\s]/);
    });
});

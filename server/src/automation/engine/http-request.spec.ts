import http from 'node:http';
import { AddressInfo } from 'node:net';
import { guardedRequest, isPrivateAddress } from './http-request';

describe('isPrivateAddress', () => {
    it('knows internal ranges', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
            expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
        }
        for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    });

    it('judges IPv6 by value, including addresses that carry an IPv4 address', () => {
        const internal = [
            '::', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '0:0:0:0:0:ffff:127.0.0.1', '0:0:0:0:0:FFFF:7F00:0001',
            '::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b::169.254.169.254', '2002:7f00:1::1', '2002:a9fe:a9fe::',
            'fe80::1%lo0', 'fec0::1', 'ff02::1', 'FD12:3456::1', '2001::1', '2001:db8::1', '100::1', '64:ff9b:1::1', 'not-an-ip',
        ];
        for (const ip of internal) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
        for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888']) {
            expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
        }
    });
});

describe('guardedRequest', () => {
    let server: http.Server;
    let port: number;
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ method: req.method, got: body ? JSON.parse(body) : null }));
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise((r) => server.close(r)));

    it('refuses internal addresses, by literal IP and through DNS', async () => {
        await expect(guardedRequest({ method: 'GET', url: `http://127.0.0.1:${port}/`, allowPrivate: false })).rejects.toThrow('private or internal');
        await expect(guardedRequest({ method: 'GET', url: `http://localhost:${port}/`, allowPrivate: false })).rejects.toThrow('private or internal');
        await expect(guardedRequest({ method: 'GET', url: 'ftp://example.com/', allowPrivate: false })).rejects.toThrow('Only http');
    });

    it('refuses IPv4-mapped IPv6 literals, which the URL parser rewrites to hex', async () => {
        for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[::1]', '[64:ff9b::7f00:1]']) {
            await expect(guardedRequest({ method: 'GET', url: `http://${host}:${port}/`, allowPrivate: false })).rejects.toThrow('private or internal');
        }
        await expect(guardedRequest({ method: 'GET', url: 'http://[::ffff:169.254.169.254]/latest/meta-data/', allowPrivate: false })).rejects.toThrow('private or internal');
    });

    it('sends JSON and reads JSON back when allowed', async () => {
        const res = await guardedRequest({ method: 'POST', url: `http://localhost:${port}/hook`, body: '{"a":1}', allowPrivate: true });
        expect(res).toEqual({ status: 200, body: { method: 'POST', got: { a: 1 } } });
    });
});

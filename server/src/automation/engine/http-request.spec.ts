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

    it('sends JSON and reads JSON back when allowed', async () => {
        const res = await guardedRequest({ method: 'POST', url: `http://localhost:${port}/hook`, body: '{"a":1}', allowPrivate: true });
        expect(res).toEqual({ status: 200, body: { method: 'POST', got: { a: 1 } } });
    });
});

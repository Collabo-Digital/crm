import * as nodemailer from 'nodemailer';
import { EmailService } from './email.service';

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({ verify: jest.fn(), sendMail: jest.fn() })),
}));

/**
 * On port 587 SMTP starts in plain text and upgrades via STARTTLS. Unless the
 * upgrade is required, a stripped or missing STARTTLS offer makes the client
 * send the SMTP login and the mail itself unencrypted.
 */
describe('EmailService — SMTP transport must be encrypted in production', () => {
    const createTransport = nodemailer.createTransport as jest.Mock;

    function build(nodeEnv: string, smtp: Record<string, unknown> = {}) {
        const values: Record<string, unknown> = {
            nodeEnv,
            frontendUrl: 'http://localhost:5173',
            'smtp.host': 'smtp.example.test',
            'smtp.port': 587,
            'smtp.secure': false,
            'smtp.user': 'user',
            'smtp.pass': 'pass',
            'smtp.fromEmail': 'noreply@example.test',
            'smtp.fromName': 'Test',
            ...smtp,
        };
        return new EmailService({ get: (key: string) => values[key] } as never);
    }

    const transportOptions = () => (createTransport.mock.calls as Array<[Record<string, unknown>]>)[0][0];

    beforeEach(() => createTransport.mockClear());

    it('refuses to send without TLS in production', () => {
        build('production');

        expect(transportOptions()).toMatchObject({ port: 587, secure: false, requireTLS: true });
    });

    it('leaves certificate verification on', () => {
        build('production');

        expect(transportOptions()).not.toHaveProperty('tls.rejectUnauthorized', false);
        expect(transportOptions()).not.toHaveProperty('ignoreTLS');
    });

    it('does not require TLS in development, so a local test mail server works', () => {
        build('development');

        expect(transportOptions()).toMatchObject({ requireTLS: false });
    });

    it('creates no transport when SMTP is not configured', () => {
        build('production', { 'smtp.host': undefined });

        expect(createTransport).not.toHaveBeenCalled();
    });
});

/**
 * Anyone can create a workspace with any name and invite any address, so a
 * name is user input that lands in someone else's inbox from our own server.
 */
describe('EmailService — user-supplied names are escaped in invitation HTML', () => {
    const orgName = '<a href="https://evil.example">Verify your account</a>';

    function build() {
        const sendMail = jest.fn().mockResolvedValue(undefined);
        (nodemailer.createTransport as jest.Mock).mockReturnValueOnce({ verify: jest.fn(), sendMail });
        const values: Record<string, unknown> = {
            nodeEnv: 'production',
            frontendUrl: 'https://app.example.test',
            'smtp.host': 'smtp.example.test',
            'smtp.user': 'user',
            'smtp.pass': 'pass',
        };
        const service = new EmailService({ get: (key: string) => values[key] } as never);
        const html = () => (sendMail.mock.calls as Array<[{ html: string }]>)[0][0].html;
        return { service, html };
    }

    it('escapes the organization name in a team invite', async () => {
        const { service, html } = build();

        await service.sendTeamInvite('a@example.test', orgName, 'tok');

        expect(html()).not.toContain('<a href="https://evil.example">');
        expect(html()).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Verify your account&lt;/a&gt;');
    });

    it('escapes the organization, inviter and invitee names in an influencer invite', async () => {
        const { service, html } = build();

        await service.sendInfluencerInvite({
            email: 'a@example.test',
            inviteeName: '<b>Invitee</b>',
            orgName,
            inviterName: '<i>Inviter</i>',
            token: 'tok',
            expiresAt: new Date('2030-01-01'),
        });

        expect(html()).not.toMatch(/<a href="https:\/\/evil|<b>Invitee|<i>Inviter/);
    });
});

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter, SendMailOptions } from 'nodemailer';

@Injectable()
export class EmailService implements OnModuleInit {
    private readonly logger = new Logger(EmailService.name);
    private readonly transporter: Transporter | null;
    private readonly fromEmail: string;
    private readonly fromName: string;
    private readonly replyTo: string | undefined;
    private readonly frontendUrl: string;
    private readonly isDev: boolean;

    constructor(private readonly config: ConfigService) {
        this.fromEmail = this.config.get<string>('smtp.fromEmail')!;
        this.fromName = this.config.get<string>('smtp.fromName')!;
        this.replyTo = this.config.get<string>('smtp.replyTo');
        this.frontendUrl = this.config.get<string>('frontendUrl')!;
        this.isDev = this.config.get('nodeEnv') !== 'production';

        const host = this.config.get<string>('smtp.host');
        const user = this.config.get<string>('smtp.user');
        const pass = this.config.get<string>('smtp.pass');

        if (!host || !user || !pass) {
            this.transporter = null;
            if (!this.isDev) {
                this.logger.error(
                    'SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing). Emails will fail in production.',
                );
            }
            return;
        }

        this.transporter = nodemailer.createTransport({
            host,
            port: this.config.get<number>('smtp.port')!,
            secure: this.config.get<boolean>('smtp.secure')!,
            // On port 587 the connection starts in plain text and upgrades via
            // STARTTLS. Without this the upgrade is optional: if it is not
            // offered (or is stripped in transit) the SMTP login and the mail —
            // reset links, verification codes, invites — go out unencrypted.
            // Refuse to send instead. Left off in development so a local test
            // mail server without TLS still works.
            requireTLS: !this.isDev,
            auth: { user, pass },
            pool: true,
            maxConnections: 5,
            maxMessages: 100,
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 20_000,
        });
    }

    async onModuleInit(): Promise<void> {
        if (!this.transporter || this.isDev) return;
        try {
            await this.transporter.verify();
            this.logger.log('SMTP transporter verified — ready to send mail.');
        } catch (err) {
            this.logger.error('SMTP verification failed at startup.', err as Error);
        }
    }

    private get from(): string {
        return `${this.fromName} <${this.fromEmail}>`;
    }

    /**
     * Absolute URL of the product wordmark, served by the frontend (PNG: Outlook cannot render WebP).
     * `?v=` busts mail-client image caches; bump it together with client brand-logo.tsx when the artwork changes.
     */
    private get logoUrl(): string {
        return `${this.frontendUrl.replace(/\/$/, '')}/brand/collabo-wordmark.png?v=2`;
    }

    /** Wraps a message body in the branded shell: wordmark header, card, footer. */
    private layout(body: string): string {
        return `
            <div style="margin: 0; padding: 32px 16px; background: #f1f7fa; font-family: 'Segoe UI', Helvetica, Arial, sans-serif; color: #111827;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 480px; margin: 0 auto;">
                    <tr>
                        <td style="padding: 0 0 24px 0;">
                            <img src="${this.logoUrl}" width="140" alt="Collabo" style="display: block; width: 140px; height: auto; border: 0;" />
                        </td>
                    </tr>
                    <tr>
                        <td style="background: #ffffff; border-radius: 16px; padding: 32px; font-size: 15px; line-height: 1.55;">
                            ${body}
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 24px 0 0 0; font-size: 12px; color: #9ca3af; text-align: center;">
                            &copy; ${new Date().getFullYear()} Collabo Digital Network
                        </td>
                    </tr>
                </table>
            </div>
        `;
    }

    /** Primary call-to-action, matching the app's ink-fill / lime-text brand button. */
    private button(href: string, label: string): string {
        return `<a href="${href}" style="display: inline-block; padding: 12px 24px; background: #000000; color: #CEF17B; font-weight: 600; text-decoration: none; border-radius: 9999px;">${label}</a>`;
    }

    private htmlToText(html: string): string {
        return html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private async send(options: SendMailOptions, context: string): Promise<void> {
        if (!this.transporter) {
            this.logger.warn(`[${context}] Skipped — SMTP not configured.`);
            return;
        }
        const payload: SendMailOptions = {
            ...options,
            from: options.from ?? this.from,
            replyTo: options.replyTo ?? this.replyTo,
            text:
                options.text ??
                (typeof options.html === 'string' ? this.htmlToText(options.html) : undefined),
        };
        try {
            await this.transporter.sendMail(payload);
            this.logger.log(`[${context}] Email sent to ${payload.to}`);
        } catch (err) {
            this.logger.warn(`[${context}] First attempt failed, retrying once...`, err as Error);
            try {
                await this.transporter.sendMail(payload);
                this.logger.log(`[${context}] Email sent to ${payload.to} (after retry)`);
            } catch (retryErr) {
                this.logger.error(
                    `[${context}] Failed to send email to ${payload.to}`,
                    retryErr as Error,
                );
            }
        }
    }

    async sendVerificationCode(email: string, code: string): Promise<void> {
        if (this.isDev) {
            this.logger.log(`[DEV] Verification code for ${email}: ${code}`);
            return;
        }
        await this.send(
            {
                to: email,
                subject: 'Your verification code',
                html: this.layout(`
                    <h2 style="margin: 0 0 12px 0; font-size: 22px;">Verify your email</h2>
                    <p>Your verification code is:</p>
                    <h1 style="font-size: 32px; letter-spacing: 8px; text-align: center; padding: 16px; background: #f3f4f6; border-radius: 8px;">${code}</h1>
                    <p>This code expires in 10 minutes.</p>
                    <p>If you didn't create an account, you can safely ignore this email.</p>
                `),
            },
            'verification',
        );
    }

    async sendPasswordResetLink(email: string, token: string): Promise<void> {
        const resetLink = `${this.frontendUrl}/auth/reset-password?token=${token}`;

        if (this.isDev) {
            this.logger.log(`[DEV] Password reset for ${email}: ${resetLink}`);
            return;
        }

        await this.send(
            {
                to: email,
                subject: 'Reset your password',
                html: this.layout(`
                    <h2 style="margin: 0 0 12px 0; font-size: 22px;">Reset your password</h2>
                    <p>Click the button below to reset your password:</p>
                    ${this.button(resetLink, 'Reset Password')}
                    <p>This link expires in 1 hour.</p>
                    <p>If you didn't request this, you can safely ignore this email.</p>
                `),
            },
            'password-reset',
        );
    }

    /**
     * Invite an external creator to join an organization as an influencer.
     *
     * Separate from `sendTeamInvite` because the recipient is a different
     * audience: someone outside the business who may never have heard of this
     * product, so the mail has to say what they are being asked to do and what
     * they will get access to — not just "you've been invited".
     */
    async sendInfluencerInvite(params: {
        email: string;
        inviteeName: string | null;
        orgName: string;
        inviterName: string | null;
        token: string;
        expiresAt: Date;
    }): Promise<void> {
        const { email, inviteeName, orgName, inviterName, token, expiresAt } = params;
        const inviteLink = `${this.frontendUrl}/auth/invite?token=${token}`;

        if (this.isDev) {
            this.logger.log(
                `[DEV] Influencer invite for ${email} to join ${orgName}: ${inviteLink}`,
            );
            return;
        }

        const greeting = inviteeName ? `Hi ${this.escape(inviteeName)},` : 'Hi,';
        const from = inviterName
            ? `${this.escape(inviterName)} has invited you`
            : 'You have been invited';
        const expiry = expiresAt.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        });

        await this.send(
            {
                to: email,
                subject: `You've been invited to join ${orgName} as an influencer`,
                html: `
                    <h2>You've been invited to collaborate</h2>
                    <p>${greeting}</p>
                    <p>${from} to join <strong>${this.escape(orgName)}</strong> as an influencer.</p>
                    <p>Accepting lets you connect your own Instagram account and collaborate on their campaigns. You keep control of your account and can disconnect it at any time.</p>
                    <a href="${inviteLink}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Accept Invitation</a>
                    <p>This invitation expires on ${expiry}.</p>
                    <p>If you weren't expecting this, you can safely ignore this email.</p>
                `,
            },
            'influencer-invite',
        );
    }

    /**
     * Escape values interpolated into a template.
     *
     * Organization and inviter names are user-supplied and reach a recipient's
     * mail client, so an unescaped `<` is a mail-client-side injection into
     * someone else's inbox.
     */
    private escape(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async sendTeamInvite(email: string, orgName: string, token: string): Promise<void> {
        const inviteLink = `${this.frontendUrl}/auth/invite?token=${token}`;

        if (this.isDev) {
            this.logger.log(`[DEV] Team invite for ${email} to join ${orgName}: ${inviteLink}`);
            return;
        }

        await this.send(
            {
                to: email,
                subject: `You're invited to join ${orgName}`,
                html: this.layout(`
                    <h2 style="margin: 0 0 12px 0; font-size: 22px;">You've been invited!</h2>
                    <p>You've been invited to join <strong>${this.escape(orgName)}</strong>.</p>
                    ${this.button(inviteLink, 'Accept Invite')}
                    <p>This invite expires in 7 days.</p>
                    <p>If you don't recognize this organization, you can safely ignore this email.</p>
                `),
            },
            'team-invite',
        );
    }
}

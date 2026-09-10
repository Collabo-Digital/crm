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
        console.log(options);
        console.log(this.from);
        console.log(this.replyTo);
        // console.log(this.htmlToText(options.html));\
        console.log("Sending email...");
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
        console.log("Sending verification code...", email, code);
        if (this.isDev) {
            this.logger.log(`[DEV] Verification code for ${email}: ${code}`);
            return;
        }
        await this.send(
            {
                to: email,
                subject: 'Your verification code',
                html: `
                    <h2>Verify your email</h2>
                    <p>Your verification code is:</p>
                    <h1 style="font-size: 32px; letter-spacing: 8px; text-align: center; padding: 16px; background: #f3f4f6; border-radius: 8px;">${code}</h1>
                    <p>This code expires in 10 minutes.</p>
                    <p>If you didn't create an account, you can safely ignore this email.</p>
                `,
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
                html: `
                    <h2>Reset your password</h2>
                    <p>Click the button below to reset your password:</p>
                    <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Reset Password</a>
                    <p>This link expires in 1 hour.</p>
                    <p>If you didn't request this, you can safely ignore this email.</p>
                `,
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
                html: `
                    <h2>You've been invited!</h2>
                    <p>You've been invited to join <strong>${orgName}</strong>.</p>
                    <a href="${inviteLink}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Accept Invite</a>
                    <p>This invite expires in 7 days.</p>
                    <p>If you don't recognize this organization, you can safely ignore this email.</p>
                `,
            },
            'team-invite',
        );
    }
}

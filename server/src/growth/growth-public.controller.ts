import { Body, Controller, Get, Header, Headers, HttpCode, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { WidgetEventDto, WidgetSignupDto } from './dto/growth.dto';
import { GrowthService } from './growth.service';

/**
 * Public, unauthenticated: the short links (/l/:code) customers open or
 * scan, and the website widget's script, beacon and sign-up form. Other
 * sites load these, so CORS lets any origin in without credentials (see
 * main.ts); sign-ups then check the widget's own allowed domains.
 */
@Controller()
export class GrowthPublicController {
    constructor(private readonly growth: GrowthService) { }

    /** Shared phones and offices sit behind one address, so following a link is not rate limited. */
    @Public()
    @SkipThrottle()
    @Get('l/:code')
    async follow(@Param('code') code: string, @Res() res: Response) {
        const target = /^[2-9A-Za-z]{8}$/.test(code) ? await this.growth.follow(code) : null;
        res.setHeader('X-Robots-Tag', 'noindex');
        res.setHeader('Cache-Control', 'no-store');
        if (!target) {
            res.status(404).type('text/plain').send('This chat link is no longer active.');
            return;
        }
        res.redirect(302, target);
    }

    /** <script src=".../widget/KEY.js" async> on the merchant's site. */
    @Public()
    @SkipThrottle()
    @Get('widget/:file')
    async script(@Param('file') file: string, @Res() res: Response) {
        const key = file.endsWith('.js') ? file.slice(0, -3) : '';
        if (!/^[\w-]{10,40}$/.test(key)) throw new NotFoundException();
        const body = await this.growth.script(key);
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        // Helmet's default would stop other sites from loading the script.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(body);
    }

    // Read from the merchant's site: Helmet's same-origin default would block the response there.
    @Public()
    @Post('widget/:key/event')
    @HttpCode(204)
    @Header('Cross-Origin-Resource-Policy', 'cross-origin')
    async event(@Param('key') key: string, @Body() dto: WidgetEventDto) {
        await this.growth.widgetEvent(key, dto.type);
    }

    @Public()
    @Post('widget/:key/signup')
    @HttpCode(200)
    @Header('Cross-Origin-Resource-Policy', 'cross-origin')
    signup(@Param('key') key: string, @Body() dto: WidgetSignupDto, @Headers('origin') origin?: string, @Headers('referer') referer?: string) {
        return this.growth.signup(key, dto, origin || referer);
    }
}

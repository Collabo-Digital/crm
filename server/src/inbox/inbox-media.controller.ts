import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { InboxService } from './inbox.service';

/**
 * Chat files behind signed, expiring links (see media-url.ts). Its own
 * controller because it is public — an <img> cannot send the Bearer token —
 * and the inbox controller's role and section requirements would refuse a
 * request with no user.
 */
@Controller('inbox/media')
@SkipThrottle()
export class InboxMediaController {
    constructor(private readonly inbox: InboxService) { }

    @Public()
    @Get(':messageId')
    async media(
        @Param('messageId') messageId: string,
        @Query('exp') exp: string | undefined,
        @Query('sig') sig: string | undefined,
        @Res() res: Response,
    ) {
        const file = await this.inbox.openMedia(messageId, exp, sig);
        res.setHeader('Content-Type', file.mime);
        res.setHeader('Content-Length', String(file.size));
        res.setHeader('Cache-Control', 'private, max-age=600');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // The app is on another origin and loads these in <img>, <video> and
        // <audio>; Helmet's same-origin default would make the browser refuse them.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        if (file.filename) {
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
        }
        file.stream.pipe(res);
    }
}

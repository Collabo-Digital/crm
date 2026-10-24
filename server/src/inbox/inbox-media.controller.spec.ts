import { PassThrough, Readable } from 'stream';
import type { Response } from 'express';
import { InboxMediaController } from './inbox-media.controller';
import type { InboxService } from './inbox.service';

describe('InboxMediaController', () => {
    it('lets the app on another origin show the file', async () => {
        const inbox = { openMedia: jest.fn().mockResolvedValue({ stream: Readable.from(['x']), size: 1, mime: 'image/jpeg', filename: null }) };
        const res = Object.assign(new PassThrough(), { setHeader: jest.fn() });
        await new InboxMediaController(inbox as unknown as InboxService).media('m1', '1', 'sig', res as unknown as Response);
        expect(res.setHeader).toHaveBeenCalledWith('Cross-Origin-Resource-Policy', 'cross-origin');
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });
});

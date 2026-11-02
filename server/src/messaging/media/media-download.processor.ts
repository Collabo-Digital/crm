import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MEDIA_DOWNLOAD_QUEUE, MediaDownloadJobData } from './media-download.queue';
import { MediaDownloadService } from './media-download.service';
import { ContactProfileService } from '../contact-profile.service';

@Processor(MEDIA_DOWNLOAD_QUEUE, { concurrency: 3 })
export class MediaDownloadProcessor extends WorkerHost {
    private readonly logger = new Logger(MediaDownloadProcessor.name);

    constructor(
        private readonly media: MediaDownloadService,
        private readonly profiles: ContactProfileService,
    ) {
        super();
    }

    async process(job: Job<MediaDownloadJobData>): Promise<void> {
        if ('contactId' in job.data) {
            await this.profiles.fetch(job.data.contactId);
            return;
        }
        const { messageId } = job.data;
        try {
            await this.media.download(messageId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
                await this.media.markFailed(messageId, message);
                this.logger.warn(`Media for message ${messageId} not stored: ${message}`);
            }
            throw err;
        }
    }
}

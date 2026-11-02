import { Module } from '@nestjs/common';
import { JudgemeClient } from './judgeme.client';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/** Reviews collected on WhatsApp, published to each organization's own Judge.me. */
@Module({
    controllers: [ReviewsController],
    providers: [ReviewsService, JudgemeClient],
    exports: [ReviewsService],
})
export class ReviewsModule { }

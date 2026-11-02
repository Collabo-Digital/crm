import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PixelIngestDto } from './dto/pixel-ingest.dto';
import { PixelIngestService } from './pixel-ingest.service';

@Controller('analytics/pixel')
export class PixelIngestController {
    constructor(private readonly service: PixelIngestService) { }

    @Public()
    @Throttle({ default: { ttl: 60_000, limit: 120 } })
    @Post()
    @HttpCode(200)
    async ingest(@Body() dto: PixelIngestDto, @Ip() ip: string) {
        return this.service.ingest(dto, ip);
    }
}
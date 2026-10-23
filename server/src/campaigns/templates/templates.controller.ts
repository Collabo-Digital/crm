import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { MessagingMediaStorage } from '../../messaging/media/messaging-media.storage';
import { CAMPAIGN_EDITORS, CAMPAIGN_READERS } from '../campaign-roles';
import { QueryTemplatesDto, SaveTemplateDto } from '../dto/campaign.dto';
import { parseDraft } from './template-draft.schema';
import { TemplatesService } from './templates.service';

/// Files a template header or a broadcast may carry, with WhatsApp's size ceilings.
const HEADER_FILES: Record<string, { kind: 'image' | 'video' | 'document'; max: number }> = {
    'image/jpeg': { kind: 'image', max: 5 * 1024 * 1024 },
    'image/png': { kind: 'image', max: 5 * 1024 * 1024 },
    'video/mp4': { kind: 'video', max: 16 * 1024 * 1024 },
    'application/pdf': { kind: 'document', max: 100 * 1024 * 1024 },
};

/** WhatsApp message templates: Meta reviews them; Collabo keeps them in step. */
@Controller('campaigns')
@RequireSection('campaigns')
export class TemplatesController {
    constructor(
        private readonly templates: TemplatesService,
        private readonly storage: MessagingMediaStorage,
    ) { }

    @Get('templates')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    list(@CurrentUser() user: SessionPayload, @Query() q: QueryTemplatesDto) {
        return this.templates.list(user.orgId!, q);
    }

    @Get('templates/starters')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    starters() {
        return this.templates.starters();
    }

    @Post('templates/sync')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    sync(@CurrentUser() user: SessionPayload) {
        return this.templates.sync(user.orgId!);
    }

    @Get('templates/:id')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.templates.get(user.orgId!, id);
    }

    @Post('templates')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('templates.manage')
    create(@CurrentUser() user: SessionPayload, @Body() dto: SaveTemplateDto) {
        return this.templates.create(user.orgId!, user.sub, parseDraft(dto.draft), dto.starterKey);
    }

    @Patch('templates/:id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('templates.manage')
    update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: SaveTemplateDto) {
        return this.templates.update(user.orgId!, id, parseDraft(dto.draft));
    }

    @Delete('templates/:id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('templates.manage')
    remove(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.templates.remove(user.orgId!, id);
    }

    /** A header sample for a template, or the header file of a broadcast. */
    @Post('uploads')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
    async upload(@CurrentUser() user: SessionPayload, @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined) {
        if (!file) throw new BadRequestException('Choose a file.');
        const mime = file.mimetype.split(';')[0].trim().toLowerCase();
        const rule = HEADER_FILES[mime];
        if (!rule) throw new BadRequestException('Use a JPEG or PNG image, an MP4 video or a PDF.');
        if (file.size > rule.max) throw new BadRequestException(`That file is too large; the limit is ${rule.max / 1024 / 1024} MB.`);
        const saved = await this.storage.save(user.orgId!, file.buffer, mime);
        return { storageKey: saved.storageKey, mime, size: saved.size, filename: file.originalname, kind: rule.kind };
    }
}

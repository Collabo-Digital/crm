import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { LockTimeoutError } from '../../automation/engine/redis-lock';
import { MessagingMediaStorage } from '../../messaging/media/messaging-media.storage';
import { CAMPAIGN_EDITORS, CAMPAIGN_READERS } from '../campaign-roles';
import { QueryTemplatesDto, SaveTemplateDto, WriteTemplateDto } from '../dto/campaign.dto';
import { parseDraft } from './template-draft.schema';
import { TemplateWriterService } from './template-writer.service';
import { TemplatesService } from './templates.service';
import { TemplatePackService } from './pack/template-pack.service';

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
        private readonly writer: TemplateWriterService,
        private readonly storage: MessagingMediaStorage,
        private readonly pack: TemplatePackService,
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

    /** Whether the AI template writer is set up on this server. */
    @Get('templates/writer')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    writerStatus() {
        return this.writer.status();
    }

    /** A draft written by AI from a description, for the editor; nothing is sent to Meta. */
    @Post('templates/writer')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('templates.manage')
    write(@CurrentUser() user: SessionPayload, @Body() dto: WriteTemplateDto) {
        return this.writer.write(user.orgId!, dto);
    }

    @Post('templates/sync')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    async sync(@CurrentUser() user: SessionPayload) {
        try {
            return await this.templates.sync(user.orgId!);
        } catch (err) {
            if (err instanceof LockTimeoutError) throw new ConflictException('Collabo is updating the templates on this WhatsApp account. Try again in a minute.');
            throw err;
        }
    }

    /** Collabo's recommended templates on the account: what was made, and what Meta made of each. */
    @Get('templates/pack')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    packView(@CurrentUser() user: SessionPayload) {
        return this.pack.view(user.orgId!);
    }

    /** Sets up the recommended templates, or repairs them; the work runs in the background. */
    @Post('templates/pack')
    @HttpCode(202)
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('templates.manage')
    startPack(@CurrentUser() user: SessionPayload) {
        return this.pack.start(user.orgId!);
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

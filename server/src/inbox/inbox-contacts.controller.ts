import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { INBOX_ROLES } from './inbox.controller';
import { InboxContactsService } from './inbox-contacts.service';
import { InboxTeamService } from './inbox-team.service';
import { ContactImportService } from './contact-import.service';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { RecordConsentDto } from './dto/record-consent.dto';
import { BulkTagContactsDto } from './dto/bulk-tag-contacts.dto';
import { StartChatDto } from './dto/start-chat.dto';

type ImportFile = { buffer: Buffer; size: number; originalname: string } | undefined;

const MappingSchema = z.object({
    phone: z.string().min(1).max(100),
    name: z.string().max(100).optional(),
    tags: z.string().max(100).optional(),
    optIn: z.string().max(100).optional(),
    attributes: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/i), z.string().max(100)).optional(),
});
const OptionsSchema = z.object({
    defaultCountryCode: z.string().max(4).optional(),
    tags: z.array(z.string().min(1).max(60)).max(10).optional(),
    markOptedIn: z.boolean().optional(),
});

function parseJson<T>(schema: z.ZodType<T>, raw: string, what: string): T {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new BadRequestException(`The ${what} is not valid JSON.`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException(`Invalid ${what}: ${parsed.error.issues[0].path.join('.')} — ${parsed.error.issues[0].message}`);
    return parsed.data;
}

/** The people behind the conversations: list, profile, tags, owner, consent, store link. */
@Controller('inbox/contacts')
@RequireSection('chat')
@Roles(...INBOX_ROLES)
export class InboxContactsController {
    constructor(
        private readonly contacts: InboxContactsService,
        private readonly teams: InboxTeamService,
        private readonly imports: ContactImportService,
    ) { }

    /** The file's columns and first rows, to map them before importing. */
    @Post('import/preview')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
    previewImport(@UploadedFile() file: ImportFile) {
        return this.imports.preview(file);
    }

    @Post('import')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
    async runImport(
        @CurrentUser() user: SessionPayload,
        @UploadedFile() file: ImportFile,
        @Body('mapping') mapping: string,
        @Body('options') options: string,
    ) {
        return this.imports.run(user.orgId!, await this.teams.viewer(user), file, parseJson(MappingSchema, mapping, 'mapping'), parseJson(OptionsSchema, options ?? '{}', 'options'));
    }

    /** Declared before :id so "imports" is not read as a contact id. */
    @Get('imports')
    importHistory(@CurrentUser() user: SessionPayload) {
        return this.imports.history(user.orgId!);
    }

    /** A WhatsApp chat with a number: the contact found or added, and its conversation. */
    @Post()
    async startChat(@CurrentUser() user: SessionPayload, @Body() dto: StartChatDto) {
        return this.contacts.startChat(user.orgId!, await this.teams.viewer(user), dto);
    }

    @Get()
    async list(@CurrentUser() user: SessionPayload, @Query() q: QueryContactsDto) {
        return this.contacts.list(user.orgId!, await this.teams.viewer(user), q);
    }

    @Post('bulk-tag')
    async bulkTag(@CurrentUser() user: SessionPayload, @Body() dto: BulkTagContactsDto) {
        return this.contacts.bulkTag(user.orgId!, await this.teams.viewer(user), dto);
    }

    /** Declared before :id so "tags" is not read as a contact id. */
    @Get('tags')
    async tags(@CurrentUser() user: SessionPayload) {
        return this.contacts.tags(user.orgId!, await this.teams.viewer(user));
    }

    @Get(':id')
    async get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.contacts.get(user.orgId!, await this.teams.viewer(user), id);
    }

    @Patch(':id')
    async update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateContactDto) {
        return this.contacts.update(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    @Post(':id/consent')
    async consent(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: RecordConsentDto) {
        return this.contacts.recordConsent(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    /** Store customers to link: the ones sharing the number, or a search. */
    @Get(':id/customers')
    async customers(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query('q') q?: string) {
        return this.contacts.customerCandidates(user.orgId!, await this.teams.viewer(user), id, q?.slice(0, 120));
    }
}

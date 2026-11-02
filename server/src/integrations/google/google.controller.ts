import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { GoogleService } from './google.service';

class CreateSheetDto {
    @IsString() @MinLength(1) @MaxLength(100) title!: string;
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(26) @IsString({ each: true }) @MaxLength(60, { each: true }) headers!: string[];
}

class CompleteDto {
    @IsString() @MinLength(10) @MaxLength(2000) code!: string;
    @IsString() @Matches(/^[0-9a-f]{32}$/, { message: 'That sign-in is not valid. Connect Google again.' }) state!: string;
}

class PickedSheetDto {
    @IsString() @Matches(/^[A-Za-z0-9_-]{10,100}$/, { message: 'That is not a Google Sheets id.' }) spreadsheetId!: string;
}

/** Everyone who sees automations sees the sheets; influencers' automations are their own Instagram only. */
const READERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER];
const EDITORS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER];
/** The organization's Google account is connected by owners and admins. */
const ACCOUNT_OWNERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN];

/** Campaigns → Automations → Google Sheets: the Google account and the sheets automations use. */
@Controller('integrations/google')
@RequireSection('campaigns')
export class GoogleController {
    constructor(private readonly google: GoogleService) { }

    @Get()
    @Roles(...READERS)
    @RequirePermissions('campaigns.view')
    status(@CurrentUser() user: SessionPayload) {
        return this.google.status(user.orgId!);
    }

    @Get('connect')
    @Roles(...ACCOUNT_OWNERS)
    connect(@CurrentUser() user: SessionPayload) {
        return this.google.connectUrl(user.orgId!, user.sub);
    }

    @Post('complete')
    @Roles(...ACCOUNT_OWNERS)
    complete(@CurrentUser() user: SessionPayload, @Body() dto: CompleteDto) {
        return this.google.complete(user.orgId!, user.sub, dto.code, dto.state);
    }

    @Delete()
    @Roles(...ACCOUNT_OWNERS)
    @HttpCode(204)
    async disconnect(@CurrentUser() user: SessionPayload) {
        await this.google.disconnect(user.orgId!);
    }

    @Get('picker-token')
    @Roles(...EDITORS)
    @RequirePermissions('campaigns.manage')
    pickerToken(@CurrentUser() user: SessionPayload) {
        return this.google.pickerToken(user.orgId!);
    }

    @Post('sheets')
    @Roles(...EDITORS)
    @RequirePermissions('campaigns.manage')
    create(@CurrentUser() user: SessionPayload, @Body() dto: CreateSheetDto) {
        return this.google.createSheet(user.orgId!, user.sub, dto);
    }

    @Post('sheets/picked')
    @Roles(...EDITORS)
    @RequirePermissions('campaigns.manage')
    picked(@CurrentUser() user: SessionPayload, @Body() dto: PickedSheetDto) {
        return this.google.addPicked(user.orgId!, user.sub, dto.spreadsheetId);
    }

    @Delete('sheets/:id')
    @Roles(...EDITORS)
    @RequirePermissions('campaigns.manage')
    remove(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.google.removeSheet(user.orgId!, id);
    }

    @Get('sheets/:id/columns')
    @Roles(...READERS)
    @RequirePermissions('campaigns.view')
    columns(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.google.columns(user.orgId!, id);
    }
}

import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ORG_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { WhatsAppPayService } from './whatsapp-pay.service';

class CreateConfigurationDto {
    /** Meta: at most 60 characters. */
    @IsString() @Matches(/^[A-Za-z0-9_-]{3,60}$/, { message: 'Use 3 to 60 letters, numbers, dashes or underscores.' })
    name!: string;

    @IsIn(['razorpay', 'payu', 'billdesk', 'zaakpay'])
    provider!: string;

    @IsOptional() @IsString() @MaxLength(500)
    redirectUrl?: string;
}

class SelectConfigurationDto {
    @IsOptional() @IsString() @MaxLength(60)
    name?: string | null;
}

class LinkAgainDto {
    @IsString() @MaxLength(60)
    name!: string;
}

/** Who may change where a number's payments go. */
const ACCOUNT_OWNERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN];

/**
 * Campaigns → Catalog → WhatsApp Pay: the number's payment configurations in
 * WhatsApp Manager, and which one its "Review and Pay" bills use.
 */
@Controller('payments/whatsapp-pay')
@RequireSection('campaigns')
export class WhatsAppPayController {
    constructor(private readonly whatsAppPay: WhatsAppPayService) { }

    @Get(':channelId')
    @Roles(...ORG_MANAGERS)
    view(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string) {
        return this.whatsAppPay.view(user.orgId!, channelId);
    }

    @Post(':channelId/configurations')
    @Roles(...ACCOUNT_OWNERS)
    create(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string, @Body() dto: CreateConfigurationDto) {
        return this.whatsAppPay.createConfiguration(user.orgId!, channelId, dto);
    }

    @Post(':channelId/configurations/link')
    @Roles(...ACCOUNT_OWNERS)
    linkAgain(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string, @Body() dto: LinkAgainDto) {
        return this.whatsAppPay.linkAgain(user.orgId!, channelId, dto.name);
    }

    @Put(':channelId')
    @Roles(...ACCOUNT_OWNERS)
    select(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string, @Body() dto: SelectConfigurationDto) {
        return this.whatsAppPay.select(user.orgId!, channelId, dto.name ?? null);
    }
}

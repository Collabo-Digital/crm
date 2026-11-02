import { IsEnum, IsOptional, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

export class UpdateMemberRoleDto {
    // New role for the member. Cannot be OWNER or INFLUENCER — validated in service.
    @IsEnum(UserRole)
    role: UserRole;

    // Required when the new role is VENDOR: the Product.vendor value the member
    // is scoped to. Validated against a real vendor in the service layer.
    @IsOptional()
    @IsString()
    vendorScope?: string;
}

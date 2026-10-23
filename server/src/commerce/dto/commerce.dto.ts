import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectCatalogDto {
    @IsString() @MaxLength(30)
    catalogId!: string;
}

export class CommerceSettingsDto {
    @IsOptional() @IsBoolean()
    catalogVisible?: boolean;

    @IsOptional() @IsBoolean()
    cartEnabled?: boolean;
}

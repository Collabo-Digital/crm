import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateWarehouseDto {
  // Sized to hold any Shopify location name verbatim — the sync stores what
  // Shopify sends without truncating, so this cap must never be the thing that
  // chops a name (the column itself is TEXT).
  @IsString()
  @MaxLength(255)
  name: string;

  // Location-code prefix ("WH1" → "WH1-A01-S02-B03"). Uppercase alnum only —
  // scanner-layout-safe (keyboard-wedge scanners emit layout-dependent keys;
  // dash/alnum survives every layout).
  @Matches(/^[A-Z0-9]{1,8}$/, {
    message: 'code must be 1-8 uppercase letters/digits (e.g. WH1)',
  })
  code: string;

  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  // GST registration this warehouse operates under — it becomes an ADDITIONAL
  // PLACE OF BUSINESS of that GSTIN. The address must resolve to the same
  // state; WarehouseService enforces it.
  @IsOptional()
  @IsString()
  gstinId?: string;

  @IsOptional()
  @IsBoolean()
  apobDeclared?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  // Null unlinks. `@IsOptional()` skips validation for null as well as
  // undefined, so the two stay distinguishable: undefined = leave alone.
  @IsOptional()
  @IsString()
  gstinId?: string | null;

  @IsOptional()
  @IsBoolean()
  apobDeclared?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Generate a rack/shelf/bin grid in one call, e.g. 5 racks × 4 shelves × 6
 * bins → A01-S01-B01 … A05-S04-B06 (120 bins + parents). Codes are derived,
 * not supplied — merchants who need custom naming edit individual locations
 * later (V2); V1 optimizes for "set up my warehouse in one minute".
 */
export class BulkLocationsDto {
  @IsInt()
  @Min(1)
  @Max(50)
  racks: number;

  @IsInt()
  @Min(1)
  @Max(20)
  shelvesPerRack: number;

  @IsInt()
  @Min(1)
  @Max(50)
  binsPerShelf: number;

  // Rack letter prefix; racks are lettered A, B, C… when true (default),
  // numbered R01, R02… when false.
  @IsOptional()
  @IsBoolean()
  letterRacks?: boolean;
}

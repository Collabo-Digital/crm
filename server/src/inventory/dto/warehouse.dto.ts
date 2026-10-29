import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * "Does this location have its own GST number?" — asked only while GST is on
 * for the workspace, and ignored otherwise.
 *
 *  - `existing`: a GSTIN already among the workspace's registrations, for the
 *    location's state.
 *  - `new`: its own GSTIN, added to the workspace's registrations and linked.
 *  - `none`: no GSTIN of its own; it operates under the workspace's GSTIN for
 *    its state, when there is one.
 *
 * Which fields a mode needs is checked by WarehouseService, so the merchant
 * gets a sentence rather than a field list.
 */
export class LocationGstChoiceDto {
  @IsIn(['existing', 'new', 'none'])
  mode: 'existing' | 'new' | 'none';

  @IsOptional()
  @IsString()
  gstinId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  gstin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tradeName?: string;
}

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

  /** A Warehouse when not given. Only a Store has a till. */
  @IsOptional()
  @IsIn(['STORE', 'WAREHOUSE'])
  kind?: 'STORE' | 'WAREHOUSE';

  // { address1, address2, city, zip, stateCode } — free-form beyond that, as
  // an address seeded from Shopify carries more keys. The state is required
  // while GST is on; WarehouseService checks it.
  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationGstChoiceDto)
  gst?: LocationGstChoiceDto;

  // Earlier form of `gst: { mode: 'existing' }`, still accepted. The address
  // must resolve to the same state; WarehouseService enforces it.
  @IsOptional()
  @IsString()
  gstinId?: string;

  @IsOptional()
  @IsBoolean()
  apobDeclared?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  /** Share stock with this Shopify location of the connected store. */
  @IsOptional()
  @IsString()
  shopifyLocationId?: string;

  /** With `shopifyLocationId`: whose counts to keep. Shopify's when not given. */
  @IsOptional()
  @IsIn(['shopify', 'collabo'])
  stockSource?: 'shopify' | 'collabo';
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @Matches(/^[A-Z0-9]{1,8}$/, {
    message: 'code must be 1-8 uppercase letters/digits (e.g. WH1)',
  })
  code?: string;

  @IsOptional()
  @IsIn(['STORE', 'WAREHOUSE'])
  kind?: 'STORE' | 'WAREHOUSE';

  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationGstChoiceDto)
  gst?: LocationGstChoiceDto;

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

  /** A Shopify location id to share stock with; null stops sharing. */
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  shopifyLocationId?: string | null;

  @IsOptional()
  @IsIn(['shopify', 'collabo'])
  stockSource?: 'shopify' | 'collabo';
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

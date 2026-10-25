import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * One Shopify location and what to do with it. Which fields an action needs
 * (a location and whose counts to keep for `link`) is checked by the service,
 * so the merchant gets a sentence rather than a field list.
 */
export class ShopifyLocationDecisionDto {
  @IsString()
  @IsNotEmpty()
  shopifyLocationId: string;

  @IsIn(['link', 'create', 'ignore'])
  action: 'link' | 'create' | 'ignore';

  /** link: the location to share stock with. */
  @IsOptional()
  @IsString()
  warehouseId?: string;

  /** link: whose counts to keep — Shopify's, or the location's own. */
  @IsOptional()
  @IsIn(['shopify', 'collabo'])
  stockSource?: 'shopify' | 'collabo';

  /** create: what the new location is; a Warehouse when not given. */
  @IsOptional()
  @IsIn(['STORE', 'WAREHOUSE'])
  kind?: 'STORE' | 'WAREHOUSE';

  /** create: its name; the Shopify location's when not given. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

export class ApplyShopifyLocationDecisionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(250)
  @ValidateNested({ each: true })
  @Type(() => ShopifyLocationDecisionDto)
  decisions: ShopifyLocationDecisionDto[];
}

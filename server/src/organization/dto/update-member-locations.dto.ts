import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

/**
 * Body for PATCH :memberId/locations. Replaces the stock locations a Manager
 * or Agent works at; an empty list means every location.
 */
export class UpdateMemberLocationsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  locationScope: string[];
}

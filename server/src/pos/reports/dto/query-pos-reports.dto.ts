import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** Store reports take calendar days only: a day means that day in the org's timezone. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MESSAGE = 'Dates must be calendar days, like 2026-10-26.';

export class QueryPosSummaryDto {
  /// First day of the period. Defaults to the last day.
  @IsOptional() @Matches(CALENDAR_DAY, { message: DAY_MESSAGE }) @IsDateString({ strict: true }) from?: string;
  /// Last day of the period, included. Defaults to today.
  @IsOptional() @Matches(CALENDAR_DAY, { message: DAY_MESSAGE }) @IsDateString({ strict: true }) to?: string;
  /// A warehouse id: the store the bills were rung up at.
  @IsOptional() @IsString() storeId?: string;
}

export class QueryPosActivityDto {
  /// Without either date the log is simply the most recent entries.
  @IsOptional() @Matches(CALENDAR_DAY, { message: DAY_MESSAGE }) @IsDateString({ strict: true }) from?: string;
  @IsOptional() @Matches(CALENDAR_DAY, { message: DAY_MESSAGE }) @IsDateString({ strict: true }) to?: string;
  /// sale, unlock, pin_failed, approval, …
  @IsOptional() @IsString() @MaxLength(40) type?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number = 50;
}

import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RecordConsentDto {
    @IsIn(['OPT_IN', 'OPT_OUT']) type: 'OPT_IN' | 'OPT_OUT';
    /** How the customer gave or withdrew consent, in the agent's words. */
    @IsOptional() @IsString() @MaxLength(500) note?: string;
}

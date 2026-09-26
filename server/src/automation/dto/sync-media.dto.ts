import { IsNotEmpty, IsString } from 'class-validator';

/** Body of POST /automations/media/sync. */
export class SyncMediaDto {
    @IsString()
    @IsNotEmpty()
    channelId!: string;
}
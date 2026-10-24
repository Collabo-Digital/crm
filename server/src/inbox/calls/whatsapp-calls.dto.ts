import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** An SDP offer or answer from the browser's WebRTC peer connection. */
export class CallSdpDto {
    @IsString() @MinLength(10) @MaxLength(20000) sdp: string;
}

export class CallPermissionRequestDto {
    @IsOptional() @IsString() @MaxLength(1024) text?: string;
}

export class CallSettingsDto {
    @IsBoolean() enabled: boolean;
    @IsBoolean() showCallButton: boolean;
    @IsBoolean() callbackPermission: boolean;
}

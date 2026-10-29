import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Recordings a browser makes, by the ffmpeg demuxer each is read with. The format is forced, never sniffed. */
export const VOICE_INPUT_FORMATS: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
};

const VOICE_MAX_MS = 120_000;
/// A recorder stopped at the limit runs a few frames over.
const VOICE_GRACE_MS = 500;
const FFMPEG_TIMEOUT_MS = 30_000;
/// Opus granule positions count 48 kHz samples whatever the input rate was.
const OPUS_RATE = 48_000;

/** A recording that cannot be used; the message is for the person who recorded it. */
export class VoiceNoteError extends Error { }

/** What an Ogg Opus file holds; null when the bytes are not one. */
export function readOggOpus(file: Buffer): { channels: number; durationMs: number } | null {
    if (file.length < 28 || file.toString('latin1', 0, 4) !== 'OggS') return null;
    // The first page carries only the OpusHead packet.
    const head = 27 + file[26];
    if (file.length < head + 19 || file.toString('latin1', head, head + 8) !== 'OpusHead') return null;
    const channels = file[head + 9];
    const preSkip = file.readUInt16LE(head + 10);

    let granule = 0n;
    let pos = 0;
    while (pos < file.length) {
        if (pos + 27 > file.length || file.toString('latin1', pos, pos + 4) !== 'OggS') return null;
        const segments = file[pos + 26];
        if (pos + 27 + segments > file.length) return null;
        let body = 0;
        for (let i = 0; i < segments; i++) body += file[pos + 27 + i];
        // -1: no packet ends on this page.
        const at = file.readBigInt64LE(pos + 6);
        if (at >= 0n) granule = at;
        pos += 27 + segments + body;
    }
    if (pos !== file.length) return null;
    const samples = Number(granule) - preSkip;
    return { channels, durationMs: Math.max(0, Math.round((samples * 1000) / OPUS_RATE)) };
}

/** A stored file's length when it can go out as a voice note (mono Ogg Opus within the limit), else null. */
export function voiceNoteDurationMs(file: Buffer): number | null {
    const note = readOggOpus(file);
    return note && note.channels === 1 && note.durationMs > 0 && note.durationMs <= VOICE_MAX_MS + VOICE_GRACE_MS ? note.durationMs : null;
}

/**
 * Converts browser recordings into what the platforms take as a voice note,
 * with ffmpeg (FFMPEG_PATH). Every run gets its own temporary directory,
 * removed afterwards whatever happened.
 */
@Injectable()
export class VoiceNoteConverter {
    private readonly logger = new Logger(VoiceNoteConverter.name);
    private readonly ffmpeg: string;

    constructor(config: ConfigService) {
        this.ffmpeg = config.get<string>('messaging.ffmpegPath') ?? 'ffmpeg';
    }

    /**
     * WhatsApp's voice note: Ogg/Opus, mono, 48 kHz, about 24 kbit/s. The
     * bitrate is constrained (free VBR doubles it on tonal sound) so two
     * minutes stay under the 512 KB WhatsApp shows a play button for.
     */
    async toVoiceNote(input: Buffer, mime: string): Promise<{ buffer: Buffer; durationMs: number }> {
        const format = VOICE_INPUT_FORMATS[mime];
        if (!format) throw new VoiceNoteError('Voice messages can be recorded as WebM, Ogg, MP4, MP3 or WAV audio only.');
        const buffer = await this.convert(
            input,
            ['-f', format],
            // Read a little past the limit, so a longer recording is refused below instead of cut short.
            ['-t', String((VOICE_MAX_MS + 1000) / 1000), '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', '-vbr', 'constrained', '-application', 'voip', '-f', 'ogg'],
            'voice.ogg',
        );
        const note = readOggOpus(buffer);
        if (!note) throw new VoiceNoteError('This recording could not be read. Record it again.');
        if (note.durationMs === 0) throw new VoiceNoteError('This recording is empty. Record it again.');
        if (note.durationMs > VOICE_MAX_MS + VOICE_GRACE_MS) throw new VoiceNoteError('Voice messages can be at most 2 minutes long. Record a shorter one.');
        return { buffer, durationMs: note.durationMs };
    }

    /** A stored voice note as an .m4a (AAC) file, for Instagram and Messenger, which take no Ogg. */
    async toM4a(voiceNote: Buffer): Promise<Buffer> {
        return this.convert(
            voiceNote,
            ['-f', 'ogg'],
            ['-vn', '-map_metadata', '-1', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4'],
            'voice.m4a',
        );
    }

    private async convert(input: Buffer, inputArgs: string[], outputArgs: string[], outputName: string): Promise<Buffer> {
        const dir = await fs.mkdtemp(join(tmpdir(), 'collabo-voice-'));
        try {
            const inputPath = join(dir, 'input');
            const outputPath = join(dir, outputName);
            await fs.writeFile(inputPath, input);
            await this.run(['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs, '-i', inputPath, ...outputArgs, outputPath]);
            return await fs.readFile(outputPath);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }

    private run(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            // Not spawn's own `timeout`: its timer outlives a binary that failed to start.
            const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
            let stderr = '';
            child.stderr.on('data', (chunk: Buffer) => {
                if (stderr.length < 2000) stderr += chunk.toString();
            });
            let spawnError: Error | null = null;
            // ffmpeg missing or not executable: a server problem, not the recording's.
            child.on('error', (err) => {
                clearTimeout(timer);
                spawnError = err;
                reject(err);
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                if (spawnError) return;
                if (code === 0) return resolve();
                this.logger.warn(signal ? `ffmpeg stopped after ${FFMPEG_TIMEOUT_MS / 1000}s` : `ffmpeg exited with ${code}: ${stderr.trim().slice(0, 500)}`);
                reject(new VoiceNoteError('This recording could not be read. Record it again.'));
            });
        });
    }
}

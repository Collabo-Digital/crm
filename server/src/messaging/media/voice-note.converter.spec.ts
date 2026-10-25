import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VoiceNoteConverter, VoiceNoteError, readOggOpus, voiceNoteDurationMs } from './voice-note.converter';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const describeIfFfmpeg = encoders.status === 0 && encoders.stdout.includes('libopus') ? describe : describe.skip;

const converter = (path = FFMPEG) => new VoiceNoteConverter({ get: () => path } as never);
const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('collabo-voice-')).length;

describeIfFfmpeg('VoiceNoteConverter (real ffmpeg)', () => {
    let dir: string;
    /** A tone made by ffmpeg itself, as a browser would upload it. */
    const make = (name: string, seconds: number, args: string[]) => {
        const path = join(dir, name);
        const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...args, path]);
        if (made.status !== 0) throw new Error(made.stderr.toString());
        return readFileSync(path);
    };

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'voice-spec-'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('turns a stereo WebM recording into mono Ogg/Opus at 48 kHz and measures it', async () => {
        const webm = make('in.webm', 1.5, ['-ac', '2', '-c:a', 'libopus', '-f', 'webm']);
        const before = leftovers();
        const { buffer, durationMs } = await converter().toVoiceNote(webm, 'audio/webm');
        expect(buffer.toString('latin1', 0, 4)).toBe('OggS');
        expect(readOggOpus(buffer)).toEqual({ channels: 1, durationMs: expect.any(Number) });
        expect(Math.abs(durationMs - 1500)).toBeLessThan(60);
        expect(voiceNoteDurationMs(buffer)).toBe(durationMs);
        expect(leftovers()).toBe(before);
    });

    it('reads an MP4 (AAC) recording, as Safari makes them', async () => {
        const mp4 = make('in.m4a', 2, ['-c:a', 'aac', '-f', 'mp4']);
        const { buffer, durationMs } = await converter().toVoiceNote(mp4, 'audio/mp4');
        expect(readOggOpus(buffer)?.channels).toBe(1);
        expect(Math.abs(durationMs - 2000)).toBeLessThan(80);
    });

    it('keeps two minutes well under the 512 KB WhatsApp shows a play button for', async () => {
        const webm = make('long.webm', 119, ['-c:a', 'libopus', '-b:a', '64k', '-f', 'webm']);
        const { buffer, durationMs } = await converter().toVoiceNote(webm, 'audio/webm');
        expect(buffer.length).toBeLessThan(512 * 1024);
        expect(Math.abs(durationMs - 119_000)).toBeLessThan(100);
    });

    it('refuses a recording longer than two minutes', async () => {
        const webm = make('too-long.webm', 125, ['-c:a', 'libopus', '-b:a', '16k', '-f', 'webm']);
        const before = leftovers();
        await expect(converter().toVoiceNote(webm, 'audio/webm')).rejects.toThrow('Voice messages can be at most 2 minutes long. Record a shorter one.');
        expect(leftovers()).toBe(before);
    });

    it('refuses bytes that are not the recording they claim to be, and cleans up', async () => {
        const before = leftovers();
        const err = await converter().toVoiceNote(Buffer.from('not audio at all'), 'audio/webm').catch((e) => e);
        expect(err).toBeInstanceOf(VoiceNoteError);
        expect(err.message).toBe('This recording could not be read. Record it again.');
        expect(leftovers()).toBe(before);
    });

    it('refuses a type it was not told how to read, without running ffmpeg', async () => {
        await expect(converter('/nonexistent/ffmpeg').toVoiceNote(Buffer.from('x'), 'video/mp4')).rejects.toBeInstanceOf(VoiceNoteError);
    });

    it('reports a missing ffmpeg as a server problem, not a bad recording', async () => {
        const webm = make('missing.webm', 0.5, ['-c:a', 'libopus', '-f', 'webm']);
        const err = await converter('/nonexistent/ffmpeg').toVoiceNote(webm, 'audio/webm').catch((e) => e);
        expect(err).not.toBeInstanceOf(VoiceNoteError);
        expect(err.code).toBe('ENOENT');
    });

    it('kills a conversion that hangs and cleans up', async () => {
        const hang = join(dir, 'hang.sh');
        writeFileSync(hang, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
        const before = leftovers();
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
            const result = converter(hang).toVoiceNote(Buffer.from('x'), 'audio/webm').catch((e) => e);
            while (jest.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));
            jest.advanceTimersByTime(30_000);
            expect(await result).toBeInstanceOf(VoiceNoteError);
        } finally {
            jest.useRealTimers();
        }
        expect(leftovers()).toBe(before);
    });

    it('makes an .m4a (AAC) copy for Instagram and Messenger', async () => {
        const { buffer } = await converter().toVoiceNote(make('note.webm', 1, ['-c:a', 'libopus', '-f', 'webm']), 'audio/webm');
        const m4a = await converter().toM4a(buffer);
        expect(m4a.toString('latin1', 4, 8)).toBe('ftyp');
        expect(m4a.includes('mp4a', 0, 'latin1')).toBe(true);
    });
});

describe('readOggOpus', () => {
    it('is null for anything but an Ogg Opus file', () => {
        expect(readOggOpus(Buffer.from('OggS but nothing else follows'))).toBeNull();
        expect(readOggOpus(Buffer.alloc(100))).toBeNull();
    });

    it('is null for a truncated file', () => {
        const page = Buffer.alloc(27 + 1 + 19);
        page.write('OggS', 0, 'latin1');
        page[26] = 1;
        page[27] = 19;
        page.write('OpusHead', 28, 'latin1');
        page[28 + 9] = 1;
        expect(readOggOpus(page)).toEqual({ channels: 1, durationMs: 0 });
        expect(readOggOpus(page.subarray(0, page.length - 1))).toBeNull();
    });
});

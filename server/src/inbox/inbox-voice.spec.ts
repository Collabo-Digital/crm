import { spawnSync } from 'child_process';
import { UserRole } from '@prisma/client';
import { VoiceNoteConverter, VoiceNoteError } from '../messaging/media/voice-note.converter';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const describeIfFfmpeg = encoders.status === 0 && encoders.stdout.includes('libopus') ? describe : describe.skip;

const viewer = { userId: 'u1', role: UserRole.AGENT, grants: [], teamIds: [] };

/** An Ogg Opus file's two pages that matter: OpusHead, and one ending at `ms`. */
function oggOpus(channels: number, ms: number): Buffer {
    const page = (granule: bigint, body: Buffer) => {
        const header = Buffer.alloc(28);
        header.write('OggS', 0, 'latin1');
        header.writeBigInt64LE(granule, 6);
        header[26] = 1;
        header[27] = body.length;
        return Buffer.concat([header, body]);
    };
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = channels;
    head.writeUInt16LE(312, 10);
    return Buffer.concat([page(0n, head), page(BigInt(312 + (ms * 48_000) / 1000), Buffer.from('opus frames'))]);
}

function build(voiceNotes: Partial<VoiceNoteConverter> = {}) {
    const storage = {
        save: jest.fn(async (orgId: string, buffer: Buffer, _mime: string) => ({ storageKey: `${orgId}/saved.ogg`, size: buffer.length })),
        read: jest.fn(async () => oggOpus(1, 1500)),
    };
    const sender = { send: jest.fn(async () => ({ ok: true, messageId: 'm1' })) };
    const prisma = { conversation: { findFirst: jest.fn(async () => ({ id: 'c1', channelId: 'ch1' })) } };
    const config = { get: () => 'secret' };
    const uploadQuota = { reserve: jest.fn(async () => undefined) };
    const service = new InboxService(
        prisma as never,
        sender as never,
        storage as never,
        voiceNotes as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        config as never,
        uploadQuota as never,
    );
    return { service, storage, sender, uploadQuota };
}

const file = (mimetype: string, buffer = Buffer.from('recording')) => ({ originalname: 'blob', mimetype, size: buffer.length, buffer });

describe('InboxService.upload', () => {
    it('stores other files as they are, as before', async () => {
        const toVoiceNote = jest.fn();
        const { service, storage } = build({ toVoiceNote });
        const audio = file('audio/ogg');
        expect(await service.upload('org1', audio)).toEqual({ storageKey: 'org1/saved.ogg', mime: 'audio/ogg', size: 9, filename: 'blob', mediaKind: 'audio' });
        expect(storage.save).toHaveBeenCalledWith('org1', audio.buffer, 'audio/ogg');
        expect(toVoiceNote).not.toHaveBeenCalled();
    });

    it('refuses a recording type it cannot convert, without running ffmpeg', async () => {
        const toVoiceNote = jest.fn();
        const { service } = build({ toVoiceNote });
        await expect(service.upload('org1', file('video/quicktime'), { voice: true })).rejects.toThrow('Voice messages can be recorded as WebM, Ogg, MP4, MP3 or WAV audio only.');
        expect(toVoiceNote).not.toHaveBeenCalled();
    });

    it('refuses a recording too large to be two minutes', async () => {
        const toVoiceNote = jest.fn();
        const { service } = build({ toVoiceNote });
        await expect(service.upload('org1', { ...file('audio/wav'), size: 30 * 1024 * 1024 }, { voice: true })).rejects.toThrow('This recording is too large.');
        expect(toVoiceNote).not.toHaveBeenCalled();
    });

    it('tells the person why a recording was refused', async () => {
        const toVoiceNote = jest.fn().mockRejectedValue(new VoiceNoteError('Voice messages can be at most 2 minutes long. Record a shorter one.'));
        const { service, storage } = build({ toVoiceNote });
        const err = await service.upload('org1', file('audio/webm;codecs=opus'), { voice: true }).catch((e) => e);
        expect(err.getStatus()).toBe(400);
        expect(err.message).toBe('Voice messages can be at most 2 minutes long. Record a shorter one.');
        expect(toVoiceNote).toHaveBeenCalledWith(expect.any(Buffer), 'audio/webm');
        expect(storage.save).not.toHaveBeenCalled();
    });
});

describeIfFfmpeg('InboxService.upload with voice (real ffmpeg)', () => {
    it('stores the recording as an Ogg/Opus voice note and says how long it is', async () => {
        const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'libopus', '-f', 'webm', 'pipe:1']);
        const webm = made.stdout;
        const { service, storage } = build(new VoiceNoteConverter({ get: () => FFMPEG } as never));

        const result = (await service.upload('org1', file('audio/webm;codecs=opus', webm), { voice: true })) as { durationMs: number };
        expect(result).toEqual({ storageKey: 'org1/saved.ogg', mime: 'audio/ogg', size: expect.any(Number), filename: 'voice-note.ogg', mediaKind: 'audio', durationMs: expect.any(Number) });
        expect(Math.abs(result.durationMs - 2000)).toBeLessThan(60);
        const [, stored, mime] = storage.save.mock.calls[0];
        expect(mime).toBe('audio/ogg');
        expect(stored.toString('latin1', 0, 4)).toBe('OggS');
    });
});

describe('InboxService.send, voice notes', () => {
    const voice = { type: 'media', mediaKind: 'audio', storageKey: 'org1/n.ogg', mime: 'audio/ogg', filename: 'voice-note.ogg', voice: true };

    it('sends the voice note with its length, measured from the stored file', async () => {
        const { service, sender, storage } = build();
        await service.send('org1', viewer, 'c1', { payload: voice });
        expect(storage.read).toHaveBeenCalledWith('org1/n.ogg');
        expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ payload: { ...voice, durationMs: 1500 } }));
    });

    it('refuses a file that is not a mono Ogg/Opus recording', async () => {
        const { service, sender, storage } = build();
        storage.read.mockResolvedValueOnce(oggOpus(2, 1500));
        await expect(service.send('org1', viewer, 'c1', { payload: voice })).rejects.toThrow('This is not a voice message recorded in the inbox. Record it again.');
        storage.read.mockResolvedValueOnce(Buffer.from('ID3 an mp3'));
        await expect(service.send('org1', viewer, 'c1', { payload: voice })).rejects.toThrow('This is not a voice message recorded in the inbox.');
        storage.read.mockResolvedValueOnce(oggOpus(1, 125_000));
        await expect(service.send('org1', viewer, 'c1', { payload: voice })).rejects.toThrow('This is not a voice message recorded in the inbox.');
        expect(sender.send).not.toHaveBeenCalled();
    });

    it("never reads another organization's file", async () => {
        const { service, storage } = build();
        await expect(service.send('org1', viewer, 'c1', { payload: { ...voice, storageKey: 'org2/n.ogg' } })).rejects.toThrow('Upload the file again before sending it.');
        expect(storage.read).not.toHaveBeenCalled();
    });

    it('allows voice only on audio', async () => {
        const { service } = build();
        await expect(service.send('org1', viewer, 'c1', { payload: { ...voice, mediaKind: 'image', mime: 'image/png' } })).rejects.toThrow(
            'Invalid message: voice — Only audio can be sent as a voice message.',
        );
    });

    it('sends plain audio as before', async () => {
        const { service, sender, storage } = build();
        const { voice: _v, ...audio } = voice;
        await service.send('org1', viewer, 'c1', { payload: audio });
        expect(storage.read).not.toHaveBeenCalled();
        expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ payload: audio }));
    });
});

describe('InboxController.upload', () => {
    it('reads the voice form field', async () => {
        const inbox = { upload: jest.fn() };
        const controller = new InboxController(inbox as never, {} as never, {} as never);
        const user = { orgId: 'org1' } as never;
        const upload = file('audio/webm');
        controller.upload(user, upload, 'true');
        controller.upload(user, upload, undefined);
        expect(inbox.upload.mock.calls).toEqual([
            ['org1', upload, { voice: true }],
            ['org1', upload, { voice: false }],
        ]);
    });
});

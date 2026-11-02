import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';

const EXT_BY_MIME: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/amr': '.amr',
    'application/pdf': '.pdf',
};

/**
 * Private, on-disk storage for chat media — customer photos, voice notes,
 * documents. Deliberately NOT the public /uploads tree the product images
 * use: these files are personal data, served only through short-lived signed
 * links (see media-url.ts). In production the directory must be a persistent
 * volume (MESSAGING_MEDIA_DIR; the compose file mounts one).
 */
@Injectable()
export class MessagingMediaStorage {
    private readonly root: string;

    constructor(config: ConfigService) {
        this.root = resolve(config.get<string>('messaging.mediaDir') ?? join(process.cwd(), 'storage', 'messaging'));
    }

    async save(orgId: string, buffer: Buffer, mime: string): Promise<{ storageKey: string; size: number }> {
        const ext = EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] ?? '.bin';
        const storageKey = `${orgId}/${randomUUID()}${ext}`;
        const path = this.pathOf(storageKey);
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, buffer);
        return { storageKey, size: buffer.length };
    }

    async read(storageKey: string): Promise<Buffer> {
        try {
            return await fs.readFile(this.pathOf(storageKey));
        } catch {
            throw new NotFoundException('File not found');
        }
    }

    async open(storageKey: string) {
        const path = this.pathOf(storageKey);
        const stat = await fs.stat(path).catch(() => null);
        if (!stat) throw new NotFoundException('File not found');
        return { stream: createReadStream(path), size: stat.size };
    }

    /** Keys come from our own rows, but a stored value must still not escape the root. */
    private pathOf(storageKey: string): string {
        const path = resolve(this.root, storageKey);
        if (!path.startsWith(this.root + sep)) throw new NotFoundException('File not found');
        return path;
    }
}

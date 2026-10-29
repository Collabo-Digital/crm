

/** One node of GET /me/media as Meta returns it. Every field may be missing. */
export interface IgMediaNode {
    id?: string;
    caption?: string;
    media_type?: string;          // IMAGE | VIDEO | CAROUSEL_ALBUM
    media_product_type?: string;  // AD | FEED | STORY | REELS
    media_url?: string;           // omitted on copyright flags
    thumbnail_url?: string;       // VIDEO only
    permalink?: string;
    timestamp?: string;           // ISO 8601, UTC
    like_count?: number;          // omitted when the owner hides likes
    comments_count?: number;
}

export interface IgMediaPage {
    data?: IgMediaNode[];
    paging?: { next?: string; cursors?: { after?: string } };
}

export interface MappedMedia {
    externalId: string;
    mediaType: string;
    permalink: string | null;
    thumbnailUrl: string | null;
    caption: string | null;
    postedAt: Date | null;
    likeCount: number;
    commentCount: number;
}

export const IG_MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
/** Newest posts kept per account. Two Graph calls at MEDIA_PAGE_SIZE. */
export const MEDIA_SYNC_LIMIT = 100;
export const MEDIA_PAGE_SIZE = 50;
/** A cached list older than this is refreshed on the next read. */
export const MEDIA_STALE_MS = 30 * 60_000;
const CAPTION_MAX = 2000;


/**
 * Graph node → channel_media columns. Returns null for nodes we do not cache:
 * stories (gone in 24 h, never a trigger subject) and nodes without an id.
 * A reel is reported as VIDEO + REELS; we store REEL so the picker can say so.
 */
export function mapIgMedia(node: IgMediaNode): MappedMedia | null {
    if (!node.id) return null;
    if (node.media_product_type === 'STORY') return null;

    const postedAt = node.timestamp ? new Date(node.timestamp) : null;
    const caption = node.caption?.trim() ?? '';

    return {
        externalId: String(node.id),
        mediaType: node.media_product_type === 'REELS' ? 'REEL' : (node.media_type ?? 'IMAGE'),
        permalink: node.permalink ?? null,
        // Images and carousels have no thumbnail field; media_url is the picture.
        thumbnailUrl: node.thumbnail_url ?? node.media_url ?? null,
        caption: caption ? caption.slice(0, CAPTION_MAX) : null,
        postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
        likeCount: typeof node.like_count === 'number' ? node.like_count : 0,
        commentCount: typeof node.comments_count === 'number' ? node.comments_count : 0,
    };
}

/** Last sync time from Channel.metadata.mediaSync.at, or null. */
export function mediaSyncedAt(metadata: unknown): Date | null {
    const at = (metadata as { mediaSync?: { at?: unknown } } | null)?.mediaSync?.at;
    if (typeof at !== 'string') return null;
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function isMediaSyncStale(metadata: unknown, now: Date): boolean {
    const at = mediaSyncedAt(metadata);
    return !at || now.getTime() - at.getTime() > MEDIA_STALE_MS;
}

/**
 * Oldest postedAt in the fetched window. A cached row newer than this that
 * Instagram did not return has been deleted; rows older than it were simply
 * outside the 100 we asked for and are left alone.
 */
export function deletionCutoff(rows: MappedMedia[]): Date | null {
    let oldest: Date | null = null;
    for (const r of rows) {
        if (r.postedAt && (!oldest || r.postedAt < oldest)) oldest = r.postedAt;
    }
    return oldest;
}
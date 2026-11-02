import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../channel/encryption.service';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS, REDIS_TTL } from '../../redis/redis.constants';
import { GoogleApiError, GoogleClient, a1, idTokenEmail } from './google.client';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
/** Columns read from a sheet: A to ZZ. */
const LAST_COLUMN = 'ZZ';

export interface SheetColumn {
    header: string;
    /** The variable a new row's cell arrives as: {{sheet.<key>}}. */
    key: string;
}

/** "Full Name" → full_name; empty or repeated headers get their column's place. */
export function sheetColumns(headers: string[]): SheetColumn[] {
    const seen = new Set<string>();
    return headers.map((header, i) => {
        let key = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || `column_${i + 1}`;
        if (seen.has(key)) key = `${key}_${i + 1}`;
        seen.add(key);
        return { header: header.trim() || `Column ${i + 1}`, key };
    });
}

/** A row's values, hashed: finds the last row read again after rows above it are deleted. */
export function rowHash(cells: string[]): string {
    return createHash('sha256').update(JSON.stringify(cells)).digest('hex').slice(0, 16);
}

/** A read position: the last row read, and its hash (null when the sheet had no rows). */
export interface SheetMark {
    number: number;
    hash: string | null;
}

export interface SheetRow {
    number: number;
    cells: string[];
    hash: string;
}

/**
 * Google Sheets for automations: the organization's Google account (OAuth
 * with drive.file, so only the sheets Collabo creates or the merchant picks),
 * the sheets in use, adding rows, and reading new ones.
 */
@Injectable()
export class GoogleService {
    private readonly logger = new Logger(GoogleService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly encryption: EncryptionService,
        private readonly redis: RedisService,
        private readonly google: GoogleClient,
        private readonly config: ConfigService,
    ) { }

    // ─── The Google account ──────────────────────────────────────────────

    async status(orgId: string) {
        const account = await this.active(orgId);
        const sheets = await this.prisma.googleSheet.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
        const watched = new Set(
            (await this.prisma.automationTrigger.findMany({
                where: { organizationId: orgId, triggerType: 'crm.sheet.row', isActive: true, automation: { status: AutomationStatus.ACTIVE } },
                select: { subjectId: true },
            })).map((t) => t.subjectId),
        );
        return {
            configured: this.google.configured,
            connected: !!account,
            email: account?.email ?? null,
            connectedAt: account?.updatedAt ?? null,
            sheets: sheets.map((s) => ({
                id: s.id,
                title: s.title,
                url: s.url,
                tab: s.tab,
                origin: s.origin,
                watched: watched.has(s.id),
                checkedAt: s.checkedAt,
                lastError: s.lastError,
                skippedRow: s.skippedRow,
                createdAt: s.createdAt,
            })),
        };
    }

    /**
     * Google's consent page, with a single-use state tied to this person and
     * organization. Google sends the browser back to the Google Sheets page,
     * which posts the code here signed in (complete), so a consent link sent
     * to someone else cannot link their Google account to this organization.
     */
    async connectUrl(orgId: string, userId: string): Promise<{ url: string }> {
        if (!this.google.configured) throw new ServiceUnavailableException('Google Sheets is not set up on this Collabo yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).');
        const state = randomBytes(16).toString('hex');
        await this.redis.set(`${REDIS_KEYS.OAUTH_GOOGLE}${state}`, { orgId, userId }, REDIS_TTL.OAUTH_STATE);
        return { url: this.google.authorizeUrl(this.redirectUri(), state) };
    }

    /** The code Google gave the browser, posted by the same signed-in person who started: keeps the refresh token, encrypted. */
    async complete(orgId: string, userId: string, code: string, state: string) {
        const key = `${REDIS_KEYS.OAUTH_GOOGLE}${state}`;
        const saved = await this.redis.get<{ orgId: string; userId: string }>(key);
        if (!saved || saved.orgId !== orgId || saved.userId !== userId) throw new UnauthorizedException('That Google sign-in expired or was started by someone else. Connect Google again.');
        await this.redis.del(key);
        let tokens: Awaited<ReturnType<GoogleClient['exchange']>>;
        try {
            tokens = await this.google.exchange(code, this.redirectUri());
        } catch (err) {
            this.logger.warn(`Google connect failed: ${err instanceof Error ? err.message : err}`);
            throw new BadRequestException('Google did not accept the sign-in. Connect Google again.');
        }
        const scopes = tokens.scope.split(' ');
        // Google lets people untick a scope on the consent screen.
        if (!scopes.includes(DRIVE_FILE)) throw new BadRequestException('Allow access to the files you use with Collabo, then connect again.');
        if (!tokens.refresh_token) throw new BadRequestException('Google did not give lasting access. Connect Google again.');
        const data = {
            email: idTokenEmail(tokens.id_token),
            credentials: this.encryption.encrypt(tokens.refresh_token),
            scopes,
            connectedById: userId,
            disconnectedAt: null,
        };
        await this.prisma.googleAccount.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, ...data }, update: data });
        await this.redis.del(`${REDIS_KEYS.GOOGLE_ACCESS_TOKEN}${orgId}`);
        return this.status(orgId);
    }

    /** Lets go of Google: revoked at Google, forgotten here. The sheets stay in the merchant's Drive. */
    async disconnect(orgId: string): Promise<void> {
        const account = await this.active(orgId);
        if (!account) throw new NotFoundException('No Google account is connected.');
        await this.google.revoke(this.encryption.decrypt(account.credentials!)).catch((err) => this.logger.warn(`Google revoke failed: ${err instanceof Error ? err.message : err}`));
        await this.prisma.googleAccount.update({ where: { id: account.id }, data: { credentials: null, disconnectedAt: new Date() } });
        await this.redis.del(`${REDIS_KEYS.GOOGLE_ACCESS_TOKEN}${orgId}`);
    }

    /** A short-lived drive.file token for Google's picker in this browser. */
    async pickerToken(orgId: string) {
        return { accessToken: await this.accessToken(orgId) };
    }

    // ─── Sheets ──────────────────────────────────────────────────────────

    /** A new spreadsheet in the merchant's Drive, with its header row. */
    async createSheet(orgId: string, userId: string, input: { title: string; headers: string[] }) {
        const headers = input.headers.map((h) => h.trim()).filter(Boolean);
        if (!headers.length) throw new BadRequestException('Name at least one column.');
        const info = await this.call(orgId, (token) => this.google.createSpreadsheet(token, input.title.trim(), headers));
        await this.prisma.googleSheet.create({
            data: { organizationId: orgId, spreadsheetId: info.spreadsheetId, title: info.title, url: info.url, tab: info.tab, origin: 'created', createdById: userId },
        });
        return this.status(orgId);
    }

    /** A sheet the merchant chose in Google's picker, which gives Collabo access to it. */
    async addPicked(orgId: string, userId: string, spreadsheetId: string) {
        const info = await this.call(orgId, (token) => this.google.spreadsheet(token, spreadsheetId)).catch((err) => {
            if (err instanceof NotFoundException) throw new BadRequestException('Collabo cannot open that sheet. Choose it in Google’s picker, which gives Collabo access to it.');
            throw err;
        });
        await this.prisma.googleSheet.upsert({
            where: { organizationId_spreadsheetId: { organizationId: orgId, spreadsheetId: info.spreadsheetId } },
            create: { organizationId: orgId, spreadsheetId: info.spreadsheetId, title: info.title, url: info.url, tab: info.tab, origin: 'picked', createdById: userId },
            update: { title: info.title, url: info.url, tab: info.tab },
        });
        return this.status(orgId);
    }

    /** Forgets a sheet (it stays in Google Drive), unless an automation uses it. */
    async removeSheet(orgId: string, id: string) {
        const sheet = await this.sheet(orgId, id);
        const using = await this.prisma.$queryRaw<Array<{ name: string }>>`
            SELECT "name" FROM "automations"
            WHERE "organization_id" = ${orgId} AND "status" <> 'ARCHIVED' AND "definition"::text LIKE ${`%${sheet.id}%`}
            LIMIT 3`;
        if (using.length) throw new ConflictException(`Used by ${using.map((a) => `“${a.name}”`).join(', ')}. Change or archive ${using.length > 1 ? 'them' : 'it'} first.`);
        await this.prisma.googleSheet.delete({ where: { id: sheet.id } });
        return this.status(orgId);
    }

    /** The header row, as columns and the {{sheet.*}} variable each one fills. */
    async columns(orgId: string, id: string): Promise<{ columns: SheetColumn[] }> {
        const sheet = await this.sheet(orgId, id);
        const [header = []] = await this.call(orgId, (token) => this.google.values(token, sheet.spreadsheetId, a1(sheet.tab, `A1:${LAST_COLUMN}1`)));
        return { columns: sheetColumns(header) };
    }

    /** An automation's "Add a row to a sheet". */
    async appendRow(orgId: string, sheetId: string, values: string[]): Promise<void> {
        const sheet = await this.prisma.googleSheet.findFirst({ where: { id: sheetId, organizationId: orgId } });
        if (!sheet) throw new BadRequestException('The sheet was removed from Collabo. Choose another one.');
        await this.call(orgId, (token) => this.google.append(token, sheet.spreadsheetId, sheet.tab, [values]));
    }

    /**
     * Rows added since the last read, and the row they reach (`end`). The
     * caller records them, then moves the read position with markRead. The
     * first read of a sheet only notes how many rows it has: rows already
     * there never start anything.
     */
    async newRows(sheetId: string): Promise<{ columns: SheetColumn[]; rows: SheetRow[]; end: SheetMark }> {
        const sheet = await this.prisma.googleSheet.findUnique({ where: { id: sheetId } });
        if (!sheet) return { columns: [], rows: [], end: { number: 0, hash: null } };
        const read = (range: string) => this.call(sheet.organizationId, (token) => this.google.values(token, sheet.spreadsheetId, a1(sheet.tab, range)));
        const restart = async (all?: string[][]) => {
            all ??= await read(`A1:${LAST_COLUMN}`);
            const end = { number: all.length, hash: all.length ? rowHash(all[all.length - 1]) : null };
            await this.prisma.googleSheet.update({ where: { id: sheet.id }, data: { seenRows: end.number, lastRowHash: end.hash, checkedAt: new Date(), lastError: null } });
            return { columns: [], rows: [], end };
        };
        try {
            if (sheet.seenRows === null) return await restart();
            const seen = sheet.seenRows;
            // From the last row read (`at`) on: one read while it is where it was.
            const tail = await read(`A${Math.max(1, seen)}:${LAST_COLUMN}`);
            let at = seen;
            let from = tail;
            let all: string[][] | undefined;
            if (seen > 0 && (!tail.length || (sheet.lastRowHash !== null && rowHash(tail[0]) !== sheet.lastRowHash))) {
                // It moved or changed. When rows above it were deleted it is found higher up, and reading goes on
                // right after it. When it is not found (deleted, or edited), reading goes on from its place if the
                // sheet still reaches it, or else from the sheet's end, so the next new row is not taken for one already seen.
                all = await read(`A1:${LAST_COLUMN}`);
                const found = sheet.lastRowHash === null ? -1 : all.slice(0, seen - 1).findLastIndex((cells) => rowHash(cells) === sheet.lastRowHash);
                if (found >= 0) {
                    at = found + 1;
                    from = all.slice(found);
                } else if (!tail.length) {
                    return await restart(all);
                }
            }
            const fresh = at > 0 ? from.slice(1) : from;
            const atHash = at > 0 ? rowHash(from[0]) : null;
            const [header = []] = fresh.length ? (all ?? await read(`A1:${LAST_COLUMN}1`)) : [[]];
            // Moves back only to follow the last row read; a position cleared meanwhile (a publish restarting the watch) stays cleared.
            await this.prisma.googleSheet.updateMany({
                where: { id: sheet.id, seenRows: seen },
                data: { seenRows: at, lastRowHash: atHash, checkedAt: new Date(), lastError: null },
            });
            return {
                columns: sheetColumns(header),
                rows: fresh.map((cells, i) => ({ number: at + 1 + i, cells, hash: rowHash(cells) })).filter((r) => r.cells.some((c) => c.trim())),
                end: fresh.length ? { number: at + fresh.length, hash: rowHash(fresh[fresh.length - 1]) } : { number: at, hash: atHash },
            };
        } catch (err) {
            const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
            await this.prisma.googleSheet.update({ where: { id: sheet.id }, data: { lastError: message, checkedAt: new Date() } }).catch(() => undefined);
            throw err;
        }
    }

    /**
     * Every row up to `last` has been recorded. Never moves back, and
     * leaves a position cleared meanwhile (a publish restarting the watch).
     */
    async markRead(sheetId: string, last: SheetMark): Promise<void> {
        await this.prisma.googleSheet.updateMany({ where: { id: sheetId, seenRows: { lt: last.number } }, data: { seenRows: last.number, lastRowHash: last.hash } });
    }

    /** A new row that started nothing, for the Google Sheets page. */
    async noteSkipped(sheetId: string, message: string): Promise<void> {
        await this.prisma.googleSheet.update({ where: { id: sheetId }, data: { skippedRow: message.slice(0, 300) } }).catch(() => undefined);
    }

    // ─── Inside ──────────────────────────────────────────────────────────

    /** Google returns the browser to the Google Sheets page, which finishes signed in. */
    private redirectUri(): string {
        return `${this.config.get<string>('frontendUrl') ?? ''}/campaigns/automations/sheets`;
    }

    private async active(orgId: string) {
        const account = await this.prisma.googleAccount.findUnique({ where: { organizationId: orgId } });
        return account?.credentials && !account.disconnectedAt ? account : null;
    }

    private async sheet(orgId: string, id: string) {
        const sheet = await this.prisma.googleSheet.findFirst({ where: { id, organizationId: orgId } });
        if (!sheet) throw new NotFoundException('Sheet not found');
        return sheet;
    }

    /** An access token from the refresh token, kept in Redis until shortly before it expires. */
    private async accessToken(orgId: string): Promise<string> {
        const key = `${REDIS_KEYS.GOOGLE_ACCESS_TOKEN}${orgId}`;
        const cached = await this.redis.get<string>(key);
        if (cached) return cached;
        const account = await this.active(orgId);
        if (!account) throw new BadRequestException('Connect a Google account in Campaigns → Automations → Google Sheets.');
        try {
            const tokens = await this.google.refresh(this.encryption.decrypt(account.credentials!));
            await this.redis.set(key, tokens.access_token, Math.max(60, tokens.expires_in - 120));
            return tokens.access_token;
        } catch (err) {
            if (err instanceof GoogleApiError && err.code === 'invalid_grant') {
                // Access removed in the Google account, or the grant expired: connecting again is the only fix.
                await this.prisma.googleAccount.update({ where: { id: account.id }, data: { credentials: null, disconnectedAt: new Date() } });
                throw new BadRequestException('Google access was removed or has expired. Connect the Google account again.');
            }
            throw new BadRequestException(`Google could not be reached: ${err instanceof Error ? err.message : err}`);
        }
    }

    /** A Sheets call with this organization's access, with Google's refusals in words. */
    private async call<T>(orgId: string, fn: (token: string) => Promise<T>): Promise<T> {
        const token = await this.accessToken(orgId);
        try {
            return await fn(token);
        } catch (err) {
            if (!(err instanceof GoogleApiError)) throw err;
            if (err.status === 401) {
                await this.redis.del(`${REDIS_KEYS.GOOGLE_ACCESS_TOKEN}${orgId}`);
                throw new UnauthorizedException('Google did not accept Collabo’s access. Try again, or connect the Google account again.');
            }
            if (err.status === 403 || err.status === 404) throw new NotFoundException('Collabo cannot open this sheet any more. It may have been deleted, or access to it removed.');
            throw new BadRequestException(`Google Sheets refused it: ${err.message}`);
        }
    }
}


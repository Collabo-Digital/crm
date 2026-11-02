import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * drive.file: only the sheets Collabo creates or the merchant picks (Google's
 * recommended, non-sensitive scope). openid and email name the account.
 */
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];

export interface GoogleTokens {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
    token_type: string;
    id_token?: string;
}

export interface SpreadsheetInfo {
    spreadsheetId: string;
    url: string;
    title: string;
    /** The first tab, where rows are read and added. */
    tab: string;
}

export class GoogleApiError extends Error {
    /** OAuth's error code, like invalid_grant for access the person removed. */
    constructor(readonly status: number, message: string, readonly code: string | null = null) {
        super(message);
    }
}

/** The email in an ID token from Google's token endpoint; taken over TLS from Google, so not re-verified (OIDC Core 3.1.3.7). */
export function idTokenEmail(idToken: string | undefined): string | null {
    try {
        const payload = JSON.parse(Buffer.from((idToken ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
        return typeof payload.email === 'string' ? payload.email : null;
    } catch {
        return null;
    }
}

/** A1 notation for a tab, quoted as Sheets expects: 'Leads (May)'!A1. */
export function a1(tab: string, cells: string): string {
    return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

/**
 * Google's OAuth 2.0 for web server apps and the Sheets API v4, with
 * Collabo's own OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 */
@Injectable()
export class GoogleClient {
    private readonly clientId: string | undefined;
    private readonly clientSecret: string | undefined;
    private readonly authUrl: string;
    private readonly tokenUrl: string;
    private readonly revokeUrl: string;
    private readonly sheetsBase: string;

    constructor(config: ConfigService) {
        this.clientId = config.get<string>('google.clientId');
        this.clientSecret = config.get<string>('google.clientSecret');
        this.authUrl = config.get<string>('google.authUrl') ?? 'https://accounts.google.com/o/oauth2/v2/auth';
        this.tokenUrl = config.get<string>('google.tokenUrl') ?? 'https://oauth2.googleapis.com/token';
        this.revokeUrl = config.get<string>('google.revokeUrl') ?? 'https://oauth2.googleapis.com/revoke';
        this.sheetsBase = config.get<string>('google.sheetsApiBase') ?? 'https://sheets.googleapis.com/v4';
    }

    get configured(): boolean {
        return !!(this.clientId && this.clientSecret);
    }

    /** Offline access, so rows can be added and read with nobody at the browser; consent each time, so a refresh token always comes back. */
    authorizeUrl(redirectUri: string, state: string): string {
        const url = new URL(this.authUrl);
        url.search = new URLSearchParams({
            client_id: this.clientId ?? '',
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: GOOGLE_SCOPES.join(' '),
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
            state,
        }).toString();
        return url.toString();
    }

    exchange(code: string, redirectUri: string): Promise<GoogleTokens> {
        return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    }

    refresh(refreshToken: string): Promise<GoogleTokens> {
        return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    }

    async revoke(token: string): Promise<void> {
        await this.request('POST', this.revokeUrl, null, new URLSearchParams({ token }));
    }

    async createSpreadsheet(accessToken: string, title: string, headers: string[]): Promise<SpreadsheetInfo> {
        const sheet = await this.request<{ spreadsheetId: string; spreadsheetUrl: string; properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string } }> }>(
            'POST', `${this.sheetsBase}/spreadsheets`, accessToken, { properties: { title } },
        );
        const info = this.info(sheet);
        if (headers.length) await this.append(accessToken, info.spreadsheetId, info.tab, [headers]);
        return info;
    }

    async spreadsheet(accessToken: string, spreadsheetId: string): Promise<SpreadsheetInfo> {
        const fields = 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties.title';
        return this.info(await this.request('GET', `${this.sheetsBase}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`, accessToken));
    }

    /** The cells in a range, as text; Sheets leaves out trailing empty cells and rows. */
    async values(accessToken: string, spreadsheetId: string, range: string): Promise<string[][]> {
        const res = await this.request<{ values?: unknown[][] }>(
            'GET', `${this.sheetsBase}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, accessToken,
        );
        return (res.values ?? []).map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v))));
    }

    /** Rows added after the table on the tab. RAW: a value is never read as a formula, whoever wrote it. */
    async append(accessToken: string, spreadsheetId: string, tab: string, rows: string[][]): Promise<void> {
        await this.request(
            'POST',
            `${this.sheetsBase}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1(tab, 'A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
            accessToken,
            { values: rows },
        );
    }

    private info(sheet: { spreadsheetId: string; spreadsheetUrl: string; properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string } }> }): SpreadsheetInfo {
        return {
            spreadsheetId: sheet.spreadsheetId,
            url: sheet.spreadsheetUrl,
            title: sheet.properties?.title ?? 'Untitled spreadsheet',
            tab: sheet.sheets?.[0]?.properties?.title ?? 'Sheet1',
        };
    }

    private token(params: Record<string, string>): Promise<GoogleTokens> {
        return this.request('POST', this.tokenUrl, null, new URLSearchParams({ client_id: this.clientId ?? '', client_secret: this.clientSecret ?? '', ...params }));
    }

    private async request<T>(method: 'GET' | 'POST', url: string, accessToken: string | null, body?: unknown): Promise<T> {
        let res: Response;
        try {
            res = await fetch(url, {
                method,
                headers: {
                    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
                    ...(body instanceof URLSearchParams ? { 'content-type': 'application/x-www-form-urlencoded' } : body ? { 'content-type': 'application/json' } : {}),
                },
                body: body instanceof URLSearchParams ? body.toString() : body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(20_000),
            });
        } catch (err) {
            throw new GoogleApiError(0, `Google could not be reached: ${err instanceof Error ? err.message : err}`);
        }
        const json = (await res.json().catch(() => null)) as { error?: string | { message?: string }; error_description?: string } | null;
        if (!res.ok) {
            const message = typeof json?.error === 'object' ? json.error.message : json?.error_description ?? json?.error;
            throw new GoogleApiError(res.status, message || `Google answered ${res.status}`, typeof json?.error === 'string' ? json.error : null);
        }
        return (json ?? {}) as T;
    }
}

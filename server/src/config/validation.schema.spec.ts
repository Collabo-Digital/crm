import { validationSchema } from './validation.schema';

const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    FRONTEND_URL: 'https://app.example.com',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
};
const production = {
    ...base,
    NODE_ENV: 'production',
    APP_URL: 'https://api.example.com',
    TRUST_PROXY: '1',
    ENCRYPTION_KEY: 'k'.repeat(32),
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'apikey',
    SMTP_PASS: 'secret',
};
const errors = (env: Record<string, string | undefined>) =>
    validationSchema.validate(env, { allowUnknown: true, abortEarly: false }).error?.details.map((d) => d.context?.key) ?? [];

describe('config validation', () => {
    it('accepts a complete production configuration', () => {
        expect(errors(production)).toEqual([]);
    });

    it.each(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'APP_URL', 'ENCRYPTION_KEY', 'TRUST_PROXY'])('refuses to start production without %s', (key) => {
        expect(errors({ ...production, [key]: undefined })).toEqual([key]);
    });

    it('refuses blank SMTP settings in production', () => {
        expect(errors({ ...production, SMTP_HOST: '', SMTP_PASS: '' })).toEqual(['SMTP_HOST', 'SMTP_PASS']);
    });

    it('refuses an http APP_URL in production', () => {
        expect(errors({ ...production, APP_URL: 'http://api.example.com' })).toEqual(['APP_URL']);
    });

    it('accepts TRUST_PROXY=0 for production reached directly', () => {
        expect(errors({ ...production, TRUST_PROXY: '0' })).toEqual([]);
    });

    it('leaves them optional, and blank, in development', () => {
        expect(errors({ ...base, NODE_ENV: 'development', SMTP_HOST: '', SMTP_USER: '', APP_URL: 'http://localhost:5000' })).toEqual([]);
    });

    describe('JWT secrets', () => {
        // The first four are the values shipped in the two .env.example files.
        const placeholders = [
            'replace_with_random_32_char_or_longer_string',
            'replace_with_different_random_32_char_string',
            'replace_with_random_32_char_or_longer_string_aaaa',
            'replace_with_different_random_32_char_string_bbbb',
            'random-string-here-random-string-here',
            'change-me-change-me-change-me-change-me',
            'CHANGEME_0123456789abcdef0123456789',
            'your-secret-key-at-least-32-characters',
        ];

        it.each(placeholders)('refuses the placeholder %s in production', (value) => {
            expect(errors({ ...production, JWT_ACCESS_SECRET: value })).toEqual(['JWT_ACCESS_SECRET']);
            expect(errors({ ...production, JWT_REFRESH_SECRET: value })).toEqual(['JWT_REFRESH_SECRET']);
        });

        it('refuses a refresh secret that repeats the access secret in production', () => {
            expect(errors({ ...production, JWT_REFRESH_SECRET: production.JWT_ACCESS_SECRET })).toEqual(['JWT_REFRESH_SECRET']);
        });

        it('accepts random secrets in production', () => {
            const random = (seed: string) => Buffer.from(seed.repeat(32)).toString('hex');
            expect(errors({ ...production, JWT_ACCESS_SECRET: random('x'), JWT_REFRESH_SECRET: random('y') })).toEqual([]);
        });

        it('still requires 32 characters in production', () => {
            expect(errors({ ...production, JWT_ACCESS_SECRET: 'too-short' })).toEqual(['JWT_ACCESS_SECRET']);
        });

        it('leaves placeholders and a shared secret alone outside production, so local setups keep working', () => {
            const local = { ...base, JWT_ACCESS_SECRET: placeholders[0], JWT_REFRESH_SECRET: placeholders[0] };
            expect(errors({ ...local, NODE_ENV: 'development' })).toEqual([]);
            expect(errors({ ...local, NODE_ENV: 'test' })).toEqual([]);
        });
    });
});

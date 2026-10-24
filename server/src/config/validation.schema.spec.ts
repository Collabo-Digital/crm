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
});

import { validationSchema } from './validation.schema';

describe('config validation', () => {
    const base = {
        DATABASE_URL: 'postgresql://localhost/crm',
        REDIS_URL: 'redis://localhost:6379',
        FRONTEND_URL: 'https://app.example.com',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
    };
    const smtp = { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'mailer', SMTP_PASS: 'secret' };
    const missing = (env: Record<string, string>) =>
        (validationSchema.validate(env, { allowUnknown: true, abortEarly: false }).error?.details ?? []).map(
            (d) => d.context?.key,
        );

    it('refuses a production boot without SMTP or TRUST_PROXY', () => {
        expect(missing({ ...base, NODE_ENV: 'production' })).toEqual(
            expect.arrayContaining(['TRUST_PROXY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']),
        );
    });

    it('accepts production with them, including TRUST_PROXY=0 for a direct deployment', () => {
        expect(missing({ ...base, ...smtp, NODE_ENV: 'production', TRUST_PROXY: '1' })).toEqual([]);
        expect(missing({ ...base, ...smtp, NODE_ENV: 'production', TRUST_PROXY: '0' })).toEqual([]);
    });

    it('does not ask for them outside production', () => {
        expect(missing({ ...base, NODE_ENV: 'development' })).toEqual([]);
    });
});

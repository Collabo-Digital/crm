import Anthropic from '@anthropic-ai/sdk';
import { HttpException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import RedisMock from 'ioredis-mock';
import { RedisService } from '../../redis/redis.service';
import { DRAFTS_PER_DAY, DRAFTS_PER_DAY_TOTAL, DRAFTS_PER_USER_PER_DAY, TemplateWriterService } from './template-writer.service';

const output = (body: string) => ({
    name: 'order_shipped',
    category: 'UTILITY',
    header: null,
    body,
    variables: [{ name: 'first_name', example: 'Ananya' }],
    footer: null,
    buttons: [],
    notes: 'Utility: it is about their order.',
});
const reply = (body: string, extra: Record<string, unknown> = {}) => ({
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 900, output_tokens: 120 },
    content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'text', text: JSON.stringify(output(body)) }],
    ...extra,
});

/** RedisService over ioredis-mock, which runs the real commands and Lua. */
function realRedis() {
    const redis = new RedisService({ get: () => 'redis://localhost:6379' } as never);
    const client = new RedisMock();
    (redis as unknown as { client: unknown }).client = client;
    return { redis, client };
}
beforeEach(() => realRedis().client.flushall());

function setup(apiKey: string | null = 'test-key', caps: { perUser?: number; total?: number } = {}) {
    const prisma = {
        organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Meera Studio', industry: 'Handloom sarees', website: null, currency: 'INR' }) },
        channel: { findFirst: jest.fn().mockResolvedValue({ externalStoreUrl: 'https://meera.myshopify.com' }) },
        messageTemplate: { findMany: jest.fn().mockResolvedValue([{ name: 'order_shipped' }]) },
    };
    const { redis, client } = realRedis();
    const config = {
        get: (key: string) =>
            ({ 'ai.anthropicApiKey': apiKey ?? undefined, 'ai.anthropicBaseUrl': undefined, 'ai.draftsPerUserPerDay': caps.perUser, 'ai.draftsPerDayTotal': caps.total })[key],
    };
    const service = new TemplateWriterService(prisma as any, redis, config as any);
    const create = jest.fn();
    if (apiKey) (service as any).client.beta.messages.create = create;
    return { service, create, client };
}
const today = () => new Date().toISOString().slice(0, 10);
const input = { brief: 'Tell customers their order has shipped', language: 'en' };

describe('TemplateWriterService', () => {
    it('reports itself unavailable without Collabo’s key', async () => {
        const { service } = setup(null);
        expect(service.status()).toEqual({ available: false, draftsPerDay: DRAFTS_PER_DAY });
        await expect(service.write('org1', 'u1', input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('asks Claude Opus 5.5 with fallbacks, structured output and a cached system prompt', async () => {
        const { service, create } = setup();
        create.mockResolvedValueOnce(reply('Hi {{first_name}}, your order is on its way.'));
        const result = await service.write('org1', 'u1', input);
        expect(result.draft).toMatchObject({ name: 'order_shipped_2', category: 'UTILITY', parameterFormat: 'NAMED' });
        expect(result.notes).toBe('Utility: it is about their order.');

        const params = create.mock.calls[0][0];
        expect(params).toMatchObject({
            model: 'claude-opus-5-5',
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'low', format: { type: 'json_schema' } },
        });
        for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) expect(params).not.toHaveProperty(key);
        expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(params.metadata.user_id).toMatch(/^[0-9a-f]{32}$/);
        expect(params.messages[0].content).toContain('Website: https://meera.myshopify.com');
    });

    it('sends a draft that breaks Meta’s rules back once, with Claude’s own turn kept whole', async () => {
        const { service, create } = setup();
        const first = reply('Your order is on its way, {{first_name}}');
        create.mockResolvedValueOnce(first).mockResolvedValueOnce(reply('Hi {{first_name}}, your order is on its way.'));
        const result = await service.write('org1', 'u1', input);
        expect(result.draft.body.text).toBe('Hi {{first_name}}, your order is on its way.');
        const retry = create.mock.calls[1][0].messages;
        expect(retry).toHaveLength(3);
        expect(retry[1]).toEqual({ role: 'assistant', content: first.content });
        expect(retry[2].content).toMatch(/^Meta would reject that template: The body cannot start or end with a variable/);
    });

    it('gives up after the rewrite also breaks a rule', async () => {
        const { service, create } = setup();
        create.mockResolvedValue(reply('{{first_name}}, your order is on its way.'));
        await expect(service.write('org1', 'u1', input)).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(create).toHaveBeenCalledTimes(2);
    });

    it('says plainly when Claude declines, without retrying', async () => {
        const { service, create } = setup();
        create.mockResolvedValueOnce(reply('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [] }));
        await expect(service.write('org1', 'u1', input)).rejects.toThrow(/declined/);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('stops at the daily allowance before calling Claude', async () => {
        const { service, create, client } = setup();
        await client.set(`crm:ai:template_drafts:org1:${today()}`, DRAFTS_PER_DAY);
        const err = await service.write('org1', 'u1', input).catch((e: HttpException) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(429);
        expect((err as HttpException).message).toBe(`Your team has used today’s ${DRAFTS_PER_DAY} AI drafts. You can write more tomorrow.`);
        expect(create).not.toHaveBeenCalled();
    });

    it('turns API errors into messages for the merchant', async () => {
        const { service, create } = setup();
        create.mockRejectedValueOnce(new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()));
        await expect(service.write('org1', 'u1', input)).rejects.toThrow('AI writing is not available right now.');
        create.mockRejectedValueOnce(new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers()));
        await expect(service.write('org1', 'u1', input)).rejects.toThrow(/busy/);
        create.mockRejectedValueOnce(new Anthropic.BadRequestError(400, undefined, 'bad', new Headers()));
        await expect(service.write('org1', 'u1', input)).rejects.toThrow('The AI writer could not handle that request.');
    });
});

/**
 * Organizations are free and unlimited, so the organization's allowance alone
 * does not bound what one account, or everyone together, spends on Claude.
 */
describe('TemplateWriterService allowances beyond the organization', () => {
    const written = () => reply('Hi {{first_name}}, your order is on its way.');
    const refusal = (p: Promise<unknown>) => p.then(() => null, (e: HttpException) => ({ status: e.getStatus(), message: e.message }));

    it('defaults to generous caps that are still far below what free organizations would allow', () => {
        expect(DRAFTS_PER_USER_PER_DAY).toBeGreaterThanOrEqual(DRAFTS_PER_DAY);
        expect(DRAFTS_PER_DAY_TOTAL).toBeGreaterThan(DRAFTS_PER_USER_PER_DAY);
    });

    it('stops a member at their own daily allowance, even in a brand-new organization', async () => {
        const { service, create } = setup('test-key', { perUser: 3 });
        create.mockResolvedValue(written());
        await service.write('org1', 'u1', input);
        await service.write('org1', 'u1', input);
        await service.write('org2', 'u1', input);

        await expect(refusal(service.write('org_fresh', 'u1', input))).resolves.toEqual({
            status: 429,
            message: 'You have used today’s 3 AI drafts. You can write more tomorrow.',
        });
        expect(create).toHaveBeenCalledTimes(3);
        // A teammate in the same organization still writes.
        await expect(service.write('org_fresh', 'u2', input)).resolves.toMatchObject({ model: 'claude-opus-5-5' });
    });

    it('stops everyone once the server’s drafts for the day are used up', async () => {
        const { service, create } = setup('test-key', { total: 2 });
        create.mockResolvedValue(written());
        await service.write('org1', 'u1', input);
        await service.write('org2', 'u2', input);

        await expect(refusal(service.write('org3', 'u3', input))).resolves.toEqual({
            status: 429,
            message: 'Collabo has used today’s AI drafts for every store. You can write more tomorrow.',
        });
        expect(create).toHaveBeenCalledTimes(2);
    });

    it('does not count a refused draft against the other allowances', async () => {
        const { service, create, client } = setup('test-key', { perUser: 1 });
        create.mockResolvedValue(written());
        await service.write('org1', 'u1', input);
        await refusal(service.write('org1', 'u1', input));

        expect(await client.get(`crm:ai:template_drafts:org1:${today()}`)).toBe('1');
        expect(await client.get(`crm:ai:template_drafts_total:${today()}`)).toBe('1');
    });

    it('lets a burst sent at once through only up to the allowance', async () => {
        const { service, create } = setup('test-key', { perUser: 4 });
        create.mockResolvedValue(written());

        const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => service.write(`org${i}`, 'u1', input)));

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
        expect(create).toHaveBeenCalledTimes(4);
    });
});

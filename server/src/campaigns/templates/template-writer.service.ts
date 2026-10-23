import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
    BadGatewayException,
    GatewayTimeoutException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { TemplateDraftError, type TemplateDraft } from './template-components';
import {
    WRITER_OUTPUT_FORMAT,
    WRITER_SYSTEM_PROMPT,
    WriterOutputSchema,
    draftFromOutput,
    writerRequestMessage,
    writerRetryMessage,
    type WriterCategory,
    type WriterOutput,
} from './template-writer';

const MODEL = 'claude-opus-5-5';
/// Drafts an organization may ask for in a UTC day: a guard on API spend.
export const DRAFTS_PER_DAY = 50;
/// The first draft, and one rewrite when it breaks one of Meta's rules.
const ATTEMPTS = 2;
const COUNT_LUA = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

export interface WriteTemplateInput {
    brief: string;
    language: string;
    category?: WriterCategory | null;
}

export interface WrittenTemplate {
    draft: TemplateDraft;
    notes: string;
    model: string;
}

/**
 * Drafts a WhatsApp template from a merchant's description with Claude, for
 * the template editor. The key is Collabo's (ANTHROPIC_API_KEY); without it
 * the writer reports itself unavailable. A draft that breaks one of Meta's
 * rules is sent back once with the problem; refusals fall back server-side
 * to the model Anthropic recommends (fallbacks: "default").
 */
@Injectable()
export class TemplateWriterService {
    private readonly logger = new Logger(TemplateWriterService.name);
    private readonly client: Anthropic | null;

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        config: ConfigService,
    ) {
        const apiKey = config.get<string>('ai.anthropicApiKey');
        this.client = apiKey
            ? new Anthropic({ apiKey, baseURL: config.get<string>('ai.anthropicBaseUrl'), timeout: 60_000, maxRetries: 1 })
            : null;
    }

    status() {
        return { available: !!this.client, draftsPerDay: DRAFTS_PER_DAY };
    }

    async write(orgId: string, input: WriteTemplateInput): Promise<WrittenTemplate> {
        if (!this.client) throw new ServiceUnavailableException('AI writing is not set up on this Collabo server.');
        const day = new Date().toISOString().slice(0, 10);
        const used = Number(await this.redis.runScript('aiTemplateDraftCount', COUNT_LUA, 1, [`ai:template_drafts:${orgId}:${day}`], [2 * 86_400]));
        if (used > DRAFTS_PER_DAY) {
            throw new HttpException(`Your team has used today’s ${DRAFTS_PER_DAY} AI drafts. You can write more tomorrow.`, HttpStatus.TOO_MANY_REQUESTS);
        }

        const org = await this.prisma.organization.findUniqueOrThrow({
            where: { id: orgId },
            select: { name: true, industry: true, website: true, currency: true },
        });
        const shop = org.website
            ? null
            : await this.prisma.channel.findFirst({
                where: { organizationId: orgId, platform: ChannelPlatform.SHOPIFY, status: ChannelStatus.CONNECTED },
                select: { externalStoreUrl: true },
            });
        const taken = new Set(
            (await this.prisma.messageTemplate.findMany({ where: { organizationId: orgId, language: input.language }, select: { name: true } })).map((t) => t.name),
        );
        const category = input.category ?? null;

        const messages: Anthropic.Beta.BetaMessageParam[] = [{
            role: 'user',
            content: writerRequestMessage({
                brief: input.brief,
                language: input.language,
                category,
                store: { name: org.name, industry: org.industry, website: org.website ?? shop?.externalStoreUrl ?? null, currency: org.currency },
            }),
        }];
        for (let attempt = 1; ; attempt++) {
            const response = await this.ask(orgId, messages);
            const output = this.read(response);
            try {
                return {
                    draft: draftFromOutput(output, { language: input.language, category, takenNames: taken }),
                    notes: output.notes.trim(),
                    model: response.model,
                };
            } catch (err) {
                if (!(err instanceof TemplateDraftError)) throw err;
                if (attempt >= ATTEMPTS) {
                    throw new UnprocessableEntityException(`The AI could not write a template that meets WhatsApp’s rules (${err.message}) Try describing it differently.`);
                }
                messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: writerRetryMessage(err.message) });
            }
        }
    }

    private async ask(orgId: string, messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
        try {
            const response = await this.client!.beta.messages.create({
                model: MODEL,
                max_tokens: 8_192,
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default',
                output_config: { effort: 'low', format: WRITER_OUTPUT_FORMAT },
                system: [{ type: 'text', text: WRITER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
                // Anthropic's abuse signal per merchant, without naming them.
                metadata: { user_id: createHash('sha256').update(orgId).digest('hex').slice(0, 32) },
                messages,
            });
            this.logger.log(
                `Template draft for ${orgId}: ${response.model}, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out, ${response.stop_reason}`,
            );
            return response;
        } catch (err) {
            throw this.failure(err);
        }
    }

    /** Claude's answer, once it is a whole one. */
    private read(response: Anthropic.Beta.BetaMessage): WriterOutput {
        if (response.stop_reason === 'refusal') {
            this.logger.warn(`Template draft declined (${response.stop_details?.category ?? 'no category'})`);
            throw new UnprocessableEntityException('The AI declined to write this message. Describe it differently and try again.');
        }
        if (response.stop_reason === 'max_tokens') {
            throw new BadGatewayException('The AI ran out of room before it finished. Try a shorter description.');
        }
        const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').at(-1)?.text;
        let parsed: ReturnType<typeof WriterOutputSchema.safeParse> | null = null;
        try {
            parsed = text ? WriterOutputSchema.safeParse(JSON.parse(text)) : null;
        } catch {
            parsed = null;
        }
        if (!parsed?.success) throw new BadGatewayException('The AI sent back a draft Collabo could not read. Try again.');
        return parsed.data;
    }

    private failure(err: unknown): Error {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
            this.logger.error(`Anthropic refused Collabo's API key: ${err.message}`);
            return new ServiceUnavailableException('AI writing is not available right now.');
        }
        if (err instanceof Anthropic.RateLimitError) return new ServiceUnavailableException('The AI writer is busy. Try again in a minute.');
        if (err instanceof Anthropic.APIConnectionTimeoutError) return new GatewayTimeoutException('The AI writer took too long. Try again.');
        if (err instanceof Anthropic.APIError) {
            this.logger.error(`Template draft failed: ${err.status ?? 'no response'} ${err.message}`);
            return err.status === undefined || err.status >= 500
                ? new ServiceUnavailableException('The AI writer is busy. Try again in a minute.')
                : new BadGatewayException('The AI writer could not handle that request.');
        }
        return err instanceof Error ? err : new Error(String(err));
    }
}

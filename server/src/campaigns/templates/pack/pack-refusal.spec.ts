import { BadRequestException } from '@nestjs/common';
import { MetaGraphError } from '../../../channel/meta-graph.types';
import { RateLimitedError } from '../../../rate-limit/rate-limit.types';
import { classifyPackFailure, isButtonInputsRefusal } from './pack-refusal';

const refusal = (message: string, opts: { code?: number; subcode?: number; userMsg?: string } = {}) =>
    new MetaGraphError(message, 'API_ERROR', opts.code ?? 100, opts.subcode, 400, { message, ...(opts.userMsg ? { error_user_msg: opts.userMsg } : {}) });

describe('what a failed template creation means for the pack', () => {
    it('a name Meta holds, or is still deleting, is taken', () => {
        expect(classifyPackFailure(refusal('Invalid parameter', { subcode: 2388024 }))).toEqual({ kind: 'name_taken' });
        expect(classifyPackFailure(refusal('Content in This Language Already Exists'))).toEqual({ kind: 'name_taken' });
        expect(classifyPackFailure(refusal('Message template language is being deleted'))).toEqual({ kind: 'name_taken' });
    });

    it('the account’s template total is told apart before the hourly limit', () => {
        expect(classifyPackFailure(refusal('You have reached the maximum number of message templates for this account'))).toEqual({ kind: 'template_limit' });
        expect(classifyPackFailure(refusal('Template limit reached. Too many requests to create templates'))).toEqual({ kind: 'template_limit' });
        // Worded by the hour, it is the creation rate: wait an hour.
        expect(classifyPackFailure(refusal('You can create at most 100 message templates per hour'))).toEqual({ kind: 'rate_limited' });
        expect(classifyPackFailure(refusal('The maximum number of message templates in an hour has been reached'))).toEqual({ kind: 'rate_limited' });
        expect(classifyPackFailure(refusal('Too many calls', { code: 80008 }))).toEqual({ kind: 'rate_limited' });
        expect(classifyPackFailure(new RateLimitedError({ platform: 'meta', kind: 'buc', id: 'w' }, Date.now(), 'BREAKER', 4))).toEqual({ kind: 'rate_limited' });
    });

    it('a refusal keeps the words Meta wrote for the business', () => {
        expect(classifyPackFailure(refusal('(#100) Invalid parameter', { userMsg: 'The body reads as promotional.' }))).toEqual({ kind: 'refused', message: 'The body reads as promotional.' });
        expect(classifyPackFailure(refusal('(#100) Invalid parameter'))).toEqual({ kind: 'refused', message: '(#100) Invalid parameter' });
        expect(classifyPackFailure(new BadRequestException('Upload the header file again.'))).toEqual({ kind: 'refused', message: 'Upload the header file again.' });
    });

    it('a dead token stops the pack; no answer is retried', () => {
        expect(classifyPackFailure(new MetaGraphError('Invalid OAuth access token', 'AUTH_FAILED', 190))).toEqual({ kind: 'auth' });
        expect(classifyPackFailure(new MetaGraphError('timed out', 'TIMEOUT'))).toEqual({ kind: 'transient' });
        expect(classifyPackFailure(new MetaGraphError('Bad gateway', 'HTTP_ERROR', undefined, undefined, 502))).toEqual({ kind: 'transient' });
    });

    it('knows a refusal of the library button inputs’ form', () => {
        expect(isButtonInputsRefusal(refusal('(#100) Param library_template_button_inputs must be a valid JSON string'))).toBe(true);
        expect(isButtonInputsRefusal(refusal('Template not found in library'))).toBe(false);
    });
});

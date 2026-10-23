import { parseDefinition } from '../blocks/definition.schema';
import { parseRunContext } from './run-context';
import { simulate } from './simulate';

const steps = parseDefinition({
    steps: [
        { id: 't', type: 'trigger', config: { channel: 'instagram', event: 'comment', keyword: 'price' } },
        { id: 'r', type: 'reply_comment', config: { message: 'Hi {{first_name}}! Want the link?' } },
        {
            id: 'w',
            type: 'wait_for_reply',
            config: { saveAs: 'answer' },
            branches: {
                replied: [
                    { id: 'c', type: 'condition', config: { rules: [{ field: 'last_reply', op: 'contains', value: 'yes' }] }, branches: { yes: [{ id: 'm', type: 'send_message', config: { message: 'Here you go, {{attr.answer}}' } }], no: [] } },
                ],
                timeout: [{ id: 'tag', type: 'add_tag', config: { tags: ['cold'] } }],
            },
        },
        { id: 'n', type: 'add_note', config: { text: 'Done with {{first_name}}' } },
    ],
});
const facts = {
    contact: { name: '@riya.k', username: 'riya.k', phone: null, tags: [], attributes: {}, optedIn: false, optedOut: false },
    customer: null,
    conversation: { assignedUserId: null, windowOpen: true },
    context: parseRunContext({ vars: { trigger_text: 'price?' } }),
};

describe('simulate', () => {
    it('follows the replied branch with the answer saved', () => {
        const trace = simulate(steps, facts, { reply: 'yes please' });
        expect(trace.map((s) => `${s.stepId}${s.branch ? `>${s.branch}` : ''}`)).toEqual(['r', 'w>replied', 'c>yes', 'm', 'n']);
        expect(trace[0].detail).toBe('Replies privately: Hi riya.k! Want the link?');
        expect(trace[3].detail).toBe('Sends: Here you go, yes please');
    });

    it('takes the timeout branch when no reply comes, without touching the real facts', () => {
        const trace = simulate(steps, facts, { reply: null });
        expect(trace.map((s) => s.stepId)).toEqual(['r', 'w', 'tag', 'n']);
        expect(facts.contact.tags).toEqual([]);
    });
});

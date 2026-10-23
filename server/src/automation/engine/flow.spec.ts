import { Flow, interpolate, keywordMatches, variablesUsed } from './flow';

const flow = new Flow([
    { id: 't', type: 'trigger', config: {} },
    { id: 'a', type: 'send_message', config: {} },
    {
        id: 'w',
        type: 'wait_for_reply',
        config: {},
        branches: {
            replied: [
                { id: 'c', type: 'condition', config: {}, branches: { yes: [{ id: 'y1', type: 'add_tag', config: {} }], no: [] } },
                { id: 'r2', type: 'send_message', config: {} },
            ],
            timeout: [],
        },
    },
    { id: 'z', type: 'add_note', config: {} },
]);

describe('Flow', () => {
    it('starts after the trigger and walks siblings', () => {
        expect(flow.first()?.id).toBe('a');
        expect(flow.next('a')?.id).toBe('w');
    });

    it('enters a branch and comes back out after it', () => {
        expect(flow.enter('w', 'replied')?.id).toBe('c');
        expect(flow.enter('c', 'yes')?.id).toBe('y1');
        expect(flow.next('y1')?.id).toBe('r2');
        expect(flow.next('r2')?.id).toBe('z');
        expect(flow.next('z')).toBeNull();
    });

    it('goes straight on through an empty branch', () => {
        expect(flow.enter('c', 'no')?.id).toBe('r2');
        expect(flow.enter('w', 'timeout')?.id).toBe('z');
    });

    it('lists every step with its branch path', () => {
        expect(flow.all().map((s) => `${s.path.join('>')}:${s.step.id}`)).toEqual([
            ':t',
            ':a',
            ':w',
            'wait_for_reply:replied:c',
            'wait_for_reply:replied>condition:yes:y1',
            'wait_for_reply:replied:r2',
            ':z',
        ]);
    });
});

describe('interpolate', () => {
    it('fills variables and drops missing ones without leaving gaps', () => {
        expect(interpolate('Hi {{first_name}}, your code is {{ attr.code }}!', { first_name: 'Riya', 'attr.code': 'X1' })).toBe('Hi Riya, your code is X1!');
        expect(interpolate('Hi {{first_name}}, welcome!', {})).toBe('Hi, welcome!');
        expect(variablesUsed('{{a}} {{b.c}} {{a}}')).toEqual(['a', 'b.c']);
    });
});

describe('keywordMatches', () => {
    it('matches whole words, ignoring case and accents', () => {
        expect(keywordMatches('What is the PRICE?', ['price'], 'contains')).toBe(true);
        expect(keywordMatches('this', ['hi'], 'contains')).toBe(false);
        expect(keywordMatches('Café menu', ['cafe'], 'contains')).toBe(true);
        expect(keywordMatches('  price ', ['price'], 'exact')).toBe(true);
        expect(keywordMatches('price please', ['price'], 'exact')).toBe(false);
        expect(keywordMatches('anything', [], 'any')).toBe(true);
        expect(keywordMatches('', ['x'], 'contains')).toBe(false);
    });
});

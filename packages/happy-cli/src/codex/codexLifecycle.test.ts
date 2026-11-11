import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
import type { EventMsg } from './codexAppServerTypes';

// Exercise lifecycle dispatch directly, without spawning Codex or replacing
// client methods. These are the states established by thread/start and turn/start.
function activeClient(turnId: string | null = 'main-turn') {
    const client = new CodexAppServerClient();
    const events: EventMsg[] = [];
    let settled = false;
    const completion = new Promise<boolean>((resolve) => {
        Object.assign(client, {
            _threadId: 'main-thread',
            _turnId: turnId,
            pendingTurnCompletion: {
                turnId,
                resolve: (aborted: boolean) => { settled = true; resolve(aborted); },
            },
        });
    });
    client.setEventHandler((event) => events.push(event));
    return { client, events, completion, settled: () => settled };
}

const turn = (id: string, status = 'inProgress') => ({ id, items: [], status, error: null });

describe('Codex primary-thread lifecycle', () => {
    it.each([
        { method: 'turn/started', params: { threadId: 'child-thread', turn: turn('child-turn') } },
        { method: 'turn/completed', params: { threadId: 'child-thread', turn: turn('child-turn', 'completed') } },
        { method: 'turn/completed', params: { threadId: 'child-thread', turn: turn('child-turn', 'interrupted') } },
        { method: 'thread/status/changed', params: { threadId: 'child-thread', status: { type: 'idle' } } },
    ])('keeps the main turn working after a child $method notification', async ({ method, params }) => {
        const { client, events, completion, settled } = activeClient();
        client['handleNotification'](method, params);
        expect(client.turnId).toBe('main-turn');
        expect(events).toEqual([]);
        expect(settled()).toBe(false);

        client['handleNotification']('turn/completed', {
            threadId: 'main-thread', turn: turn('main-turn', 'completed'),
        });
        expect(await completion).toBe(false);
        expect(events).toEqual([{ type: 'task_complete', turn_id: 'main-turn', status: 'completed' }]);
    });

    it.each(['task_started', 'task_complete', 'turn_aborted'])('ignores a child legacy %s event', async (type) => {
        const { client, events, completion, settled } = activeClient();
        client['handleNotification']('codex/event', {
            conversationId: 'child-thread', msg: { type, turn_id: 'child-turn' },
        });
        expect(client.turnId).toBe('main-turn');
        expect(events).toEqual([]);
        expect(settled()).toBe(false);

        client['handleNotification']('codex/event', {
            conversationId: 'main-thread', msg: { type: 'task_complete', turn_id: 'main-turn' },
        });
        expect(await completion).toBe(false);
        expect(events).toEqual([{ type: 'task_complete', turn_id: 'main-turn' }]);
    });

    it('ignores a child idle fallback after legacy notifications selected the protocol', async () => {
        const { client, events, completion, settled } = activeClient();
        client['handleNotification']('codex/event', {
            conversationId: 'main-thread', msg: { type: 'task_started', turn_id: 'main-turn' },
        });
        events.length = 0;
        client['handleNotification']('thread/status/changed', { threadId: 'child-thread', status: { type: 'idle' } });
        client['handleNotification']('turn/completed', { threadId: 'child-thread', turn: turn('child-turn', 'completed') });
        expect(client.turnId).toBe('main-turn');
        expect(events).toEqual([]);
        expect(settled()).toBe(false);
        client['handleNotification']('turn/completed', { threadId: 'main-thread', turn: turn('main-turn', 'completed') });
        expect(await completion).toBe(false);
        expect(events).toEqual([{ type: 'task_complete', turn_id: 'main-turn', status: 'completed' }]);
    });

    it('retains the primary-thread idle completion fallback and deduplicates its turn end', async () => {
        const { client, events, completion } = activeClient();
        client['handleNotification']('thread/status/changed', { threadId: 'main-thread', status: { type: 'idle' } });
        expect(await completion).toBe(false);
        client['handleNotification']('turn/completed', { threadId: 'main-thread', turn: turn('main-turn', 'completed') });
        expect(events).toEqual([{ type: 'task_complete', turn_id: 'main-turn', status: 'completed' }]);
    });

    it.each(['main-turn', null])('forwards a child final answer without completing the primary turn (turn ID: %s)', async (turnId) => {
        const { client, events, completion, settled } = activeClient(turnId);
        client['handleNotification']('item/completed', {
            threadId: 'child-thread', turnId: 'child-turn',
            item: { type: 'agentMessage', id: 'child-message', text: 'Child result', phase: 'final_answer' },
        });
        expect(client.turnId).toBe(turnId);
        expect(settled()).toBe(false);
        expect(events).toEqual([{ type: 'agent_message', message: 'Child result', item_id: 'child-message', phase: 'final_answer' }]);

        client['handleNotification']('item/completed', {
            threadId: 'main-thread', turnId: 'main-turn',
            item: { type: 'agentMessage', id: 'main-message', text: 'Main result', phase: 'final_answer' },
        });
        expect(await completion).toBe(false);
        expect(events.at(-1)).toEqual({ type: 'task_complete', turn_id: 'main-turn', status: 'completed' });
    });

    it('accepts legacy lifecycle events without a thread identifier', async () => {
        const { client, events, completion } = activeClient();
        client['handleNotification']('codex/event/task_complete', { msg: { type: 'task_complete', turn_id: 'main-turn' } });
        expect(await completion).toBe(false);
        expect(events).toEqual([{ type: 'task_complete', turn_id: 'main-turn' }]);
    });
});

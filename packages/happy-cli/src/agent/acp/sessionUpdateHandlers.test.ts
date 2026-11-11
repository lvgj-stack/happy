import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../core';
import {
    handleAgentThoughtChunk,
    handleToolCall,
    handleToolCallUpdate,
    stripLeakedThoughtSummarizerDraft,
    type HandlerContext,
} from './sessionUpdateHandlers';

// Shortened from real cursor-agent `agent_thought_chunk` payloads. Cursor's
// thought summarizer sometimes leaks its own ~4KB drafting notes and appends
// the actual summary at the end, in a few slightly different layouts.
const DRAFT_PREFIX = 'Thinking Process:\n\n1.  **Analyze the Request:**\n    *   **Goal:** Summarize the provided thoughts.\n    *   **Length:** Maximum 50 words.\n\n4.  **Review against Constraints:**\n    *   Header: `**Inspecting specific log match lines**` (5 words).\n    *   Separator: `\\n\\n`\n\n';

describe('stripLeakedThoughtSummarizerDraft', () => {
    it('keeps only the summary appended after a Final Polish draft', () => {
        const text = DRAFT_PREFIX
            + '5.  **Final Polish:**\n    **Examining remaining CLI files**\n\n    I am reviewing `AgentBackend.ts`.'
            + '**Examining remaining CLI files**\n\nI am reviewing `AgentBackend.ts` to map its dependencies.\n\n';
        expect(stripLeakedThoughtSummarizerDraft(text)).toBe(
            '**Examining remaining CLI files**\n\nI am reviewing `AgentBackend.ts` to map its dependencies.\n\n',
        );
    });

    it('handles a summary glued onto the last draft bullet', () => {
        const text = DRAFT_PREFIX
            + '6.  **Final Output Generation:**\n    *   Assemble header and summary.**Inspecting specific log match lines**\n\nI am now executing a targeted search.\n\n';
        expect(stripLeakedThoughtSummarizerDraft(text)).toBe(
            '**Inspecting specific log match lines**\n\nI am now executing a targeted search.\n\n',
        );
    });

    it('unwraps a backticked, indented summary with literal \\n\\n separator', () => {
        const text = DRAFT_PREFIX
            + '6.  **Final Output Generation:**\n    `**Trace repetitive notification spam loops**`\n    \\n\\n\n    I have mapped the core notification spam mechanism.\n\n';
        expect(stripLeakedThoughtSummarizerDraft(text)).toBe(
            '**Trace repetitive notification spam loops**\n\nI have mapped the core notification spam mechanism.\n\n',
        );
    });

    it('drops a draft that never reaches a summary', () => {
        expect(stripLeakedThoughtSummarizerDraft(DRAFT_PREFIX + '5.  **Drafting the Header:**\n    *   *Idea 1:* ')).toBe('');
    });

    it('passes ordinary thoughts through untouched', () => {
        const text = '**Identify premature settle timer evaluation**\n\nI am tracking settle timers.\n\n';
        expect(stripLeakedThoughtSummarizerDraft(text)).toBe(text);
    });
});

describe('handleAgentThoughtChunk', () => {
    const makeCtx = (emitted: AgentMessage[]): HandlerContext => ({
        activeToolCalls: new Set(),
        emit: (msg: AgentMessage) => { emitted.push(msg); },
    } as unknown as HandlerContext);

    it('emits the cleaned summary instead of the leaked draft', () => {
        const emitted: AgentMessage[] = [];
        handleAgentThoughtChunk({
            content: { text: DRAFT_PREFIX + '**Inspecting backend specs**\n\nI am diving into the commit.\n\n' },
        }, makeCtx(emitted));
        expect(emitted).toEqual([{
            type: 'event',
            name: 'thinking',
            payload: { text: '**Inspecting backend specs**\n\nI am diving into the commit.\n\n', streaming: true },
        }]);
    });

    it('emits nothing for a draft with no summary', () => {
        const emitted: AgentMessage[] = [];
        const result = handleAgentThoughtChunk({ content: { text: DRAFT_PREFIX } }, makeCtx(emitted));
        expect(result).toEqual({ handled: true });
        expect(emitted).toEqual([]);
    });
});

describe('Cursor edit tool updates', () => {
    const makeCtx = (emitted: AgentMessage[]): HandlerContext => ({
        transport: {},
        activeToolCalls: new Set(),
        toolCallStartTimes: new Map(),
        toolCallTimeouts: new Map(),
        toolCallIdToNameMap: new Map(),
        idleTimeout: null,
        toolCallCountSincePrompt: 0,
        emit: (msg: AgentMessage) => { emitted.push(msg); },
        emitIdleStatus: () => {},
        clearIdleTimeout: () => {},
        setIdleTimeout: () => {},
    } as unknown as HandlerContext);

    it('waits for Cursor to enrich an empty edit placeholder with its path', () => {
        const emitted: AgentMessage[] = [];
        const ctx = makeCtx(emitted);

        expect(handleToolCall({
            sessionUpdate: 'tool_call',
            toolCallId: 'edit-1',
            kind: 'edit',
            status: 'pending',
            title: 'Edit File',
            rawInput: {},
        }, ctx)).toEqual({ handled: true });
        expect(emitted).toEqual([]);
        expect(ctx.activeToolCalls.has('edit-1')).toBe(false);

        const result = handleToolCallUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'edit-1',
            title: 'Edit `/repo/src/app.ts`',
            rawInput: { path: '/repo/src/app.ts' },
            locations: [{ path: '/repo/src/app.ts' }],
        }, ctx);

        expect(result).toEqual({ handled: true, toolCallCountSincePrompt: 1 });
        expect(emitted).toContainEqual({
            type: 'tool-call',
            toolName: 'edit',
            callId: 'edit-1',
            args: {
                path: '/repo/src/app.ts',
                locations: [{ path: '/repo/src/app.ts' }],
            },
        });
        expect(ctx.activeToolCalls.has('edit-1')).toBe(true);

        for (const timeout of ctx.toolCallTimeouts.values()) clearTimeout(timeout);
    });

    it('starts an edit immediately when its first event already has metadata', () => {
        const emitted: AgentMessage[] = [];
        const ctx = makeCtx(emitted);

        handleToolCall({
            sessionUpdate: 'tool_call',
            toolCallId: 'edit-2',
            kind: 'edit',
            status: 'pending',
            rawInput: { path: '/repo/README.md' },
        }, ctx);

        expect(emitted).toContainEqual({
            type: 'tool-call',
            toolName: 'edit',
            callId: 'edit-2',
            args: { path: '/repo/README.md' },
        });

        for (const timeout of ctx.toolCallTimeouts.values()) clearTimeout(timeout);
    });
});

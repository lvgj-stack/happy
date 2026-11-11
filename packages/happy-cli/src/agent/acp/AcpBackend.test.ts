import { describe, expect, it, vi } from 'vitest';
import { AcpBackend, isHappyChangeTitleTool, selectPermissionOutcome } from './AcpBackend';

/**
 * Builds a small Node script acting as an ACP stdio agent over newline-delimited JSON-RPC.
 */
function makeFakeAcpAgentScript(mode: 'cursor-permissions' | 'gemini-permissions' | 'cursor-change-title'): string {
  return `
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let nextId = 100;
    const pending = new Map();

    function send(msg) {
      process.stdout.write(JSON.stringify(msg) + '\\n');
    }

    function callClient(method, params) {
      const id = nextId++;
      send({ jsonrpc: '2.0', id, method, params });
      return new Promise((resolve) => pending.set(id, resolve));
    }

    rl.on('line', async (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && !msg.method) {
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          },
        });
        return;
      }
      if (msg.method === 'session/new') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'cursor-sess-1',
          },
        });
        return;
      }
      if (msg.method === 'session/prompt') {
        const promptText = msg.params.prompt[0].text;
        let options;
        let toolCall;
        if (${JSON.stringify(mode)} === 'cursor-permissions') {
          options = promptText === 'no-always'
            ? [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
              ]
            : [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
              ];
          toolCall = {
            toolCallId: 'call-' + promptText,
            kind: 'execute',
            title: 'Terminal: ls',
            rawInput: { command: 'ls -la' },
          };
        } else if (${JSON.stringify(mode)} === 'gemini-permissions') {
          options = [
            { optionId: 'proceed_once', name: 'Proceed once', kind: 'allow_once' },
            { optionId: 'proceed_always', name: 'Proceed always', kind: 'allow_always' },
            { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
          ];
          toolCall = {
            toolCallId: 'gemini-call-' + promptText,
            kind: 'execute',
            input: { cmd: 'pwd' },
          };
        } else {
          options = [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ];
          toolCall = {
            toolCallId: 'mcp-call-1',
            kind: 'other',
            title: 'happy-change_title: change_title',
            rawInput: { title: 'Fix login bug' },
          };
        }

        const permResult = await callClient('session/request_permission', {
          sessionId: 'cursor-sess-1',
          toolCall,
          options,
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'cursor-sess-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: JSON.stringify(permResult) },
            },
          },
        });
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn' },
        });
      }
    });
  `;
}

describe('selectPermissionOutcome & isHappyChangeTitleTool', () => {
  it('selects Cursor permission optionIds by ACP kind and returns cancelled outcome on abort', () => {
    const cursorOptions = [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ];

    expect(selectPermissionOutcome('approved', cursorOptions)).toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
    expect(selectPermissionOutcome('approved_for_session', cursorOptions)).toEqual({
      outcome: 'selected',
      optionId: 'allow-always',
    });
    expect(selectPermissionOutcome('denied', cursorOptions)).toEqual({
      outcome: 'selected',
      optionId: 'reject-once',
    });
    expect(selectPermissionOutcome('abort', cursorOptions)).toEqual({
      outcome: 'cancelled',
    });
  });

  it('falls back to allow_once when allow_always is absent, and reject_always when reject_once is absent', () => {
    const partialOptions = [
      { optionId: 'custom-allow-1', name: 'Yes', kind: 'allow_once' },
      { optionId: 'custom-reject-all', name: 'Never', kind: 'reject_always' },
    ];

    expect(selectPermissionOutcome('approved_for_session', partialOptions)).toEqual({
      outcome: 'selected',
      optionId: 'custom-allow-1',
    });
    expect(selectPermissionOutcome('denied', partialOptions)).toEqual({
      outcome: 'selected',
      optionId: 'custom-reject-all',
    });
  });

  it('falls back to Gemini/OpenCode optionId and name matching when kind is absent or unrecognized', () => {
    const geminiOptions = [
      { optionId: 'proceed_once', name: 'Proceed once' },
      { optionId: 'proceed_always', name: 'Proceed always' },
      { optionId: 'cancel', name: 'Cancel' },
    ];

    expect(selectPermissionOutcome('approved', geminiOptions)).toEqual({
      outcome: 'selected',
      optionId: 'proceed_once',
    });
    expect(selectPermissionOutcome('approved_for_session', geminiOptions)).toEqual({
      outcome: 'selected',
      optionId: 'proceed_always',
    });
    expect(selectPermissionOutcome('denied', geminiOptions)).toEqual({
      outcome: 'selected',
      optionId: 'cancel',
    });
  });

  it('matches Cursor MCP change_title titles without matching shell execute calls', () => {
    expect(isHappyChangeTitleTool({
      toolName: 'other',
      toolCallId: 'mcp-1',
      title: 'happy-change_title: change_title',
      kind: 'other',
    })).toBe(true);

    expect(isHappyChangeTitleTool({
      toolName: 'execute',
      toolCallId: 'exec-1',
      title: 'happy-change_title: change_title',
      kind: 'execute',
    })).toBe(false);

    expect(isHappyChangeTitleTool({
      toolName: 'other',
      toolCallId: 'mcp-2',
      title: 'change_title_and_rm_rf',
      kind: 'other',
    })).toBe(false);
  });
});

describe('AcpBackend requestPermission over real ACP stream', () => {
  it('maps Cursor permission decisions end-to-end and passes rawInput + toolCallId', async () => {
    const decisions: Record<string, 'approved' | 'approved_for_session' | 'denied' | 'abort'> = {
      'call-approve': 'approved',
      'call-session': 'approved_for_session',
      'call-deny': 'denied',
      'call-abort': 'abort',
      'call-no-always': 'approved_for_session',
    };
    const seenCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const outputs: string[] = [];

    const backend = new AcpBackend({
      agentName: 'cursor',
      cwd: process.cwd(),
      command: process.execPath,
      args: ['-e', makeFakeAcpAgentScript('cursor-permissions')],
      permissionHandler: {
        handleToolCall: vi.fn(async (id, name, input) => {
          seenCalls.push({ id, name, input });
          return { decision: decisions[id] ?? 'denied' };
        }),
      },
    });
    backend.onMessage((msg) => {
      if (msg.type === 'model-output' && msg.textDelta) {
        outputs.push(msg.textDelta);
      }
    });

    try {
      const { sessionId } = await backend.startSession();
      for (const prompt of ['approve', 'session', 'deny', 'abort', 'no-always']) {
        await backend.sendPrompt(sessionId, prompt);
      }

      expect(seenCalls[0]).toEqual({
        id: 'call-approve',
        name: 'execute',
        input: { command: 'ls -la' },
      });
      expect(outputs.map((raw) => JSON.parse(raw))).toEqual([
        { outcome: { outcome: 'selected', optionId: 'allow-once' } },
        { outcome: { outcome: 'selected', optionId: 'allow-always' } },
        { outcome: { outcome: 'selected', optionId: 'reject-once' } },
        { outcome: { outcome: 'cancelled' } },
        { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it('preserves Gemini option selection when kind is unrecognized', async () => {
    const outputs: string[] = [];
    const backend = new AcpBackend({
      agentName: 'gemini',
      cwd: process.cwd(),
      command: process.execPath,
      args: ['-e', makeFakeAcpAgentScript('gemini-permissions')],
      permissionHandler: {
        handleToolCall: vi.fn(async (id: string) => ({
          decision: (id.endsWith('deny') ? 'denied' : 'approved_for_session') as 'denied' | 'approved_for_session',
        })),
      },
    });
    backend.onMessage((msg) => {
      if (msg.type === 'model-output' && msg.textDelta) {
        outputs.push(msg.textDelta);
      }
    });

    try {
      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, 'always');
      await backend.sendPrompt(sessionId, 'deny');

      expect(outputs.map((raw) => JSON.parse(raw))).toEqual([
        { outcome: { outcome: 'selected', optionId: 'proceed_always' } },
        { outcome: { outcome: 'selected', optionId: 'cancel' } },
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it('normalizes Cursor happy-change_title: change_title MCP tool name to change_title', async () => {
    const seenCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const backend = new AcpBackend({
      agentName: 'cursor',
      cwd: process.cwd(),
      command: process.execPath,
      args: ['-e', makeFakeAcpAgentScript('cursor-change-title')],
      permissionHandler: {
        handleToolCall: vi.fn(async (id: string, name: string, input: unknown) => {
          seenCalls.push({ id, name, input });
          return { decision: 'approved' as const };
        }),
      },
    });

    try {
      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, 'hello');

      expect(seenCalls).toEqual([
        {
          id: 'mcp-call-1',
          name: 'change_title',
          input: { title: 'Fix login bug' },
        },
      ]);
    } finally {
      await backend.dispose();
    }
  });
});

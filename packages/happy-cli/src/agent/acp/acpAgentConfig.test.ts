import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFindCursorBin: vi.fn<() => string | undefined>(),
}));

vi.mock('@/cursor/constants', () => ({
  findCursorBin: mocks.mockFindCursorBin,
}));

import { KNOWN_ACP_AGENTS, resolveAcpAgentConfig } from './acpAgentConfig';

describe('KNOWN_ACP_AGENTS', () => {
  beforeEach(() => {
    mocks.mockFindCursorBin.mockReset();
    mocks.mockFindCursorBin.mockReturnValue(undefined);
  });

  it('defines built-in Gemini, OpenCode, and Cursor command mappings', () => {
    expect(KNOWN_ACP_AGENTS).toEqual({
      gemini: { command: 'gemini', args: ['--experimental-acp'] },
      opencode: { command: 'opencode', args: ['acp'] },
      cursor: { command: 'cursor-agent', args: ['acp'] },
    });
  });
});

describe('resolveAcpAgentConfig', () => {
  beforeEach(() => {
    mocks.mockFindCursorBin.mockReset();
    mocks.mockFindCursorBin.mockReturnValue(undefined);
  });

  it('resolves known agent names to predefined command + args', () => {
    expect(resolveAcpAgentConfig(['gemini'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
  });

  it('resolves cursor command dynamically via findCursorBin at call time', () => {
    mocks.mockFindCursorBin.mockReturnValueOnce('/Users/dev/.local/bin/cursor-agent');
    expect(resolveAcpAgentConfig(['cursor'])).toEqual({
      agentName: 'cursor',
      command: '/Users/dev/.local/bin/cursor-agent',
      args: ['acp'],
    });

    mocks.mockFindCursorBin.mockReturnValueOnce(undefined);
    expect(resolveAcpAgentConfig(['cursor'])).toEqual({
      agentName: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
    });
  });

  it('appends extra CLI args for known agent aliases', () => {
    expect(resolveAcpAgentConfig(['opencode', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('strips legacy --acp for opencode compatibility', () => {
    expect(resolveAcpAgentConfig(['opencode', '--acp', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('resolves custom command form with -- separator', () => {
    expect(resolveAcpAgentConfig(['--', 'custom-agent', '--flag'])).toEqual({
      agentName: 'custom-agent',
      command: 'custom-agent',
      args: ['--flag'],
    });
  });

  it('treats unknown agent names as direct commands', () => {
    expect(resolveAcpAgentConfig(['my-agent', '--x'])).toEqual({
      agentName: 'my-agent',
      command: 'my-agent',
      args: ['--x'],
    });
  });

  it('throws with helpful usage when no args are provided', () => {
    expect(() => resolveAcpAgentConfig([])).toThrow('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  });

  it('throws when separator form omits command', () => {
    expect(() => resolveAcpAgentConfig(['--'])).toThrow('Missing command after "--". Usage: happy acp -- <command> [args]');
  });
});

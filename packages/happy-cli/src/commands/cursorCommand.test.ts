import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFindCursorBin: vi.fn<() => string | undefined>(),
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
  mockRunAcp: vi.fn(),
}));

vi.mock('@/cursor/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cursor/constants')>();
  return {
    ...actual,
    findCursorBin: mocks.mockFindCursorBin,
  };
});

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}));

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}));

vi.mock('@/agent/acp', () => ({
  runAcp: mocks.mockRunAcp,
}));

import { handleCursorCommand } from './cursorCommand';

describe('handleCursorCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockFindCursorBin.mockReturnValue('/home/user/.local/bin/cursor-agent');
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    });
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined);
    mocks.mockRunAcp.mockResolvedValue(undefined);
  });

  it('throws an installation hint before auth when cursor-agent binary is missing', async () => {
    mocks.mockFindCursorBin.mockReturnValue(undefined);

    await expect(handleCursorCommand([])).rejects.toThrow(/cursor-agent.*install/i);
    expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled();
    expect(mocks.mockRunAcp).not.toHaveBeenCalled();
  });

  it('starts runAcp with resolved cursor-agent binary and acp subcommand', async () => {
    await handleCursorCommand(['--started-by', 'terminal', '--verbose']);

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(mocks.mockRunAcp).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      agentName: 'cursor',
      command: '/home/user/.local/bin/cursor-agent',
      args: ['acp'],
      startedBy: 'terminal',
      verbose: true,
      model: undefined,
      permissionMode: undefined,
      resumeAgentSessionId: undefined,
    });
  });

  it('accepts and ignores --happy-starting-mode while forwarding --model and --permission-mode', async () => {
    await handleCursorCommand([
      '--happy-starting-mode', 'remote',
      '--started-by', 'daemon',
      '--model', 'claude-opus-5-5[context=300k,effort=medium,fast=false]',
      '--permission-mode', 'plan',
    ]);

    expect(mocks.mockRunAcp).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      agentName: 'cursor',
      command: '/home/user/.local/bin/cursor-agent',
      args: ['acp'],
      startedBy: 'daemon',
      verbose: false,
      model: 'claude-opus-5-5[context=300k,effort=medium,fast=false]',
      permissionMode: 'plan',
      resumeAgentSessionId: undefined,
    });
  });

  it('appends cursor-agent login hint when ACP fails due to missing authentication', async () => {
    mocks.mockRunAcp.mockRejectedValue(new Error('Authentication required (cursor_login)'));

    await expect(handleCursorCommand([])).rejects.toThrow(/cursor-agent login/);
  });

  it('forwards --resume <cursorSessionId> as resumeAgentSessionId to runAcp', async () => {
    await handleCursorCommand(['--resume', 'cursor-acp-id-123', '--started-by', 'daemon']);

    expect(mocks.mockRunAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'cursor',
        startedBy: 'daemon',
        resumeAgentSessionId: 'cursor-acp-id-123',
      }),
    );
  });
});

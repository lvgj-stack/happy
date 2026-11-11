import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (params: any) => Promise<any> | any>();
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;

  const mockSession = {
    onUserMessage: vi.fn((handler: (message: any) => void) => {
      userMessageHandler = handler;
    }),
    keepAlive: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    suppressNextArchiveSignal: vi.fn(),
    skipExistingMessages: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    updateAgentState: vi.fn((handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
      handler({});
    }),
    rpcHandlerManager: {
      registerHandler: vi.fn((name: string, handler: (params: any) => Promise<any> | any) => {
        sessionHandlers.set(name, handler);
      }),
    },
  };

  const backendState = {
    listeners: [] as Array<(message: any) => void>,
    prompts: [] as Array<{ sessionId: string; prompt: string }>,
    setConfigOptionCalls: [] as Array<{ configId: string; value: string }>,
    setModeCalls: [] as string[],
    setModelCalls: [] as string[],
    startSessionMessages: [] as any[],
    sendPromptError: null as Error | null,
    sendPromptImpl: null as null | ((emit: (message: any) => void) => Promise<void>),
    startSessionCalls: 0,
    resetSessionCalls: 0,
    cancelCalls: [] as string[],
    disposeCalls: 0,
    constructorArgs: null as any,
  };

  return {
    mockReadSettings: vi.fn(async () => ({ machineId: 'machine-1', sandboxConfig: undefined })),
    mockApiCreate: vi.fn(),
    mockGetOrCreateMachine: vi.fn(async () => ({})),
    mockGetOrCreateSession: vi.fn(async () => ({ id: 'session-1' })),
    mockSetupOfflineReconnection: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockStartHappyServer: vi.fn(),
    mockProjectPath: vi.fn(() => '/tmp/happy'),
    mockSetBackend: vi.fn(),
    mockKillRegister: vi.fn((_rpc: unknown, handler: () => Promise<void>) => {
      killHandler = handler;
    }),
    mockLoggerDebug: vi.fn(),
    mockConsoleLog: vi.spyOn(console, 'log').mockImplementation(() => {}),
    sessionHandlers,
    getUserMessageHandler: () => userMessageHandler,
    setUserMessageHandler: (handler: ((message: any) => void) | null) => {
      userMessageHandler = handler;
    },
    getKillHandler: () => killHandler,
    setKillHandler: (handler: (() => Promise<void>) | null) => {
      killHandler = handler;
    },
    mockSession,
    backendState,
  };
});

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
  return {
    ...actual,
    readSettings: mocks.mockReadSettings,
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}));

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: { host: 'host', platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happy', happyLibDir: '/tmp/happy' },
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockKillRegister,
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
  startHappyServer: mocks.mockStartHappyServer,
}));

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: {
    setBackend: mocks.mockSetBackend,
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}));

vi.mock('./AcpBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AcpBackend')>();
  return {
    ...actual,
    AcpBackend: class MockAcpBackend {
    constructor(args: any) {
      mocks.backendState.constructorArgs = args;
    }

    onMessage(handler: (message: any) => void) {
      mocks.backendState.listeners.push(handler);
    }

    offMessage(handler: (message: any) => void) {
      mocks.backendState.listeners = mocks.backendState.listeners.filter((item) => item !== handler);
    }

    async startSession() {
      mocks.backendState.startSessionCalls += 1;
      for (const message of mocks.backendState.startSessionMessages) {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      }
      return { sessionId: 'acp-session-1' };
    }

    async resetSession() {
      mocks.backendState.resetSessionCalls += 1;
      for (const message of mocks.backendState.startSessionMessages) {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      }
      return { sessionId: `acp-session-reset-${mocks.backendState.resetSessionCalls}` };
    }

    async sendPrompt(sessionId: string, prompt: string) {
      mocks.backendState.prompts.push({ sessionId, prompt });
      if (mocks.backendState.sendPromptError) {
        throw mocks.backendState.sendPromptError;
      }
      if (mocks.backendState.sendPromptImpl) {
        const emit = (message: any) => {
          for (const listener of mocks.backendState.listeners) {
            listener(message);
          }
        };
        await mocks.backendState.sendPromptImpl(emit);
        return;
      }
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'running' });
        listener({ type: 'model-output', textDelta: 'hello' });
        listener({ type: 'tool-call', toolName: 'ReadFile', args: { path: 'README.md' }, callId: 'tool-1' });
        listener({ type: 'tool-result', toolName: 'ReadFile', result: { ok: true }, callId: 'tool-1' });
        listener({ type: 'status', status: 'idle' });
      }
    }

    async setSessionConfigOption(configId: string, value: string) {
      mocks.backendState.setConfigOptionCalls.push({ configId, value });
      return true;
    }

    async setSessionMode(modeId: string) {
      mocks.backendState.setModeCalls.push(modeId);
      return true;
    }

    async setSessionModel(modelId: string) {
      mocks.backendState.setModelCalls.push(modelId);
      return true;
    }

    async cancel(sessionId: string) {
      mocks.backendState.cancelCalls.push(sessionId);
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'stopped' });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
    }
    },
  };
});

import { runAcp } from './runAcp';

describe('runAcp', () => {
  const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  const stripLogPrefix = (line: string) => stripAnsi(line).replace(/^\[\d{2}:\d{2}\] /, '');
  const consoleLines = () => mocks.mockConsoleLog.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .map(stripLogPrefix);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionHandlers.clear();
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.setConfigOptionCalls = [];
    mocks.backendState.setModeCalls = [];
    mocks.backendState.setModelCalls = [];
    mocks.backendState.startSessionMessages = [];
    mocks.backendState.sendPromptError = null;
    mocks.backendState.sendPromptImpl = null;
    mocks.backendState.startSessionCalls = 0;
    mocks.backendState.resetSessionCalls = 0;
    mocks.backendState.cancelCalls = [];
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.constructorArgs = null;

    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
    });
    mocks.mockSetupOfflineReconnection.mockImplementation(() => ({
      session: mocks.mockSession,
      reconnectionHandle: { cancel: vi.fn() },
      isOffline: false,
    }));
    mocks.mockStartHappyServer.mockResolvedValue({
      url: 'http://127.0.0.1:9876',
      stop: vi.fn(),
    });
  });

  it('wires backend messages through mapper into session envelopes', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Build a test plan' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.command).toBe('opencode');
    expect(mocks.backendState.constructorArgs.args).toEqual(['--acp']);
    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: 'Build a test plan',
    });

    const envelopeTypes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.ev.t);
    expect(envelopeTypes).toEqual(['turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end']);
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Happy Session ID: session-1',
      'Incoming prompt: Build a test plan',
      'Status: running',
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
      'Tool: ReadFile completed (callId=tool-1)',
      'Status: idle',
    ]));
  });

  it('keeps reporting thinking until the prompt resolves, despite heuristic idle statuses mid-turn', async () => {
    let finishPrompt!: () => void;
    let midTurnReached!: () => void;
    const midTurn = new Promise<void>((resolve) => { midTurnReached = resolve; });
    mocks.backendState.sendPromptImpl = async (emit) => {
      emit({ type: 'status', status: 'running' });
      emit({ type: 'model-output', textDelta: 'Looking around' });
      // AcpBackend emits idle after a short pause in chunks or once tool calls settle,
      // while the ACP prompt request (the real turn) is still open.
      emit({ type: 'status', status: 'idle' });
      emit({ type: 'tool-call', toolName: 'ReadFile', args: { path: 'README.md' }, callId: 'tool-1' });
      emit({ type: 'tool-result', toolName: 'ReadFile', result: { ok: true }, callId: 'tool-1' });
      emit({ type: 'status', status: 'idle' });
      midTurnReached();
      await new Promise<void>((resolve) => { finishPrompt = resolve; });
      emit({ type: 'model-output', textDelta: 'Done' });
      emit({ type: 'status', status: 'idle' });
    };

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'Investigate' } });

    await midTurn;
    const lastThinking = () => mocks.mockSession.keepAlive.mock.calls.at(-1)?.[0];
    expect(lastThinking()).toBe(true);
    expect(mocks.mockSession.keepAlive.mock.calls.slice(1).map(([thinking]) => thinking)).not.toContain(false);

    finishPrompt();
    await vi.waitFor(() => {
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });
    expect(lastThinking()).toBe(false);

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('registers abort handler that cancels the ACP backend session', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    const abortHandler = mocks.sessionHandlers.get('abort');
    expect(abortHandler).toBeTypeOf('function');

    await abortHandler!({});
    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toEqual(['acp-session-1']);
    });

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('emits thinking messages in default mode', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    const listener = mocks.backendState.listeners[0];
    const prompts = mocks.backendState.prompts;
    if (!listener) {
      throw new Error('Expected backend listener to be registered');
    }

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Think first' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    listener({ type: 'event', name: 'thinking', payload: { text: 'Analyzing request' } });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(prompts).toHaveLength(1);
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Thinking: "Analyzing request"',
    ]));
  });

  it('emits raw backend and envelope logs when verbose is enabled', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run the command' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines.some((line) => line.startsWith('Outgoing raw backend message from opencode: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Incoming raw envelope for opencode: '))).toBe(true);
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
    ]));
  });

  it('logs slash commands, modes, and models line by line when verbose is enabled', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'available_commands',
        payload: [
          { name: 'init', description: 'create/update AGENTS.md' },
          { name: 'review', description: 'review uncommitted changes' },
        ],
      },
      {
        type: 'event',
        name: 'modes_update',
        payload: {
          availableModes: [
            { id: 'build', name: 'build', description: 'Executes tools' },
            { id: 'plan', name: 'plan', description: 'Disallows edit tools' },
          ],
          currentModeId: 'build',
        },
      },
      {
        type: 'event',
        name: 'models_update',
        payload: {
          currentModelId: 'gemini-2.5-pro',
          availableModels: [
            { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing slash commands from gemini (2):',
      '  /init - create/update AGENTS.md',
      '  /review - review uncommitted changes',
      'Outgoing modes from gemini (2), current=build:',
      '  mode=build name=build - Executes tools',
      '  mode=plan name=plan - Disallows edit tools',
      'Outgoing models from gemini (2), current=gemini-2.5-pro:',
      '  model=gemini-2.5-pro name=Gemini 2.5 Pro',
      '  model=gemini-2.5-flash name=Gemini 2.5 Flash',
    ]));
  });

  it('exits when backend reports terminal startup status', async () => {
    mocks.backendState.startSessionMessages = [
      { type: 'status', status: 'error', detail: 'spawn opencode ENOENT' },
    ];

    await runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    expect(consoleLines()).toContain('Status: error: spawn opencode ENOENT');
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'opencode error: spawn opencode ENOENT',
    });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(mocks.backendState.disposeCalls).toBe(1);
  });

  it('surfaces a prompt exception when no backend error status was emitted', async () => {
    mocks.backendState.sendPromptError = new Error('model switch failed');
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });
    const runOutcome = runPromise.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Use that model' },
    });

    expect(await runOutcome).toMatchObject({ message: 'model switch failed' });
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'opencode error: model switch failed',
    });
  });

  it('updates session metadata with ACP config options (models and operating modes)', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'code',
              options: [
                { value: 'ask', name: 'Ask', description: 'Q&A mode' },
                { value: 'code', name: 'Code', description: 'Implementation mode' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced model' },
                { value: 'claude-opus', name: 'Claude Opus', description: 'Deep reasoning model' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const metadataHandlers = mocks.mockSession.updateMetadata.mock.calls.map((call) => call[0]);
    const baseMetadata = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
    };
    const appliedMetadata = metadataHandlers.map((handler) => handler(baseMetadata));

    expect(appliedMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentModelCode: 'claude-sonnet',
          currentOperatingModeCode: 'code',
          models: [
            { code: 'claude-sonnet', value: 'Claude Sonnet', description: 'Balanced model' },
            { code: 'claude-opus', value: 'Claude Opus', description: 'Deep reasoning model' },
          ],
          operatingModes: [
            { code: 'ask', value: 'Ask', description: 'Q&A mode' },
            { code: 'code', value: 'Code', description: 'Implementation mode' },
          ],
        }),
      ]),
    );
  });

  it('switches ACP model, permission mode, and effort when requested values match config options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
            {
              type: 'select',
              id: 'reasoning-depth',
              name: 'Thought Level',
              category: 'thought_level',
              currentValue: 'mid',
              options: [
                { value: 'mid', name: 'Mid' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Apply settings then run' },
      meta: {
        permissionMode: 'Code',
        model: 'claude-opus',
        effort: 'high',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'permission-mode', value: 'code' },
      { configId: 'model', value: 'claude-opus' },
      { configId: 'reasoning-depth', value: 'high' },
    ]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });

  it('ignores ACP model and permission mode requests when values do not match advertised options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run without switching' },
      meta: {
        permissionMode: 'invalid-mode',
        model: 'invalid-model',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });

  it('creates session metadata with cursor flavor when agentName is cursor', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          flavor: 'cursor',
        }),
      }),
    );
  });

  it('applies initial model and permissionMode on startup and ignores default model for cursor', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'agent',
              options: [
                { value: 'agent', name: 'Agent' },
                { value: 'plan', name: 'Plan' },
                { value: 'ask', name: 'Ask' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'composer-2.5',
              options: [
                { value: 'composer-2.5', name: 'Composer 2.5' },
                { value: 'claude-opus-5-5[context=300k,effort=medium,fast=false]', name: 'Claude Opus 5.5' },
                { value: 'custom-default-named', name: 'Default' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
      permissionMode: 'plan',
      model: 'claude-opus-5-5[context=300k,effort=medium,fast=false]',
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'mode', value: 'plan' },
      { configId: 'model', value: 'claude-opus-5-5[context=300k,effort=medium,fast=false]' },
    ]);

    mocks.backendState.setConfigOptionCalls = [];

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Keep current model when meta.model is default' },
      meta: {
        model: 'default',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('supports synthesized yolo mode for cursor (including --permission-mode yolo) and restores prompting on switching back to agent', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'plan',
              options: [
                { value: 'agent', name: 'Agent' },
                { value: 'plan', name: 'Plan' },
                { value: 'ask', name: 'Ask' },
              ],
            },
          ],
        },
      },
    ];

    let currentMetadata: Record<string, unknown> = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
      flavor: 'cursor',
    };
    mocks.mockSession.updateMetadata.mockImplementation((updater: (m: any) => any) => {
      currentMetadata = updater(currentMetadata);
    });

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
      permissionMode: 'yolo',
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    // Startup --permission-mode yolo switched Cursor from 'plan' to 'agent' and published currentOperatingModeCode='yolo'
    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'mode', value: 'agent' },
    ]);
    expect(currentMetadata.currentOperatingModeCode).toBe('yolo');

    // Even if backend emits a config_options_update reporting currentValue='agent', currentOperatingModeCode stays 'yolo'
    for (const listener of mocks.backendState.listeners) {
      listener({
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'agent',
              options: [
                { value: 'agent', name: 'Agent' },
                { value: 'plan', name: 'Plan' },
                { value: 'ask', name: 'Ask' },
              ],
            },
          ],
        },
      });
    }
    expect(currentMetadata.currentOperatingModeCode).toBe('yolo');

    // Two consecutive shell tool calls auto-approve immediately without waiting for mobile response
    const permHandler = mocks.backendState.constructorArgs.permissionHandler;
    await expect(permHandler.handleToolCall('shell-1', 'execute', { command: 'ls' }))
      .resolves.toEqual({ decision: 'approved' });
    await expect(permHandler.handleToolCall('shell-2', 'execute', { command: 'pwd' }))
      .resolves.toEqual({ decision: 'approved' });

    // Switch back to 'agent' mode via user message
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Switch back to normal agent mode' },
      meta: { permissionMode: 'agent' },
    });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });
    expect(currentMetadata.currentOperatingModeCode).toBe('agent');

    // Now shell tool call waits for mobile permission response, while change_title still auto-approves!
    await expect(permHandler.handleToolCall('mcp-title-1', 'change_title', { title: 'Chat title' }))
      .resolves.toEqual({ decision: 'approved' });

    let shell3Resolved = false;
    const shell3Promise = permHandler.handleToolCall('shell-3', 'execute', { command: 'whoami' }).then((res: any) => {
      shell3Resolved = true;
      return res;
    });
    await Promise.resolve();
    expect(shell3Resolved).toBe(false);

    // Approve shell-3 through the permission RPC handler
    const rpcPermHandler = mocks.sessionHandlers.get('permission');
    await rpcPermHandler!({ id: 'shell-3', approved: true, decision: 'approved' });
    await expect(shell3Promise).resolves.toEqual({ decision: 'approved' });

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('reconnects in-place via HAPPY_RECONNECT_* env vars, forwards resumeAgentSessionId, writes cursorSessionId, and announces fallback if loadSession failed', async () => {
    vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'existing-happy-sess-1');
    vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_VARIANT', 'dataKey');
    vi.stubEnv('HAPPY_RECONNECT_SEQ', '15');
    vi.stubEnv('HAPPY_RECONNECT_METADATA_VERSION', '4');
    vi.stubEnv('HAPPY_RECONNECT_AGENT_STATE_VERSION', '6');

    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'session_resume_failed',
        payload: { sessionId: 'old-cursor-sess', reason: 'Session not found on disk' },
      },
    ];

    let currentMetadata: Record<string, unknown> = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
      flavor: 'cursor',
      lifecycleState: 'archived',
      archivedBy: 'cli',
    };
    mocks.mockSession.updateMetadata.mockImplementation((updater: (m: any) => any) => {
      currentMetadata = updater(currentMetadata);
    });

    try {
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'cursor',
        command: 'cursor-agent',
        args: ['acp'],
        resumeAgentSessionId: 'old-cursor-sess',
      });

      await vi.waitFor(() => {
        expect(mocks.backendState.startSessionCalls).toBe(1);
      });

      expect(mocks.mockGetOrCreateSession).not.toHaveBeenCalled();
      expect(mocks.mockSession.suppressNextArchiveSignal).toHaveBeenCalledTimes(1);
      expect(mocks.mockSession.skipExistingMessages).toHaveBeenCalledTimes(1);
      expect(mocks.backendState.constructorArgs.resumeSessionId).toBe('old-cursor-sess');
      expect(currentMetadata.cursorSessionId).toBe('acp-session-1');
      expect(currentMetadata.lifecycleState).toBe('running');
      expect(currentMetadata.archivedBy).toBeUndefined();
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
        type: 'message',
        message: expect.stringContaining('Session not found on disk'),
      });
      expect(mocks.mockNotifyDaemonSessionStarted).toHaveBeenCalledWith(
        'existing-happy-sess-1',
        expect.objectContaining({ cursorSessionId: 'acp-session-1' }),
        expect.any(Object),
      );

      await mocks.getKillHandler()!();
      await runPromise;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('filters spurious trailing WritableIterable stream-close error chunks for cursor while preserving real error chunks', async () => {
    let promptCall = 0;
    mocks.backendState.sendPromptImpl = async (emit) => {
      promptCall += 1;
      emit({ type: 'status', status: 'running' });
      if (promptCall === 1) {
        emit({ type: 'model-output', textDelta: 'Clean reply.' });
        emit({
          type: 'model-output',
          textDelta: '\n\nError: RetriableError: WritableIterable is closed',
        });
      } else {
        emit({ type: 'model-output', textDelta: 'Partial reply.' });
        emit({
          type: 'model-output',
          textDelta: '\n\nError: RetriableError: Connection failed',
        });
      }
      emit({ type: 'status', status: 'idle' });
    };

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'cursor',
      command: '/root/.local/bin/cursor-agent',
      args: ['acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'First turn' },
    });
    await vi.waitFor(() => {
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    mocks.mockSession.sendSessionEvent.mockClear();
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Second turn' },
    });
    await vi.waitFor(() => {
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const textEnvelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.ev.t === 'text')
      .map((envelope) => envelope.ev.text);

    expect(textEnvelopes).toEqual([
      'Clean reply.',
      'Partial reply.\n\nError: RetriableError: Connection failed',
    ]);
    expect(consoleLines()).toContain('Filtered spurious stream-close error chunk from cursor');
    expect(consoleLines()).not.toContain(
      'Outgoing message: "\\n\\nError: RetriableError: WritableIterable is closed"',
    );
  });

  it('handles /clear by resetting the ACP session, updating cursorSessionId, re-applying mode/model, and emitting Context was reset', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'agent',
              options: [
                { value: 'agent', name: 'Agent' },
                { value: 'plan', name: 'Plan' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'composer-2.5',
              options: [
                { value: 'composer-2.5', name: 'Composer 2.5' },
                { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
              ],
            },
          ],
        },
      },
    ];

    let currentMetadata: Record<string, unknown> = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
      flavor: 'cursor',
    };
    mocks.mockSession.updateMetadata.mockImplementation((updater: (m: any) => any) => {
      currentMetadata = updater(currentMetadata);
    });

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
      permissionMode: 'plan',
      model: 'claude-sonnet-4',
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    expect(currentMetadata.cursorSessionId).toBe('acp-session-1');
    mocks.backendState.setConfigOptionCalls = [];
    mocks.mockSession.sendSessionEvent.mockClear();

    // Send /clear
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: '  /clear  ' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.resetSessionCalls).toBe(1);
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    // /clear must not be sent as a prompt to the model
    expect(mocks.backendState.prompts).toEqual([]);
    expect(currentMetadata.cursorSessionId).toBe('acp-session-reset-1');
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'Context was reset',
    });
    // Mode and model are re-applied onto the fresh ACP session
    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'mode', value: 'plan' },
      { configId: 'model', value: 'claude-sonnet-4' },
    ]);

    // Subsequent prompt uses the new sessionId
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Hello after clear' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toEqual([
        { sessionId: 'acp-session-reset-1', prompt: 'Hello after clear' },
      ]);
    });

    await mocks.getKillHandler()!();
    await runPromise;
  });
});

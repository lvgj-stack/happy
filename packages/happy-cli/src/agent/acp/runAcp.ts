import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { Session as ApiSession } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage } from '@/agent/core';
import { AcpBackend, isHappyChangeTitleTool, type AcpPermissionHandler } from './AcpBackend';
import { buildAcpTurnPrompt } from './acpPrompt';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { downloadCodexFileEventAttachment } from '@/codex/utils/attachmentEvents';
import { createSerialAsyncHandler } from '@/codex/utils/serialAsyncHandler';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { isCursorSpuriousStreamCloseChunk, isLikelyCursorAuthError } from '@/cursor/constants';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import {
  extractConfigOptionsFromPayload,
  extractCurrentModeIdFromPayload,
  extractModeStateFromPayload,
  extractModelStateFromPayload,
  mergeAcpSessionConfigIntoMetadata,
} from './sessionConfigMetadata';
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const ACP_EVENT_PREVIEW_CHARS = 240;
const ACP_RAW_PREVIEW_CHARS = 2000;
const ACP_COLOR_RESET = '\u001b[0m';
const ACP_LOG_COLORS = {
  muted: '\u001b[90m',
  error: '\u001b[31m',
  incoming: '\u001b[32m',
  outgoing: '\u001b[34m',
  tool: '\u001b[38;5;208m',
} as const;

type AcpLogKind = keyof typeof ACP_LOG_COLORS;
type AcpFormattedLog = {
  kind: AcpLogKind;
  text: string;
};

function shouldUseColoredAcpLogs(): boolean {
  if (process.env.FORCE_COLOR === '0') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return process.stdout.isTTY === true || process.stderr.isTTY === true;
}

function formatAcpTime(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function colorizeAcpLine(kind: AcpLogKind, line: string): string {
  if (!shouldUseColoredAcpLogs()) {
    return line;
  }
  return `${ACP_LOG_COLORS[kind]}${line}${ACP_COLOR_RESET}`;
}

function logAcp(kind: AcpLogKind, message: string): void {
  const line = `[${formatAcpTime()}] ${message}`;
  console.log(colorizeAcpLine(kind, line));
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateForConsole(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function formatUnknownForConsole(value: unknown, limit: number): string {
  let serialized = '';
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }
  return truncateForConsole(toSingleLine(serialized), limit);
}

function formatTextForConsole(text: string): string {
  return JSON.stringify(truncateForConsole(toSingleLine(text), ACP_EVENT_PREVIEW_CHARS));
}

function formatOptionalDetail(text: string | null | undefined, limit = ACP_EVENT_PREVIEW_CHARS): string {
  if (!text) {
    return '';
  }
  return ` - ${truncateForConsole(toSingleLine(text), limit)}`;
}

function extractThinkingText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text;
  }
  return '';
}

function formatAcpMessageForFrontend(agentName: string, msg: AgentMessage, detailed: boolean): AcpFormattedLog | null {
  switch (msg.type) {
    case 'status':
      return null;
    case 'model-output': {
      const text = msg.textDelta ?? msg.fullText ?? '';
      return {
        kind: 'outgoing',
        text: `Outgoing message: ${formatTextForConsole(text)}`,
      };
    }
    case 'tool-call':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} started (callId=${msg.callId})`,
      };
    case 'tool-result':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} completed (callId=${msg.callId})`,
      };
    case 'permission-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission request from ${agentName}: id=${msg.id} reason=${msg.reason}`,
      };
    case 'permission-response':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission response from ${agentName}: id=${msg.id} approved=${msg.approved}`,
      };
    case 'fs-edit':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing fs edit from ${agentName}: description=${formatTextForConsole(msg.description)}`,
      };
    case 'terminal-output':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing terminal output from ${agentName}: text=${formatTextForConsole(msg.data)}`,
      };
    case 'event': {
      if (msg.name === 'thinking') {
        const thinkingText = extractThinkingText(msg.payload);
        return {
          kind: 'muted',
          text: `Thinking: ${formatTextForConsole(thinkingText)}`,
        };
      }
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing event from ${agentName}: name=${msg.name} payload=${formatUnknownForConsole(msg.payload, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    }
    case 'token-count':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing token count from ${agentName}: data=${formatUnknownForConsole(msg, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    case 'exec-approval-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing exec approval request from ${agentName}: callId=${msg.call_id}`,
      };
    case 'patch-apply-begin':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply begin from ${agentName}: callId=${msg.call_id} autoApproved=${msg.auto_approved === true}`,
      };
    case 'patch-apply-end':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply end from ${agentName}: callId=${msg.call_id} success=${msg.success}`,
      };
    default:
      return null;
  }
}

function formatEnvelopeForServerLog(agentName: string, envelope: SessionEnvelope): AcpFormattedLog {
  if (envelope.ev.t === 'text') {
    const thinkingPrefix = envelope.ev.thinking ? 'thinking' : 'text';
    return {
      kind: 'incoming',
      text: `Incoming ${thinkingPrefix} prompt for ${agentName}: ${formatUnknownForConsole(envelope.ev.text, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-start') {
    return {
      kind: 'tool',
      text: `Tool start sent to server from ${agentName}: tool=${envelope.ev.name} callId=${envelope.ev.call} args=${formatUnknownForConsole(envelope.ev.args, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-end') {
    return {
      kind: 'tool',
      text: `Tool end sent to server from ${agentName}: callId=${envelope.ev.call}`,
    };
  }
  if (envelope.ev.t === 'turn-start') {
    return {
      kind: 'incoming',
      text: `Incoming turn start for ${agentName}`,
    };
  }
  if (envelope.ev.t === 'turn-end') {
    return {
      kind: 'incoming',
      text: `Incoming turn end for ${agentName}: status=${envelope.ev.status}`,
    };
  }
  return {
    kind: 'incoming',
    text: `Incoming ${envelope.ev.t} for ${agentName}: ${formatUnknownForConsole(envelope.ev, ACP_EVENT_PREVIEW_CHARS)}`,
  };
}

type AcpSwitchMode = {
  permissionMode?: string;
  model?: string | null;
  effort?: string | null;
  appendSystemPrompt?: string;
};

type AcpSelectableOption = {
  code: string;
  value: string;
};

type AcpConfigSelector = {
  configId: string;
  currentCode: string;
  options: AcpSelectableOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isSelectValue(value: unknown): value is { value: string; name: string } {
  return isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string';
}

function isSelectGroup(value: unknown): value is { options: unknown[] } {
  return isRecord(value) && Array.isArray(value.options);
}

function flattenSelectOptions(options: unknown): AcpSelectableOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  const flattened: AcpSelectableOption[] = [];

  for (const entry of options) {
    if (isSelectValue(entry)) {
      flattened.push({ code: entry.value, value: entry.name });
      continue;
    }
    if (isSelectGroup(entry)) {
      for (const grouped of entry.options) {
        if (!isSelectValue(grouped)) {
          continue;
        }
        flattened.push({ code: grouped.value, value: grouped.name });
      }
    }
  }

  return flattened;
}

function extractConfigSelector(
  configOptions: SessionConfigOption[],
  category: 'mode' | 'model' | 'thought_level',
): AcpConfigSelector | null {
  const optionMatchesCategory = (option: SessionConfigOption): boolean => {
    if (option.category === category) {
      return true;
    }
    // Some ACP providers omit category; fallback to id/name heuristics.
    const id = normalizeComparable(option.id);
    const name = normalizeComparable(option.name);
    if (category === 'model') {
      return id.includes('model') || name.includes('model');
    }
    if (category === 'thought_level') {
      return id.includes('thought') || id.includes('reasoning') || id.includes('effort')
        || name.includes('thought') || name.includes('reasoning') || name.includes('effort');
    }
    return id.includes('mode') || id.includes('permission') || name.includes('mode') || name.includes('permission');
  };

  for (const option of configOptions) {
    if (option.type !== 'select' || !optionMatchesCategory(option)) {
      continue;
    }
    return {
      configId: option.id,
      currentCode: option.currentValue,
      options: flattenSelectOptions(option.options),
    };
  }
  return null;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function resolveRequestedCode(options: AcpSelectableOption[], requested: string): string | null {
  for (const option of options) {
    if (option.code === requested || option.value === requested) {
      return option.code;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const option of options) {
    if (normalizeComparable(option.code) === normalizedRequested || normalizeComparable(option.value) === normalizedRequested) {
      return option.code;
    }
  }

  return null;
}

function resolveRequestedLegacyModeCode(modes: SessionModeState, requested: string): string | null {
  for (const mode of modes.availableModes) {
    if (mode.id === requested || mode.name === requested) {
      return mode.id;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const mode of modes.availableModes) {
    if (normalizeComparable(mode.id) === normalizedRequested || normalizeComparable(mode.name) === normalizedRequested) {
      return mode.id;
    }
  }

  return null;
}

function resolveRequestedLegacyModelCode(models: SessionModelState, requested: string): string | null {
  for (const model of models.availableModels) {
    if (model.modelId === requested || model.name === requested) {
      return model.modelId;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const model of models.availableModels) {
    if (normalizeComparable(model.modelId) === normalizedRequested || normalizeComparable(model.name) === normalizedRequested) {
      return model.modelId;
    }
  }

  return null;
}

class GenericAcpPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
  private readonly logPrefix: string;
  private autoApprove = false;

  constructor(session: ApiSessionClient, agentName: string) {
    super(session);
    this.logPrefix = `[${agentName}]`;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
    logger.debug(`${this.logPrefix} Auto-approve mode set to: ${enabled}`);
  }

  private shouldAutoApprove(toolName: string, toolCallId: string, input: unknown): boolean {
    if (this.autoApprove) {
      return true;
    }
    const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
    return isHappyChangeTitleTool({ toolName, toolCallId, input: inputRecord });
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    if (this.shouldAutoApprove(toolName, toolCallId, input)) {
      logger.debug(`${this.logPrefix} Auto-approving tool: ${toolName} (${toolCallId})`);
      this.session.updateAgentState((currentState) => ({
        ...currentState,
        completedRequests: {
          ...currentState.completedRequests,
          [toolCallId]: {
            tool: toolName,
            arguments: input,
            createdAt: Date.now(),
            completedAt: Date.now(),
            status: 'approved',
            decision: 'approved',
          },
        },
      }));
      return { decision: 'approved' };
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }
}

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'cursor' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  if (agentName === 'cursor') {
    return 'cursor';
  }
  return 'acp';
}

function formatAcpErrorForSession(agentName: string, detail?: string | null): string {
  const baseDetail = detail?.trim() || 'The agent stopped because of an unknown error.';
  if (agentName === 'cursor' && isLikelyCursorAuthError(baseDetail) && !baseDetail.includes('cursor-agent login')) {
    return `${agentName} error: ${baseDetail}. Run \`cursor-agent login\` to authenticate Cursor CLI.`;
  }
  return `${agentName} error: ${baseDetail}`;
}

export async function runAcp(opts: {
  credentials: Credentials;
  agentName: string;
  command: string;
  args: string[];
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  model?: string;
  permissionMode?: string;
  resumeAgentSessionId?: string;
}): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend(opts.agentName);

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const sessionFlavor = resolveSessionFlavor(opts.agentName);
  const commandExecutable = opts.command.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const isCursorAgent = sessionFlavor === 'cursor'
    || commandExecutable === 'cursor-agent'
    || commandExecutable === 'cursor-agent.exe'
    || commandExecutable === 'cursor-agent.cmd';
  const { state, metadata } = createSessionMetadata({
    flavor: sessionFlavor,
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
  });
  if (sessionFlavor === 'cursor' && opts.resumeAgentSessionId) {
    metadata.cursorSessionId = opts.resumeAgentSessionId;
  }

  // Support in-place session reconnection via HAPPY_RECONNECT_* env vars (daemon/CLI resume)
  const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
  const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
  const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
  const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
  const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
  const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

  let response: ApiSession | null;
  if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
    logger.debug(`[${opts.agentName}] Reconnecting to existing session ${reconnectSessionId}`);
    response = {
      id: reconnectSessionId,
      seq: parseInt(reconnectSeq || '0', 10),
      encryptionKey: decodeBase64(reconnectKeyBase64),
      encryptionVariant: reconnectVariant,
      metadata,
      metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
      agentState: state,
      agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
    };
  } else {
    response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  }
  if (response) {
    logAcp('muted', `Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
    },
  });
  session = initialSession;

  if (reconnectSessionId) {
    session.suppressNextArchiveSignal();
    session.skipExistingMessages();
    session.updateMetadata((meta) => ({
      ...meta,
      lifecycleState: 'running',
      archivedBy: undefined,
      archiveReason: undefined,
    }));
  }

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[acp] Failed to report session to daemon:', error);
    }
  }

  permissionHandler = new GenericAcpPermissionHandler(session, opts.agentName);
  // Drop any permission requests left in agent state from a previous CLI
  // process that died while a tool prompt was open — see the matching
  // call in claudeRemoteLauncher for the full rationale.
  permissionHandler.reset('Previous CLI process exited before responding');
  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<AcpSwitchMode>((mode) => hashObject(mode));
  let currentPermissionMode: string | undefined = opts.permissionMode;
  let currentModel: string | null | undefined = opts.model;
  let currentEffort: string | null | undefined;
  let currentAppendSystemPrompt: string | undefined = undefined;
  let firstTurn = !Boolean(opts.resumeAgentSessionId);
  let appendSystemPromptInjected = Boolean(opts.resumeAgentSessionId);
  let modeSelector: AcpConfigSelector | null = null;
  let modelSelector: AcpConfigSelector | null = null;
  let effortSelector: AcpConfigSelector | null = null;
  let legacyModes: SessionModeState | null = null;
  let legacyModels: SessionModelState | null = null;
  let sawSlashCommands = false;
  let sawModes = false;
  let sawModels = false;
  let cursorYoloActive = false;

  const happyServer = await startHappyServer(session);
  const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: process.execPath,
      args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url],
    },
  };

  const backend = new AcpBackend({
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.command,
    args: opts.args,
    mcpServers,
    permissionHandler,
    transportHandler: new DefaultTransport(opts.agentName),
    hasChangeTitleInstruction: (prompt) => prompt.toLowerCase().includes('change_title'),
    verbose,
    resumeSessionId: opts.resumeAgentSessionId,
  });

  let thinking = false;
  // True while an ACP prompt request is open. The prompt response is what ends
  // a turn; AcpBackend's `idle` statuses are a heuristic (a pause between chunks,
  // or the active tool calls settling) and also fire mid-turn, so while a prompt
  // is open they must not tell the app the agent stopped working.
  let promptInFlight = false;
  const setThinking = (next: boolean) => {
    if (thinking === next) {
      return;
    }
    thinking = next;
    session.keepAlive(thinking, 'remote');
  };
  let acpSessionId: string | null = null;
  let shouldExit = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;
  let errorReportedForCurrentTurn = false;

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      return;
    }
    clearTimeout(pendingTurn.timeout);
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      current.reject(error);
      return;
    }
    current.resolve();
  };

  const waitForTurnEnd = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTurn = null;
      reject(new Error(`Timed out waiting for ${opts.agentName} to finish the turn`));
    }, TURN_TIMEOUT_MS);
    pendingTurn = { resolve, reject, timeout };
  });

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error(reason));
  };

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      if (verbose) {
        const formatted = formatEnvelopeForServerLog(opts.agentName, envelope);
        logAcp('muted', formatted.text);
      }
      session.sendSessionProtocolMessage(envelope);
      if (verbose) {
        logAcp('muted', `Incoming raw envelope for ${opts.agentName}: ${formatUnknownForConsole(envelope, ACP_RAW_PREVIEW_CHARS)}`);
      }
    }
  };

  const switchPermissionModeIfRequested = async (requestedMode: string): Promise<void> => {
    if (!requestedMode) {
      return;
    }

    if (sessionFlavor === 'cursor' && normalizeComparable(requestedMode) === 'yolo') {
      cursorYoloActive = true;
      permissionHandler.setAutoApprove(true);

      if (modeSelector) {
        const agentCode = resolveRequestedCode(modeSelector.options, 'agent');
        if (agentCode && agentCode !== modeSelector.currentCode) {
          const switched = await backend.setSessionConfigOption(modeSelector.configId, agentCode);
          if (switched) {
            modeSelector.currentCode = agentCode;
          }
        }
      } else if (legacyModes) {
        const agentCode = resolveRequestedLegacyModeCode(legacyModes, 'agent');
        if (agentCode && agentCode !== legacyModes.currentModeId) {
          const switched = await backend.setSessionMode(agentCode);
          if (switched) {
            legacyModes = {
              ...legacyModes,
              currentModeId: agentCode,
            };
          }
        }
      }

      session.updateMetadata((currentMetadata) =>
        mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentModeId: 'yolo' }),
      );
      return;
    }

    const disableCursorYolo = (nextModeCode: string) => {
      if (!cursorYoloActive) {
        return;
      }
      cursorYoloActive = false;
      permissionHandler.setAutoApprove(false);
      session.updateMetadata((currentMetadata) =>
        mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentModeId: nextModeCode }),
      );
    };

    if (modeSelector) {
      const resolved = resolveRequestedCode(modeSelector.options, requestedMode);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP permission mode request: ${requestedMode}`);
        return;
      }
      if (resolved === modeSelector.currentCode) {
        disableCursorYolo(resolved);
        return;
      }
      disableCursorYolo(resolved);
      const switched = await backend.setSessionConfigOption(modeSelector.configId, resolved);
      if (switched) {
        modeSelector.currentCode = resolved;
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentModeId: resolved }),
        );
        return;
      }
    }

    if (!legacyModes) {
      return;
    }

    const resolvedLegacyMode = resolveRequestedLegacyModeCode(legacyModes, requestedMode);
    if (!resolvedLegacyMode) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy mode request: ${requestedMode}`);
      return;
    }
    if (resolvedLegacyMode === legacyModes.currentModeId) {
      disableCursorYolo(resolvedLegacyMode);
      return;
    }

    disableCursorYolo(resolvedLegacyMode);
    const switched = await backend.setSessionMode(resolvedLegacyMode);
    if (switched) {
      legacyModes = {
        ...legacyModes,
        currentModeId: resolvedLegacyMode,
      };
    }
  };

  const switchModelIfRequested = async (requestedModel: string): Promise<void> => {
    if (!requestedModel) {
      return;
    }
    if (opts.agentName === 'cursor' && requestedModel === 'default') {
      return;
    }

    if (modelSelector) {
      const resolved = resolveRequestedCode(modelSelector.options, requestedModel);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP model request: ${requestedModel}`);
        return;
      }
      if (resolved === modelSelector.currentCode) {
        return;
      }
      const switched = await backend.setSessionConfigOption(modelSelector.configId, resolved);
      if (switched) {
        modelSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModels) {
      return;
    }

    const resolvedLegacyModel = resolveRequestedLegacyModelCode(legacyModels, requestedModel);
    if (!resolvedLegacyModel) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy model request: ${requestedModel}`);
      return;
    }
    if (resolvedLegacyModel === legacyModels.currentModelId) {
      return;
    }

    const switched = await backend.setSessionModel(resolvedLegacyModel);
    if (switched) {
      legacyModels = {
        ...legacyModels,
        currentModelId: resolvedLegacyModel,
      };
    }
  };

  const switchEffortIfRequested = async (requestedEffort: string): Promise<void> => {
    if (!requestedEffort || !effortSelector) {
      return;
    }
    const resolved = resolveRequestedCode(effortSelector.options, requestedEffort);
    if (!resolved) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP effort request: ${requestedEffort}`);
      return;
    }
    if (resolved === effortSelector.currentCode) {
      return;
    }
    const switched = await backend.setSessionConfigOption(effortSelector.configId, resolved);
    if (switched) {
      effortSelector.currentCode = resolved;
      session.updateMetadata((currentMetadata) =>
        mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentThoughtLevelCode: resolved }),
      );
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    // cursor-agent (verified on 2026.11.10-731fb78) has a ConnectRPC bidirectional
    // stream teardown race after turnEnded where ClientExecController writes to an
    // already-closed WritableIterable; ACP mode lacks enableAgentRetries and emits
    // "\n\nError: RetriableError: WritableIterable is closed" as a trailing
    // agent_message_chunk before returning stopReason="end_turn". Drop that chunk
    // here while letting AcpBackend's idle timer settle the turn normally.
    if (
      isCursorAgent
      && msg.type === 'model-output'
      && isCursorSpuriousStreamCloseChunk(msg.textDelta)
    ) {
      logger.debug(
        `[${opts.agentName}] Filtered spurious Cursor ACP stream-teardown chunk: ${JSON.stringify(msg.textDelta)}`,
      );
      if (verbose) {
        logAcp('muted', `Filtered spurious stream-close error chunk from ${opts.agentName}`);
      }
      return;
    }

    if (msg.type === 'event' && msg.name === 'images_skipped') {
      const count = isRecord(msg.payload) && typeof msg.payload.count === 'number' ? msg.payload.count : 0;
      const displayAgent = sessionFlavor === 'cursor' ? 'Cursor' : opts.agentName;
      session.sendSessionEvent({
        type: 'message',
        message: `${displayAgent} could not read ${count} image(s); sent the text only.`,
      });
    }

    if (msg.type === 'event' && msg.name === 'session_resume_failed') {
      firstTurn = !Boolean(reconnectSessionId);
      appendSystemPromptInjected = false;
      const payload = isRecord(msg.payload) ? msg.payload : {};
      const reason = typeof payload.reason === 'string' && payload.reason.trim().length > 0
        ? payload.reason.trim()
        : 'session could not be loaded';
      const displayAgent = sessionFlavor === 'cursor' ? 'Cursor' : opts.agentName;
      session.sendSessionEvent({
        type: 'message',
        message: `Could not restore previous ${displayAgent} context (${reason}); started a new session instead.`,
      });
    }

    if (msg.type === 'event' && msg.name === 'available_commands') {
      const commands = msg.payload as { name: string; description?: string }[];
      const commandNames = commands.map((c) => c.name);
      sawSlashCommands = commands.length > 0;
      if (verbose) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName} (${commands.length}):`);
        for (const command of commands) {
          logAcp('muted', `  /${command.name}${formatOptionalDetail(command.description, 160)}`);
        }
      }
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        slashCommands: commandNames,
      }));
    }

    if (msg.type === 'event' && msg.name === 'config_options_update') {
      const configOptions = extractConfigOptionsFromPayload(msg.payload);
      if (configOptions) {
        if (verbose) {
          logAcp('muted', `Outgoing config options from ${opts.agentName} (${configOptions.length}):`);
          for (const option of configOptions) {
            if (option.type === 'select') {
              const optionValues = flattenSelectOptions(option.options);
              logAcp('muted', `  config=${option.id} category=${option.category ?? 'unknown'} current=${option.currentValue} options=${optionValues.length}`);
            } else {
              logAcp('muted', `  config=${option.id} type=${option.type} category=${option.category ?? 'unknown'}`);
            }
          }
        }

        modeSelector = extractConfigSelector(configOptions, 'mode');
        modelSelector = extractConfigSelector(configOptions, 'model');
        effortSelector = extractConfigSelector(configOptions, 'thought_level');
        if (verbose) {
          if (modeSelector) {
            sawModes = true;
            logAcp('muted', `Outgoing mode options from ${opts.agentName} (${modeSelector.options.length}), current=${modeSelector.currentCode}:`);
            for (const option of modeSelector.options) {
              logAcp('muted', `  mode=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing mode options from ${opts.agentName}: not reported in config options`);
          }
          if (modelSelector) {
            sawModels = true;
            logAcp('muted', `Outgoing model options from ${opts.agentName} (${modelSelector.options.length}), current=${modelSelector.currentCode}:`);
            for (const option of modelSelector.options) {
              logAcp('muted', `  model=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing model options from ${opts.agentName}: not reported in config options`);
          }
          if (effortSelector) {
            logAcp('muted', `Outgoing effort options from ${opts.agentName} (${effortSelector.options.length}), current=${effortSelector.currentCode}:`);
            for (const option of effortSelector.options) {
              logAcp('muted', `  effort=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing effort options from ${opts.agentName}: not reported in config options`);
          }
        }
        if (cursorYoloActive && modeSelector && modeSelector.currentCode !== 'agent') {
          cursorYoloActive = false;
          permissionHandler.setAutoApprove(false);
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, {
            configOptions,
            ...(cursorYoloActive ? { currentModeId: 'yolo' } : {}),
          }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'modes_update') {
      const modes = extractModeStateFromPayload(msg.payload);
      if (modes) {
        legacyModes = modes;
        sawModes = true;
        if (verbose) {
          logAcp('muted', `Outgoing modes from ${opts.agentName} (${modes.availableModes.length}), current=${modes.currentModeId}:`);
          for (const mode of modes.availableModes) {
            logAcp('muted', `  mode=${mode.id} name=${mode.name}${formatOptionalDetail(mode.description, 160)}`);
          }
        }
        if (cursorYoloActive && modes.currentModeId !== 'agent') {
          cursorYoloActive = false;
          permissionHandler.setAutoApprove(false);
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, {
            modes,
            ...(cursorYoloActive ? { currentModeId: 'yolo' } : {}),
          }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'models_update') {
      const models = extractModelStateFromPayload(msg.payload);
      if (models) {
        legacyModels = models;
        sawModels = true;
        if (verbose) {
          logAcp('muted', `Outgoing models from ${opts.agentName} (${models.availableModels.length}), current=${models.currentModelId}:`);
          for (const model of models.availableModels) {
            logAcp('muted', `  model=${model.modelId} name=${model.name}`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { models }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'current_mode_update') {
      const currentModeId = extractCurrentModeIdFromPayload(msg.payload);
      if (currentModeId) {
        if (modeSelector) {
          modeSelector = {
            ...modeSelector,
            currentCode: currentModeId,
          };
        }
        if (legacyModes) {
          legacyModes = {
            ...legacyModes,
            currentModeId,
          };
        }
        if (cursorYoloActive && currentModeId !== 'agent') {
          cursorYoloActive = false;
          permissionHandler.setAutoApprove(false);
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, {
            currentModeId: cursorYoloActive ? 'yolo' : currentModeId,
          }),
        );
      }
    }

    if (msg.type === 'status') {
      const suffix = msg.detail ? `: ${msg.detail}` : '';
      const statusLine = `Status: ${msg.status}${suffix}`;
      logAcp('muted', statusLine);
      if (msg.status === 'running') {
        setThinking(true);
      } else if (msg.status !== 'idle' || !promptInFlight) {
        setThinking(false);
      }
      if (msg.status === 'idle') {
        clearPendingTurn();
      }
      if (msg.status === 'error' || msg.status === 'stopped') {
        stopRunnerFromBackendStatus(msg.status, msg.detail);
      }
    }

    const frontendMessage = formatAcpMessageForFrontend(opts.agentName, msg, verbose);
    if (frontendMessage) {
      logAcp(frontendMessage.kind, frontendMessage.text);
    }

    const envelopes = sessionManager.mapMessage(msg);
    sendEnvelopes(envelopes);
    if (msg.type === 'status' && msg.status === 'error' && envelopes.length === 0) {
      session.sendSessionEvent({
        type: 'message',
        message: formatAcpErrorForSession(opts.agentName, msg.detail),
      });
    }
    if (msg.type === 'status' && msg.status === 'error') {
      errorReportedForCurrentTurn = true;
    }
  };

  backend.onMessage(onBackendMessage);

  // Images arrive as file events just before the text they belong to. Start
  // each download right away; the next user message claims them in order.
  session.onFileEvent((fileEvent) => {
    logger.debug(`[${opts.agentName}] File event received (${fileEvent.content.data.ev.size} bytes)`);
    session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
  });

  session.onUserMessage(createSerialAsyncHandler(async (message) => {
    const attachments = await session.drainAttachmentsForUserMessage();
    if (!message.content.text) {
      return;
    }

    if (typeof message.meta?.permissionMode === 'string') {
      currentPermissionMode = message.meta.permissionMode;
      logger.debug(`[${opts.agentName}] Requested ACP permission mode: ${currentPermissionMode}`);
    }

    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
      currentModel = message.meta.model ?? null;
      logger.debug(`[${opts.agentName}] Requested ACP model: ${currentModel ?? 'null'}`);
    }

    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'effort')) {
      currentEffort = message.meta.effort ?? null;
      logger.debug(`[${opts.agentName}] Requested ACP effort: ${currentEffort ?? 'null'}`);
    }

    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'appendSystemPrompt')) {
      currentAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
      logger.debug(`[${opts.agentName}] Updated ACP appendSystemPrompt: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
    }

    if (parseSpecialCommand(message.content.text).type === 'clear') {
      logger.debug(`[${opts.agentName}] /clear command pushed to isolated queue`);
      messageQueue.pushIsolateAndClear(message.content.text, {
        permissionMode: currentPermissionMode,
        model: currentModel,
        effort: currentEffort,
        appendSystemPrompt: currentAppendSystemPrompt,
      });
      return;
    }

    messageQueue.push(message.content.text, {
      permissionMode: currentPermissionMode,
      model: currentModel,
      effort: currentEffort,
      appendSystemPrompt: currentAppendSystemPrompt,
    }, attachments);
  }, (error) => {
    logger.debug(`[${opts.agentName}] Failed to queue user message:`, error);
  }));
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    try {
      if (acpSessionId) {
        await backend.cancel(acpSessionId);
      }
      permissionHandler.reset();
      abortController.abort();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Abort failed:`, error);
    } finally {
      abortController = new AbortController();
    }
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  });

  const syncCursorSessionId = async (nextSessionId: string | null): Promise<void> => {
    if (sessionFlavor !== 'cursor' || !nextSessionId) {
      return;
    }
    metadata.cursorSessionId = nextSessionId;
    session.updateMetadata((currentMetadata) => ({
      ...currentMetadata,
      cursorSessionId: nextSessionId,
    }));
    if (response) {
      try {
        await notifyDaemonSessionStarted(response.id, metadata, {
          encryptionKey: encodeBase64(response.encryptionKey),
          encryptionVariant: response.encryptionVariant,
          seq: response.seq,
          metadataVersion: response.metadataVersion,
          agentStateVersion: response.agentStateVersion,
        });
      } catch (error) {
        logger.debug('[acp] Failed to update daemon session metadata with cursorSessionId:', error);
      }
    }
  };

  try {
    const started = await backend.startSession();
    acpSessionId = started.sessionId;
    await syncCursorSessionId(acpSessionId);
    if (typeof opts.permissionMode === 'string' && opts.permissionMode.length > 0) {
      await switchPermissionModeIfRequested(opts.permissionMode);
    }
    if (typeof opts.model === 'string' && opts.model.length > 0) {
      await switchModelIfRequested(opts.model);
    }
    if (verbose) {
      if (!sawSlashCommands) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName}: not reported yet`);
      }
      if (!sawModes) {
        logAcp('muted', `Outgoing modes from ${opts.agentName}: not reported yet`);
      }
      if (!sawModels) {
        logAcp('muted', `Outgoing models from ${opts.agentName}: not reported yet`);
      }
    }

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) {
          break;
        }
        if (waitSignal.aborted) {
          continue;
        }
        break;
      }

      if (!acpSessionId) {
        throw new Error('ACP session is not started');
      }

      if (parseSpecialCommand(batch.message).type === 'clear') {
        logger.debug(`[${opts.agentName}] Handling /clear command - resetting ACP session`);
        logAcp('incoming', 'Incoming /clear command: resetting session context');
        permissionHandler.reset();
        thinking = false;
        session.keepAlive(thinking, 'remote');
        try {
          const reset = await backend.resetSession();
          acpSessionId = reset.sessionId;
          appendSystemPromptInjected = false;
          await syncCursorSessionId(acpSessionId);
          const targetPermissionMode = batch.mode.permissionMode ?? currentPermissionMode;
          if (typeof targetPermissionMode === 'string' && targetPermissionMode.length > 0) {
            await switchPermissionModeIfRequested(targetPermissionMode);
          }
          const targetModel = batch.mode.model ?? currentModel;
          if (typeof targetModel === 'string' && targetModel.length > 0) {
            await switchModelIfRequested(targetModel);
          }
          const targetEffort = batch.mode.effort ?? currentEffort;
          if (typeof targetEffort === 'string' && targetEffort.length > 0) {
            await switchEffortIfRequested(targetEffort);
          }
          session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
          session.sendSessionEvent({ type: 'ready' });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          session.sendSessionEvent({
            type: 'message',
            message: formatAcpErrorForSession(opts.agentName, detail),
          });
          session.sendSessionEvent({ type: 'ready' });
          logAcp('error', `Session reset error from ${opts.agentName}: ${detail}`);
        }
        continue;
      }

      logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      errorReportedForCurrentTurn = false;
      sendEnvelopes(sessionManager.startTurn());
      const turnEnded = waitForTurnEnd();
      try {
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          await switchPermissionModeIfRequested(batch.mode.permissionMode);
        }
        if (typeof batch.mode.model === 'string' && batch.mode.model.length > 0) {
          await switchModelIfRequested(batch.mode.model);
        }
        if (typeof batch.mode.effort === 'string' && batch.mode.effort.length > 0) {
          await switchEffortIfRequested(batch.mode.effort);
        }
        const includeAppendSystemPrompt = Boolean(
          batch.mode.appendSystemPrompt && !appendSystemPromptInjected,
        );
        const turnPrompt = buildAcpTurnPrompt({
          message: batch.message,
          appendSystemPrompt: batch.mode.appendSystemPrompt,
          includeAppendSystemPrompt,
          includeTitleInstruction: firstTurn,
          isCursorAgent,
        });
        promptInFlight = true;
        setThinking(true);
        try {
          await backend.sendPrompt(acpSessionId, turnPrompt, batch.attachments);
        } finally {
          promptInFlight = false;
        }
        firstTurn = false;
        if (includeAppendSystemPrompt) {
          appendSystemPromptInjected = true;
        }
        await turnEnded;
        setThinking(false);
        sendEnvelopes(sessionManager.endTurn('completed'));
        session.sendSessionEvent({ type: 'ready' });
        if (verbose) {
          logAcp('muted', `Outgoing prompt completion from ${opts.agentName}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!errorReportedForCurrentTurn) {
          session.sendSessionEvent({
            type: 'message',
            message: formatAcpErrorForSession(opts.agentName, detail),
          });
          errorReportedForCurrentTurn = true;
        }
        setThinking(false);
        sendEnvelopes(sessionManager.endTurn('failed'));
        session.sendSessionEvent({ type: 'ready' });
        logAcp('error', `Prompt error from ${opts.agentName}: ${detail}`);
        clearPendingTurn(error instanceof Error ? error : new Error(String(error)));
        await turnEnded.catch(() => {});
        throw error;
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    clearPendingTurn(new Error('ACP runner shutting down'));

    try {
      permissionHandler.reset();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to reset permission handler:`, error);
    }

    backend.offMessage?.(onBackendMessage);
    await backend.dispose();

    try {
      happyServer.stop();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to stop Happy MCP server:`, error);
    }

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Session close failed:`, error);
    }
  }
}

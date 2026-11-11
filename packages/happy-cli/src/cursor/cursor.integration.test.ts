/**
 * Integration tests for Cursor CLI (`cursor-agent acp`) lifecycle.
 *
 * Skips automatically when `cursor-agent` is not installed or not authenticated.
 *
 * Run:
 *   pnpm --filter happy exec vitest run src/cursor/cursor.integration.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCursorBin, isLikelyCursorAuthError } from './constants';
import { AcpBackend, isHappyChangeTitleTool } from '@/agent/acp/AcpBackend';
import { buildAcpTurnPrompt } from '@/agent/acp/acpPrompt';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage } from '@/agent/core';

function isCursorAcpReady(): { ready: boolean; bin?: string; reason?: string } {
  const bin = findCursorBin();
  if (!bin) {
    return { ready: false, reason: 'cursor-agent binary not found' };
  }
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return { ready: true, bin };
  } catch (error) {
    return { ready: false, reason: String(error) };
  }
}

const probe = isCursorAcpReady();

describe.skipIf(!probe.ready)('Cursor ACP integration', () => {
  let backend: AcpBackend | null = null;
  let tempCwd: string | null = null;

  afterEach(async () => {
    await backend?.dispose();
    backend = null;
    if (tempCwd) {
      rmSync(tempCwd, { recursive: true, force: true });
      tempCwd = null;
    }
  });

  it('initializes ACP session, reports modes/models, and supports session/load without replaying history', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'happy-cursor-integ-'));
    tempCwd = cwd;
    const messages: AgentMessage[] = [];

    backend = new AcpBackend({
      agentName: 'cursor',
      cwd,
      command: probe.bin!,
      args: ['acp'],
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
      },
    });
    backend.onMessage((msg) => messages.push(msg));

    let started: { sessionId: string };
    try {
      started = await backend.startSession();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (isLikelyCursorAuthError(detail)) {
        console.log(`[cursor-integ] Skipping: cursor-agent not logged in (${detail})`);
        return;
      }
      throw error;
    }

    expect(started.sessionId).toBeTruthy();

    try {
      await backend.sendPrompt(started.sessionId, 'Remember the secret token PINEAPPLE_42 and reply ONLY with OK.');
      await backend.waitForResponseComplete(60_000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (isLikelyCursorAuthError(detail)) {
        console.log(`[cursor-integ] Skipping: cursor-agent not logged in (${detail})`);
        return;
      }
      throw error;
    }

    const firstTurnText = messages
      .filter((m) => m.type === 'model-output')
      .map((m) => (m as { textDelta?: string }).textDelta ?? '')
      .join('');
    expect(firstTurnText.length).toBeGreaterThan(0);

    await backend.dispose();
    backend = null;

    // Resume in a fresh process via session/load
    const resumedMessages: AgentMessage[] = [];
    backend = new AcpBackend({
      agentName: 'cursor',
      cwd,
      command: probe.bin!,
      args: ['acp'],
      resumeSessionId: started.sessionId,
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
      },
    });
    backend.onMessage((msg) => resumedMessages.push(msg));

    const resumed = await backend.startSession();
    expect(resumed.sessionId).toBe(started.sessionId);
    // Replayed history chunks during session/load must be suppressed
    expect(resumedMessages.filter((m) => m.type === 'model-output')).toEqual([]);
  }, 120_000);

  it('calls Happy MCP change_title on the first turn when scaffolded with buildAcpTurnPrompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'happy-cursor-title-integ-'));
    tempCwd = cwd;

    const titleSummaries: string[] = [];
    const fakeSessionClient = {
      sessionId: 'cursor-integ-session',
      sendClaudeSessionMessage: (msg: unknown) => {
        if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'summary') {
          titleSummaries.push(String((msg as { summary?: string }).summary ?? ''));
        }
      },
    } as unknown as ApiSessionClient;

    const happyServer = await startHappyServer(fakeSessionClient);
    try {
      const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
      backend = new AcpBackend({
        agentName: 'cursor',
        cwd,
        command: probe.bin!,
        args: ['acp'],
        mcpServers: {
          happy: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url],
          },
        },
        hasChangeTitleInstruction: (prompt) => prompt.toLowerCase().includes('change_title'),
        permissionHandler: {
          handleToolCall: async (toolCallId, toolName, input) => {
            const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : undefined;
            if (isHappyChangeTitleTool({ toolName, toolCallId, input: inputRecord })) {
              return { decision: 'approved' };
            }
            return { decision: 'denied' };
          },
        },
      });

      let started: { sessionId: string };
      try {
        started = await backend.startSession();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (isLikelyCursorAuthError(detail)) {
          console.log(`[cursor-integ] Skipping: cursor-agent not logged in (${detail})`);
          return;
        }
        throw error;
      }

      const firstPrompt = buildAcpTurnPrompt({
        message: '帮忙排查一下登录超时的问题，先只回复收到',
        includeAppendSystemPrompt: false,
        includeTitleInstruction: true,
        isCursorAgent: true,
      });

      try {
        await backend.sendPrompt(started.sessionId, firstPrompt);
        await backend.waitForResponseComplete(90_000);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (isLikelyCursorAuthError(detail)) {
          console.log(`[cursor-integ] Skipping: cursor-agent not logged in (${detail})`);
          return;
        }
        throw error;
      }

      expect(titleSummaries.length).toBeGreaterThan(0);
      expect(titleSummaries[0]?.trim().length).toBeGreaterThan(0);
    } finally {
      happyServer.stop();
    }
  }, 120_000);
});

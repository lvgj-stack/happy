import { findCursorBin, isLikelyCursorAuthError } from '@/cursor/constants';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { runAcp } from '@/agent/acp';
import { projectPath } from '@/projectPath';
import { CURSOR_WARM_DIR_ENV } from '@/cursor/warmAcp';
import { join } from 'node:path';

const CURSOR_AUTH_HINT = 'Run `cursor-agent login` to authenticate Cursor CLI.';

export async function handleCursorCommand(args: string[]): Promise<void> {
  const command = findCursorBin();
  if (!command) {
    throw new Error(
      "Cursor CLI ('cursor-agent') was not found on PATH or at ~/.local/bin/cursor-agent. Install Cursor CLI from https://cursor.com/cli (or set HAPPY_CURSOR_PATH).",
    );
  }

  let startedBy: 'daemon' | 'terminal' | undefined = undefined;
  let verbose = false;
  let model: string | undefined = undefined;
  let permissionMode: string | undefined = undefined;
  let resumeAgentSessionId: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--started-by') {
      startedBy = args[++i] as 'daemon' | 'terminal';
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--happy-starting-mode') {
      // Passed by daemon on spawn/resume; Cursor ACP always runs in remote-controllable mode.
      i += 1;
    } else if (arg === '--model') {
      model = args[++i];
    } else if (arg === '--permission-mode') {
      permissionMode = args[++i];
    } else if (arg === '--yolo') {
      permissionMode = 'yolo';
    } else if (arg === '--resume') {
      resumeAgentSessionId = args[++i];
    }
  }

  const { credentials } = await authAndSetupMachineIfNeeded();
  await ensureDaemonRunning();

  // Daemon-spawned sessions may take a pre-warmed cursor-agent through the
  // warm connector, which falls back to running cursor-agent itself.
  const warmDir = process.platform === 'win32' ? undefined : process.env[CURSOR_WARM_DIR_ENV];
  const launch = warmDir
    ? {
      command: process.execPath,
      args: ['--no-warnings', '--no-deprecation', join(projectPath(), 'dist', 'cursor', 'warmAcpEntry.mjs'), 'connect', '--dir', warmDir, '--', command, 'acp'],
    }
    : { command, args: ['acp'] };

  try {
    await runAcp({
      credentials,
      agentName: 'cursor',
      command: launch.command,
      args: launch.args,
      startedBy,
      verbose,
      model,
      permissionMode,
      resumeAgentSessionId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isLikelyCursorAuthError(detail) && !detail.includes('cursor-agent login')) {
      throw new Error(`${detail}. ${CURSOR_AUTH_HINT}`);
    }
    throw error;
  }
}

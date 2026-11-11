import os from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Default command name for the Cursor CLI binary (`agent` alias is intentionally ignored). */
export const CURSOR_BIN = 'cursor-agent';

/**
 * Find the installed `cursor-agent` executable.
 *
 * `cursor-agent` installs to `~/.local/bin/cursor-agent`, which is frequently
 * absent from a daemon's PATH (launchd, systemd, or non-login shells).
 * Resolution order:
 *   1. `HAPPY_CURSOR_PATH` env override — an explicit path to the binary.
 *   2. `cursor-agent` already resolvable on PATH.
 *   3. `~/.local/bin/cursor-agent` — the Cursor CLI installer's default location.
 */
export function findCursorBin(): string | undefined {
  const override = process.env.HAPPY_CURSOR_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  try {
    const probe = process.platform === 'win32'
      ? `where ${CURSOR_BIN}`
      : `command -v ${CURSOR_BIN}`;
    execSync(probe, { stdio: 'ignore', windowsHide: true });
    return CURSOR_BIN;
  } catch {
    // not on PATH — fall through to the known install location
  }

  const localBin = join(os.homedir(), '.local', 'bin', CURSOR_BIN);
  if (existsSync(localBin)) {
    return localBin;
  }

  return undefined;
}

/**
 * Resolve the Cursor CLI executable to a spawnable command.
 */
export function resolveCursorBin(): string {
  return findCursorBin() ?? CURSOR_BIN;
}

/**
 * Heuristic check for whether an ACP startup/runtime failure looks like an
 * unauthenticated Cursor CLI session.
 */
export function isLikelyCursorAuthError(detail: string | null | undefined): boolean {
  if (!detail) {
    return false;
  }
  return /cursor_login|auth(?:entication)?\s*required|not\s+logged\s+in|unauthenticated|unauthorized|please\s+log\s*in|cursor-agent\s+login/i.test(
    detail,
  );
}

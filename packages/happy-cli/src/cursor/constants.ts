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

const CURSOR_SPURIOUS_STREAM_CLOSE_CHUNK_RE =
  /^\n\nError: (?:(?:RetriableError|WriteIterableClosedError|LostConnection): )?(?:cannot write, )?WritableIterable (?:is|already) closed$/;

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

/**
 * Detects the spurious trailing `agent_message_chunk` emitted by `cursor-agent acp`
 * (verified on `cursor-agent 2026.11.10-731fb78`) during ConnectRPC bidirectional
 * stream teardown after `turnEnded`:
 *
 *   1. Once `turnEnded` arrives and the server closes the stream, `streamSplitter.finally`
 *      closes the outbound `WritableIterable` wrapper while `ClientExecController` may
 *      still have an async write in flight, throwing `WritableIterable is closed`.
 *   2. Because `streamSplitter` always rejects first when `turnEnded` was NOT received,
 *      this error only escapes after `turnEnded` when no post-turn checkpoint suppressed
 *      handler errors (`ineligible_terminal_turn`).
 *   3. `cursor-agent` ACP omits `enableAgentRetries`, catches the wrapped `RetriableError`,
 *      and sends `\n\nError: RetriableError: WritableIterable is closed` as a single
 *      `agent_message_chunk` before returning `stopReason: "end_turn"`.
 */
export function isCursorSpuriousStreamCloseChunk(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  return CURSOR_SPURIOUS_STREAM_CLOSE_CHUNK_RE.test(text);
}

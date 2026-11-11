/**
 * Daemon-side Cursor speedups, started once per daemon:
 * - keep Cursor's team-managed hook scripts from blocking every tool call
 *   (`hookFdLeakFix.ts`);
 * - keep one `cursor-agent acp` warmed up for the next session (`warmAcp.ts`).
 *
 * Opt out with HAPPY_CURSOR_HOOK_FDFIX=0 / HAPPY_CURSOR_WARM=0.
 */

import { join } from 'node:path';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { findCursorBin } from './constants';
import { startCursorHookFdLeakFix } from './hookFdLeakFix';
import { CURSOR_WARM_DIR_ENV, cleanupStaleHosts, ensureWarmHost } from './warmAcp';

const ENSURE_INTERVAL_MS = 60_000;

export type CursorSpeedups = {
    /** Env to add to a Cursor session's spawn so it may use a warm agent. */
    warmEnv: Record<string, string>;
    stop: () => void;
};

export function startCursorSpeedups(): CursorSpeedups {
    const cursorBin = process.platform === 'win32' ? undefined : findCursorBin();
    if (!cursorBin) {
        return { warmEnv: {}, stop: () => {} };
    }

    const stopHookFix = process.env.HAPPY_CURSOR_HOOK_FDFIX === '0' ? () => {} : startCursorHookFdLeakFix();
    if (process.env.HAPPY_CURSOR_WARM === '0') {
        return { warmEnv: {}, stop: stopHookFix };
    }

    const pool = {
        dir: join(configuration.happyHomeDir, 'cursor-warm'),
        entryPath: join(projectPath(), 'dist', 'cursor', 'warmAcpEntry.mjs'),
        command: cursorBin,
        args: ['acp'],
    };
    const tick = async (): Promise<void> => {
        await cleanupStaleHosts(pool.dir);
        if (await ensureWarmHost(pool)) {
            logger.debug(`[cursor-warm] Started a warm cursor-agent host in ${pool.dir}`);
        }
    };
    const onError = (error: unknown): void => logger.debug('[cursor-warm] Failed to ensure a warm host:', error);
    void tick().catch(onError);
    const interval = setInterval(() => void tick().catch(onError), ENSURE_INTERVAL_MS);
    interval.unref();

    return {
        warmEnv: { [CURSOR_WARM_DIR_ENV]: pool.dir },
        stop: () => {
            clearInterval(interval);
            stopHookFix();
        },
    };
}

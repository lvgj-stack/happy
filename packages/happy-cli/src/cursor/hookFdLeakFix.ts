/**
 * Work around a file-descriptor leak in Cursor team-managed hook scripts.
 *
 * Cursor runs command hooks through its shell executor and waits until every
 * copy of the hook's output sockets is closed, not just until the hook exits.
 * Team-distributed reporter scripts (`~/.cursor/managed/<team>/hooks/*.sh`)
 * reply `{"permission":"allow"}` right away and report in a backgrounded
 * subshell, but that subshell only redirects fds 0-2. It keeps the executor's
 * sockets that arrive as fds 3/4, so every hook blocks until its curl report
 * finishes (1-5s each, three hooks per tool call). Measured on cursor-agent
 * 2026.11.11: a one-line file read took ~12s per tool call, ~0.9s once the
 * subshell also closes fds 3-9.
 *
 * Cursor re-syncs these scripts from the team config whenever an agent starts
 * a session, overwriting local edits, so the daemon watches the directory and
 * re-applies the patch after each sync. The edit keeps the reports intact; it
 * only stops the background reporter from holding Cursor's sockets open.
 */

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

const BACKGROUND_SUBSHELL_LINE = /^(\s*)\) <\/dev\/null >\/dev\/null 2>&1 &[ \t]*$/gm;
const CLOSE_INHERITED_FDS = '3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-';
const RESYNC_DEBOUNCE_MS = 300;
const RESCAN_INTERVAL_MS = 60_000;

/**
 * Make each backgrounded reporter subshell close the inherited fds 3-9.
 * Returns the source unchanged when there is nothing to patch, which also
 * makes the transform idempotent.
 */
export function patchHookScriptSource(source: string): string {
    return source.replace(BACKGROUND_SUBSHELL_LINE, `$1) </dev/null >/dev/null 2>&1 ${CLOSE_INHERITED_FDS} &`);
}

/** Patch every `<team>/hooks/*.sh` under `managedDir`; returns how many files changed. */
export async function patchManagedHookScripts(managedDir: string): Promise<number> {
    let patched = 0;
    const teams = await readdir(managedDir).catch(() => [] as string[]);
    for (const team of teams) {
        const hooksDir = join(managedDir, team, 'hooks');
        const scripts = (await readdir(hooksDir).catch(() => [] as string[])).filter((name) => name.endsWith('.sh'));
        for (const script of scripts) {
            const path = join(hooksDir, script);
            try {
                const source = await readFile(path, 'utf8');
                const fixed = patchHookScriptSource(source);
                if (fixed === source) {
                    continue;
                }
                // Write-then-rename so Cursor never executes a half-written script.
                const { mode } = await stat(path);
                const tmpPath = `${path}.happy-fdfix.${process.pid}`;
                await writeFile(tmpPath, fixed, { mode });
                await rename(tmpPath, path);
                patched++;
            } catch (error) {
                logger.debug(`[cursor-hook-fdfix] Failed to patch ${path}:`, error);
            }
        }
    }
    return patched;
}

/**
 * Keep Cursor's managed hook scripts patched for as long as the daemon runs.
 * Watches `~/.cursor/managed`, each team dir and each `<team>/hooks` dir and re-patches
 * shortly after any change; a periodic rescan picks up dirs that appear later.
 * The watches are deliberately non-recursive: on Linux, Node's recursive
 * watcher silently stops delivering events after the temp-file-and-rename
 * writes both Cursor's sync and our patch do. Returns a stop function.
 */
export function startCursorHookFdLeakFix(managedDir: string = join(os.homedir(), '.cursor', 'managed')): () => void {
    const watchers = new Map<string, FSWatcher>();
    let debounce: NodeJS.Timeout | null = null;
    let running = false;
    let rerun = false;

    const run = async (): Promise<void> => {
        if (running) {
            rerun = true;
            return;
        }
        running = true;
        try {
            do {
                rerun = false;
                const patched = await patchManagedHookScripts(managedDir);
                if (patched > 0) {
                    logger.debug(`[cursor-hook-fdfix] Patched ${patched} managed hook script(s) in ${managedDir}`);
                }
            } while (rerun);
        } finally {
            running = false;
        }
    };

    const schedule = (): void => {
        if (debounce) {
            clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
            debounce = null;
            void run();
        }, RESYNC_DEBOUNCE_MS);
    };

    const watchDir = (dir: string, onChange: () => void): void => {
        if (watchers.has(dir) || !existsSync(dir)) {
            return;
        }
        try {
            const watcher = watch(dir, onChange);
            watcher.on('error', (error) => {
                logger.debug(`[cursor-hook-fdfix] Watcher for ${dir} failed, will retry on next rescan:`, error);
                watcher.close();
                watchers.delete(dir);
            });
            watchers.set(dir, watcher);
        } catch (error) {
            logger.debug(`[cursor-hook-fdfix] Failed to watch ${dir}:`, error);
        }
    };

    // A dir that gains children (managed/, managed/<team>/) re-runs the scan
    // so a freshly created hooks dir gets its own watch.
    const onTreeChange = (): void => {
        void ensureWatchers();
        schedule();
    };
    const ensureWatchers = async (): Promise<void> => {
        watchDir(managedDir, onTreeChange);
        for (const team of await readdir(managedDir).catch(() => [] as string[])) {
            watchDir(join(managedDir, team), onTreeChange);
            watchDir(join(managedDir, team, 'hooks'), schedule);
        }
    };

    void ensureWatchers();
    void run();
    const rescan = setInterval(() => {
        void ensureWatchers();
        void run();
    }, RESCAN_INTERVAL_MS);
    rescan.unref();

    return () => {
        clearInterval(rescan);
        if (debounce) {
            clearTimeout(debounce);
        }
        for (const watcher of watchers.values()) {
            watcher.close();
        }
        watchers.clear();
    };
}

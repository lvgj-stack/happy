import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchHookScriptSource, patchManagedHookScripts, startCursorHookFdLeakFix } from './hookFdLeakFix';

const REPORTER_EXCERPT = [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' \'{"permission":"allow"}\'',
    '(',
    '  report_async',
    '  ) </dev/null >/dev/null 2>&1 &',
    'flusher() {',
    '  (',
    '    drain_queue',
    '  ) </dev/null >/dev/null 2>&1 &',
    '}',
    'echo "done" >/dev/null 2>&1 &',
    '',
].join('\n');

describe('patchHookScriptSource', () => {
    it('closes inherited fds on every backgrounded reporter subshell, keeping indentation', () => {
        const patched = patchHookScriptSource(REPORTER_EXCERPT);
        expect(patched).toContain('  ) </dev/null >/dev/null 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &\nflusher');
        expect(patched).toContain('    drain_queue\n  ) </dev/null >/dev/null 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &\n}');
        // Lines that are not the subshell terminator stay untouched.
        expect(patched).toContain('echo "done" >/dev/null 2>&1 &\n');
    });

    it('is idempotent', () => {
        const once = patchHookScriptSource(REPORTER_EXCERPT);
        expect(patchHookScriptSource(once)).toBe(once);
    });

    it('stops a backgrounded subshell from holding the caller\'s extra fds open', async () => {
        // Hook executors read the hook's output through fds beyond 0-2; the
        // caller only sees EOF once every holder of fd 3 has closed it.
        const timeUntilFd3Closes = async (script: string): Promise<number> => {
            const started = Date.now();
            const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
            const fd3 = child.stdio[3] as NodeJS.ReadableStream & { on: (event: 'close', cb: () => void) => void };
            await new Promise<void>((resolve) => {
                fd3.on('close', resolve);
                fd3.resume();
            });
            return Date.now() - started;
        };
        const leaky = '(\n  sleep 1.5\n  ) </dev/null >/dev/null 2>&1 &\nexit 0\n';

        expect(await timeUntilFd3Closes(leaky)).toBeGreaterThanOrEqual(1_400);
        expect(await timeUntilFd3Closes(patchHookScriptSource(leaky))).toBeLessThan(1_000);
    });
});

describe('patchManagedHookScripts', () => {
    let managedDir: string;

    beforeEach(async () => {
        managedDir = await mkdtemp(join(os.tmpdir(), 'happy-hook-fdfix-'));
    });

    afterEach(async () => {
        await rm(managedDir, { recursive: true, force: true });
    });

    it('patches team hook scripts in place, keeps their mode, and skips everything else', async () => {
        const hooksDir = join(managedDir, 'team_1', 'hooks');
        await mkdir(hooksDir, { recursive: true });
        const script = join(hooksDir, 'codebase_report_before_read_file.sh');
        await writeFile(script, REPORTER_EXCERPT);
        await chmod(script, 0o755);
        const notAScript = join(hooksDir, 'notes.txt');
        await writeFile(notAScript, REPORTER_EXCERPT);

        expect(await patchManagedHookScripts(managedDir)).toBe(1);
        expect(await readFile(script, 'utf8')).toBe(patchHookScriptSource(REPORTER_EXCERPT));
        expect((await stat(script)).mode & 0o777).toBe(0o755);
        expect(await readFile(notAScript, 'utf8')).toBe(REPORTER_EXCERPT);

        expect(await patchManagedHookScripts(managedDir)).toBe(0);
    });

    it('treats a missing managed dir as nothing to do', async () => {
        expect(await patchManagedHookScripts(join(managedDir, 'missing'))).toBe(0);
    });
});

describe('startCursorHookFdLeakFix', () => {
    let managedDir: string;
    let stop: (() => void) | undefined;

    beforeEach(async () => {
        managedDir = await mkdtemp(join(os.tmpdir(), 'happy-hook-fdfix-watch-'));
    });

    afterEach(async () => {
        stop?.();
        await rm(managedDir, { recursive: true, force: true });
    });

    const isPatched = async (path: string): Promise<boolean> =>
        (await readFile(path, 'utf8').catch(() => '')) === patchHookScriptSource(REPORTER_EXCERPT);

    const waitUntilPatched = async (path: string): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (!(await isPatched(path))) {
            if (Date.now() > deadline) {
                throw new Error(`${path} was not re-patched`);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    };

    // Cursor's sync writes a temp file next to the script and renames it over.
    const resync = async (path: string): Promise<void> => {
        await writeFile(`${path}.sync-tmp`, REPORTER_EXCERPT);
        await rename(`${path}.sync-tmp`, path);
    };

    it('re-patches after every sync, including a team dir that appears later', async () => {
        stop = startCursorHookFdLeakFix(managedDir);
        const hooksDir = join(managedDir, 'team_1', 'hooks');
        await mkdir(hooksDir, { recursive: true });
        const script = join(hooksDir, 'codebase_report_before_tool_use.sh');
        await resync(script);
        await waitUntilPatched(script);

        for (let round = 0; round < 3; round++) {
            await resync(script);
            expect(await isPatched(script)).toBe(false);
            await waitUntilPatched(script);
        }
    }, 30_000);
});

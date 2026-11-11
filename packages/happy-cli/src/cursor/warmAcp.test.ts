/**
 * Exercises the built warm host / connector processes against a fake ACP
 * agent. Needs `dist/` (the `test` script builds first).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPath } from '@/projectPath';
import { isPidAlive } from '@/daemon/sessionLiveness';
import { ensureWarmHost, spawnWarmHost } from './warmAcp';

const ENTRY = join(projectPath(), 'dist', 'cursor', 'warmAcpEntry.mjs');

// Minimal ACP agent: answers initialize/session/new and reports how many
// sessions it has created, so a test can tell a warm agent from a cold one.
const FAKE_AGENT = `
import { createInterface } from 'node:readline';
let sessions = 0;
process.stderr.write('fake-agent up\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method } = JSON.parse(line);
    if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (method === 'session/new') {
        sessions++;
        send({ method: 'session/update', params: { sessionId: 's' + sessions, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } });
        send({ id, result: { sessionId: 's' + sessions } });
    } else if (method === 'whoami') send({ id, result: { pid: process.pid, sessions } });
});
`;

const until = async (condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
};

const hostFiles = async (dir: string, suffix: string): Promise<number[]> =>
    (await readdir(dir)).filter((name) => name.endsWith(suffix)).map((name) => Number(name.slice(0, -suffix.length)));

/** Spawn a connector and give it a tiny JSON-RPC client. */
function startConnector(dir: string, agentPath: string) {
    const child = spawn(process.execPath, [ENTRY, 'connect', '--dir', dir, '--', process.execPath, agentPath]) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    let nextId = 100;
    const call = async (method: string): Promise<any> => {
        const id = nextId++;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
        let found: any;
        await until(async () => {
            found = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === id);
            return Boolean(found);
        });
        return found.result;
    };
    return { child, call, stderr: () => stderr };
}

describe('warm cursor-agent pool', () => {
    let root: string;
    let dir: string;
    let agentPath: string;
    const pidsToKill: number[] = [];

    beforeEach(async () => {
        root = await mkdtemp(join(os.tmpdir(), 'happy-cursor-warm-'));
        dir = root;
        agentPath = join(root, 'fake-agent.mjs');
        await writeFile(agentPath, FAKE_AGENT);
    });

    afterEach(async () => {
        for (const pid of pidsToKill.splice(0)) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // already gone
            }
        }
        for (const suffix of ['.warming', '.ready', '.claimed']) {
            for (const pid of await hostFiles(dir, suffix).catch(() => [])) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {
                    // already gone
                }
            }
        }
        await rm(root, { recursive: true, force: true });
    });

    it.each([
        ['a short pool dir', ''],
        ['a pool dir too deep for a unix socket path', 'd'.repeat(110)],
    ])('hands a warmed-up agent to a connector and cleans up when the session ends (%s)', async (_label, subdir) => {
        dir = join(dir, subdir);
        spawnWarmHost({ dir, entryPath: ENTRY, command: process.execPath, args: [agentPath] });
        await until(async () => (await hostFiles(dir, '.ready')).length === 1);
        const [hostPid] = await hostFiles(dir, '.ready');

        const connector = startConnector(dir, agentPath);
        pidsToKill.push(connector.child.pid!);
        await connector.call('initialize');
        const agent = await connector.call('whoami');

        // The warm-up session already exists: this is the pre-warmed agent.
        expect(agent.sessions).toBe(1);
        expect(await hostFiles(dir, '.claimed')).toEqual([hostPid]);
        await until(async () => connector.stderr().includes('fake-agent up'));
        expect(connector.stderr()).toContain(`attached to warm cursor-agent host ${hostPid}`);
        // Warm-up notifications never leak into the session's stream.
        expect(await connector.call('session/new')).toEqual({ sessionId: 's2' });

        connector.child.kill('SIGTERM');
        await until(async () => !isPidAlive(hostPid) && !isPidAlive(agent.pid));
        expect((await readdir(dir)).filter((name) => name.startsWith(`${hostPid}.`))).toEqual([]);
    }, 30_000);

    it('falls back to a cold agent when no host is ready, then warms one for next time', async () => {
        const connector = startConnector(dir, agentPath);
        pidsToKill.push(connector.child.pid!);
        await connector.call('initialize');
        expect((await connector.call('whoami')).sessions).toBe(0);
        expect(connector.stderr()).toContain('starting cold');

        await until(async () => (await hostFiles(dir, '.ready')).length === 1);
        connector.child.kill('SIGTERM');
    }, 30_000);

    it('does not start hosts again right after a warm-up failure', async () => {
        await writeFile(join(dir, 'failed'), '');
        expect(await ensureWarmHost({ dir, entryPath: ENTRY, command: process.execPath, args: [agentPath] })).toBe(false);
        expect(await hostFiles(dir, '.warming')).toEqual([]);
    });
});

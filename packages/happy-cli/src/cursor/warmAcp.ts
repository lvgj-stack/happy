/**
 * Pre-warmed `cursor-agent acp` processes for Happy Cursor sessions.
 *
 * A cold `cursor-agent acp` spends ~6s in its first `session/new` (server
 * config, team hook sync, shell snapshot...); later `session/new` calls in the
 * same process take ~1.3s, even for another cwd. So we keep one agent warmed
 * up ahead of time and hand it to the next session.
 *
 * The warm agent lives in a detached *host* process, not in the daemon, so a
 * daemon restart never cuts a running session's stdio. Pool layout under
 * `dir` (one host = one pid):
 *   <pid>.warming   host is starting the agent (counts as pending)
 *   <pid>.ready     agent finished initialize + a throwaway session/new
 *   <pid>.claimed   a session took it (atomic rename from .ready)
 *   <pid>.sock      host's unix socket (in the temp dir if `dir` is too deep)
 *   cwd/            throwaway cwd for the warm-up session
 *   failed          touched when a warm-up fails; pauses new hosts for a while
 *
 * A session's *connector* (the command AcpBackend spawns instead of
 * cursor-agent) claims a ready host, then opens two connections to its socket:
 * one tagged `O` for the JSON-RPC stdio stream and one tagged `E` for the
 * agent's stderr. When nothing is ready it runs cursor-agent itself, exactly
 * like the cold path. Either way it then starts a successor host so the next
 * session finds one.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, statSync, truncateSync } from 'node:fs';
import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { isPidAlive } from '@/daemon/sessionLiveness';
import { sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';

/** Env var the daemon sets on eligible Cursor sessions; its value is the pool dir. */
export const CURSOR_WARM_DIR_ENV = 'HAPPY_CURSOR_WARM_DIR';

const HOST_IDLE_TTL_MS = 30 * 60_000;
const WARMUP_TIMEOUT_MS = 90_000;
const CLAIM_CONNECT_TIMEOUT_MS = 10_000;
const SUCCESSOR_DELAY_MS = 5_000;
const KILL_GRACE_MS = 3_000;
const HOST_LOG_MAX_BYTES = 1_000_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;

type HostState = 'warming' | 'ready' | 'claimed';

const stateFile = (dir: string, pid: number, state: HostState): string => join(dir, `${pid}.${state}`);
/**
 * Unix socket paths are capped at ~104-108 bytes; fall back to a short,
 * pool-specific name in the temp dir when the pool dir is too deep.
 */
const socketFile = (dir: string, pid: number): string => {
    const inPool = join(dir, `${pid}.sock`);
    if (inPool.length <= 100) {
        return inPool;
    }
    const poolKey = createHash('sha1').update(dir).digest('hex').slice(0, 12);
    return join(os.tmpdir(), `happy-cw-${poolKey}-${pid}.sock`);
};

/** Hosts (by pid) currently in `state` whose process is still alive. */
async function listHosts(dir: string, state: HostState): Promise<number[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const suffix = `.${state}`;
    return names
        .filter((name) => name.endsWith(suffix))
        .map((name) => Number(name.slice(0, -suffix.length)))
        .filter((pid) => isPidAlive(pid));
}

/** Remove pool files left behind by hosts that are no longer running. */
export async function cleanupStaleHosts(dir: string): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
        const match = /^(\d+)\.(warming|ready|claimed|sock)$/.exec(name);
        const pid = Number(match?.[1]);
        if (match && !isPidAlive(pid)) {
            await rm(join(dir, name), { force: true });
            await rm(socketFile(dir, pid), { force: true });
        }
    }
}

/** Start a detached warm host. `entryPath` is the built warmAcpEntry module. */
export function spawnWarmHost(opts: { dir: string; entryPath: string; command: string; args: string[] }): void {
    mkdirSync(opts.dir, { recursive: true });
    const env = sanitizeSessionEnvironment(process.env);
    delete env[CURSOR_WARM_DIR_ENV];
    // A crash before the host's own logging is up still lands in host.log.
    const logFd = openSync(join(opts.dir, 'host.log'), 'a');
    try {
        const child = spawn(process.execPath, ['--no-warnings', '--no-deprecation', opts.entryPath, 'host', '--dir', opts.dir, '--', opts.command, ...opts.args], {
            detached: true,
            stdio: ['ignore', 'ignore', logFd],
            env,
        });
        child.unref();
    } finally {
        closeSync(logFd);
    }
}

/**
 * Spawn a host unless one is already warming or ready, or a warm-up failed
 * recently (e.g. cursor-agent is logged out). Returns whether it spawned.
 */
export async function ensureWarmHost(opts: { dir: string; entryPath: string; command: string; args: string[] }): Promise<boolean> {
    const lastFailure = await stat(join(opts.dir, 'failed')).then((info) => info.mtimeMs, () => 0);
    if (Date.now() - lastFailure < FAILURE_BACKOFF_MS) {
        return false;
    }
    const pending = [...await listHosts(opts.dir, 'warming'), ...await listHosts(opts.dir, 'ready')];
    if (pending.length > 0) {
        return false;
    }
    spawnWarmHost(opts);
    return true;
}

/** Newline-delimited JSON-RPC client used only for the host's warm-up calls. */
function createWarmupRpc(agent: ChildProcess) {
    let nextId = 1;
    let buffer = '';
    const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();

    const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) {
                continue;
            }
            let message: { id?: number | string; method?: string; result?: unknown; error?: unknown };
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            const resolve = typeof message.id === 'number' && !message.method ? pending.get(message.id) : undefined;
            if (resolve) {
                pending.delete(message.id as number);
                resolve(message);
            } else if (message.method && message.id !== undefined) {
                // No client is attached yet, so refuse agent->client requests.
                agent.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'No client attached' } }) + '\n');
            }
            // Notifications for the throwaway warm-up session are dropped.
        }
    };
    agent.stdout?.on('data', onData);

    return {
        call(method: string, params: unknown): Promise<unknown> {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result)));
                agent.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
        },
        /** Stop parsing and hand back any partial line still buffered. */
        detach(): string {
            agent.stdout?.off('data', onData);
            return buffer;
        },
    };
}

/** Host mode: warm up one agent, serve it to the first session that claims it, then exit. */
export async function runWarmHost(dir: string, command: string, args: string[]): Promise<void> {
    const pid = process.pid;
    const logFile = join(dir, 'host.log');
    try {
        if (statSync(logFile).size > HOST_LOG_MAX_BYTES) {
            truncateSync(logFile, 0);
        }
    } catch {
        // no log yet
    }
    const log = (text: string): void => {
        try {
            appendFileSync(logFile, `[${new Date().toISOString()}] host ${pid}: ${text}\n`);
        } catch {
            // logging is best effort
        }
    };

    const cwd = join(dir, 'cwd');
    mkdirSync(cwd, { recursive: true });
    await writeFile(stateFile(dir, pid, 'warming'), '');

    let agent: ChildProcess | null = null;
    let finished = false;
    const finish = async (reason: string, code = 0): Promise<never> => {
        if (!finished) {
            finished = true;
            log(`exit: ${reason}`);
            if (agent && agent.exitCode === null && agent.signalCode === null) {
                agent.kill('SIGTERM');
                setTimeout(() => agent?.kill('SIGKILL'), KILL_GRACE_MS).unref();
            }
            await Promise.all((['warming', 'ready', 'claimed'] as const).map((state) => rm(stateFile(dir, pid, state), { force: true })));
            await rm(socketFile(dir, pid), { force: true });
        }
        // Give SIGTERM a moment to land before the host disappears.
        setTimeout(() => process.exit(code), 200);
        return new Promise<never>(() => {});
    };

    process.on('uncaughtException', (error) => void finish(`uncaught: ${error.stack ?? error.message}`, 1));
    process.on('unhandledRejection', (reason) => void finish(`unhandled rejection: ${String(reason)}`, 1));
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        process.on(signal, () => void finish(`received ${signal}`));
    }

    const startedAt = Date.now();
    agent = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    agent.on('error', (error) => void finish(`agent spawn error: ${error.message}`, 1));
    // EPIPE after the agent dies; its 'exit' event does the cleanup.
    agent.stdin?.on('error', () => {});
    agent.on('exit', (code, signal) => void finish(`agent exited (code=${code}, signal=${signal})`, code ? 1 : 0));

    const stderrBacklog: Buffer[] = [];
    let stderrSink: Socket | null = null;
    agent.stderr?.on('data', (chunk: Buffer) => {
        if (stderrSink) {
            stderrSink.write(chunk);
        } else if (stderrBacklog.length < 64) {
            stderrBacklog.push(chunk);
        }
    });

    const rpc = createWarmupRpc(agent);
    const warmup = (async () => {
        await rpc.call('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            clientInfo: { name: 'happy-cli-warm', version: '1' },
        });
        await rpc.call('session/new', { cwd, mcpServers: [] });
    })();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('warm-up timed out')), WARMUP_TIMEOUT_MS).unref());
    try {
        await Promise.race([warmup, timeout]);
        await rm(join(dir, 'failed'), { force: true });
    } catch (error) {
        await writeFile(join(dir, 'failed'), '').catch(() => {});
        await finish(`warm-up failed: ${error instanceof Error ? error.message : String(error)}`, 1);
    }

    let stdioClient: Socket | null = null;
    let readyAt = 0;
    const server = createServer((socket) => {
        socket.once('data', (chunk: Buffer) => {
            const tag = String.fromCharCode(chunk[0]);
            const rest = chunk.subarray(1);
            if (tag === 'E' && !stderrSink) {
                stderrSink = socket;
                for (const backlog of stderrBacklog.splice(0)) {
                    socket.write(backlog);
                }
                socket.on('error', () => {});
                return;
            }
            if (tag !== 'O' || stdioClient || !agent?.stdin || !agent.stdout) {
                socket.destroy();
                return;
            }
            stdioClient = socket;
            log(`attached after ${Math.round((Date.now() - readyAt) / 1000)}s idle`);
            const leftover = rpc.detach();
            if (leftover) {
                socket.write(leftover);
            }
            if (rest.length > 0) {
                agent.stdin.write(rest);
            }
            agent.stdout.pipe(socket);
            socket.pipe(agent.stdin);
            socket.on('error', () => {});
            socket.on('close', () => void finish('client disconnected'));
        });
        socket.on('error', () => {});
    });
    await rm(socketFile(dir, pid), { force: true });
    await new Promise<void>((resolve) => server.listen(socketFile(dir, pid), resolve));

    readyAt = Date.now();
    await rename(stateFile(dir, pid, 'warming'), stateFile(dir, pid, 'ready'));
    log(`ready in ${((readyAt - startedAt) / 1000).toFixed(1)}s`);

    // Expire if nobody claims us. Renaming away `.ready` is what makes expiry
    // safe against a concurrent claim: whoever renames first wins.
    setTimeout(async () => {
        try {
            await rm(stateFile(dir, pid, 'ready'));
        } catch {
            return; // claimed in the meantime
        }
        await finish('idle ttl reached');
    }, HOST_IDLE_TTL_MS).unref();

    // A claim that never connects (connector crashed) must not leak the agent.
    const watchClaim = setInterval(async () => {
        const claimed = (await readdir(dir).catch(() => [] as string[])).includes(`${pid}.claimed`);
        if (claimed && !stdioClient) {
            clearInterval(watchClaim);
            setTimeout(() => {
                if (!stdioClient) {
                    void finish('claimed but never connected');
                }
            }, CLAIM_CONNECT_TIMEOUT_MS).unref();
        } else if (stdioClient) {
            clearInterval(watchClaim);
        }
    }, 1_000);
    watchClaim.unref();

    // Keep the event loop alive until finish() exits the process.
    await new Promise<never>(() => {});
}

function connect(path: string, tag: 'O' | 'E'): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(path);
        socket.once('connect', () => {
            socket.off('error', reject);
            socket.write(tag);
            resolve(socket);
        });
        socket.once('error', reject);
    });
}

/** Claim a ready host and open its stdio/stderr connections, or return null. */
async function claimWarmHost(dir: string): Promise<{ pid: number; stdio: Socket; stderr: Socket } | null> {
    for (const pid of await listHosts(dir, 'ready')) {
        try {
            await rename(stateFile(dir, pid, 'ready'), stateFile(dir, pid, 'claimed'));
        } catch {
            continue; // someone else claimed or it expired
        }
        try {
            const stderr = await connect(socketFile(dir, pid), 'E');
            const stdio = await connect(socketFile(dir, pid), 'O');
            return { pid, stdio, stderr };
        } catch {
            // Host vanished between listing and connecting; try the next one.
        }
    }
    return null;
}

/**
 * Connector mode: the process AcpBackend spawns in place of cursor-agent.
 * Bridges our stdio to a claimed warm host, or runs `command args` directly.
 * `entryPath` is the built entry module, used to start the successor host.
 */
export async function runWarmConnector(dir: string, entryPath: string, command: string, args: string[]): Promise<void> {
    const replenish = (): void => {
        setTimeout(() => {
            void ensureWarmHost({ dir, entryPath, command, args }).catch(() => {});
        }, SUCCESSOR_DELAY_MS).unref();
    };

    const claimed = await claimWarmHost(dir).catch(() => null);
    if (!claimed) {
        process.stderr.write(`[happy-warm] no warm cursor-agent ready, starting cold\n`);
        const agent = spawn(command, args, { stdio: 'inherit' });
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
            process.on(signal, () => agent.kill(signal));
        }
        agent.on('error', (error) => {
            process.stderr.write(`[happy-warm] failed to start ${command}: ${error.message}\n`);
            process.exit(1);
        });
        agent.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
        replenish();
        return;
    }

    process.stderr.write(`[happy-warm] attached to warm cursor-agent host ${claimed.pid}\n`);
    const { stdio, stderr } = claimed;
    stderr.pipe(process.stderr);
    stderr.on('error', () => {});
    process.stdin.pipe(stdio);
    stdio.pipe(process.stdout);
    stdio.on('error', () => process.exit(1));
    stdio.on('close', () => process.exit(0));
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        process.on(signal, () => {
            // Closing the socket makes the host kill its agent.
            stdio.destroy();
            stderr.destroy();
            process.exit(0);
        });
    }
    replenish();
}

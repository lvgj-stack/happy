#!/usr/bin/env node

/**
 * Install this workspace as the global `happy` binary for local development.
 *
 * Steps:
 *   1. build
 *   2. stop any running daemon (ignores failure)
 *   3. npm link (replaces the globally-installed `happy` with a symlink to this workspace)
 *   4. start the daemon again
 *   5. verify by running `happy --version`, and warn when `happy` on PATH
 *      still resolves to another install
 *
 * Steps 2, 4 and 5 run this workspace's own bin/happy.mjs, never whatever
 * `happy` PATH finds first: a daemon runs from the install that started it,
 * and so does every session it spawns. With a second global install ahead
 * on PATH (pnpm's, say), looking `happy` up would restart the old daemon.
 *
 * Reuses ~/.happy/ — no separate dev home dir. Auth and sessions carry over.
 * To undo: `npm unlink -g happy && npm i -g happy@latest`.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const IS_WINDOWS = process.platform === 'win32';
const HAPPY_BIN = path.join(PACKAGE_DIR, 'bin', 'happy.mjs');

function run(cmd, args, { allowFailure = false, env = process.env } = {}) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        stdio: 'inherit',
        env,
        // shell: true resolves `.cmd` shims on Windows so `pnpm` / `npm` / `happy` are found.
        shell: IS_WINDOWS,
    });
    if (result.error) {
        console.error(`Failed to spawn: ${label}`, result.error.message);
        if (!allowFailure) process.exit(1);
        return 1;
    }
    const status = result.status ?? 1;
    if (status !== 0 && !allowFailure) {
        console.error(`\nExit ${status}: ${label}`);
        process.exit(status);
    }
    return status;
}

function withoutWorkspaceBinPaths() {
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const inheritedPath = process.env[pathKey] ?? '';
    const cleanPath = inheritedPath
        .split(path.delimiter)
        .filter((entry) => !(
            entry.startsWith(`${WORKSPACE_ROOT}${path.sep}`)
            && entry.endsWith(`${path.sep}node_modules${path.sep}.bin`)
        ))
        .join(path.delimiter);
    return { ...process.env, [pathKey]: cleanPath };
}

/** Where `happy` on this PATH really runs from, links followed; null when it isn't found. */
function resolveHappyOnPath(env) {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const names = IS_WINDOWS ? ['happy.cmd', 'happy.ps1', 'happy'] : ['happy'];
    for (const dir of (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return fs.realpathSync(candidate);
            } catch {
                // Not here; keep looking down PATH.
            }
        }
    }
    return null;
}

run('pnpm', ['run', 'build']);
run(process.execPath, [HAPPY_BIN, 'daemon', 'stop'], { allowFailure: true });
run('npm', ['link']);
// pnpm prepends workspace node_modules/.bin to PATH for lifecycle scripts.
// A missing optional native agent package can leave a discoverable but broken
// local shim there, shadowing the user's working global Codex/Claude binary in
// every daemon-spawned session. The daemon should inherit the normal shell PATH.
const daemonEnvironment = withoutWorkspaceBinPaths();
run(process.execPath, [HAPPY_BIN, 'daemon', 'start'], { env: daemonEnvironment });
run(process.execPath, [HAPPY_BIN, '--version'], { env: daemonEnvironment });

console.log(`\n✓ Installed from ${PACKAGE_DIR}; the daemon runs this build.`);
// Windows resolves `happy` to npm's .cmd shim, which never links back here.
const onPath = IS_WINDOWS ? null : resolveHappyOnPath(daemonEnvironment);
if (!IS_WINDOWS && onPath !== HAPPY_BIN) {
    console.log(`\n⚠ \`happy\` on this PATH runs ${onPath ?? 'nothing'}, not this build.`);
    console.log('  Running `happy daemon start` from it would bring back the other install\'s daemon.');
    console.log('  Put the npm global bin first on PATH, or remove the other install once its sessions are done');
    console.log('  (installed with pnpm: `pnpm rm -g happy`).');
}
console.log('  To undo: npm unlink -g happy && npm i -g happy@latest');

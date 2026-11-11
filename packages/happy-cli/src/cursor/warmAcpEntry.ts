/**
 * Process entry for pre-warmed Cursor ACP agents (see `warmAcp.ts`).
 *
 *   warmAcpEntry host    --dir <pool> -- <command> [args...]
 *   warmAcpEntry connect --dir <pool> -- <command> [args...]
 */

import { fileURLToPath } from 'node:url';
import { runWarmConnector, runWarmHost } from './warmAcp';

const argv = process.argv.slice(2);
const mode = argv[0];
const dirIndex = argv.indexOf('--dir');
const separator = argv.indexOf('--');
const dir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
const [command, ...args] = separator >= 0 ? argv.slice(separator + 1) : [];

if (!dir || !command || (mode !== 'host' && mode !== 'connect')) {
    process.stderr.write('usage: warmAcpEntry <host|connect> --dir <pool> -- <command> [args...]\n');
    process.exit(2);
}

if (mode === 'host') {
    void runWarmHost(dir, command, args);
} else {
    void runWarmConnector(dir, fileURLToPath(import.meta.url), command, args);
}

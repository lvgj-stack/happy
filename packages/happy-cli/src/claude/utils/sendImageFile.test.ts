import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ApiSessionClient, LocalImageAttachment } from '@/api/apiSession';
import { MAX_SEND_IMAGE_BYTES, sendImageFile } from './sendImageFile';
import { startHappyServer } from './startHappyServer';

/** A PNG header announcing 640x480; the apps only need the bytes to be a picture. */
const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0, 8, 6, 0, 0, 0,
]);

function sessionRecordingImages(): { sent: LocalImageAttachment[]; client: ApiSessionClient } {
    const sent: LocalImageAttachment[] = [];
    const client = {
        sessionId: 'send-image-test',
        sendAgentImage: async (attachment: LocalImageAttachment) => {
            sent.push(attachment);
        },
    } as unknown as ApiSessionClient;
    return { sent, client };
}

describe('send_image', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'happy-send-image-'));
        await writeFile(join(dir, 'chart.png'), PNG);
        await writeFile(join(dir, 'notes.png'), 'these are words, whatever the name says');
        await writeFile(join(dir, 'huge.png'), PNG);
        await truncate(join(dir, 'huge.png'), MAX_SEND_IMAGE_BYTES + 1);
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('sends a picture with its type and size read from the bytes', async () => {
        const { sent, client } = sessionRecordingImages();

        expect(await sendImageFile(client, join(dir, 'chart.png')))
            .toEqual({ success: true, name: 'chart.png', width: 640, height: 480 });
        expect(sent).toEqual([{
            data: PNG,
            mimeType: 'image/png',
            name: 'chart.png',
            image: { width: 640, height: 480 },
        }]);
    });

    it('refuses what it cannot show, and says what to do', async () => {
        const { sent, client } = sessionRecordingImages();

        expect(await sendImageFile(client, 'chart.png'))
            .toMatchObject({ success: false, error: expect.stringContaining('absolute path') });
        expect(await sendImageFile(client, dir))
            .toMatchObject({ success: false, error: expect.stringContaining('not a file') });
        expect(await sendImageFile(client, join(dir, 'missing.png')))
            .toMatchObject({ success: false, error: expect.stringContaining('ENOENT') });
        expect(await sendImageFile(client, join(dir, 'notes.png')))
            .toMatchObject({ success: false, error: expect.stringContaining('not a PNG, JPEG, GIF or WebP') });
        expect(await sendImageFile(client, join(dir, 'huge.png')))
            .toMatchObject({ success: false, error: expect.stringContaining('limit is 10 MB') });
        expect(sent).toEqual([]);
    });

    it('reports a failed upload instead of claiming the picture was sent', async () => {
        const client = {
            sendAgentImage: async () => {
                throw new Error('Request failed with status code 413');
            },
        };

        expect(await sendImageFile(client, join(dir, 'chart.png')))
            .toEqual({ success: false, error: 'Request failed with status code 413' });
    });

    it('is a tool of the Happy MCP server', async () => {
        const { sent, client } = sessionRecordingImages();
        const server = await startHappyServer(client);
        const mcp = new Client({ name: 'send-image-test', version: '1.0.0' }, { capabilities: {} });

        try {
            expect(server.toolNames).toEqual(['change_title', 'send_image']);
            await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(['change_title', 'send_image']);

            const shown = await mcp.callTool({ name: 'send_image', arguments: { path: join(dir, 'chart.png') } });
            expect(shown.isError).toBe(false);
            expect(shown.content).toEqual([
                { type: 'text', text: 'Sent "chart.png" (640x480). The user now sees it in the chat.' },
            ]);
            expect(sent.map((attachment) => attachment.name)).toEqual(['chart.png']);

            const refused = await mcp.callTool({ name: 'send_image', arguments: { path: join(dir, 'notes.png') } });
            expect(refused.isError).toBe(true);
            expect(sent).toHaveLength(1);
        } finally {
            await mcp.close();
            server.stop();
        }
    });

    it('reaches Codex, Gemini and ACP agents through the STDIO bridge', async () => {
        const { sent, client } = sessionRecordingImages();
        const server = await startHappyServer(client);
        const mcp = new Client({ name: 'send-image-bridge-test', version: '1.0.0' }, { capabilities: {} });

        try {
            // The built bridge, as the agents launch it (the test run builds dist first).
            await mcp.connect(new StdioClientTransport({
                command: process.execPath,
                args: [
                    '--no-warnings',
                    '--no-deprecation',
                    fileURLToPath(new URL('../../../dist/codex/happyMcpStdioBridge.mjs', import.meta.url)),
                    '--url',
                    server.url,
                ],
            }));
            expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(['change_title', 'send_image']);

            const shown = await mcp.callTool({ name: 'send_image', arguments: { path: join(dir, 'chart.png') } });
            expect(shown.isError).toBe(false);
            expect(sent).toEqual([{
                data: PNG,
                mimeType: 'image/png',
                name: 'chart.png',
                image: { width: 640, height: 480 },
            }]);
        } finally {
            await mcp.close();
            server.stop();
        }
    });
});

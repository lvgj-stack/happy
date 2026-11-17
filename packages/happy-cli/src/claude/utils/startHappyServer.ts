/**
 * Happy MCP server
 * Provides Happy CLI specific tools: chat session title management, and
 * showing a picture from this machine in the chat (`send_image`).
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { sendImageFile, SendImageResult } from "./sendImageFile";
import { SEND_IMAGE_TOOL } from "./sendImageTool";

function createMcpServer(
    handler: (title: string) => Promise<{ success: boolean; error?: string }>,
    sendImage: (path: string) => Promise<SendImageResult>,
): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool(SEND_IMAGE_TOOL.name, {
        description: SEND_IMAGE_TOOL.description,
        title: SEND_IMAGE_TOOL.title,
        inputSchema: {
            path: z.string().describe(SEND_IMAGE_TOOL.pathDescription),
        },
    }, async (args) => {
        const response = await sendImage(args.path);
        logger.debug('[happyMCP] send_image:', response);

        const size = response.success && response.width && response.height ? ` (${response.width}x${response.height})` : '';
        return {
            content: [
                {
                    type: 'text',
                    text: response.success
                        ? `Sent "${response.name}"${size}. The user now sees it in the chat.`
                        : `Failed to send image: ${response.error}`,
                },
            ],
            isError: !response.success,
        };
    });

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handler, (path) => sendImageFile(client, path));
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', SEND_IMAGE_TOOL.name],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        }
    }
}

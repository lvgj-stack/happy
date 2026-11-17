/**
 * Shows a picture from this machine in the Happy chat.
 *
 * Behind the Happy MCP server's `send_image` tool: reads the file, checks
 * its bytes are a picture the apps can draw and that it fits the server's
 * attachment limit, then hands it to the session to encrypt, upload and post
 * as the agent. Every refusal says why, in words the agent can act on.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import { detectImage } from '@/utils/imageInfo';

/** The server takes 10 MB per attachment, counted after encryption (24-byte nonce, 16-byte tag). */
export const MAX_SEND_IMAGE_BYTES = 10 * 1024 * 1024 - 40;

export type SendImageResult =
    | { success: true; name: string; width?: number; height?: number }
    | { success: false; error: string };

export async function sendImageFile(
    client: Pick<ApiSessionClient, 'sendAgentImage'>,
    path: string,
): Promise<SendImageResult> {
    if (!isAbsolute(path)) {
        return { success: false, error: `"${path}" is not an absolute path. Pass the image's absolute path.` };
    }

    try {
        const info = await stat(path);
        if (!info.isFile()) {
            return { success: false, error: `"${path}" is not a file.` };
        }
        if (info.size > MAX_SEND_IMAGE_BYTES) {
            return {
                success: false,
                error: `The image is ${(info.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB. Resize or compress it and send it again.`,
            };
        }

        const data = new Uint8Array(await readFile(path));
        const image = detectImage(data);
        if (!image) {
            return {
                success: false,
                error: `"${path}" is not a PNG, JPEG, GIF or WebP image. Convert it to one of these (PNG for an SVG or a PDF page) and send that.`,
            };
        }

        const { mimeType, width, height } = image;
        const name = basename(path);
        await client.sendAgentImage({
            data,
            mimeType,
            name,
            ...(width && height ? { image: { width, height } } : {}),
        });
        return { success: true, name, width, height };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

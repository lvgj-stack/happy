/**
 * How the Happy MCP `send_image` tool describes itself to an agent.
 *
 * Kept free of imports: the HTTP server registers the tool, and the STDIO
 * bridge that fronts it for Codex, Gemini and ACP agents registers the same
 * words without loading the session client.
 */

export const SEND_IMAGE_TOOL = {
    name: 'send_image',
    title: 'Send Image',
    description: 'Show an image file from this machine to the user, inline in the Happy chat. The user is often on a phone and cannot open local files, so call this for any picture they should see: a chart or plot, a screenshot, a diagram, a generated image. PNG, JPEG, GIF or WebP, up to 10 MB. One call per image.',
    pathDescription: 'Absolute path of the image file on this machine',
} as const;

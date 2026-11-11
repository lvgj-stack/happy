import { HAPPY_SYSTEM_BLOCK_CLOSE, HAPPY_SYSTEM_BLOCK_OPEN } from '@/codex/codexPrompt';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { trimIdent } from '@/utils/trimIdent';

/**
 * Title instruction for Cursor ACP sessions.
 *
 * Mirrors Claude's system prompt ("ALWAYS when you start a new chat...") and
 * Codex's `<happy-system>` turn scaffolding, while naming both Cursor's dynamic
 * MCP tool namespace (`happy` -> `change_title` via GetDynamicTools /
 * CallDynamicTool) and direct MCP tool names (`mcp__happy__change_title`,
 * `functions.happy__change_title`).
 */
export const CURSOR_CHANGE_TITLE_INSTRUCTION = trimIdent(`
    ALWAYS when you start a new chat - you must call the "change_title" tool from the "happy" MCP server (if MCP tools are in dynamic namespaces, call GetDynamicTools for namespace "happy" and then CallDynamicTool with namespace "happy" and toolName "change_title"; otherwise call mcp__happy__change_title or functions.happy__change_title) to set a chat title that represents the current task. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a chance to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`);

function wrapHappySystem(text: string): string {
  return `${HAPPY_SYSTEM_BLOCK_OPEN}\n${text}\n${HAPPY_SYSTEM_BLOCK_CLOSE}`;
}

export function buildAcpTurnPrompt(opts: {
  message: string;
  appendSystemPrompt?: string;
  includeAppendSystemPrompt: boolean;
  includeTitleInstruction: boolean;
  isCursorAgent?: boolean;
}): string {
  const parts: string[] = [];

  if (opts.includeAppendSystemPrompt && opts.appendSystemPrompt) {
    parts.push(wrapHappySystem(opts.appendSystemPrompt));
  }

  parts.push(opts.message);

  if (opts.includeTitleInstruction) {
    const titleInstruction = opts.isCursorAgent
      ? CURSOR_CHANGE_TITLE_INSTRUCTION
      : CHANGE_TITLE_INSTRUCTION;
    parts.push(wrapHappySystem(titleInstruction));
  }

  return parts.join('\n\n');
}

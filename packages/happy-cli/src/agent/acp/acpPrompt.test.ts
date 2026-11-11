import { describe, expect, it } from 'vitest';

import { stripHappySystemBlocks } from '@/codex/codexPrompt';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { buildAcpTurnPrompt, CURSOR_CHANGE_TITLE_INSTRUCTION } from './acpPrompt';

const APPEND = '# Options\n\n<options><option>Yes</option></options>';
const wrapped = (text: string) => `<happy-system>\n${text}\n</happy-system>`;

describe('buildAcpTurnPrompt', () => {
  it('wraps appendSystemPrompt and Cursor change_title instruction on the first Cursor turn', () => {
    const prompt = buildAcpTurnPrompt({
      message: '为什么不会自动改名',
      appendSystemPrompt: APPEND,
      includeAppendSystemPrompt: true,
      includeTitleInstruction: true,
      isCursorAgent: true,
    });

    expect(prompt).toBe(
      `${wrapped(APPEND)}\n\n` +
      '为什么不会自动改名\n\n' +
      wrapped(CURSOR_CHANGE_TITLE_INSTRUCTION),
    );
    expect(stripHappySystemBlocks(prompt)).toBe('为什么不会自动改名');
  });

  it('injects Cursor change_title instruction even when appendSystemPrompt is omitted (e.g. web/terminal)', () => {
    const prompt = buildAcpTurnPrompt({
      message: '现在使用的是什么模型',
      includeAppendSystemPrompt: true,
      includeTitleInstruction: true,
      isCursorAgent: true,
    });

    expect(prompt).toBe(`现在使用的是什么模型\n\n${wrapped(CURSOR_CHANGE_TITLE_INSTRUCTION)}`);
    expect(stripHappySystemBlocks(prompt)).toBe('现在使用的是什么模型');
  });

  it('uses generic CHANGE_TITLE_INSTRUCTION for non-Cursor ACP agents', () => {
    const prompt = buildAcpTurnPrompt({
      message: 'Build a test plan',
      includeAppendSystemPrompt: true,
      includeTitleInstruction: true,
      isCursorAgent: false,
    });

    expect(prompt).toBe(`Build a test plan\n\n${wrapped(CHANGE_TITLE_INSTRUCTION)}`);
  });

  it('leaves normal follow-up turns untouched', () => {
    const prompt = buildAcpTurnPrompt({
      message: '继续下一步',
      appendSystemPrompt: APPEND,
      includeAppendSystemPrompt: false,
      includeTitleInstruction: false,
      isCursorAgent: true,
    });

    expect(prompt).toBe('继续下一步');
  });

  it('can re-inject appendSystemPrompt without title instruction after /clear reset', () => {
    const prompt = buildAcpTurnPrompt({
      message: '新话题',
      appendSystemPrompt: APPEND,
      includeAppendSystemPrompt: true,
      includeTitleInstruction: false,
      isCursorAgent: true,
    });

    expect(prompt).toBe(`${wrapped(APPEND)}\n\n新话题`);
  });
});

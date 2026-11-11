import { describe, expect, it } from 'vitest';
import { buildAcpPromptBlocks } from './AcpBackend';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5]);
const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

describe('buildAcpPromptBlocks', () => {
  it('sends text only when there are no images', () => {
    expect(buildAcpPromptBlocks('hi', [], true)).toEqual({
      blocks: [{ type: 'text', text: 'hi' }],
      skippedImages: 0,
    });
  });

  it('puts image blocks before the text, typed by their bytes', () => {
    const { blocks, skippedImages } = buildAcpPromptBlocks('what is this?', [
      { data: PNG, mimeType: 'image/jpeg', name: 'a.png' },
      { data: JPEG, mimeType: 'image/jpeg', name: 'b.jpg' },
    ], true);
    expect(skippedImages).toBe(0);
    expect(blocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') },
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from(JPEG).toString('base64') },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('skips images the agent cannot read', () => {
    const images = [{ data: PNG, mimeType: 'image/png', name: 'a.png' }];
    expect(buildAcpPromptBlocks('x', images, false)).toEqual({
      blocks: [{ type: 'text', text: 'x' }],
      skippedImages: 1,
    });
  });

  it('skips formats it does not recognise', () => {
    const images = [{ data: HEIC, mimeType: 'image/heic', name: 'a.heic' }];
    expect(buildAcpPromptBlocks('x', images, true)).toEqual({
      blocks: [{ type: 'text', text: 'x' }],
      skippedImages: 1,
    });
  });
});

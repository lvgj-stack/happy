import { describe, expect, it } from 'vitest';
import { detectImage } from './imageInfo';

function png(width: number, height: number): Uint8Array {
    const data = new Uint8Array(33);
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(data.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return data;
}

function ascii(text: string): number[] {
    return [...text].map((char) => char.charCodeAt(0));
}

describe('detectImage', () => {
    it('reads a PNG', () => {
        expect(detectImage(png(1200, 675))).toEqual({ mimeType: 'image/png', width: 1200, height: 675 });
    });

    it('reads a GIF', () => {
        const data = new Uint8Array([...ascii('GIF89a'), 0x40, 0x01, 0xf0, 0x00, 0, 0, 0]);
        expect(detectImage(data)).toEqual({ mimeType: 'image/gif', width: 320, height: 240 });
    });

    it('reads a JPEG whose size follows other segments', () => {
        const data = new Uint8Array([
            0xff, 0xd8,
            // APP0, 4 bytes of payload
            0xff, 0xe0, 0x00, 0x06, 1, 2, 3, 4,
            // DHT is not a frame header, though it sits in the SOF range
            0xff, 0xc4, 0x00, 0x04, 9, 9,
            // SOF2 (progressive): precision, height, width
            0xff, 0xc2, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0, 0, 0, 0,
        ]);
        expect(detectImage(data)).toEqual({ mimeType: 'image/jpeg', width: 800, height: 600 });
    });

    it('reads the three WebP layouts', () => {
        const riff = (chunk: string, body: number[]) => new Uint8Array([
            ...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 0, 0, 0, 0, ...body,
        ]);
        // Lossy: frame tag (3), start code (3), 14-bit width and height.
        expect(detectImage(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02])))
            .toEqual({ mimeType: 'image/webp', width: 800, height: 600 });
        // Lossless: 0x2f, then 14 bits of width-1 and 14 bits of height-1.
        expect(detectImage(riff('VP8L', [0x2f, 0x1f, 0xc3, 0x95, 0x00])))
            .toEqual({ mimeType: 'image/webp', width: 800, height: 600 });
        // Extended: flags (4), 24-bit width-1, 24-bit height-1.
        expect(detectImage(riff('VP8X', [0, 0, 0, 0, 0x1f, 0x03, 0x00, 0x57, 0x02, 0x00])))
            .toEqual({ mimeType: 'image/webp', width: 800, height: 600 });
    });

    it('still names the type when the size cannot be read', () => {
        expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ mimeType: 'image/jpeg' });
        expect(detectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])))
            .toEqual({ mimeType: 'image/png' });
    });

    it('refuses what is not a picture the apps can draw', () => {
        expect(detectImage(new Uint8Array())).toBeNull();
        expect(detectImage(new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBeNull();
        expect(detectImage(new Uint8Array(ascii('%PDF-1.7 not a picture')))).toBeNull();
    });
});

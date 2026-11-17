/**
 * Recognises a picture from its first bytes and reads its pixel size.
 *
 * Covers the formats both native apps draw: PNG, JPEG, GIF and WebP. The
 * type comes from the bytes, never from the file name, so a file that only
 * claims to be a picture is refused. The size is read from the header alone;
 * nothing is decoded.
 */

export type ImageInfo = {
    mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    width?: number;
    height?: number;
};

function startsWith(data: Uint8Array, bytes: number[], offset: number = 0): boolean {
    return data.length >= offset + bytes.length && bytes.every((byte, index) => data[offset + index] === byte);
}

function sized(mimeType: ImageInfo['mimeType'], width: number, height: number): ImageInfo {
    return width > 0 && height > 0 ? { mimeType, width, height } : { mimeType };
}

function readPng(data: Uint8Array, view: DataView): ImageInfo {
    // Signature (8), chunk length (4), "IHDR" (4), width (4), height (4).
    if (data.length < 24 || !startsWith(data, [0x49, 0x48, 0x44, 0x52], 12)) {
        return { mimeType: 'image/png' };
    }
    return sized('image/png', view.getUint32(16), view.getUint32(20));
}

function readGif(data: Uint8Array, view: DataView): ImageInfo {
    if (data.length < 10) {
        return { mimeType: 'image/gif' };
    }
    return sized('image/gif', view.getUint16(6, true), view.getUint16(8, true));
}

function readJpeg(data: Uint8Array, view: DataView): ImageInfo {
    let offset = 2;
    while (offset + 4 <= data.length && data[offset] === 0xff) {
        const marker = data[offset + 1];
        // Padding before a marker, and markers that carry no length.
        if (marker === 0xff) {
            offset += 1;
            continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            offset += 2;
            continue;
        }
        // End of image, or the start of the scan: no frame header ahead.
        if (marker === 0xd9 || marker === 0xda) {
            break;
        }
        // SOF0..SOF15 hold the size, except DHT (C4), JPG (C8) and DAC (CC).
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame && offset + 9 <= data.length) {
            return sized('image/jpeg', view.getUint16(offset + 7), view.getUint16(offset + 5));
        }
        offset += 2 + view.getUint16(offset + 2);
    }
    return { mimeType: 'image/jpeg' };
}

function readWebp(data: Uint8Array, view: DataView): ImageInfo {
    if (data.length >= 30 && startsWith(data, [0x56, 0x50, 0x38, 0x20], 12) && startsWith(data, [0x9d, 0x01, 0x2a], 23)) {
        return sized('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (data.length >= 25 && startsWith(data, [0x56, 0x50, 0x38, 0x4c], 12) && data[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (data.length >= 30 && startsWith(data, [0x56, 0x50, 0x38, 0x58], 12)) {
        const width = data[24] | (data[25] << 8) | (data[26] << 16);
        const height = data[27] | (data[28] << 8) | (data[29] << 16);
        return sized('image/webp', width + 1, height + 1);
    }
    return { mimeType: 'image/webp' };
}

/**
 * The picture's type and, when the header gives it, its size in pixels.
 * Null when the bytes are not a PNG, JPEG, GIF or WebP.
 */
export function detectImage(data: Uint8Array): ImageInfo | null {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return readPng(data, view);
    }
    if (startsWith(data, [0xff, 0xd8])) {
        return readJpeg(data, view);
    }
    if (startsWith(data, [0x47, 0x49, 0x46, 0x38]) && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) {
        return readGif(data, view);
    }
    if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
        return readWebp(data, view);
    }
    return null;
}

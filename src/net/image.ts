// Checks a downloaded or user-supplied logo before it is stored and embedded into the report. The format is decided
// by the file's own leading bytes (never by the server's headers or the file name); only raster formats a browser
// shows as a plain picture are accepted – SVG, HTML and anything else is refused (SVG can carry scripts).

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export const LOGO_MAX_BYTES = 100 * 1024;
const MIN_SIDE = 16;
const MAX_SIDE = 1024;

export type ImageCheck = { ok: true; mime: ImageMime; width: number; height: number } | { ok: false; reason: string };

const startsWith = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

function pngSize(b: Uint8Array): [number, number] | null {
  // signature, then the IHDR chunk must come first
  if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [(b[i + 7]! << 8) | b[i + 8]!, (b[i + 5]! << 8) | b[i + 6]!];
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8X') return [1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))];
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
  }
  if (chunk === 'VP8 ' && startsWith(b, [0x9d, 0x01, 0x2a], 23)) return [(b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff];
  return null;
}

/** Decides whether the bytes are a small PNG/JPEG/WebP picture; anything else is refused with a reason. */
export function inspectImage(b: Uint8Array): ImageCheck {
  if (b.length > LOGO_MAX_BYTES) return { ok: false, reason: `soubor je příliš velký (${b.length} B, nejvýš ${LOGO_MAX_BYTES} B)` };
  let mime: ImageMime;
  let size: [number, number] | null;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) [mime, size] = ['image/png', pngSize(b)];
  else if (startsWith(b, [0xff, 0xd8, 0xff])) [mime, size] = ['image/jpeg', jpegSize(b)];
  else if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') [mime, size] = ['image/webp', webpSize(b)];
  else return { ok: false, reason: 'není to obrázek PNG, JPEG ani WebP' };
  if (!size) return { ok: false, reason: 'poškozený obrázek (nejde přečíst rozměry)' };
  const [width, height] = size;
  if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) {
    return { ok: false, reason: `nečekané rozměry ${width}×${height} px (povoleno ${MIN_SIDE}–${MAX_SIDE} px)` };
  }
  return { ok: true, mime, width, height };
}

/** Data URI accepted by the report (also re-checked there before it is put into <img src>). */
export const LOGO_DATA_URI = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

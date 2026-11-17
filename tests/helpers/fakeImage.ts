/** Minimal PNG header (signature + IHDR with the given size) – enough for the format check in src/net/image.ts. */
export function fakePng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return new Uint8Array(b);
}

// Shared by Node (report build, tests) and the browser (report decryption).
// Uses only Web-standard APIs (WebCrypto, CompressionStream, atob/btoa) – no imports allowed here,
// the file is inlined into the HTML report.

export interface EncryptedPayload {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  /** base64(AES-256-GCM(gzip(utf8(json)))) */
  data: string;
}

export const PBKDF2_ITERATIONS = 600_000;

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function transform(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const piped = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encryptPayload(json: string, password: string, iterations = PBKDF2_ITERATIONS): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const packed = await transform(new TextEncoder().encode(json), new CompressionStream('gzip'));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(cipher) };
}

/** Throws (OperationError) when the password is wrong or the data was tampered with. */
export async function decryptPayload(payload: EncryptedPayload, password: string): Promise<string> {
  if (payload.v !== 1 || payload.kdf !== 'PBKDF2-SHA256') throw new Error('Nepodporovaný formát dat');
  const key = await deriveKey(password, fromBase64(payload.salt), payload.iter);
  const packed = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(payload.iv) }, key, fromBase64(payload.data)),
  );
  return new TextDecoder().decode(await transform(packed, new DecompressionStream('gzip')));
}

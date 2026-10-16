/**
 * Byte helpers shared by the export renderers.
 *
 * The renderer libraries hand back their output in whatever shape is convenient
 * for them — a pdfmake `Buffer`/`Uint8Array`, a docx base64 string, an
 * `ArrayBuffer` from `fetch`. The save layer wants exactly one shape, so the
 * conversion is written once here rather than in each renderer.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET[index]] = index;
  }
  return table;
})();

/**
 * Decode a base64 string to bytes without `atob`.
 *
 * `atob` is not guaranteed on Hermes and turns binary into a lossy string on
 * some engines; decoding by hand keeps a generated `.docx` byte-identical to the
 * one the library produced.
 */
export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  const length = clean.length;
  if (length === 0) return new Uint8Array(0);

  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const byteLength = (length / 4) * 3 - padding;
  const bytes = new Uint8Array(byteLength);

  let byteIndex = 0;
  for (let index = 0; index < length; index += 4) {
    const chunk =
      (BASE64_LOOKUP[clean[index]] << 18) |
      (BASE64_LOOKUP[clean[index + 1]] << 12) |
      ((BASE64_LOOKUP[clean[index + 2]] ?? 0) << 6) |
      (BASE64_LOOKUP[clean[index + 3]] ?? 0);

    bytes[byteIndex++] = (chunk >> 16) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = (chunk >> 8) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = chunk & 0xff;
  }

  return bytes;
}

/**
 * Normalise anything byte-like to a `Uint8Array` view.
 *
 * A `Uint8Array` is passed through unchanged (`saveFile` will slice it), an
 * `ArrayBuffer` is wrapped, and a numeric-array-like is copied.
 */
export function toBytes(value: Uint8Array | ArrayBuffer | ArrayLike<number>): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value as ArrayLike<number>);
}

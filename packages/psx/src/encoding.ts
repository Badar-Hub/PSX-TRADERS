/**
 * Decodes a file out of a PSX archive.
 *
 * The exchange is not consistent about text encoding between its own files, and
 * the difference is invisible until the data is wrong:
 *
 *   - `closing11.lis` (daily OHLCV) is plain ASCII/UTF-8.
 *   - `symbolname.lis` (symbol master) is UTF-16 **big-endian**, and repeats the
 *     byte-order mark before every single field rather than once at the start.
 *   - the price-band export is ASCII with bare CR line endings.
 *
 * Decoding the symbol master as UTF-8 does not throw. It yields a string with a
 * NUL between every character, so each symbol silently fails to match the price
 * file and the whole master list appears empty of anything useful. That class of
 * bug is why this is one shared function rather than a TextDecoder at each call
 * site.
 *
 * The repeated interior BOMs survive decoding as U+FEFF characters and are
 * stripped by the parsers, which treat them as field padding.
 */

export type ExchangeEncoding = 'utf-8' | 'utf-16be' | 'utf-16le';

export function detectEncoding(bytes: Uint8Array): ExchangeEncoding {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  }
  // A UTF-16 file without a BOM still gives itself away: ASCII content means
  // every other byte is NUL. Checking a prefix is enough to tell them apart.
  if (bytes.length >= 4) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 64));
    let evenNulls = 0;
    let oddNulls = 0;
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i] === 0x00) {
        if (i % 2 === 0) evenNulls += 1;
        else oddNulls += 1;
      }
    }
    const half = sample.length / 2;
    if (evenNulls > half * 0.6) return 'utf-16be';
    if (oddNulls > half * 0.6) return 'utf-16le';
  }
  return 'utf-8';
}

export function decodeExchangeText(bytes: Uint8Array): string {
  const encoding = detectEncoding(bytes);
  const text = new TextDecoder(encoding).decode(bytes);
  // Drop a leading BOM if the decoder left one; interior ones are the parsers'
  // business, since they sit inside fields.
  return text.startsWith('﻿') ? text.slice(1) : text;
}

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyListing, parseSymbolMaster } from '../src/parse/symbolNames.js';
import { decodeExchangeText, detectEncoding } from '../src/encoding.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const rawMaster = readFileSync(join(fixtures, 'symbolname-2026-10-20.lis'));
const rawClosing = readFileSync(join(fixtures, 'closing11-2026-10-20.lis'));

describe('exchange file encoding', () => {
  it('detects that the symbol master is UTF-16BE', () => {
    expect(detectEncoding(new Uint8Array(rawMaster))).toBe('utf-16be');
  });

  it('detects that the daily price file is UTF-8', () => {
    expect(detectEncoding(new Uint8Array(rawClosing))).toBe('utf-8');
  });

  /**
   * The failure this guards against is silent: decoding UTF-16 as UTF-8 does
   * not throw, it just puts a NUL between every character, and then no symbol
   * ever matches the price file.
   */
  it('produces usable text where a plain UTF-8 decode would not', () => {
    const correct = decodeExchangeText(new Uint8Array(rawMaster));
    expect(correct).toContain('Allied Bank Limited');

    const wrong = new TextDecoder('utf-8').decode(rawMaster);
    expect(wrong).not.toContain('Allied Bank Limited');
    expect(wrong).toContain('\u0000');
  });

  it('detects BOM-less UTF-16 from its null-byte pattern', () => {
    const beNoBom = new Uint8Array([0x00, 0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x44]);
    expect(detectEncoding(beNoBom)).toBe('utf-16be');
    const leNoBom = new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x44, 0x00]);
    expect(detectEncoding(leNoBom)).toBe('utf-16le');
  });
});

describe('parseSymbolMaster, against a real PSX file', () => {
  const result = parseSymbolMaster(decodeExchangeText(new Uint8Array(rawMaster)));

  it('reads the whole master list', () => {
    expect(result.records.length).toBe(1084);
  });

  /**
   * The file ends with a lone "|" on its own line, a trailing field separator
   * rather than a record. It is skipped and reported, so a real malformed row
   * appearing later would stand out instead of blending into a count.
   */
  it('reports the trailing separator line rather than silently dropping it', () => {
    expect(result.skippedLines).toEqual([1085]);
  });

  it('strips the BOM marks the exchange writes between fields', () => {
    for (const record of result.records) {
      expect(record.symbol).not.toMatch(/[﻿​]/);
      expect(record.fullName).not.toMatch(/[﻿​]/);
      expect(record.symbol).toBe(record.symbol.trim());
      expect(record.symbol.length).toBeGreaterThan(0);
    }
  });

  it('reads known entries', () => {
    expect(result.records.find((r) => r.symbol === 'ABL')?.fullName).toBe('Allied Bank Limited');
    expect(result.records.find((r) => r.symbol === '786')?.fullName).toBe(
      '786 Investments Limited',
    );
  });

  it('uppercases symbols so they join against the price file', () => {
    for (const record of result.records) {
      expect(record.symbol).toBe(record.symbol.toUpperCase());
    }
  });
});

describe('classifyListing', () => {
  const records = parseSymbolMaster(decodeExchangeText(new Uint8Array(rawMaster))).records;
  const bySymbol = new Map(records.map((r) => [r.symbol, r]));
  const classify = (symbol: string) => {
    const record = bySymbol.get(symbol);
    expect(record, `${symbol} missing from the fixture`).toBeDefined();
    return classifyListing(record!);
  };

  it('finds exactly the four rights issues the file names', () => {
    const rights = records.filter((r) => classifyListing(r).kind === 'RIGHT');
    expect(rights).toHaveLength(4);
  });

  it('recovers the parent ticker of a rights issue', () => {
    expect(classify('786R')).toEqual({ base: '786', kind: 'RIGHT' });
    expect(classify('AGICR2')).toEqual({ base: 'AGIC', kind: 'RIGHT' });
  });

  /**
   * The regression this locks down: a "ticker ends in R" rule called these
   * rights issues. They are a REIT and an ordinary listing.
   */
  it('does not mistake tickers ending in R for rights issues', () => {
    expect(classify('JSRR').kind).toBe('EQUITY');
    expect(classify('SRR').kind).toBe('EQUITY');
  });

  it('recognises ETFs and preference classes by name', () => {
    expect(classify('ACIETF').kind).toBe('ETF');
    expect(classify('AGLNCPS').kind).toBe('PREFERENCE');
  });

  it('groups a futures contract under its underlying', () => {
    expect(classify('AGHA-OCT')).toEqual({ base: 'AGHA', kind: 'FUTURE' });
    expect(classify('AGP-CDEC')).toEqual({ base: 'AGP', kind: 'FUTURE' });
    expect(classify('AGP-OCTB')).toEqual({ base: 'AGP', kind: 'FUTURE' });
  });

  it('leaves ordinary equities alone', () => {
    expect(classify('ABL')).toEqual({ base: 'ABL', kind: 'EQUITY' });
    expect(classify('HBL')).toEqual({ base: 'HBL', kind: 'EQUITY' });
    expect(classify('OGDC')).toEqual({ base: 'OGDC', kind: 'EQUITY' });
  });
});

/**
 * Parser for the PSX symbol master, `symbol_name/<YYYY-MM-DD>.zip`, whose single
 * entry `symbolname.lis` is pipe-delimited:
 *
 *   786|786 Invest Ltd|786 Investments Limited|
 *   SYM|SHORT NAME    |FULL NAME             |
 *
 * The exchange writes BOM and zero-width characters between fields in this file,
 * so stripping them is load-bearing rather than cosmetic: without it, symbols
 * arrive with an invisible prefix and never match anything.
 */

export interface PsxSymbolRecord {
  symbol: string;
  shortName: string;
  fullName: string;
}

export interface SymbolMaster {
  records: PsxSymbolRecord[];
  skippedLines: number[];
}

export type ListingKind = 'EQUITY' | 'RIGHT' | 'FUTURE' | 'ETF' | 'PREFERENCE';

export interface Listing {
  /** The underlying ticker this listing belongs to, for grouping in the UI. */
  base: string;
  kind: ListingKind;
}

/**
 * Classifies a listing using its company name rather than its ticker.
 *
 * A ticker suffix is the obvious-looking signal and it is wrong. "Ends in R"
 * would classify JSRR (JS Rental REIT), SRR, GTYR, HCAR and MACTER as rights
 * issues, and all of them are ordinary listings. What is unambiguous is the
 * parenthesised marker the exchange appends to the company name — "Waves Home
 * (R)", "EFU Life(R)" — which none of those twelve lookalikes carries.
 *
 * Both spellings are matched. The daily closing summary writes "(R)" and this
 * only looked for "(Right)", so against the files this app actually ingests the
 * test never fired: 18 rights letters were stored as ordinary equities, which
 * put them in the universe for predictions and into a market index they then
 * dominated. A rights letter trading at one paisa that closes at 76 is a
 * +7,500% day, and it is not a day the market had.
 *
 * The ticker is used only once the name has already established the kind, to
 * recover the parent ticker by stripping the rights suffix ("786R" to "786",
 * "AGICR2" to "AGIC").
 */
export function classifyListing(record: PsxSymbolRecord): Listing {
  const name = `${record.fullName} ${record.shortName}`;
  const symbol = record.symbol;

  if (/\(\s*(?:r|right|rights)\s*\)/i.test(name)) {
    const stripped = /^(.*?)R\d*$/.exec(symbol);
    const base = stripped?.[1];
    return { base: base !== undefined && base.length >= 2 ? base : symbol, kind: 'RIGHT' };
  }

  if (/\(etf\)/i.test(name)) return { base: symbol, kind: 'ETF' };

  if (/\(pref\)|\bnon-voting\b|\(pr\)/i.test(name)) return { base: symbol, kind: 'PREFERENCE' };

  const future = /^(.*?)-C?(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)B?$/i.exec(symbol);
  if (future?.[1] !== undefined) return { base: future[1], kind: 'FUTURE' };

  return { base: symbol, kind: 'EQUITY' };
}

export function parseSymbolMaster(content: string): SymbolMaster {
  const records: PsxSymbolRecord[] = [];
  const skippedLines: number[] = [];
  const lines = content.split(/\r\n|[\r\n]/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').replace(/[﻿​]/g, '').trim();
    if (line === '') continue;

    const fields = line.split('|').map((field) => field.replace(/[﻿​]/g, '').trim());
    const symbol = (fields[0] ?? '').toUpperCase();
    if (symbol === '' || fields.length < 3) {
      skippedLines.push(i + 1);
      continue;
    }

    records.push({
      symbol,
      shortName: fields[1] ?? '',
      fullName: fields[2] ?? '',
    });
  }

  return { records, skippedLines };
}

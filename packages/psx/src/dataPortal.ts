import { unzipSync } from 'fflate';
import {
  parseClosingSummary,
  type ClosingSummary,
  type ParseOptions,
  type PsxDailyBar,
} from './parse/closingSummary.js';
import { parseSymbolMaster, type PsxSymbolRecord } from './parse/symbolNames.js';
import { decodeExchangeText } from './encoding.js';

/**
 * Market data provider backed by the PSX Data Portal's official dated archive
 * files.
 *
 * Why these files and not the portal's JSON endpoints: the portal does expose
 * `/symbols` and `/timeseries/eod/<SYM>`, and they are tempting because they are
 * already JSON. But they are undocumented, unversioned, and sit behind bot
 * protection that answers a non-browser client with 403 or 404 while serving the
 * same request fine from a browser tab. Building the core of the product on them
 * means an outage every time that protection is tuned, and a terms-of-use
 * problem the moment the app is sold to anyone.
 *
 * The `/download/...` archive files, by contrast, are the exchange's own
 * published bulk exports: stable, dated, downloadable from a server without
 * special handling, and present back to at least 2018, which is enough history
 * to build indicators and to backtest a prediction engine against.
 *
 * Everything here sits behind MarketDataProvider so that swapping in a paid feed
 * later (for intraday ticks, or for the fundamentals these files do not carry)
 * touches this file and nothing else.
 */

export interface MarketDataProvider {
  readonly name: string;
  /** Resolves to null when the exchange published no file for that date. */
  fetchDailyBars(date: string, options?: ParseOptions): Promise<DailyBarsResult | null>;
  fetchSymbolMaster(date: string): Promise<PsxSymbolRecord[] | null>;
}

export interface DailyBarsResult {
  date: string;
  bars: PsxDailyBar[];
  summary: ClosingSummary;
  /** The archive exactly as downloaded, for keeping a local copy. */
  raw: Uint8Array;
}

export class PsxPortalError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface PsxDataPortalOptions {
  baseUrl?: string;
  /**
   * The portal rejects some non-browser clients. A browser user-agent is sent
   * because the archive files are public downloads and this is the same request
   * a person clicking the link would make.
   */
  userAgent?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts per request, for transient network and 5xx failures only. */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class PsxDataPortal implements MarketDataProvider {
  readonly name = 'psx-data-portal';

  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PsxDataPortalOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://dps.psx.com.pk/download').replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Daily OHLCV for every symbol on one trading date.
   *
   * Note the `.Z` extension on this one: the file is a ZIP regardless, holding a
   * single `closing11.lis` entry.
   */
  async fetchDailyBars(date: string, options?: ParseOptions): Promise<DailyBarsResult | null> {
    const raw = await this.download(`${this.baseUrl}/mkt_summary/${date}.Z`);
    if (raw === null) return null;

    const content = this.extractSingleEntry(raw, date, /closing.*\.lis$/i);
    // Defaults to equities: the file also carries futures, index futures and
    // government debt, none of which belong in an equity price history.
    const summary = parseClosingSummary(content, options ?? { segments: ['EQUITY'] });

    // The file names its own date on every row. If that disagrees with the date
    // requested, the portal has served something unexpected and silently
    // ingesting it would misdate a whole day of prices.
    if (summary.date !== null && summary.date !== date) {
      throw new PsxPortalError(
        `Archive for ${date} contains rows dated ${summary.date}; refusing to ingest`,
      );
    }

    return { date, bars: summary.bars, summary, raw };
  }

  async fetchSymbolMaster(date: string): Promise<PsxSymbolRecord[] | null> {
    const raw = await this.download(`${this.baseUrl}/symbol_name/${date}.zip`);
    if (raw === null) return null;
    const content = this.extractSingleEntry(raw, date, /symbolname.*\.lis$/i);
    return parseSymbolMaster(content).records;
  }

  /** Returns null on 404, which the portal uses for weekends and holidays. */
  private async download(url: string): Promise<Uint8Array | null> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': this.userAgent,
            Accept: '*/*',
          },
        });

        if (response.status === 404) return null;

        if (response.status === 403) {
          throw new PsxPortalError(
            `PSX refused the request for ${url} with 403. The archive files are ` +
              `normally served to any client; check the user-agent before assuming ` +
              `the file is missing.`,
            403,
          );
        }

        if (!response.ok) {
          throw new PsxPortalError(`PSX returned ${response.status} for ${url}`, response.status);
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        // A ZIP starts with "PK". An HTML error page served with status 200
        // would otherwise reach the unzip step as a confusing failure.
        if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
          throw new PsxPortalError(
            `Response for ${url} is not a ZIP archive (first bytes: ` +
              `${Array.from(bytes.slice(0, 4)).join(' ')}); the portal may have served an error page`,
          );
        }

        return bytes;
      } catch (error) {
        lastError = error;

        // A 403 or a malformed body will not fix itself on retry.
        const retriable =
          !(error instanceof PsxPortalError) ||
          (error.status !== undefined && error.status >= 500);
        if (!retriable || attempt === this.maxAttempts) break;

        await delay(500 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new PsxPortalError(`Failed to download ${url}: ${String(lastError)}`);
  }

  private extractSingleEntry(archive: Uint8Array, date: string, want: RegExp): string {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(archive);
    } catch (error) {
      throw new PsxPortalError(
        `Could not unzip the archive for ${date}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const names = Object.keys(entries);
    const matched = names.find((name) => want.test(name)) ?? names[0];
    if (matched === undefined) {
      throw new PsxPortalError(`Archive for ${date} is empty`);
    }

    const payload = entries[matched];
    if (payload === undefined) {
      throw new PsxPortalError(`Archive entry "${matched}" for ${date} could not be read`);
    }

    // Not a plain UTF-8 decode: the symbol master is UTF-16BE. See encoding.ts.
    return decodeExchangeText(payload);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

# psx-trader

Portfolio tracking, stop-loss and trailing-stop alerts, and explainable swing /
long-term predictions for the Pakistan Stock Exchange.

Built for personal use first, with a path to a commercial product.

> **Not investment advice.** This system produces signals and analysis from
> public data. It does not know anything about your circumstances, and its
> predictions are scored guesses that are tracked and reported as such.

## Status

| Area | State |
| --- | --- |
| Monorepo scaffold (pnpm + turbo) | done |
| `@psx/shared` — money, charges, domain types | done, 18 tests |
| `@psx/data` — PSX ingest, corporate actions | done, 44 tests, verified live |
| Database schema (tax lots, trades, rules) | next |
| Express API | not started |
| `@psx/engine` — indicators, candles, factor scoring | not started |
| Next.js dashboard | not started |
| Expo mobile app | not started |

## Getting started

```bash
pnpm install
pnpm infra:up          # Postgres on 5433, Redis on 6380
cp .env.example .env
pnpm test
```

To check the exchange feed is healthy right now:

```bash
pnpm --filter @psx/data check
```

## Architecture

```
packages/
  shared     Money (integer paisa), charge schedules, domain types. No I/O.
  psx        PSX Data Portal provider, file parsers, corporate-action detection.
  engine     (next) Indicators, candle patterns, factor scoring. Pure functions.
apps/
  api        (next) Express + Prisma. Owns the database and the job queue.
  web        (later) Next.js dashboard.
  mobile     (later) Expo.
```

Two rules hold the design together:

1. **`shared` and `engine` do no I/O.** Indicators and scoring are pure
   functions over arrays, which is what makes them testable, and testable is
   what makes a prediction worth trusting.
2. **Money is never a float.** It is an integer count of paisa, with a branded
   TypeScript type so a raw number cannot be passed where an amount belongs.
   See `packages/shared/src/money.ts` for why.

## Market data

PSX data is the hardest part of this project, so the findings are recorded here.

### What we use, and why

The PSX Data Portal exposes JSON endpoints (`/symbols`,
`/timeseries/eod/<SYM>`) that look like the obvious choice. They are not: they
are undocumented and sit behind bot protection that answers a server with 403
or 404 while serving the same request from a browser tab. Building on them
means an outage whenever that protection is tuned, plus a terms-of-use problem
once the app is sold.

Instead we use the exchange's own published bulk archive files under
`/download/...`. They are dated, stable, downloadable from a server with no
special handling, and present back to **at least 2018** — enough history to
compute indicators and to backtest the prediction engine.

| File | Contents |
| --- | --- |
| `mkt_summary/<date>.Z` | **Daily OHLCV for every symbol.** The primary price source. |
| `symbol_name/<date>.zip` | Symbol master: ticker, short name, full name. |
| `symbol_price/<date>.zip` | Circuit-breaker bands and last close. Not OHLCV. |
| `closing_rates/<date>.pdf` | Official closing rates, human-readable. |

A 404 means a non-trading day, so the provider returns `null` for it rather
than throwing. There is no machine-readable holiday calendar, so the trading
calendar is discovered this way.

### Things the files do that look like bugs

Each of these cost real time to find and is now locked down by a test.

**The OHLCV file has no header, and two of its fields are closing prices.**
`closing11.lis` inside `mkt_summary` is
`DATE|SYMBOL|SECTOR|NAME|OPEN|HIGH|LOW|CLOSE|VOLUME|LDCP`. Field 7 is this
day's close; field 9 is the previous day's. Reading them the wrong way round
shifts the entire price series by one day, and no test on a single file would
notice. The order is proven by chaining two consecutive days: the previous
close published on the 21st equals the close published on the 20th, for every
symbol.

**The file is not equity-only.** Of 1033 rows on 20 Oct 2026, only 497 were
equities; 507 were single-stock futures, 9 index futures and 20 government
debt instruments. They are told apart by the *sector code*, not the symbol:
equities carry a 4-digit code (`0807`), futures `40`, index futures `41`, debt
`36`. The provider filters to equities by default.

**The symbol master is UTF-16BE**, while the price file is UTF-8, and it
repeats the byte-order mark before every field. Decoding it as UTF-8 does not
throw — it just puts a NUL between every character, so no symbol ever matches
the price file and the list silently appears useless. `src/encoding.ts` detects
this.

**Line endings vary.** The summary uses LF; the price-band export uses bare CR.

**The close can sit outside the day's high/low.** On 20 Oct this affected 10
equities, every one of them trading between 1 and 80 shares. PSX computes its
official closing price by its own methodology rather than taking the last
trade, so this is the exchange's number and is kept, flagged, not "repaired".

### Corporate actions, for free

The LDCP field turns out to be a corporate-action feed. On an ordinary day it
equals the previous day's published close; on an ex-date it does not, because
the exchange marks the reference price down by the value of the entitlement.

Between 20 and 21 Oct 2026 this fired for 21 of 489 equities, and **every delta
was an exact multiple of Rs 0.25** (0.25 through 15.00), always downward —
which is how cash dividends are declared. `detectAdjustments()` reports these
as candidates for the user to confirm, so a dividend or bonus issue can never
silently corrupt a cost basis.

It distinguishes a split from a dividend by ratio, because half of a round
price is also a multiple of 25 paisa and would otherwise be reported as a Rs 50
dividend on a Rs 100 share. Where both readings fit (a 1.1x gap is equally a
10% bonus or a 9% dividend) the adjustment is marked `ambiguous` and the user
is asked rather than told.

### Still missing: fundamentals

The bulk files carry no EPS, ROE, P/E or debt figures, so the long-term
prediction factors have no input yet. Options are parsing
`/company/reports/<SYM>`, parsing annual-report PDFs, or a paid feed (Mettis
Global, Sarmaaya, Stocks.pk). The schema will carry fundamentals from the
start; technicals work without them.

## Charges and tax

`packages/shared/src/charges.ts` models brokerage, sales tax on brokerage, CDC,
SECP and CGT **as configuration, not constants**. Every one of those is
negotiable, provincial, or set by a finance act that changes.

**The default rates in that file are placeholders, not verified statutory
rates.** Set them from a real contract note before trusting any P&L figure. The
shape is the contract; the numbers are yours.

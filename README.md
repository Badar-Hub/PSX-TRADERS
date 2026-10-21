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
| `@psx/shared` — money, dates, charges, domain types | done, 18 tests |
| `@psx/data` — PSX ingest, corporate-action detection | done, 44 tests, verified live |
| `@psx/ledger` — tax lots, FIFO, cycles, buy-backs, P&L | done, 76 tests |
| Database schema (19 tables) | done, migrated |
| Express API — auth, portfolios, trades, positions, P&L | done, 136 tests |
| `@psx/engine` — indicators, candles, explainable scoring | done, 180 tests |
| Nightly ingest, signal endpoints, settling | done, live |
| `@psx/web` — Next.js dashboard | done, 17 tests |
| Expo mobile app | next |

505 tests, all passing. `pnpm test` runs them all. The integration tests need a
database and skip with a note when there isn't one.

**Live state of the local database:** 225 trading days (2025-11-25 to
2026-10-21), 533 securities, 109,099 bar rows, no gaps, 440 signals.

To see a prediction and its reasoning:

```bash
pnpm --filter @psx/engine explain PRL swing
```

## API

```
POST   /api/auth/register                         create an account (+ a "Main" portfolio)
POST   /api/auth/login
POST   /api/auth/refresh                          rotates the refresh token
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/portfolios
POST   /api/portfolios
GET    /api/portfolios/:id
PATCH  /api/portfolios/:id
GET    /api/portfolios/:id/positions              holdings, valued against the latest close
GET    /api/portfolios/:id/cycles                 round trips and buy-backs

POST   /api/portfolios/:id/trades                 record a trade
GET    /api/portfolios/:id/trades                 paginated, filterable
POST   /api/trades/:tradeId/reverse               cancel with a reversing entry

GET    /api/portfolios/:id/reports/pnl            defaults to the current tax year

GET    /api/securities/:symbol/signal             prediction + full factor table
POST   /api/securities/:symbol/signal/refresh     recompute now
GET    /api/signals/:id
GET    /api/signals/stats/accuracy                the engine's own hit rate
GET    /api/portfolios/:id/signals                a signal per holding
GET    /api/market/coverage                       what price history is present

GET    /health                                    liveness, no database touched
GET    /health/ready                              readiness, 503 when the database is down
```

Three conventions worth knowing:

**Amounts cross the wire as strings.** `"170.19"`, never the JSON number
170.19 — which is already 170.18999999999999 once parsed, and rounding it back
is guesswork. Responses return integer paisa.

**There is no `DELETE` for a trade.** The ledger is append-only, so a mistake
is cancelled by `POST /api/trades/:id/reverse`, which writes an opposing entry
and leaves both rows. That is what makes the history auditable later.

**Charges are optional on a trade.** Omit them and they are computed from the
portfolio's brokerage account; supply them and the figures from your contract
note are used verbatim, because reconciling against the broker matters more
than internal consistency.

Unowned resources return **404, not 403** — saying "forbidden" would confirm
that another user's portfolio exists.

## Getting started

```bash
pnpm install
cp .env.example .env                       # then set real JWT secrets
pnpm infra:up                              # Postgres on 5433, Redis on 6380
pnpm --filter @psx/api db:migrate          # create the tables
pnpm test
pnpm --filter @psx/api dev                 # api on :4000
```

`infra:up` needs Docker running. Without it everything still builds and the
unit tests pass; only the 38 integration tests skip.

Postgres is on **5433** and Redis on **6380**, offset from the defaults so this
never collides with another project's containers already using 5432/6379.

To check the exchange feed is healthy right now:

```bash
pnpm --filter @psx/data check
```

## Architecture

```
packages/
  shared     Money (integer paisa), dates, charge schedules, domain types. No I/O.
  psx        PSX Data Portal provider, file parsers, corporate-action detection.
  ledger     Tax lots, FIFO matching, position cycles, buy-backs, P&L. No I/O.
  engine     Indicators, candle patterns, explainable factor scoring. No I/O.
apps/
  api        Express, Prisma, the nightly job. Owns the database.
  web        Next.js dashboard. Talks to the API over HTTP only.
  mobile     (next) Expo.
```

Two rules hold the design together:

1. **`shared` and `engine` do no I/O.** Indicators and scoring are pure
   functions over arrays, which is what makes them testable, and testable is
   what makes a prediction worth trusting.
2. **Money is never a float.** It is an integer count of paisa, with a branded
   TypeScript type so a raw number cannot be passed where an amount belongs.
   See `packages/shared/src/money.ts` for why.

## The ledger

Two rules decide how every number in a portfolio is produced.

**The trade ledger is the only source of truth.** Trades are append-only: a
mistake is corrected with a reversing entry, never an `UPDATE`. Lots, realised
gains, positions and cycles are derived by replaying that ledger
(`packages/ledger/src/replay.ts`). They are stored as tables for query speed,
but the ledger wins any disagreement and a rebuild is always safe. That costs a
replay and buys the ability to answer "why is this number what it is" for any
figure in the app.

**Sales consume specific lots, not an average.** A gain is realised against the
particular shares disposed of, and PSX capital gains are assessed FIFO.
Collapsing a holding to one average cost throws away what is needed to compute
either the tax or an honest per-trade result, and it cannot be recovered later.
LIFO and average costing are implemented too, for comparison rather than for tax.

The invariant the package exists to protect: **for any lot, the basis consumed
by sales plus the basis still open equals the basis it opened with, to the
paisa, forever.** Every division of an amount goes through `allocatePaisa`,
which splits a total without losing or inventing a paisa. This is checked over
900 randomised trade histories with deliberately awkward share counts and odd
prices, asserting exact equality rather than approximate.

### Corporate actions

A bonus issue raises the share count with no cash changing hands. Unapplied,
the position looks as though it lost a tenth of its value per share overnight,
every later gain is computed against a basis spread over too few shares, and
the next sale of the full holding is rejected as a short because the ledger and
the registrar disagree. So:

- A bonus or split never changes total cost basis. The same money is spread
  over more shares, lowering the per-share cost.
- Entitlements are computed on the whole holding and then distributed. A 10%
  bonus on two lots of 75 issues 15 shares; flooring per lot would issue 14.
- A reverse split that rounds a small lot to nothing redistributes its basis
  rather than discarding it.
- A rights issue is a purchase, so it does raise the basis.
- Dividends are income, not a return of capital: the basis is untouched.

### Buy-backs

Recording a repurchase of something previously sold, because it is a decision
with an outcome no other figure captures. The realised gain shows what the exit
made; it says nothing about whether getting out and back in beat simply
holding. `advantage` answers that in rupees, and it is tracked for trims as
well as full exits:

> Sold ABL at 130.00, bought back at 110.00 after 31 days: 2,000.00 better off
> on 100 shares.

## Running it

```bash
pnpm --filter @psx/api backfill --days 330   # one-off, ~5 min, resumable
pnpm --filter @psx/api nightly               # schedule after the close
```

The nightly job does three things in order, because each depends on the last:
ingest the day's prices, recompute signals from the new history, then settle
any prediction whose horizon has now elapsed. A real run:

```
[nightly] ingest 2026-10-21: SUCCESS, 494 bars, 1 rows skipped, 14 warnings
[nightly] corporate action: PNSC went ex-dividend: reference price cut by Rs 10.00
[nightly] corporate action: FZCM went ex-entitlement: this reads either as a
          Rs 15.00 dividend or as a 1.05x bonus issue. Which was it?
[nightly] 21 action(s) recorded as DETECTED and awaiting confirmation
[nightly] signals: 440 computed, 4 refused
[nightly] settled 0: 0 hit, 0 missed, 0 neutral
[nightly] done in 15.3s
```

It is a plain script, not a queued worker. One run a day over a few hundred
symbols does not need Redis, a scheduler process or retry-with-backoff to be
reliable; it needs to be **idempotent**, which it is. Re-running a date replaces
that day's bars rather than duplicating or merging them, so a run that failed
halfway is fixed by running it again. A missing archive file is recorded as
`NO_FILE` and the run still succeeds — the exchange publishes nothing for
weekends and public holidays, and Pakistan's holidays include lunar-calendar
dates announced weeks ahead, so there is no calendar to validate against.

Detected corporate actions land as `DETECTED` and are **never applied
automatically**. The LDCP gap is strong evidence but not proof, the exchange's
announcements remain authoritative, and a mis-applied bonus issue corrupts a
cost basis silently. `rebuildProjection` refuses to run while a confirmed
action is unapplied, so a wrong share count cannot appear quietly.

## The dashboard

```bash
pnpm --filter @psx/api dev    # :4000
pnpm --filter @psx/web dev    # :3000
```

Four pages: positions, trades, P&L, and market data. The prediction view is the
one the engine exists for — the factor table with each contribution drawn from
a centre line, and selecting a factor marks on the chart the exact candles it
fired on.

**No token ever reaches the browser.** Both the access and refresh tokens live
in httpOnly cookies that JavaScript cannot read, every API call happens in a
server component or a server action, and the API's origin is never exposed to
the client. An access token in `localStorage` is readable by any script that
gets onto the page, and a refresh token there is a lasting account compromise.
The cost is that interactive data comes through a server action or a navigation
rather than a browser fetch, which for an app built on end-of-day prices is no
cost at all.

Token refresh happens in `middleware.ts` rather than in the API client, because
a server component can read cookies but cannot set them — so it has nowhere to
put a refreshed token. The middleware runs first and writes both cookies, which
matters because the API rotates refresh tokens: storing only the new access
token would leave the old refresh token to be replayed, and the API treats a
replay as a theft and drops every session.

**The UI never does arithmetic on money.** Amounts arrive as integer paisa and
are divided exactly once, in `lib/format.ts`, at the moment they become text.
Every total on screen is one the server computed, so a page cannot disagree
with the ledger. A missing value renders as an em dash rather than `0.00`,
because a holding with no price and a holding worth nothing are different facts.

## Predictions

Every prediction is a weighted sum of factors, and **each factor explains
itself**. The score and its explanation are produced by the same code from the
same numbers, so they cannot drift apart — which is what a narrative written
separately from the scoring eventually does.

```
factor                             observed           score  weight  contrib
----------------------------------------------------------------------------
Moving average alignment           20 > 50 > 200         85   12.8%     10.8
Candlestick patterns               Bearish engulfing   -100   10.6%    -10.6
MACD                               above signal          72   12.8%      9.2
RSI (14)                           RSI 57.0             -31   10.6%     -3.3
Volume against average             1.7x average         -30    9.6%     -2.9
Trend strength                     ADX 30                26   10.6%      2.8
...
                                              PRL: +7.7, HOLD, confidence 58%
```

Each factor carries the bars it fired on, so tapping one highlights exactly the
candles behind it.

### What makes it more than a shape matcher

**Candlestick patterns require context.** A hammer is a reversal at the bottom
of a decline; the same shape partway up a rally is a day with a long lower
wick. Every reversal pattern checks the trend it claims to reverse and stays
silent without it — which is why the engine fires on under 45% of days rather
than constantly. Strength is graded too: a body that engulfs the previous one
by a hair scores lower than one that swallows it whole.

**Missing data is not a neutral vote.** A factor with no data returns null, not
zero. Scoring zero would claim "neutral evidence"; null says "no evidence",
which is the truth when a company has no published earnings. Weights are
renormalised over the factors that reported, so a stock without fundamentals
gets a real answer from its price data instead of being dragged towards HOLD by
seven silent zeros. The cost is that such a signal is thinner than it looks,
so `missingFactors` and a coverage term in the confidence figure say how much.

**The engine refuses rather than guesses.** Under 30 sessions of history, or a
stock that traded on fewer than half of the last 20 sessions, returns a refusal
with a reason. On this exchange that matters: several hundred listings go days
without a trade, and indicators computed across those gaps describe the gaps. A
system that always produces an answer teaches you to ignore it.

**The two horizons genuinely differ.** Swing weights momentum, volume and
patterns; long term weights earnings, valuation and leverage. Same factors,
different lens, and a stock with a strong chart and poor accounts scores
differently on the two.

**Confidence measures the evidence, not the odds.** It is coverage times
agreement: how much of the model had data, and how closely those factors
agreed. It is explicitly not a probability of being right — `settleSignal`
scores past predictions against what happened, and that is the only honest
source of a hit rate.

### What the LLM costs

**Today: nothing.** `ANTHROPIC_API_KEY` is empty and nothing calls the API —
`summarise()` writes every explanation deterministically. The LLM pass is an
enhancement you can switch on, not a dependency.

Measured with `pnpm --filter @psx/engine narrative-cost`, which builds the real
prompt for every fixture symbol on both horizons:

```
input per narrative    727 tokens   (199 system + 528 factor table)
output per narrative   ~165 tokens
```

Monthly, at 30 days:

| Narratives/month | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
| --- | --- | --- | --- |
| 600 — lazy, ~20 views/day | $0.05 | $0.93 | $1.86 |
| 1,800 — 30-symbol watchlist nightly | $0.14 | $2.79 | $5.59 |
| 13,200 — all 440 signals nightly | $1.02 | $20.49 | $40.97 |

Batched (50% off, results within 24h), which suits a nightly job exactly.

**Cost does not scale with users.** Signals and their narratives are stored per
*security*, not per user — one row serves everybody. Covering the whole
tradeable PSX costs about **$1/month on Haiku batched** whether one person
reads it or ten thousand do. The per-user cost of this feature is effectively
zero; what scales is symbol coverage.

**Prompt caching does not help here**, which is worth knowing before reaching
for it. The shared prefix is only the 199-token system prompt, below the
512–4096-token minimum cacheable prefix, and the factor table that varies per
call is 73% of the input anyway.

### Narratives

`summarise()` writes the explanation deterministically from the factor table:
no API, no cost, no network. An LLM pass is an enhancement on top, and
`validateNarrative()` checks the result before it is stored — rejecting prose
that contradicts the score, invents a price target, or tells the reader what to
do. A failed or unavailable generation falls back to the deterministic text, so
an explanation is never missing.

That last rule is not only about quality. Telling someone to buy something is
investment advice, which has licensing implications in Pakistan; describing
what an analysis shows does not.

### Sanity-checking the output

On 21 Oct 2026 the 438 signals came out SELL 215, HOLD 163, BUY 55,
STRONG_BUY 4, STRONG_SELL 1. A near 4:1 bearish skew looks alarming until you
check the market it was describing: **387 of 513 symbols fell over the
preceding 20 sessions, median −5.1%**. The skew tracks reality rather than
revealing a tilt in the weights. This is the kind of check worth repeating
whenever the weights change.

### Still missing

- **Fundamentals have no source**, so long-term signals currently run on price
  data alone with eight or nine factors reporting as missing — which is why
  their confidence reads around 20% against the swing horizon's 50%. The schema
  and the factors are ready for them.
- **No index series**, so relative strength never reports. The KSE-100 is not
  in the daily OHLCV file and needs a separate source.
- **The weights are a considered prior, not a fitted model.** They were chosen
  from what each factor measures. Fitting them is what the prediction-outcome
  tracking is for: once a few hundred signals have been settled, the per-factor
  hit rate is evidence and these numbers can be revised against it. Nothing has
  settled yet — a swing horizon is 20 sessions.
- **Six signals from an early run are stranded.** They were computed for
  symbols that had stopped trading, so they carry a stale `asOf` and no later
  bars exist to settle them against. `liquidSymbols` now excludes such symbols;
  the old rows are harmless but will sit PENDING forever.

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

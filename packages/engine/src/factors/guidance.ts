/**
 * How each indicator is conventionally read, and what to watch next.
 *
 * ## What this is, and what it deliberately is not
 *
 * This answers "what do I do with this number" by explaining what the
 * indicator measures, how traders conventionally use it, and the specific
 * condition that would change its reading. It does not tell anyone to buy or
 * sell anything.
 *
 * That line is not squeamishness. Three reasons it is drawn exactly here:
 *
 * 1. **There is no evidence to recommend from.** Not one prediction has
 *    settled long enough to be scored, so the factor weights are a considered
 *    prior and nothing in this app has earned the right to say "sell". Telling
 *    someone to act on an untested model is worse than telling them nothing.
 *
 * 2. **It is regulated.** Advising on securities for a fee is a licensed
 *    activity in Pakistan, and this app is intended to be sold. "Here is what
 *    RSI measures and when it is usually treated as meaningful" is education;
 *    "sell LUCK" is advice, and the second one needs a licence the owner does
 *    not have.
 *
 * 3. **The app already refuses it elsewhere.** `validateNarrative` rejects
 *    prose containing "you should buy", "I recommend" or a price target, and
 *    the narrative prompt forbids telling the reader what to do. A guidance
 *    panel that did the opposite would make the product incoherent — and the
 *    validator would be the only honest part left.
 *
 * `watchFor` is the closest thing to actionable here, and it is the honest
 * kind: a condition, stated mechanically, that would change what the factor
 * says. "Watch for ADX above 25" is a fact about the indicator. "Buy when ADX
 * crosses 25" is a strategy nobody here has tested.
 *
 * The conventions below are textbook readings, widely used and widely
 * disputed. They describe what practitioners do, not what works.
 */

export interface FactorGuidance {
  /** What the indicator measures and how it is conventionally interpreted. */
  reads: string;
  /** The condition that would change this factor's reading. */
  watchFor: string;
  /** Where the convention is weakest or most often misapplied. */
  caveat: string;
}

export const FACTOR_GUIDANCE: Readonly<Record<string, FactorGuidance>> = {
  ema_alignment: {
    reads:
      'Whether the 20, 50 and 200-day averages are stacked in order. Bullish stacking ' +
      '(20 above 50 above 200) says short-term price is above medium, which is above ' +
      'long — the textbook picture of an established uptrend. Stacked the other way is the ' +
      'same statement about a downtrend. Traders use alignment as a filter rather than a ' +
      'trigger: it says which direction to be looking for trades in.',
    watchFor:
      'A crossing. The 20 crossing the 50 is the first of the three to move, so it is the ' +
      'earliest sign the stacking is breaking down.',
    caveat:
      'Moving averages are prices from the past, so alignment confirms a trend that has ' +
      'already happened. It is latest to turn at exactly the moments a turn matters most.',
  },

  price_vs_ema200: {
    reads:
      'How far price sits from its 200-day average, the most widely watched long-term line ' +
      'on any chart. Above it is conventionally treated as a bull market for that stock and ' +
      'below it a bear market, and many institutional mandates are written in those terms, ' +
      'which gives the level some of its own momentum.',
    watchFor:
      'Price crossing the line, and whether it holds. A cross that reverses within days is ' +
      'read very differently from one that sticks.',
    caveat:
      'The distance matters as much as the side. A stock 2% above its 200-day is a coin ' +
      'toss away from being below it, and treating that as a bull market is reading a ' +
      'rounding error.',
  },

  adx_strength: {
    reads:
      'How strongly a trend is trending, regardless of direction. ADX below 20 is ' +
      'conventionally read as no trend — a ranging market — and above 25 as a trend worth ' +
      'respecting. Its usual job is to decide whether to believe the other trend ' +
      'indicators at all.',
    watchFor:
      'ADX rising through 25, which is when trend-following readings are conventionally ' +
      'treated as meaningful, and falling back under 20, when they are not.',
    caveat:
      'ADX says nothing about direction. A high reading on a falling stock means the fall ' +
      'is well established, which is the opposite of good news.',
  },

  rsi_14: {
    reads:
      'Where price sits in its own recent range, 0 to 100. Above 70 is called overbought ' +
      'and below 30 oversold, and the textbook reading is that extremes tend to revert. ' +
      'The 40-60 middle is usually treated as carrying no information at all.',
    watchFor:
      'A move through 30 or 70. More useful to many traders is divergence: price making a ' +
      'new low while RSI does not, which is the classic early sign of a fall losing force.',
    caveat:
      'The most expensive misreading in technical analysis. A strong trend can hold RSI ' +
      'above 70 for months, and selling every overbought reading in a bull market means ' +
      'selling the whole bull market.',
  },

  macd: {
    reads:
      'The gap between two moving averages, and whether that gap is widening. Above its ' +
      'signal line is conventionally read as momentum turning up, below as down. It is a ' +
      'momentum indicator built from trend components, so it turns earlier than the ' +
      'averages themselves.',
    watchFor:
      'The crossing, and whether it happens above or below zero. A bullish cross below ' +
      'zero is conventionally treated as weaker than one above it.',
    caveat:
      'In a sideways market MACD crosses constantly and means nothing each time. Pair it ' +
      'with the trend-strength reading before giving a cross any weight.',
  },

  roc_20: {
    reads:
      'Plain percentage change over the last twenty sessions — roughly a trading month. ' +
      'Used as a momentum check: strength tends to persist over weeks more often than it ' +
      'reverses, which is the whole basis of momentum trading.',
    watchFor:
      'The sign flipping, and the size shrinking while still positive, which says a rise ' +
      'is decelerating before it turns.',
    caveat:
      'Twenty sessions is an arbitrary window, and a single large day near its start or ' +
      'end moves the figure sharply for reasons that have nothing to do with the present.',
  },

  bollinger_position: {
    reads:
      'Where price sits within two standard deviations of its 20-day average, and how wide ' +
      'that envelope is. Near the upper band means a stretched move; a narrow envelope — ' +
      'a "squeeze" — says volatility has contracted, which conventionally precedes an ' +
      'expansion in one direction or the other.',
    watchFor:
      'The bands widening after a squeeze, which is the move beginning. Also price closing ' +
      'outside a band, which is rare and usually brief.',
    caveat:
      'A squeeze is directionless. It says a larger move is likelier, not which way, and ' +
      'trading one as though it were bullish is reading something that is not there.',
  },

  atr_percent: {
    reads:
      'How much the stock moves on an average day, as a percentage of its price. Not ' +
      'directional at all. Its real use is sizing: a stop two or three ATR away adapts to ' +
      'the stock, where a flat 5% is far too tight on a volatile small cap and far too ' +
      'loose on a utility.',
    watchFor:
      'ATR rising sharply, which usually accompanies a breakout or bad news, and means any ' +
      'fixed stop just became tighter in practical terms.',
    caveat:
      'Low volatility is not safety. It is a measure of recent movement, and it is lowest ' +
      'immediately before the moves nobody saw coming.',
  },

  volume_ratio: {
    reads:
      'The day’s volume against its recent average. Conventionally used to judge whether ' +
      'a price move was backed by participation: a breakout on heavy volume is treated as ' +
      'more credible than the same breakout on thin volume.',
    watchFor:
      'Volume well above average on a day price moves, which is the combination that ' +
      'carries information. Either alone carries much less.',
    caveat:
      'Volume has no direction. A huge day can be accumulation or capitulation, and the ' +
      'figure alone cannot tell you which.',
  },

  obv_trend: {
    reads:
      'Volume added on up days and subtracted on down days, accumulated. Rising says ' +
      'buying is concentrated on advances — accumulation; falling says selling is ' +
      'concentrated on declines — distribution. Used to check whether a price trend has ' +
      'participation behind it.',
    watchFor:
      'Divergence, which is what this indicator is for: price making new highs while OBV ' +
      'does not, meaning the advance is running on less and less volume.',
    caveat:
      'It treats a 0.1% up day and a 10% up day identically, since only the sign of the ' +
      'move decides the sign of the volume. That makes it crude on choppy series.',
  },

  candlestick: {
    reads:
      'Named single and multi-bar formations — engulfing bars, hammers, stars — each with ' +
      'a conventional reading about a short-term reversal or continuation. Where the ' +
      'pattern appears matters more than the pattern: a hammer at a support level is ' +
      'treated quite differently from the same shape mid-range.',
    watchFor:
      'The next one or two bars. A pattern that is not confirmed by what follows is ' +
      'conventionally treated as having failed.',
    caveat:
      'The weakest evidence on this page. Patterns are frequent, their definitions vary ' +
      'between sources, and most published support for them does not survive careful ' +
      'testing. Weighted lightly here for that reason.',
  },

  relative_strength: {
    reads:
      'Whether the stock is outperforming the wider market. The conventional use is to ' +
      'separate a stock that is rising because everything is rising from one that is ' +
      'rising on its own account.',
    watchFor:
      'Nothing yet. This factor cannot report, because the exchange’s bulk archive ' +
      'publishes no index level for it to compare against, so it is one of the factors ' +
      'counted as unavailable on every prediction.',
    caveat:
      'Its absence is why coverage never reaches 100% here. It would need a licensed index ' +
      'feed.',
  },

  pe_vs_sector: {
    reads:
      'Earnings multiple against the stock’s own sector rather than the whole market, ' +
      'since multiples differ enormously between a bank and a cement maker. Cheaper than ' +
      'peers is conventionally read as value, dearer as the market expecting more growth.',
    watchFor:
      'The earnings half of the ratio, not the price half. A multiple that fell because ' +
      'earnings rose is a different thing from one that fell because price did.',
    caveat:
      'Cheap against peers is often cheap for a reason the ratio cannot see. Value and ' +
      'distress look identical on this measure.',
  },

  price_to_book: {
    reads:
      'Price against the accounting value of the company’s net assets. Most meaningful ' +
      'for banks and asset-heavy businesses, where book value is close to something real.',
    watchFor:
      'Book value being restated, which happens on revaluation and writedowns and moves ' +
      'the ratio without price moving at all.',
    caveat:
      'Nearly meaningless for a company whose value is people or brand, where the balance ' +
      'sheet records almost nothing of what the business is worth.',
  },

  dividend_yield: {
    reads:
      'Dividend against price. On the PSX this carries more weight than in many markets, ' +
      'since a large part of the local investor base holds for income.',
    watchFor:
      'Whether the payout is covered by earnings. An unusually high yield is frequently a ' +
      'price that has fallen in anticipation of the dividend being cut.',
    caveat:
      'A trailing yield describes a dividend already paid. It is not a promise of the next ' +
      'one.',
  },

  eps_growth: {
    reads:
      'Direction and pace of earnings per share. Conventionally the single most watched ' +
      'fundamental number, on the reasoning that price follows earnings over long periods.',
    watchFor:
      'Growth decelerating while still positive, which markets tend to reprice well before ' +
      'growth actually turns negative.',
    caveat:
      'Per-share figures move on buybacks and issuance as well as on profit. Check which ' +
      'one did the moving.',
  },

  revenue_growth: {
    reads:
      'Top-line growth, harder to flatter with accounting choices than earnings. Used as a ' +
      'check on whether earnings growth is coming from the business or from cost-cutting.',
    watchFor:
      'Revenue and earnings moving apart in either direction, which is where margins are ' +
      'changing and the interesting questions are.',
    caveat:
      'In an economy with high inflation, nominal revenue growth can be entirely price ' +
      'rather than volume — which matters a great deal in Pakistan.',
  },

  roe: {
    reads:
      'Profit against shareholders’ equity: how well the company turns the capital it ' +
      'holds into earnings. Conventionally used as a quality measure, with persistently ' +
      'high ROE taken as a sign of durable advantage.',
    watchFor:
      'ROE rising while debt rises too, which is leverage flattering the figure rather ' +
      'than the business improving.',
    caveat:
      'Equity is a denominator that can be shrunk. Buybacks and writedowns both raise ROE ' +
      'without anything about the business getting better.',
  },

  debt_to_equity: {
    reads:
      'How much of the business is funded by borrowing. Conventionally read as risk: ' +
      'leverage amplifies both directions, and heavily indebted companies are the ones ' +
      'that struggle when rates rise.',
    watchFor:
      'The direction of travel and the cost of the debt, which matter more than the level. ' +
      'Pakistani policy rates have moved sharply, and the same leverage is a different ' +
      'burden at different rates.',
    caveat:
      'Normal leverage differs hugely by industry. A utility and a software company at the ' +
      'same ratio are not comparably risky.',
  },
};

/** Guidance for one factor, or null when none is written for it. */
export function guidanceFor(key: string): FactorGuidance | null {
  return FACTOR_GUIDANCE[key] ?? null;
}

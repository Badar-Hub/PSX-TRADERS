/**
 * Display formatting.
 *
 * The API speaks in integer paisa, so every amount that reaches a component is
 * a whole number of paisa and is divided only here, at the moment it becomes
 * text. Nothing in the UI does arithmetic on money: a total shown on screen is
 * always one the server computed, so the app cannot disagree with the ledger.
 *
 * The web app's equivalent uses `Intl.NumberFormat('en-PK')`. This one groups
 * digits by hand, because Hermes ships without the full ICU locale data on
 * Android unless the build opts in, and a missing locale degrades silently to
 * a differently grouped string rather than throwing. Money that renders one
 * way on iOS and another on Android is not worth the convenience.
 */

const GROUP = /\B(?=(\d{3})+(?!\d))/g;

function withGroups(digits: string): string {
  return digits.replace(GROUP, ',');
}

/**
 * Paisa to "1,234.56", unsigned.
 *
 * Rounded to a whole paisa first. Everything in the ledger is an integer, but
 * a figure derived on the way out of the API can arrive as 40027.999999999996,
 * and splitting that on the hundreds would print "400.27.999999999996" — a
 * formatter that turns odd input into nonsense is worse than one that rounds.
 */
function paisaToDecimal(paisa: number): string {
  const rounded = Math.round(Math.abs(paisa));
  const whole = Math.trunc(rounded / 100);
  const fraction = rounded % 100;
  return `${withGroups(String(whole))}.${String(fraction).padStart(2, '0')}`;
}

export function money(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  return `${paisa < 0 ? '−' : ''}${paisaToDecimal(paisa)}`;
}

export function rupees(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  return `${paisa < 0 ? '−' : ''}Rs ${paisaToDecimal(paisa)}`;
}

/** Paisa to "Rs 1.2M", for figures where the exact paisa is noise. */
export function rupeesCompact(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  const sign = paisa < 0 ? '−' : '';
  const value = Math.abs(paisa) / 100;

  // Crore and lakh would be the local idiom, but the rest of the app and the
  // PSX's own figures read in millions, so the two stay consistent.
  if (value >= 1_000_000_000) return `${sign}Rs ${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${sign}Rs ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${sign}Rs ${(value / 1_000).toFixed(1)}K`;
  return `${sign}Rs ${value.toFixed(0)}`;
}

/** Paisa with an explicit sign, for a gain or loss. */
export function signedRupees(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  const sign = paisa > 0 ? '+' : paisa < 0 ? '−' : '';
  return `${sign}Rs ${paisaToDecimal(paisa)}`;
}

/** Basis points to "+12.3%". */
export function percentFromBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  const value = bps / 100;
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;
}

export function percent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function shares(count: number): string {
  return withGroups(String(Math.trunc(count)));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-21" to "21 Oct 2026". */
export function shortDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  if (name === undefined) return iso;
  return `${Number(day)} ${name} ${year}`;
}

/** "in 9 minutes", for the verification code's remaining life. */
export function countdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'expired';
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function actionLabel(action: string): string {
  return action
    .replace('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const CATEGORY_LABELS: Record<string, string> = {
  TREND: 'Trend',
  MOMENTUM: 'Momentum',
  VOLATILITY: 'Volatility',
  VOLUME: 'Volume',
  PATTERN: 'Candlestick patterns',
  VALUATION: 'Valuation',
  GROWTH: 'Growth',
  QUALITY: 'Quality',
  LEVERAGE: 'Leverage',
  MARKET: 'Market',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * Display formatting.
 *
 * The API speaks in integer paisa, so every amount that reaches a component is
 * a whole number of paisa and is divided only here, at the moment it becomes
 * text. Nothing in the UI does arithmetic on money: a total shown on screen is
 * always one the server computed, so the page cannot disagree with the ledger.
 */

const pkr = new Intl.NumberFormat('en-PK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const pkrCompact = new Intl.NumberFormat('en-PK', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Paisa to "1,234.56". */
export function money(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  return pkr.format(paisa / 100);
}

/** Paisa to "Rs 1,234.56". */
export function rupees(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  return `Rs ${pkr.format(paisa / 100)}`;
}

/** Paisa to "Rs 1.2M", for figures where the exact paisa is noise. */
export function rupeesCompact(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  return `Rs ${pkrCompact.format(paisa / 100)}`;
}

/** Paisa with an explicit sign, for a gain or loss. */
export function signedRupees(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  const sign = paisa > 0 ? '+' : paisa < 0 ? '−' : '';
  return `${sign}Rs ${pkr.format(Math.abs(paisa) / 100)}`;
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
  return new Intl.NumberFormat('en-PK').format(count);
}

/** "2026-10-21" to "21 Oct 2026". */
export function shortDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Tailwind colour for a gain, a loss, or neither. */
export function toneFor(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return 'text-slate-400';
  return value > 0 ? 'text-emerald-400' : 'text-rose-400';
}

const ACTION_TONES: Record<string, string> = {
  STRONG_BUY: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  BUY: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
  HOLD: 'bg-slate-500/10 text-slate-300 ring-slate-500/20',
  SELL: 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
  STRONG_SELL: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

export function actionTone(action: string): string {
  return ACTION_TONES[action] ?? ACTION_TONES.HOLD!;
}

export function actionLabel(action: string): string {
  return action.replace('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
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

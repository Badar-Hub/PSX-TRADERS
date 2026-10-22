/**
 * Colours and spacing.
 *
 * The web app gets these from Tailwind; React Native has no stylesheet to
 * share, so the palette is restated here as plain values. The hexes are the
 * same slate/emerald/rose scale the dashboard uses, so a screenshot of one app
 * sits next to the other without looking like a different product.
 */

export const colors = {
  bg: '#020617', // slate-950
  surface: '#0f172a', // slate-900
  surfaceRaised: '#1e293b', // slate-800
  border: '#1e293b',
  borderStrong: '#334155', // slate-700

  text: '#f1f5f9', // slate-100
  textMuted: '#94a3b8', // slate-400
  textFaint: '#64748b', // slate-500

  gain: '#34d399', // emerald-400
  gainDim: 'rgba(16, 185, 129, 0.14)',
  loss: '#fb7185', // rose-400
  lossDim: 'rgba(244, 63, 94, 0.14)',
  neutral: '#94a3b8',
  neutralDim: 'rgba(100, 116, 139, 0.16)',

  accent: '#38bdf8', // sky-400
  accentDim: 'rgba(56, 189, 248, 0.14)',
  warn: '#fbbf24', // amber-400
  warnDim: 'rgba(251, 191, 36, 0.14)',
} as const;

/** Text colour for a gain, a loss, or neither. Mirrors `toneFor` on the web. */
export function toneFor(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return colors.textMuted;
  return value > 0 ? colors.gain : colors.loss;
}

export interface Tone {
  fg: string;
  bg: string;
}

const ACTION_TONES: Record<string, Tone> = {
  STRONG_BUY: { fg: '#6ee7b7', bg: 'rgba(16, 185, 129, 0.2)' },
  BUY: { fg: colors.gain, bg: colors.gainDim },
  HOLD: { fg: '#cbd5e1', bg: colors.neutralDim },
  SELL: { fg: colors.loss, bg: colors.lossDim },
  STRONG_SELL: { fg: '#fda4af', bg: 'rgba(244, 63, 94, 0.2)' },
};

export function actionTone(action: string): Tone {
  return ACTION_TONES[action] ?? ACTION_TONES.HOLD!;
}

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

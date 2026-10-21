import { toneFor } from '@/lib/format';

/**
 * A single headline figure.
 *
 * `tone` is optional and only applied when a number is genuinely a gain or a
 * loss. Colouring a cost basis green because it happens to be positive would
 * imply a judgement the number does not carry.
 */
export function Stat({
  label,
  value,
  sub,
  tone,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Signed value that decides the colour. Omit to leave it neutral. */
  tone?: number | null;
  hint?: string;
}) {
  return (
    <div className="card">
      <p className="label">{label}</p>
      <p
        className={`numeric mt-1.5 text-xl font-semibold ${
          tone === undefined ? 'text-slate-100' : toneFor(tone)
        }`}
      >
        {value}
      </p>
      {sub !== undefined && <p className="numeric mt-0.5 text-xs text-slate-500">{sub}</p>}
      {hint !== undefined && <p className="mt-2 text-xs leading-relaxed text-slate-600">{hint}</p>}
    </div>
  );
}

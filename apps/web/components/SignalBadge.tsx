import { actionLabel, actionTone } from '@/lib/format';

export function SignalBadge({
  action,
  score,
  size = 'sm',
}: {
  action: string;
  score?: number;
  size?: 'sm' | 'lg';
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md ring-1 ring-inset ${actionTone(
        action,
      )} ${size === 'lg' ? 'px-3 py-1.5 text-sm font-semibold' : 'px-2 py-0.5 text-xs font-medium'}`}
    >
      {actionLabel(action)}
      {score !== undefined && (
        <span className="numeric opacity-70">
          {score > 0 ? '+' : ''}
          {score.toFixed(1)}
        </span>
      )}
    </span>
  );
}

/**
 * The confidence figure, with what it actually means on hover.
 *
 * Worth labelling carefully. It is coverage times agreement — how much of the
 * model had data and how closely those factors agreed — and explicitly not a
 * probability of being right. Showing a bare percentage next to a BUY would
 * invite exactly that misreading.
 */
export function ConfidenceMeter({
  confidence,
  missingFactors,
}: {
  confidence: number;
  missingFactors: number;
}) {
  const pct = Math.round(confidence * 100);
  const tone = pct >= 60 ? 'bg-emerald-500' : pct >= 35 ? 'bg-amber-500' : 'bg-slate-500';

  return (
    <div
      title="How much of the model had data, and how closely those factors agreed. Not a probability of being right."
      className="flex items-center gap-2"
    >
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="numeric text-xs text-slate-400">{pct}%</span>
      {missingFactors > 0 && (
        <span className="text-xs text-slate-600">· {missingFactors} missing</span>
      )}
    </div>
  );
}

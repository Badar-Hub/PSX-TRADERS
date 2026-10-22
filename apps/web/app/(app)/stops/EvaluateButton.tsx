'use client';

import { useActionState } from 'react';
import { evaluateStops } from './actions';
import { initialStopState } from './formState';

/**
 * Checks the armed rules against the stored closes now.
 *
 * The nightly job does this anyway. The button exists because without it a
 * user cannot tell "nothing has been breached" from "nothing has been
 * checked" — and a rule armed this afternoon has genuinely not been looked at
 * yet. Idempotent, so pressing it twice costs nothing.
 */
export function EvaluateButton({ portfolioId }: { portfolioId: string }) {
  const [state, action, pending] = useActionState(evaluateStops, initialStopState);

  return (
    <div className="text-right">
      <form action={action}>
        <input type="hidden" name="portfolioId" value={portfolioId} />
        <button type="submit" disabled={pending} className="btn-ghost text-sm">
          {pending ? 'Checking…' : 'Check now'}
        </button>
      </form>
      {state.notice !== null && (
        <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-slate-500">{state.notice}</p>
      )}
      {state.error !== null && (
        <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-rose-300">{state.error}</p>
      )}
    </div>
  );
}

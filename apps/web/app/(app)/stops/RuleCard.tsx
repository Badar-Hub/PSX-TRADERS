'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { percentFromBps, rupees, shares, shortDate } from '@/lib/format';
import type { StopRule } from '@/lib/types';
import { acknowledgeStopEvent, cancelStop } from './actions';
import { initialStopState } from './formState';
import { labelFor, triggerLabel } from './labels';

/**
 * One rule, with the market context that makes its level mean something.
 *
 * A stop at 95.00 says nothing on its own. "95.00, the stock is at 103.40, so
 * 8.8% of headroom, and 200 shares behind it" is a thing a person can act on,
 * and it is the whole reason this is a card rather than a table row.
 */
export function RuleCard({ rule }: { rule: StopRule }) {
  const [cancelState, cancel, cancelling] = useActionState(cancelStop, initialStopState);
  const [ackState, acknowledge, acknowledging] = useActionState(
    acknowledgeStopEvent,
    initialStopState,
  );

  const level = rule.type === 'TRAILING_STOP' ? rule.effectiveStop : rule.thresholdPrice;
  const armed = rule.status === 'ARMED';
  const fired = rule.status === 'TRIGGERED';
  const event = rule.events[0];

  /*
   * Headroom is the number worth colouring. Under 3% a stop is about to go, and
   * saying so in amber is more use than a figure the user has to compare
   * against the level themselves.
   */
  const headroom = rule.headroomBps;
  const protective = rule.type === 'STOP_LOSS' || rule.type === 'TRAILING_STOP';
  // Nearness is a warning on a stop and good news on a target, so only the
  // protective kinds get the amber treatment.
  const tight = protective && headroom !== null && headroom >= 0 && headroom < 300;
  const through = headroom !== null && headroom < 0;

  const covers = rule.quantity ?? rule.sharesHeld ?? null;
  // A rule on a symbol you do not hold will fire with nothing to sell. Worth
  // naming: "covers 0 shares" reads like a bug rather than a fact.
  const holdsNothing = (rule.sharesHeld ?? 0) === 0 && rule.quantity === null;
  const overcommitted =
    rule.quantity !== null && rule.sharesHeld !== null && rule.quantity > rule.sharesHeld;

  return (
    <div
      className={`card ${
        fired ? 'border-rose-800/50' : tight ? 'border-amber-800/40' : ''
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-slate-100">
            <Link href={`/signals/${rule.symbol}`} className="hover:text-sky-300">
              {rule.symbol}
            </Link>{' '}
            <span className="text-xs font-normal text-slate-500">{labelFor(rule.type)}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-600">{rule.securityName}</p>
        </div>

        <div className="text-right">
          <p className="numeric text-lg font-semibold text-slate-100">{rupees(level)}</p>
          <p className="text-[11px] text-slate-600">
            {triggerLabel(rule.triggerOn)}
            {rule.trailBps !== null && ` · trails ${(rule.trailBps / 100).toFixed(1)}%`}
            {rule.trailAmount !== null && ` · trails ${rupees(rule.trailAmount)}`}
          </p>
        </div>
      </div>

      {armed && (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-slate-800 pt-3 text-xs sm:grid-cols-4">
          <Row label="Market" value={rupees(rule.marketPrice)} />
          <Row
            label={protective ? 'Headroom' : 'Still to rise'}
            value={headroom === null ? '—' : percentFromBps(headroom)}
            tone={through ? 'text-rose-400' : tight ? 'text-amber-400' : 'text-slate-300'}
          />
          {rule.highWaterMark !== null && (
            <Row label="Trailed from" value={rupees(rule.highWaterMark)} />
          )}
          {covers !== null && covers > 0 && (
            <Row
              label="Covers"
              value={`${shares(covers)} shares`}
              tone={overcommitted ? 'text-amber-400' : 'text-slate-300'}
            />
          )}
          {rule.valueAtStop !== null && (
            <Row label="Value at stop" value={rupees(rule.valueAtStop)} />
          )}
          {rule.expiresAt !== null && <Row label="Expires" value={shortDate(rule.expiresAt)} />}
          <Row
            label="Checked to"
            value={rule.lastCheckedOn === null ? 'not yet' : shortDate(rule.lastCheckedOn)}
            tone={rule.lastCheckedOn === null ? 'text-amber-400' : 'text-slate-300'}
          />
        </dl>
      )}

      {holdsNothing && armed && (
        <p className="mt-2 text-xs leading-relaxed text-amber-400">
          You hold none of {rule.symbol}, so there is nothing for this rule to protect. It will
          still tell you when the level breaks.
        </p>
      )}

      {overcommitted && (
        <p className="mt-2 text-xs leading-relaxed text-amber-400">
          This rule covers {shares(rule.quantity!)} shares but only {shares(rule.sharesHeld!)} are
          held, so the figure above overstates what is at risk.
        </p>
      )}

      {through && armed && (
        <p className="mt-2 text-xs leading-relaxed text-rose-400">
          The last close is already through this level. It has not been evaluated yet — press
          &ldquo;check now&rdquo; above.
        </p>
      )}

      {rule.note !== null && rule.note !== '' && (
        <p className="mt-2 border-l-2 border-slate-700 pl-3 text-xs italic leading-relaxed text-slate-400">
          {rule.note}
        </p>
      )}

      {fired && event !== undefined && (
        <div className="mt-3 rounded-lg border border-rose-900/40 bg-rose-950/20 p-3">
          <p className="text-xs leading-relaxed text-rose-200">{event.message}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            <Row label="Fired on" value={shortDate(event.triggeredOn)} />
            <Row label="At" value={rupees(event.triggerPrice)} />
            <Row label="Stop was" value={rupees(event.stopAtTrigger)} />
          </dl>
          {event.acknowledgedAt === null && (
            <form action={acknowledge} className="mt-3">
              <input type="hidden" name="eventId" value={event.id} />
              <button type="submit" disabled={acknowledging} className="btn-ghost text-xs">
                {acknowledging ? 'Marking…' : 'Mark as seen'}
              </button>
            </form>
          )}
        </div>
      )}

      {(cancelState.error ?? ackState.error) !== null && (
        <p className="mt-2 text-xs text-rose-300">{cancelState.error ?? ackState.error}</p>
      )}

      {armed && (
        <form action={cancel} className="mt-3 border-t border-slate-800 pt-3">
          <input type="hidden" name="ruleId" value={rule.id} />
          <input type="hidden" name="symbol" value={rule.symbol} />
          <button type="submit" disabled={cancelling} className="btn-ghost text-xs">
            {cancelling ? 'Stopping…' : 'Stop watching'}
          </button>
        </form>
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`numeric ${tone ?? 'text-slate-300'}`}>{value}</dd>
    </div>
  );
}

import { api } from '@/lib/api';
import { resolveActivePortfolio } from '@/lib/portfolio';
import { rupees, shares, shortDate } from '@/lib/format';
import type { PortfolioSummary, StopRule } from '@/lib/types';
import { StopForm } from './StopForm';
import { RuleCard } from './RuleCard';
import { EvaluateButton } from './EvaluateButton';
import { labelFor } from './labels';

/**
 * Stops and targets.
 *
 * The page leads with what has fired, because a triggered stop is the only
 * thing in this app the user may need to act on today. Armed rules come next,
 * sorted by how little headroom they have left — the one closest to firing is
 * the one worth looking at.
 *
 * Everything here is an alert. PSX brokers do not generally give retail an
 * order API, so nothing is placed with anyone: the app watches the closes and
 * tells the user, and the page says so rather than letting the word "stop"
 * imply a resting order at the exchange.
 */
export default async function StopsPage({
  searchParams,
}: {
  searchParams: Promise<{ portfolio?: string; symbol?: string }>;
}) {
  const params = await searchParams;
  const { active } = await resolveActivePortfolio(params.portfolio);

  if (active === null) {
    return <p className="text-sm text-slate-400">No portfolio yet.</p>;
  }

  const [{ rules, counts }, positions] = await Promise.all([
    api<{ rules: StopRule[]; counts: Record<string, number> }>(
      `/api/portfolios/${active.id}/stops`,
    ),
    api<PortfolioSummary>(`/api/portfolios/${active.id}/positions`),
  ]);

  const armed = rules
    .filter((rule) => rule.status === 'ARMED')
    // Least headroom first: closest to firing is most worth reading.
    .sort((a, b) => (a.headroomBps ?? Number.MAX_SAFE_INTEGER) - (b.headroomBps ?? Number.MAX_SAFE_INTEGER));
  const triggered = rules.filter((rule) => rule.status === 'TRIGGERED');
  const closed = rules.filter(
    (rule) => rule.status === 'CANCELLED' || rule.status === 'EXPIRED',
  );

  const unacknowledged = triggered.filter((rule) =>
    rule.events.some((event) => event.acknowledgedAt === null),
  );

  /** Holdings with nothing watching them, which is the gap worth pointing out. */
  const unprotected = positions.positions.filter(
    (position) =>
      position.quantity > 0 &&
      !armed.some(
        (rule) =>
          rule.symbol === position.symbol &&
          (rule.type === 'STOP_LOSS' || rule.type === 'TRAILING_STOP'),
      ),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Stops and targets</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
            Checked against each new close. These are alerts, not orders — nothing is placed with
            your broker, so a trigger is a prompt to act rather than a sale.
          </p>
        </div>
        <EvaluateButton portfolioId={active.id} />
      </div>

      {unacknowledged.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-rose-300">
            {unacknowledged.length} stop{unacknowledged.length === 1 ? '' : 's'} fired
          </h2>
          {unacknowledged.map((rule) => (
            <RuleCard key={rule.id} rule={rule} />
          ))}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-200">
                Armed{counts.ARMED !== undefined && ` (${counts.ARMED})`}
              </h2>
              {armed.length > 1 && (
                <p className="text-xs text-slate-600">Closest to firing first</p>
              )}
            </div>

            {armed.length === 0 ? (
              <div className="card">
                <p className="text-sm text-slate-300">Nothing is being watched.</p>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                  A stop is the one decision easiest to make calmly in advance and hardest to make
                  while a position is falling. Arm one on the right.
                </p>
              </div>
            ) : (
              armed.map((rule) => <RuleCard key={rule.id} rule={rule} />)
            )}
          </section>

          {unprotected.length > 0 && (
            <section className="card">
              <h2 className="text-sm font-semibold text-slate-200">
                Held with no stop
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                Not a recommendation — plenty of people hold without stops deliberately. It is
                here because the alternative is a portfolio where you cannot tell at a glance
                which positions are covered.
              </p>
              <ul className="mt-3 space-y-1.5">
                {unprotected.map((position) => (
                  <li
                    key={position.symbol}
                    className="flex items-center justify-between border-t border-slate-800 pt-1.5 text-sm"
                  >
                    <span className="text-slate-200">{position.symbol}</span>
                    <span className="numeric text-xs text-slate-500">
                      {shares(position.quantity)} shares · {rupees(position.marketValue)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {closed.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-slate-200">No longer watching</h2>
              <div className="card space-y-2">
                {closed.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2 text-sm first:border-0 first:pt-0"
                  >
                    <span className="text-slate-300">
                      {rule.symbol}{' '}
                      <span className="text-xs text-slate-600">
                        {labelFor(rule.type)} at{' '}
                        {rupees(
                          rule.type === 'TRAILING_STOP' ? rule.effectiveStop : rule.thresholdPrice,
                        )}
                      </span>
                    </span>
                    <span className="text-xs text-slate-500">
                      {rule.status.toLowerCase()} · armed {shortDate(rule.armedAt.slice(0, 10))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {triggered.length > unacknowledged.length && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-slate-200">Already seen</h2>
              {triggered
                .filter((rule) => !unacknowledged.includes(rule))
                .map((rule) => (
                  <RuleCard key={rule.id} rule={rule} />
                ))}
            </section>
          )}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">Watch a symbol</h2>
          <StopForm
            portfolioId={active.id}
            defaultSymbol={params.symbol?.toUpperCase() ?? ''}
            held={positions.positions.map((position) => ({
              symbol: position.symbol,
              quantity: position.quantity,
              marketPrice: position.marketPrice,
            }))}
          />
        </div>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';

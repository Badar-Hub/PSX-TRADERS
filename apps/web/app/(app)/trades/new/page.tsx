import Link from 'next/link';
import { resolveActivePortfolio, withPortfolio } from '@/lib/portfolio';
import { TradeForm } from './TradeForm';

export default async function NewTradePage({
  searchParams,
}: {
  searchParams: Promise<{ portfolio?: string; symbol?: string }>;
}) {
  const params = await searchParams;
  const { active } = await resolveActivePortfolio(params.portfolio);
  if (active === null) return <p className="text-sm text-slate-400">No portfolios.</p>;

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <Link
          href={withPortfolio('/trades', active.id)}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          ← Trades
        </Link>
        <h1 className="mt-2 text-lg font-semibold text-slate-100">Record a trade</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Into {active.name} · {active.costBasisMethod} cost basis
        </p>
      </div>

      <TradeForm
        portfolioId={active.id}
        defaultSymbol={params.symbol?.toUpperCase() ?? ''}
        hasAccount={active.accountId !== null}
      />
    </div>
  );
}

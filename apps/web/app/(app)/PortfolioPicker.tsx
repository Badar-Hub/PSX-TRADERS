'use client';

import { usePathname, useRouter } from 'next/navigation';
import type { Portfolio } from '@/lib/types';

export function PortfolioPicker({
  portfolios,
  activeId,
}: {
  portfolios: Portfolio[];
  activeId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  if (portfolios.length <= 1) return null;

  return (
    <select
      value={activeId}
      aria-label="Portfolio"
      onChange={(event) => {
        // Navigating rather than holding the selection in client state keeps
        // every page a shareable URL and survives a refresh.
        router.push(`${pathname}?portfolio=${event.target.value}`);
      }}
      className="input w-auto py-1.5 text-sm"
    >
      {portfolios.map((portfolio) => (
        <option key={portfolio.id} value={portfolio.id}>
          {portfolio.name}
          {portfolio.isPaperTrading ? ' (paper)' : ''}
        </option>
      ))}
    </select>
  );
}

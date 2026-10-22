import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useFetch } from './useFetch';
import { useSession } from './session';
import type { Portfolio } from './types';

/**
 * Which portfolio the app is looking at.
 *
 * The web app keeps this in the URL, which is the right answer there — a link
 * to a portfolio should open that portfolio. A phone has no address bar, so it
 * lives in context instead, fetched once for the whole app rather than by each
 * screen that needs it, which would then be free to disagree.
 *
 * It sits at the root rather than around the tab group, because the trade and
 * admin screens are siblings of the tabs, not children, and would otherwise
 * find no provider. The fetch waits for the account to be approved: mounted
 * this high it would otherwise fire while the user is still signing in, and
 * collect a 401 for its trouble.
 */
interface PortfolioValue {
  portfolios: Portfolio[];
  active: Portfolio | null;
  loading: boolean;
  error: string | null;
  select: (id: string) => void;
  reload: () => void;
}

const PortfolioContext = createContext<PortfolioValue | null>(null);

export function PortfolioProvider({ children }: { children: ReactNode }): ReactNode {
  const { next } = useSession();
  const { data, error, loading, reload } = useFetch<{ portfolios: Portfolio[] }>(
    next === 'READY' ? '/api/portfolios' : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const portfolios = data?.portfolios ?? [];

  // The selection is validated against the list rather than trusted: a
  // portfolio can be renamed or removed on another device, and a stale id
  // would otherwise leave every tab fetching a 404.
  const active = useMemo(
    () => portfolios.find((p) => p.id === selectedId) ?? portfolios[0] ?? null,
    [portfolios, selectedId],
  );

  const select = useCallback((id: string) => setSelectedId(id), []);

  const value = useMemo<PortfolioValue>(
    () => ({ portfolios, active, loading, error, select, reload }),
    [portfolios, active, loading, error, select, reload],
  );

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio(): PortfolioValue {
  const value = useContext(PortfolioContext);
  if (value === null) throw new Error('usePortfolio must be used inside a PortfolioProvider');
  return value;
}

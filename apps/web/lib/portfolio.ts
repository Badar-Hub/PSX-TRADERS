import { api } from './api';
import type { Portfolio } from './types';

/**
 * Resolving which portfolio a page is about.
 *
 * The portfolio travels in the query string rather than in a cookie or a
 * context provider. That keeps every page a plain shareable URL and means a
 * refresh, a back button or a bookmark all land on the same data — which a
 * client-held "selected portfolio" would not.
 */

export async function loadPortfolios(): Promise<Portfolio[]> {
  const { portfolios } = await api<{ portfolios: Portfolio[] }>('/api/portfolios');
  return portfolios;
}

export async function resolveActivePortfolio(
  requestedId: string | undefined,
): Promise<{ portfolios: Portfolio[]; active: Portfolio | null }> {
  const portfolios = await loadPortfolios();
  if (portfolios.length === 0) return { portfolios, active: null };

  const active =
    (requestedId !== undefined ? portfolios.find((p) => p.id === requestedId) : undefined) ??
    portfolios[0]!;

  return { portfolios, active };
}

/** Appends the portfolio to a path, so navigation keeps the selection. */
export function withPortfolio(path: string, portfolioId: string | undefined): string {
  if (portfolioId === undefined) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}portfolio=${portfolioId}`;
}

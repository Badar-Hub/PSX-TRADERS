'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Positions' },
  { href: '/predictions', label: 'Predictions' },
  { href: '/trades', label: 'Trades' },
  { href: '/stops', label: 'Stops' },
  { href: '/reports', label: 'P&L' },
  { href: '/market', label: 'Market' },
];

/** Shown only to admins. The route refuses a member anyway, but a link to a
 * page you may not open is just a dead end. */
const ADMIN_LINK = { href: '/admin/users', label: 'Members' };

/**
 * Navigation that carries the selected portfolio.
 *
 * Client-side only so the active link can be highlighted from the current path,
 * and so the portfolio query parameter survives a move between pages. Losing it
 * on every navigation would silently drop the user back to their first
 * portfolio.
 */
export function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const portfolio = params.get('portfolio');
  const links = isAdmin ? [...LINKS, ADMIN_LINK] : LINKS;

  return (
    <nav className="flex items-center gap-1">
      {links.map((link) => {
        const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
        const href =
          portfolio === null ? link.href : `${link.href}?portfolio=${portfolio}`;
        return (
          <Link
            key={link.href}
            href={href}
            className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${
              active
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

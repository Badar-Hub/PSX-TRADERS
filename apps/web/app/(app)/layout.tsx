import Link from 'next/link';
import { Suspense } from 'react';
import { requireActive } from '@/lib/account';
import { signOut } from '../login/actions';
import { NavLinks } from './NavLinks';

/**
 * Nothing in this section can be prerendered: every page reads the session
 * cookie and fetches a figure that must be current. Saying so explicitly is
 * clearer than relying on `cookies()` to opt each page out one at a time.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  /*
   * The gate, in one place.
   *
   * Every page under this layout is behind it, so there is no page that forgot
   * to check — an unverified or unapproved account is sent to the step it is
   * actually on before any of them renders. The API enforces the same thing on
   * every request; this is so the user sees a screen that explains itself
   * rather than a dashboard full of 403s.
   */
  const account = await requireActive();

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/40">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-sm font-semibold tracking-tight text-slate-100">
            PSX Trader
          </Link>

          {/*
            NavLinks reads the query string to carry the portfolio selection
            between pages, which needs a Suspense boundary so the shell can
            render before the parameters are known.
          */}
          <Suspense fallback={<div className="h-8" />}>
            <NavLinks isAdmin={account.role === 'ADMIN'} />
          </Suspense>

          <div className="ml-auto flex items-center gap-4">
            <span className="hidden text-xs text-slate-500 sm:inline">{account.email}</span>
            <form action={signOut}>
              <button type="submit" className="text-xs text-slate-500 hover:text-slate-300">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>

      <footer className="mx-auto max-w-7xl px-4 pb-10 pt-4">
        <p className="text-xs leading-relaxed text-slate-600">
          Signals and analysis from public data, not investment advice. Figures are
          computed from the trades you record; charge rates and the capital-gains
          estimate come from configuration you should check against a real contract
          note.
        </p>
      </footer>
    </div>
  );
}

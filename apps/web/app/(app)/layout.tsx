import Link from 'next/link';
import { Suspense } from 'react';
import { signOut } from '../login/actions';
import { NavLinks } from './NavLinks';

/**
 * Nothing in this section can be prerendered: every page reads the session
 * cookie and fetches a figure that must be current. Saying so explicitly is
 * clearer than relying on `cookies()` to opt each page out one at a time.
 */
export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: { children: React.ReactNode }) {
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
            <NavLinks />
          </Suspense>

          <form action={signOut} className="ml-auto">
            <button type="submit" className="text-xs text-slate-500 hover:text-slate-300">
              Sign out
            </button>
          </form>
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

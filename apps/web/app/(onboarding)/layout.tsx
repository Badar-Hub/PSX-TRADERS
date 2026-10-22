import { signOut } from '../login/actions';

/**
 * The frame for the two gates.
 *
 * Deliberately not the app shell: there is no navigation here, because there
 * is nowhere to navigate to. An account at this stage can do exactly one thing,
 * and the page says what it is.
 */
export const dynamic = 'force-dynamic';

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-slate-100">PSX Trader</h1>
        </div>

        {children}

        <form action={signOut} className="mt-6 text-center">
          <button type="submit" className="text-xs text-slate-500 hover:text-slate-300">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

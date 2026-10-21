import { LoginForm } from './LoginForm';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string; unreachable?: string; mode?: string }>;
}) {
  const params = await searchParams;

  const notice =
    params.unreachable !== undefined
      ? 'Could not reach the API. Is it running on port 4000?'
      : params.expired !== undefined
        ? 'Your session expired. Sign in again.'
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-slate-100">PSX Trader</h1>
          <p className="mt-1 text-sm text-slate-500">
            Portfolio tracking and explainable predictions
          </p>
        </div>

        {notice !== null && (
          <div className="mb-4 rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-sm text-amber-300">
            {notice}
          </div>
        )}

        <LoginForm initialMode={params.mode === 'register' ? 'register' : 'signin'} />

        <p className="mt-6 text-center text-xs leading-relaxed text-slate-600">
          This app produces signals and analysis from public data. It is not
          investment advice and knows nothing about your circumstances.
        </p>
      </div>
    </main>
  );
}

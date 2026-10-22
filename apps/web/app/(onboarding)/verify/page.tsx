import { requireStep } from '@/lib/account';
import { VerifyForm } from './VerifyForm';

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ expires?: string }>;
}) {
  const account = await requireStep('VERIFY_EMAIL');
  const params = await searchParams;

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-slate-100">Check your email</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
        We sent a six-digit code to <span className="text-slate-200">{account.email}</span>. Codes
        are valid for ten minutes.
      </p>

      {/*
        The expiry is passed in on the query string by the registration action,
        which is the only place that knows it: the API returns it with the
        account, and a page reload would otherwise lose the countdown.
      */}
      <VerifyForm initialExpiresAt={params.expires ?? null} />

      <p className="mt-5 border-t border-slate-800 pt-4 text-xs leading-relaxed text-slate-600">
        Once the address is confirmed, an administrator still has to approve the account before it
        can be used. You will be emailed when that happens.
      </p>
    </div>
  );
}

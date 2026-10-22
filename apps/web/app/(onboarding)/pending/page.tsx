import { requireStep } from '@/lib/account';
import { shortDate } from '@/lib/format';
import { PendingPoller } from './PendingPoller';

/**
 * The second gate: verified, waiting on a person.
 *
 * An admin approving someone happens elsewhere, so this page has no way to be
 * told. It refreshes itself every fifteen seconds, which is what turns the
 * approval into something the user sees happen rather than something they have
 * to go and check.
 */
export default async function PendingPage() {
  const account = await requireStep('AWAITING_APPROVAL');

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-slate-100">Waiting for approval</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
        Your email address is confirmed. An administrator has to approve the account before it can
        be used.
      </p>

      <dl className="mt-5 space-y-2 border-t border-slate-800 pt-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Account</dt>
          <dd className="text-slate-200">{account.email}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Email confirmed</dt>
          <dd className="text-slate-200">{shortDate(account.emailVerifiedAt?.slice(0, 10))}</dd>
        </div>
      </dl>

      <p className="mt-5 text-xs leading-relaxed text-slate-600">
        You will be emailed as soon as the account is approved. This page checks for itself every
        few seconds, so you can leave it open.
      </p>

      <PendingPoller />
    </div>
  );
}

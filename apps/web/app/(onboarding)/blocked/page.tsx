import { requireStep } from '@/lib/account';

/**
 * Rejected or suspended.
 *
 * The administrator's note is shown when there is one. A refusal with no
 * reason invites the user to assume a bug and sign up again; a reason ends the
 * matter. There is no retry button, because there is nothing the user can do
 * from here.
 */
export default async function BlockedPage() {
  const account = await requireStep('BLOCKED');
  const suspended = account.status === 'SUSPENDED';
  const note = account.decisionNote;

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-slate-100">
        {suspended ? 'Account suspended' : 'Account not approved'}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
        {suspended
          ? 'This account has been suspended, so it cannot be used for now.'
          : 'An administrator did not approve this account.'}
      </p>

      {note !== null && note !== '' && (
        <div className="mt-5 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="label">Reason given</p>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-200">{note}</p>
        </div>
      )}

      <p className="mt-5 text-xs leading-relaxed text-slate-600">
        If you think this is a mistake, speak to whoever administers this app.
      </p>
    </div>
  );
}
